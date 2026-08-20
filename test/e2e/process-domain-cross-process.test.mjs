import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { openProcessDomain } from "pi-extension-utils/process-domain";
import { createReflectDomainCoordinator } from "../../dist/process-domain.js";
import { ROOT } from "../../scripts/e2e/harness.mjs";

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

function spawnChild(declaration) {
	const child = fork(path.join(ROOT, "test/e2e/process-domain-child.mjs"), {
		cwd: ROOT,
		env: {
			...process.env,
			PI_EXTENSION_UTILS_PROCESS_DOMAIN: declaration,
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

test("real process transport preserves reflect-owned state across heartbeat recovery", {
	timeout: 20_000,
}, async (t) => {
	const env = {};
	const root = createReflectDomainCoordinator({
		env,
		open,
		activeTickMs: 100,
		idleResetGapMs: 300,
	});
	const instance = {};
	await root.attach(instance, { getBusy: () => false, onFatal() {} });
	t.after(() => root.detach(instance));
	const declaration = env.PI_EXTENSION_UTILS_PROCESS_DOMAIN;
	assert.ok(declaration);
	const child = spawnChild(declaration);
	t.after(() => child.stop());
	await child.ready();
	await child.command("idle");
	await waitFor(
		() => root.counters()?.certain === true,
		"initial child activity acknowledgement",
	);

	await child.command("root-loop");
	await child.command("all-loop");
	await waitFor(
		() =>
			root.counters()?.rootLoops.value === 1n &&
			root.counters()?.allLoops.value === 2n,
		"cross-process loop aggregation",
	);

	await child.command("busy");
	await waitFor(
		() => (root.counters()?.activeMs.value ?? 0n) >= 100n,
		"cross-process active tick",
	);
	child.process.kill("SIGSTOP");
	await waitFor(
		() => root.counters()?.certain === false,
		"heartbeat uncertainty",
		4_000,
	);
	const frozen = root.counters()?.activeMs.value;
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.equal(root.counters()?.activeMs.value, frozen);

	child.process.kill("SIGCONT");
	await waitFor(
		() => root.counters()?.certain === true,
		"fresh activity after heartbeat recovery",
		5_000,
	);
	await waitFor(
		() => (root.counters()?.activeMs.value ?? 0n) > (frozen ?? 0n),
		"active tick resumes after recovery",
	);

	const activeBeforeReflection = root.counters()?.activeMs.value;
	const reset = await root.pause();
	assert.equal(reset?.rootLoops.value, 1n);
	assert.equal(reset?.allLoops.value, 2n);
	assert.ok((reset?.taskMs.value ?? 0n) > 0n);
	assert.equal(reset?.activeMs.value, activeBeforeReflection);
	assert.equal(reset?.activeLoops.value, 2n);
	assert.equal(reset?.rootLoops.paused, true);
	await child.command("all-loop");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(root.counters()?.allLoops.value, 2n);
	assert.equal(root.counters()?.activeLoops.value, 2n);
	await root.resume();
	await child.command("idle");
	await child.command("all-loop");
	await waitFor(
		() =>
			root.counters()?.allLoops.value === 3n &&
			root.counters()?.activeLoops.value === 3n,
		"post-resume loop",
	);

	const revisionBeforeLeave = root.counters()?.revision;
	await child.stop();
	await waitFor(
		() =>
			root.counters()?.certain === true &&
			revisionBeforeLeave !== undefined &&
			root.counters()?.revision > revisionBeforeLeave,
		"graceful child leave",
		10_000,
	);
});
