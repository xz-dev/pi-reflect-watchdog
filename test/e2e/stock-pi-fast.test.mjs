import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	access,
	lstat,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
	modelConfig,
	startFakeProvider,
} from "../../scripts/e2e/fake-provider.mjs";
import {
	assertStockPiDependencyShape,
	createGitFixture,
	installGitPackage,
	MASTER_FIXTURE_ALLOWLIST,
	managedGitPath,
	tryInstallGitPackage,
} from "../../scripts/e2e/git-fixture.mjs";
import {
	assertSingleWatchdogCommand,
	assertStockPi,
	createIsolatedEnvironment,
	createTestResources,
	installPackedArtifact,
	RpcPi,
	runBoundedProcess,
	writeJson,
} from "../../scripts/e2e/harness.mjs";

async function missing(target) {
	try {
		await access(target);
		return false;
	} catch {
		return true;
	}
}

function processExists(pid) {
	try {
		execFileSync("kill", ["-0", String(pid)], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function waitForProviderRequests(provider, count, timeoutMs = 10_000) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (provider.requests.length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(
		`Provider received ${provider.requests.length}/${count} requests within ${timeoutMs}ms`,
	);
}

async function waitForProviderResponse(record, timeoutMs = 10_000) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (record.finishedAt !== undefined) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Provider response did not finish within ${timeoutMs}ms`);
}

function warningPlan({ requestIndex }) {
	if (requestIndex === 0) {
		return {
			delay: 20,
			chunks: [
				{
					tool_calls: [
						{
							index: 0,
							id: "ordinary-read-1",
							type: "function",
							function: {
								name: "read",
								arguments: '{"path":"package.json","limit":1,"offset":1}',
							},
						},
					],
				},
			],
			finishReason: "tool_calls",
		};
	}
	if (requestIndex === 1) {
		return {
			delay: 20,
			chunks: [
				{
					tool_calls: [
						{
							index: 0,
							id: "ordinary-read-2",
							type: "function",
							function: {
								name: "read",
								arguments: '{"path":"README.md","limit":1,"offset":1}',
							},
						},
					],
				},
			],
			finishReason: "tool_calls",
		};
	}
	return {
		delay: 20,
		chunks: [
			{
				content:
					"fixture complete\n<reflection><type>NO_ISSUE</type><reason>route is sound</reason><done>fixture checked</done><current_step>finish</current_step><next_step>stop</next_step></reflection>",
			},
		],
	};
}

test("the installed packed tarball loads dist with only the reflect command", async (t) => {
	assertStockPi();
	const resources = await createTestResources(t);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	const packagedManifest = await import(
		path.join(artifact.packagePath, "package.json"),
		{ with: { type: "json" } }
	);
	assert.equal(
		assertStockPiDependencyShape(packagedManifest.default),
		true,
		"packed artifact declares only Pi aliases as direct peers",
	);
	const rpc = new RpcPi({ cwd: isolated.workspace, env: isolated.env });
	resources.add(() => rpc.close());
	await assertSingleWatchdogCommand(
		rpc,
		path.join(artifact.packagePath, "dist", "extension.js"),
	);
	const commands = await rpc.request({ type: "get_commands" });
	assert.deepEqual(
		commands.data.commands
			.filter((command) =>
				command.sourceInfo?.path?.includes("pi-reflect-watchdog"),
			)
			.map((command) => command.name),
		["reflect"],
	);
});

test("packed stock Pi semantic hook pause suppresses then resumes automatic reflection", {
	timeout: 60_000,
}, async (t) => {
	assertStockPi();
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-hook-pause-",
	);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	await writeJson(path.join(isolated.agentDir, "pi-reflect-watchdog.json"), {
		rootLoopLimit: 1,
		allLoopLimit: 500,
		taskMinutes: 30,
		hookPauses: [{ pause: "fixture-pause", resume: "fixture-resume" }],
	});
	const producerDir = path.join(resources.base, "hook-producer");
	await mkdir(producerDir, { recursive: true });
	await writeFile(
		path.join(producerDir, "package.json"),
		JSON.stringify({
			name: "watchdog-hook-producer",
			version: "1.0.0",
			type: "module",
			pi: { extensions: ["./index.js"] },
			dependencies: {
				"pi-extension-utils":
					"git+https://github.com/xz-dev/pi-extension-utils.git#fc15bcfa8bc2f5ad56fe5db69137c9a0e29fb6b0",
			},
		}),
	);
	await writeFile(
		path.join(producerDir, "index.js"),
		`import { publishSemanticHook } from "pi-extension-utils/semantic-hook";
export default function producer(pi) {
  pi.registerCommand("fixture-hook", {
    description: "publish a fixture semantic hook",
    handler(args) { publishSemanticHook(pi.events, { name: args.trim() }); },
  });
}
`,
	);
	const utilityTarball = process.env.PI_EXTENSION_UTILS_E2E_TARBALL;
	assert.ok(utilityTarball, "PI_EXTENSION_UTILS_E2E_TARBALL is required");
	const result = await runBoundedProcess(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--prefix",
			producerDir,
			utilityTarball,
		],
		{ timeoutMs: 120_000 },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		(
			await lstat(path.join(producerDir, "node_modules", "pi-extension-utils"))
		).isSymbolicLink(),
		false,
	);
	const settingsPath = path.join(isolated.agentDir, "settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8"));
	settings.packages.push(producerDir);
	await writeJson(settingsPath, settings);

	const provider = await startFakeProvider({ responsePlan: warningPlan });
	resources.add(() => provider.close());
	await writeJson(
		path.join(isolated.agentDir, "models.json"),
		modelConfig(provider.baseUrl),
	);
	const rpc = new RpcPi({
		cwd: isolated.workspace,
		env: isolated.env,
		args: ["--provider", "watchdog-fixture", "--model", "watchdog-fixture"],
		launcherArgs: ["--mode", "rpc", "--no-session"],
	});
	resources.add(() => rpc.close());
	await assertSingleWatchdogCommand(
		rpc,
		path.join(artifact.packagePath, "dist", "extension.js"),
	);
	await new Promise((resolve) => setTimeout(resolve, 500));
	await rpc.request({ type: "prompt", message: "/fixture-hook fixture-pause" });
	await new Promise((resolve) => setTimeout(resolve, 200));
	provider.requests.length = 0;
	await rpc.request({
		type: "prompt",
		message: "Complete one ordinary tool round while fixture pause is active.",
	});
	await waitForProviderRequests(provider, 2);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(
		provider.requests.some((request) =>
			JSON.stringify(request.body.messages).includes("Trigger source(s):"),
		),
		false,
		"paused threshold emitted no reflection",
	);
	const pausedRequestCount = provider.requests.length;
	await rpc.request({
		type: "prompt",
		message: "/fixture-hook fixture-resume",
	});
	await new Promise((resolve) => setTimeout(resolve, 200));
	await rpc.request({
		type: "prompt",
		message: "Complete another ordinary event after fixture resume.",
	});
	const reflectionDeadline = performance.now() + 10_000;
	let reflection;
	while (performance.now() < reflectionDeadline) {
		reflection = provider.requests.find((request) =>
			JSON.stringify(request.body.messages).includes(
				"Trigger source(s): ROOT_LOOP_LIMIT",
			),
		);
		if (reflection) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.ok(reflection, "resume dispatched one qualifying reflection");
	assert.equal(
		provider.requests
			.slice(pausedRequestCount)
			.filter((request) =>
				JSON.stringify(request.body.messages).includes(
					"Trigger source(s): ROOT_LOOP_LIMIT",
				),
			).length,
		1,
		"resume dispatches exactly one qualifying reflection",
	);
});

test("packed stock Pi sends a root-loop reflection to its continuation provider request", {
	timeout: 45_000,
}, async (t) => {
	assertStockPi();
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-provider-warning-",
	);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	await writeJson(path.join(isolated.agentDir, "pi-reflect-watchdog.json"), {
		rootLoopLimit: 2,
		allLoopLimit: 500,
		taskMinutes: 30,
	});
	const provider = await startFakeProvider({ responsePlan: warningPlan });
	resources.add(() => provider.close());
	await writeJson(
		path.join(isolated.agentDir, "models.json"),
		modelConfig(provider.baseUrl),
	);
	const rpc = new RpcPi({
		cwd: isolated.workspace,
		env: isolated.env,
		args: ["--provider", "watchdog-fixture", "--model", "watchdog-fixture"],
		launcherArgs: ["--mode", "rpc", "--no-session"],
	});
	resources.add(() => rpc.close());
	await assertSingleWatchdogCommand(
		rpc,
		path.join(artifact.packagePath, "dist", "extension.js"),
	);

	const accepted = await rpc.request({
		type: "prompt",
		message:
			"Complete this ordinary fixture task without mentioning watchdogs.",
	});
	assert.equal(accepted.success, true);
	await waitForProviderRequests(provider, 2);
	const warningMarker = "Trigger source(s): ROOT_LOOP_LIMIT";
	const initialRequests = provider.requests.slice(0, 2);
	for (const request of initialRequests) {
		const messages = JSON.stringify(request.body.messages);
		assert.doesNotMatch(
			messages,
			new RegExp(warningMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			"tool round requests contain no watchdog reminder before the threshold",
		);
	}
	await waitForProviderRequests(provider, 3);
	const continuation = provider.requests[2];
	const continuationMessages = JSON.stringify(continuation.body.messages);
	// This provider request is the authoritative agent-facing seam.
	assert.match(
		continuationMessages,
		new RegExp(warningMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
	);
	assert.match(
		continuationMessages,
		/Threshold snapshot: active=\d+ms\/2 loops; task=\d+ms\/30m; root=2\/2; all=2\/500/,
	);
	assert.ok(
		continuation.startedAt >= initialRequests[1].finishedAt,
		"the reflection provider request starts after the ordinary tool round",
	);
	await waitForProviderResponse(continuation);
	await rpc.waitFor((message) => message.type === "agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal(
		provider.requests.length,
		4,
		"stock Pi performs one terminal continuation after the internal response",
	);
	const terminalMessages = JSON.stringify(provider.requests[3].body.messages);
	assert.doesNotMatch(
		terminalMessages,
		/Your previous reflection response was invalid/,
		"the terminal continuation is not a recursive XML re-ask",
	);
	const last = await rpc.request({ type: "get_last_assistant_text" });
	assert.equal(
		last.data.text ?? "",
		"",
		"the internal NO_ISSUE reflection response is not visible as assistant output",
	);
});

test("packed stock Pi hides reflection XML and applies a correction without user input", {
	timeout: 45_000,
}, async (t) => {
	assertStockPi();
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-correction-",
	);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	await writeJson(path.join(isolated.agentDir, "pi-reflect-watchdog.json"), {
		rootLoopLimit: 100,
		allLoopLimit: 500,
		taskMinutes: 30,
	});
	const reflectionXml =
		"<reflection><type>ROUTE_CORRECTION</type><reason>change route</reason><done>checked</done><current_step>pause</current_step><next_step>apply corrected route</next_step></reflection>";
	const provider = await startFakeProvider({
		responsePlan: ({ requestIndex }) => ({
			delay: 20,
			chunks: [
				{
					content:
						requestIndex === 0
							? reflectionXml
							: "correction applied automatically",
				},
			],
		}),
	});
	resources.add(() => provider.close());
	await writeJson(
		path.join(isolated.agentDir, "models.json"),
		modelConfig(provider.baseUrl),
	);
	const rpc = new RpcPi({
		cwd: isolated.workspace,
		env: isolated.env,
		launcherArgs: [
			"--mode",
			"rpc",
			"--no-tools",
			"--provider",
			"watchdog-fixture",
			"--model",
			"watchdog-fixture",
		],
	});
	resources.add(() => rpc.close());
	await assertSingleWatchdogCommand(
		rpc,
		path.join(artifact.packagePath, "dist", "extension.js"),
	);

	const accepted = await rpc.request({
		type: "prompt",
		message: "/reflect inspect the current route",
	});
	assert.equal(accepted.success, true);
	await waitForProviderRequests(provider, 2);
	await waitForProviderResponse(provider.requests[1]);
	await rpc.waitFor((message) => message.type === "agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(
		provider.requests.length,
		2,
		"the correction starts exactly one ordinary turn without a user prompt",
	);
	const continuationMessages = JSON.stringify(
		provider.requests[1].body.messages,
	);
	assert.match(continuationMessages, /Continue the current task/);
	assert.match(continuationMessages, /Do not emit reflection XML/);
	assert.match(continuationMessages, /Next step: apply corrected route/);
	assert.equal(
		provider.requests[1].body.messages.some(
			(message) => message.role === "assistant",
		),
		false,
		"the internal reflection assistant is replaced before the next request",
	);
	assert.equal(
		continuationMessages.includes(reflectionXml),
		false,
		"the raw reflection XML is absent from the next provider request",
	);
	const last = await rpc.request({ type: "get_last_assistant_text" });
	assert.equal(last.data.text, "correction applied automatically");

	const sessionDirectory = isolated.env.PI_CODING_AGENT_SESSION_DIR;
	const sessionFiles = (await readdir(sessionDirectory, { recursive: true }))
		.filter((entry) => entry.endsWith(".jsonl"))
		.map((entry) => path.join(sessionDirectory, entry));
	assert.equal(sessionFiles.length, 1);
	const entries = (await readFile(sessionFiles[0], "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const assistantText = entries
		.filter(
			(entry) =>
				entry.type === "message" && entry.message?.role === "assistant",
		)
		.flatMap((entry) => entry.message.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	assert.doesNotMatch(assistantText, /<reflection>/i);
	assert.match(assistantText, /correction applied automatically/);
	assert.equal(
		entries.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "pi-reflect-watchdog:route-correction",
		).length,
		1,
	);
});

test("stock Pi loads global and trusted-project watchdog configuration", async (t) => {
	const resources = await createTestResources(t);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	await writeJson(path.join(isolated.agentDir, "pi-reflect-watchdog.json"), {
		rootLoopLimit: 17,
		allLoopLimit: 19,
		taskMinutes: 23,
	});
	await writeJson(
		path.join(isolated.workspace, ".pi", "pi-reflect-watchdog.json"),
		{
			rootLoopLimit: 29,
		},
	);

	const rpc = new RpcPi({
		cwd: isolated.workspace,
		env: isolated.env,
		args: ["--approve"],
	});
	resources.add(() => rpc.close());
	await assertSingleWatchdogCommand(
		rpc,
		path.join(artifact.packagePath, "dist", "extension.js"),
	);
	const accepted = await rpc.request({
		type: "prompt",
		message: "/reflect verify layered configuration",
	});
	assert.equal(accepted.success, true);
});

test("stock Pi installs master from an actual local Git remote with the exact source path", async (t) => {
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-git-e2e-",
	);
	const fixture = await createGitFixture(resources.base);
	resources.add(() => fixture.stop());
	const isolated = await createIsolatedEnvironment(resources.base, "master");
	await installGitPackage({
		source: fixture.masterSource,
		cwd: isolated.workspace,
		env: isolated.env,
	});
	const managed = managedGitPath(isolated.agentDir);
	const rpc = new RpcPi({ cwd: isolated.workspace, env: isolated.env });
	resources.add(() => rpc.close());
	const entry = path.join(managed, "src", "extension.ts");
	await assertSingleWatchdogCommand(rpc, entry);
	const commands = await rpc.request({ type: "get_commands" });
	const watchdog = commands.data.commands.find(
		(command) => command.name === "reflect",
	);
	assert.equal(watchdog.sourceInfo.path, entry);
	const tracked = execFileSync(
		"git",
		["ls-tree", "-r", "--name-only", "HEAD"],
		{ cwd: managed, encoding: "utf8" },
	)
		.trim()
		.split("\n")
		.filter(Boolean)
		.sort();
	assert.deepEqual(tracked, MASTER_FIXTURE_ALLOWLIST);
});

test("failed stock Git installation is bounded and resource cleanup removes its checkout and daemon", async (t) => {
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-git-failure-",
	);
	const fixture = await createGitFixture(resources.base);
	resources.add(() => fixture.stop());
	const isolated = await createIsolatedEnvironment(resources.base, "invalid");
	const started = performance.now();
	const result = await tryInstallGitPackage({
		source: fixture.invalidInstallSource,
		cwd: isolated.workspace,
		env: isolated.env,
		timeoutMs: 60_000,
	});
	assert.notEqual(result.status, 0, "invalid Git install must fail");
	assert.ok(
		performance.now() - started < 62_000,
		"invalid Git install remains bounded",
	);
	assert.match(
		`${result.stdout}\n${result.stderr}`,
		/pi-reflect-watchdog-e2e-not-a-real-package|E404|install failed/i,
	);
	await resources.cleanup();
	assert.equal(
		await missing(resources.base),
		true,
		"temporary root is removed",
	);
	assert.equal(
		processExists(fixture.daemonPid),
		false,
		"git daemon is stopped",
	);
});
