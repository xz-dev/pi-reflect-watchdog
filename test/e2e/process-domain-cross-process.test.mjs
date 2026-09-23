import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	openProcessDomain,
	openSharedProcessDomain,
} from "pi-extension-utils/process-domain";
import { createReflectDomainCoordinator } from "../../dist/process-domain.js";
import {
	createIsolatedEnvironment,
	createTestResources,
	installPackedArtifact,
	ROOT,
	runBoundedProcess,
} from "../../scripts/e2e/harness.mjs";

const open = (options) =>
	openProcessDomain({
		...options,
		connectTimeoutMs: 2_000,
		heartbeatIntervalMs: 100,
		heartbeatTimeoutMs: 400,
		heartbeatTimeToLiveMs: 300,
	});

async function waitFor(predicate, label, timeoutMs = 5_000) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const value = predicate();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${label}`);
}

class MinimalPi {
	constructor() {
		this.handlers = new Map();
		this.messages = [];
		this.commands = [];
		this.entries = [];
		this.bus = new Map();
		this.events = {
			on: (channel, handler) => {
				const handlers = this.bus.get(channel) ?? new Set();
				handlers.add(handler);
				this.bus.set(channel, handlers);
				return () => handlers.delete(handler);
			},
			emit: (channel, value) => {
				for (const handler of this.bus.get(channel) ?? []) handler(value);
			},
		};
	}

	on(name, handler) {
		this.handlers.set(name, handler);
	}

	registerCommand(name, command) {
		this.commands.push({ name, handler: command.handler });
	}

	registerShortcut() {}

	registerMessageRenderer() {}

	sendMessage(message, options) {
		this.messages.push({ message, options });
	}

	appendEntry(customType, data) {
		this.entries.push({ customType, data });
	}

	async emit(name, event, context) {
		return await this.handlers.get(name)?.(event, context);
	}
}

function minimalContext(sessionId) {
	let idle = true;
	return {
		hasUI: true,
		mode: "rpc",
		cwd: `/work/${sessionId}`,
		isProjectTrusted: () => false,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		abort() {},
		setIdle(value) {
			idle = value;
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
			getLeafId: () => null,
			getBranch: () => [],
		},
		ui: {
			notify() {},
			setStatus() {},
			setWidget() {},
		},
	};
}

function spawnChild(declaration, processDomainModule) {
	const child = fork(path.join(ROOT, "test/e2e/process-domain-child.mjs"), {
		cwd: ROOT,
		env: {
			...process.env,
			PI_EXTENSION_UTILS_PROCESS_DOMAIN: declaration,
			...(processDomainModule
				? { PI_WATCHDOG_PROCESS_DOMAIN_MODULE: processDomainModule }
				: {}),
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	let stdout = "";
	let stderr = "";
	let nextId = 0;
	const pending = new Map();
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	child.on("message", (message) => {
		if (typeof message !== "object" || message === null) return;
		if (Number.isSafeInteger(message.id)) {
			const request = pending.get(message.id);
			if (!request) return;
			pending.delete(message.id);
			clearTimeout(request.timer);
			if (message.error) request.reject(new Error(message.error));
			else request.resolve(message.data);
			return;
		}
		if (message.event === "ready") child.ready = true;
		if (message.event === "startup-error") child.startupError = message.message;
	});
	child.on("exit", (code, signal) => {
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(
				new Error(
					`child exited (${code ?? signal}); stdout=${stdout}; stderr=${stderr}`,
				),
			);
		}
		pending.clear();
	});
	return {
		process: child,
		command(command) {
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(
						new Error(
							`child command ${command} timed out; stdout=${stdout}; stderr=${stderr}`,
						),
					);
				}, 5_000);
				pending.set(id, { resolve, reject, timer });
				child.send({ id, command });
			});
		},
		async ready() {
			await waitFor(() => child.ready || child.startupError, "child startup");
			if (child.startupError) throw new Error(child.startupError);
		},
		async stop() {
			if (child.exitCode !== null || child.signalCode !== null) return;
			try {
				await this.command("shutdown");
			} catch {
				child.kill("SIGKILL");
			}
			if (child.exitCode === null && child.signalCode === null) {
				await Promise.race([
					once(child, "exit"),
					new Promise((resolve) =>
						setTimeout(() => {
							child.kill("SIGKILL");
							resolve();
						}, 2_000),
					),
				]);
			}
		},
	};
}

// Real extension installs share one in-realm node via openSharedProcessDomain;
// using it here reproduces the first-opener metadata that the bug hinges on.
const sharedOpen = (options) =>
	openSharedProcessDomain({
		...options,
		connectTimeoutMs: 2_000,
		heartbeatIntervalMs: 100,
		heartbeatTimeoutMs: 400,
		heartbeatTimeToLiveMs: 300,
	});

// Cross-process tests exercise the *actual installed* continue-watchdog
// coordinator over the real shared transport. Its dist is not published, so
// we fetch it from the pinned upstream ref and build it once per run.
const CONTINUE_REPO = "https://github.com/xz-dev/pi-continue-watchdog";
const CONTINUE_REF = "b6297eed75e8ace20d7f065077c782e508135212";

let continueDistPromise;

async function ensureContinueDist() {
	if (!continueDistPromise) {
		continueDistPromise = (async () => {
			const worktree = await mkdtemp(
				path.join(os.tmpdir(), "pi-continue-watchdog-e2e-"),
			);
			const clone = await runBoundedProcess(
				"git",
				["clone", "--quiet", CONTINUE_REPO, worktree],
				{ timeoutMs: 120_000 },
			);
			if (clone.status !== 0 || clone.error)
				throw new Error(`continue-watchdog clone failed:\n${clone.stderr}`);
			const checkout = await runBoundedProcess(
				"git",
				["checkout", "--quiet", CONTINUE_REF],
				{ cwd: worktree, timeoutMs: 120_000 },
			);
			if (checkout.status !== 0 || checkout.error)
				throw new Error(
					`continue-watchdog checkout ${CONTINUE_REF.slice(0, 12)} failed:\n${checkout.stderr}`,
				);
			const install = await runBoundedProcess(
				"npm",
				["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
				{ cwd: worktree, timeoutMs: 180_000 },
			);
			if (install.status !== 0 || install.error)
				throw new Error(`continue-watchdog npm ci failed:\n${install.stderr}`);
			const build = await runBoundedProcess(
				"npx",
				["tsc", "-p", "tsconfig.json"],
				{ cwd: worktree, timeoutMs: 180_000 },
			);
			if (build.status !== 0 || build.error)
				throw new Error(
					`continue-watchdog build failed:\n${build.stdout}\n${build.stderr}`,
				);
			const dist = path.join(worktree, "dist", "process-domain.js");
			await access(dist);
			return dist;
		})();
		continueDistPromise.catch(() => {
			// Allow a retry on the next call after a transient fetch failure.
			continueDistPromise = undefined;
		});
	}
	return continueDistPromise;
}

function spawnContinueChild(declaration, continueDist) {
	// Minimal subprocess running the *actual installed* continue-watchdog
	// coordinator (client role) over the real shared transport.
	const source = [
		'import { openProcessDomain } from "pi-extension-utils/process-domain";',
		`import { createProcessDomainCoordinator } from ${JSON.stringify(pathToFileURL(continueDist).href)};`,
		"const open = (options) => openProcessDomain({ ...options, connectTimeoutMs: 2000, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 400, heartbeatTimeToLiveMs: 300 });",
		"const coordinator = createProcessDomainCoordinator({ open });",
		"const instance = {};",
		"let idle = true;",
		"function reply(id, data, error) { process.send?.({ id, data, error }); }",
		'await coordinator.attach(instance, { getIdle: () => idle, onFatal: (error) => process.send?.({ event: "transport-error", message: error.message }) });',
		'process.send?.({ event: "ready", pid: process.pid });',
		'process.on("message", async (message) => {',
		'	if (typeof message !== "object" || message === null) return;',
		"	const { id, command } = message;",
		'	if (!Number.isSafeInteger(id) || typeof command !== "string") return;',
		"	try {",
		"		switch (command) {",
		'			case "busy": idle = false; await coordinator.reportIdle(instance, false); reply(id, true); break;',
		'			case "idle": idle = true; await coordinator.reportIdle(instance, true); reply(id, true); break;',
		'			case "snapshot": reply(id, coordinator.snapshot); break;',
		'			case "shutdown": await coordinator.detach(instance, true); reply(id, true); setTimeout(() => process.disconnect?.(), 50); break;',
		"			default: throw new Error(`unknown command: ${command}`);",
		"		}",
		"	} catch (error) { reply(id, undefined, error instanceof Error ? error.message : String(error)); }",
		"});",
	].join("\n");
	const child = spawn(
		process.execPath,
		["--input-type=module", "--eval", source],
		{
			cwd: ROOT,
			env: { ...process.env, PI_EXTENSION_UTILS_PROCESS_DOMAIN: declaration },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	let stdout = "";
	let stderr = "";
	let nextId = 0;
	const pending = new Map();
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	child.on("message", (message) => {
		if (typeof message !== "object" || message === null) return;
		if (Number.isSafeInteger(message.id)) {
			const request = pending.get(message.id);
			if (!request) return;
			pending.delete(message.id);
			clearTimeout(request.timer);
			if (message.error) request.reject(new Error(message.error));
			else request.resolve(message.data);
			return;
		}
		if (message.event === "ready") child.ready = true;
		if (message.event === "startup-error") child.startupError = message.message;
	});
	child.on("exit", (code, signal) => {
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(
				new Error(
					`continue child exited (${code ?? signal}); stdout=${stdout}; stderr=${stderr}`,
				),
			);
		}
		pending.clear();
	});
	return {
		process: child,
		command(command) {
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(
						new Error(
							`continue child command ${command} timed out; stdout=${stdout}; stderr=${stderr}`,
						),
					);
				}, 5_000);
				pending.set(id, { resolve, reject, timer });
				child.send({ id, command });
			});
		},
		async ready() {
			await waitFor(
				() => child.ready || child.startupError,
				"continue child startup",
			);
			if (child.startupError) throw new Error(child.startupError);
		},
		async stop() {
			if (child.exitCode !== null || child.signalCode !== null) return;
			try {
				await this.command("shutdown");
			} catch {
				child.kill("SIGKILL");
			}
			if (child.exitCode === null && child.signalCode === null) {
				await Promise.race([
					once(child, "exit"),
					new Promise((resolve) =>
						setTimeout(() => {
							child.kill("SIGKILL");
							resolve();
						}, 2_000),
					),
				]);
			}
		},
	};
}

test("real shared transport: continue first opener preserves reflect child accounting", {
	timeout: 30_000,
}, async (t) => {
	// Both actual installed watchdog coordinators share the real transport;
	// Continue opens first, so its metadata ({role,pid} — no reflect protocol
	// fields) populates the shared node declaration. Reflect must still admit
	// the background child's accounting from private-protocol checkpoints.
	const continueModule = pathToFileURL(await ensureContinueDist()).href;
	const continueDomain = await import(continueModule);
	const env = {};
	const continueRoot = continueDomain.createProcessDomainCoordinator({
		env,
		open: sharedOpen,
	});
	const continueInstance = {};
	await continueRoot.attach(continueInstance, {
		getIdle: () => true,
		onFatal() {},
	});
	t.after(() => continueRoot.detach(continueInstance, true));
	assert.equal(continueRoot.isRootProcess, true, "continue opened first");
	const declaration = env.PI_EXTENSION_UTILS_PROCESS_DOMAIN;
	assert.ok(declaration);

	const root = createReflectDomainCoordinator({
		env,
		open: sharedOpen,
		activeTickMs: 100,
		idleResetGapMs: 10_000,
	});
	const instance = {};
	await root.attach(instance, { getBusy: () => false, onFatal() {} });
	t.after(() => root.detach(instance));
	const child = spawnChild(declaration);
	t.after(() => child.stop());
	await child.ready();

	const start = root.counters()?.activeMs.value ?? 0n;
	await child.command("busy");
	await waitFor(
		() => root.counters()?.otherBusy === true,
		"reflect root observes reflect child busy",
	);
	await child.command("all-loop");
	await child.command("all-loop");
	await child.command("all-loop");
	await waitFor(
		() => root.counters()?.allLoops.value >= 3n,
		"reflect child loops aggregate",
	);
	await new Promise((resolve) => setTimeout(resolve, 650));
	const counters = root.counters();
	assert.equal(
		counters?.rootLoops.value,
		0n,
		"child work stays off root loops",
	);
	assert.ok(
		(counters?.activeMs.value ?? 0n) > start,
		"child-only work advances active time",
	);
	assert.ok((counters?.taskMs.value ?? 0n) > 0n, "task time advances");

	// Continue must still observe the same background child through its own
	// protocol on the shared transport.
	const continueChild = spawnContinueChild(
		declaration,
		await ensureContinueDist(),
	);
	t.after(() => continueChild.stop());
	await continueChild.ready();
	await continueChild.command("busy");
	await waitFor(
		() => continueRoot.snapshot.busyParticipants >= 1,
		"continue root observes continue child busy",
	);
	assert.equal(root.counters()?.otherBusy, true);

	await continueChild.command("idle");
	await continueChild.stop();
	await child.stop();
	await waitFor(
		() => root.counters()?.anyBusy === false,
		"graceful child leave",
		10_000,
	);
});

test("real shared transport: reflect first opener keeps continue activity", {
	timeout: 30_000,
}, async (t) => {
	// Reverse order: Reflect opens the shared node first, Continue joins
	// second. Continue behavior must be unchanged and Reflect accounting
	// must work identically.
	const env = {};
	const root = createReflectDomainCoordinator({
		env,
		open,
		activeTickMs: 100,
		idleResetGapMs: 10_000,
	});
	const instance = {};
	await root.attach(instance, { getBusy: () => false, onFatal() {} });
	t.after(() => root.detach(instance));
	const declaration = env.PI_EXTENSION_UTILS_PROCESS_DOMAIN;
	assert.ok(declaration);

	const continueModule = pathToFileURL(await ensureContinueDist()).href;
	const continueDomain = await import(continueModule);
	const continueRoot = continueDomain.createProcessDomainCoordinator({
		env,
		open: sharedOpen,
	});
	const continueInstance = {};
	await continueRoot.attach(continueInstance, {
		getIdle: () => true,
		onFatal() {},
	});
	t.after(() => continueRoot.detach(continueInstance, true));
	// Continue joins as a non-host peer on the shared node but still claims
	// isRootProcess semantics for its protocol; its child observes activity.
	assert.equal(continueRoot.isRootProcess, false);

	const child = spawnChild(declaration);
	t.after(() => child.stop());
	await child.ready();
	await child.command("busy");
	await waitFor(
		() => root.counters()?.otherBusy === true,
		"reflect root observes child busy",
	);
	await child.command("all-loop");
	await waitFor(
		() => root.counters()?.allLoops.value >= 1n,
		"reflect child loop aggregates",
	);

	const continueChild = spawnContinueChild(
		declaration,
		await ensureContinueDist(),
	);
	t.after(() => continueChild.stop());
	await continueChild.ready();
	// Continue here is a non-host peer on the Reflect-owned shared node: by
	// design it reports to the host but does not aggregate. Verify that its
	// join does not disrupt the Reflect accounting of the reflect child.
	await continueChild.command("busy");
	assert.equal(
		root.counters()?.otherBusy,
		true,
		"reflect accounting unaffected",
	);
	assert.equal(
		continueRoot.isRootProcess,
		false,
		"continue stays a non-host peer on the shared node",
	);

	await continueChild.stop();
	await child.stop();
	await waitFor(
		() => root.counters()?.anyBusy === false,
		"graceful child leave",
		10_000,
	);
});

test("wrong capability fails closed with status 78 and sanitized output", {
	timeout: 10_000,
}, async (t) => {
	const env = {};
	const root = createReflectDomainCoordinator({ env, open });
	const instance = {};
	await root.attach(instance, { getBusy: () => false, onFatal() {} });
	t.after(() => root.detach(instance));
	const declaration = env.PI_EXTENSION_UTILS_PROCESS_DOMAIN;
	assert.ok(declaration);
	const decoded = JSON.parse(
		Buffer.from(declaration, "base64url").toString("utf8"),
	);
	const actualCapability = decoded.capability;
	const wrongCapability = randomBytes(32).toString("base64url");
	const wrongDeclaration = Buffer.from(
		JSON.stringify({ ...decoded, capability: wrongCapability }),
		"utf8",
	).toString("base64url");
	const source = [
		'import { openProcessDomain } from "pi-extension-utils/process-domain";',
		'import { createReflectDomainCoordinator, isReflectDomainFatalError } from "./dist/process-domain.js";',
		"const open = (options) => openProcessDomain({ ...options, connectTimeoutMs: 1500, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 400, heartbeatTimeToLiveMs: 300 });",
		"const coordinator = createReflectDomainCoordinator({ open });",
		"try { await coordinator.attach({}, { getBusy: () => false, onFatal() {} }); process.exitCode = 1; } catch (error) {",
		'  console.error("CODE=" + (isReflectDomainFatalError(error) ? error.code : "UNKNOWN"));',
		"  process.exitCode = 78;",
		"}",
	].join("\n");
	const child = spawn(
		process.execPath,
		["--input-type=module", "--eval", source],
		{
			cwd: ROOT,
			env: {
				...process.env,
				PI_EXTENSION_UTILS_PROCESS_DOMAIN: wrongDeclaration,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const [code, signal] = await once(child, "exit");
	assert.equal(signal, null);
	assert.equal(code, 78);
	const output = `${stdout}\n${stderr}`;
	assert.match(output, /CODE=AUTHENTICATION_FAILED/);
	assert.doesNotMatch(output, new RegExp(actualCapability, "u"));
	assert.doesNotMatch(output, new RegExp(wrongCapability, "u"));
	assert.equal(output.includes(decoded.endpoint), false);
});

test("real process transport removes stopped peer immediately and resumes from checkpoint", {
	timeout: 20_000,
}, async (t) => {
	const env = {};
	const root = createReflectDomainCoordinator({
		env,
		open,
		activeTickMs: 100,
		idleResetGapMs: 10_000,
	});
	const instance = {};
	await root.attach(instance, { getBusy: () => false, onFatal() {} });
	t.after(() => root.detach(instance));
	const declaration = env.PI_EXTENSION_UTILS_PROCESS_DOMAIN;
	assert.ok(declaration);
	const child = spawnChild(declaration);
	t.after(() => child.stop());
	await child.ready();

	await child.command("root-loop");
	await child.command("all-loop");
	await child.command("busy");
	await waitFor(
		() =>
			root.counters()?.rootLoops.value === 1n &&
			root.counters()?.allLoops.value === 2n &&
			(root.counters()?.activeMs.value ?? 0n) >= 100n,
		"initial checkpoint aggregation",
	);
	child.process.kill("SIGSTOP");
	await waitFor(
		() => root.counters()?.anyBusy === false,
		"stopped peer removal",
		4_000,
	);
	const frozen = root.counters()?.activeMs.value;
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.equal(root.counters()?.activeMs.value, frozen);

	child.process.kill("SIGCONT");
	await waitFor(
		() => root.counters()?.anyBusy === true,
		"checkpoint recovery",
		5_000,
	);
	await waitFor(
		() => (root.counters()?.activeMs.value ?? 0n) > (frozen ?? 0n),
		"active tick resumes after recovery",
	);
	await child.command("all-loop");
	await waitFor(
		() =>
			root.counters()?.allLoops.value === 3n &&
			root.counters()?.activeLoops.value === 3n,
		"post-recovery loop",
	);

	await child.stop();
	await waitFor(
		() => root.counters()?.anyBusy === false,
		"graceful child leave",
		10_000,
	);
});

test("packed abrupt loss preserves replacement accounting and automatic Reflect", {
	timeout: 60_000,
}, async (t) => {
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-checkpoint-v3-",
	);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	const moduleUrl = pathToFileURL(
		path.join(artifact.packagePath, "dist", "process-domain.js"),
	).href;
	const extensionUrl = pathToFileURL(
		path.join(artifact.packagePath, "dist", "extension.js"),
	).href;
	const packedDomain = await import(moduleUrl);
	const packedExtension = await import(extensionUrl);
	const env = {};
	const root = packedDomain.createReflectDomainCoordinator({
		env,
		open,
		activeTickMs: 100,
	});
	const pi = new MinimalPi();
	const context = minimalContext("packed-root");
	packedExtension.createWatchdogExtension({
		processDomain: root,
		services: {
			loadConfig: async () => ({
				config: {
					rootLoopLimit: 3,
					allLoopLimit: 300,
					taskMinutes: 20,
					idleResetGapSeconds: 60,
					reflectionPrompt: "Inspect current work and return reflection XML.",
					hookPauses: [],
				},
				diagnostics: [],
			}),
		},
	})(pi);
	await pi.emit("session_start", {}, context);
	t.after(async () => {
		await pi.emit("session_shutdown", {}, context);
	});
	const declaration = env.PI_EXTENSION_UTILS_PROCESS_DOMAIN;
	assert.ok(declaration);

	const first = spawnChild(declaration, moduleUrl);
	t.after(() => first.stop());
	await first.ready();
	await first.command("busy");
	await first.command("root-loop");
	await waitFor(
		() =>
			root.counters()?.anyBusy === true &&
			root.counters()?.rootLoops.value === 1n &&
			(root.counters()?.activeMs.value ?? 0n) >= 100n &&
			(root.counters()?.taskMs.value ?? 0n) >= 100n,
		"first packed contributor",
	);
	const firstExit = once(first.process, "exit");
	first.process.kill("SIGKILL");
	await firstExit;
	await waitFor(
		() => root.counters()?.anyBusy === false,
		"first SIGKILL contributor removal",
		5_000,
	);
	assert.equal(root.counters()?.rootLoops.value, 1n);
	const frozenActiveMs = root.counters()?.activeMs.value ?? 0n;
	const frozenTaskMs = root.counters()?.taskMs.value ?? 0n;
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal(root.counters()?.activeMs.value, frozenActiveMs);
	assert.equal(root.counters()?.taskMs.value, frozenTaskMs);

	const replacement = spawnChild(declaration, moduleUrl);
	t.after(() => replacement.stop());
	await replacement.ready();
	await replacement.command("busy");
	await replacement.command("root-loop");
	await waitFor(
		() =>
			root.counters()?.anyBusy === true &&
			root.counters()?.rootLoops.value === 2n &&
			(root.counters()?.activeMs.value ?? 0n) > frozenActiveMs &&
			(root.counters()?.taskMs.value ?? 0n) > frozenTaskMs,
		"replacement packed contributor",
		5_000,
	);
	const replacementExit = once(replacement.process, "exit");
	replacement.process.kill("SIGKILL");
	await replacementExit;
	await waitFor(
		() => root.counters()?.anyBusy === false,
		"replacement SIGKILL contributor removal",
		5_000,
	);

	context.setIdle(false);
	await pi.emit("agent_start", {}, context);
	await pi.emit(
		"turn_end",
		{ message: { role: "assistant", stopReason: "stop" } },
		context,
	);
	await waitFor(
		() =>
			pi.messages.some(({ message }) =>
				String(message?.customType ?? "").endsWith(":inquiry"),
			),
		"automatic Reflect after abrupt peer loss",
	);
	const inquiry = pi.messages.findLast(({ message }) =>
		String(message?.customType ?? "").endsWith(":inquiry"),
	);
	assert.match(inquiry?.message?.content ?? "", /ROOT_LOOP_LIMIT/);
	assert.match(
		inquiry?.message?.content ?? "",
		/Branch-scoped history recovery unavailable/,
	);
	assert.deepEqual(inquiry?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});
});
