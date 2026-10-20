import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
	isPrivateReflectionRequest,
	modelConfig,
	privateReflectionPlan,
	startFakeProvider,
} from "../../scripts/e2e/fake-provider.mjs";
import {
	assertSingleWatchdogCommand,
	assertStockPi,
	createIsolatedEnvironment,
	createTestResources,
	installPackedArtifact,
	RpcPi,
	writeJson,
} from "../../scripts/e2e/harness.mjs";

async function installHookTracer({
	base,
	agentDir,
	tracePath,
	fixtureSource = "",
	watchdogPath,
}) {
	const tracerDir = path.join(base, "hook-tracer");
	await mkdir(tracerDir, { recursive: true });
	await writeFile(
		path.join(tracerDir, "package.json"),
		JSON.stringify({
			name: "watchdog-hook-tracer",
			version: "1.0.0",
			type: "module",
			pi: { extensions: ["./index.js"] },
		}),
	);
	await writeFile(
		path.join(tracerDir, "index.js"),
		`import { appendFileSync, writeFileSync } from "node:fs";
${watchdogPath ? `import registerWatchdog from ${JSON.stringify(new URL(`file://${watchdogPath}`).href)};` : ""}
export default function tracer(pi) {
  let sequence = 0;
  const tracePath = ${JSON.stringify(tracePath)};
  const submissions = [];
  const record = (kind, data) => appendFileSync(tracePath + ".actions.jsonl", JSON.stringify({ sequence: ++sequence, at: Date.now(), kind, ...data }) + "\\n");
  for (const name of ["agent_start", "agent_settled", "message_start", "message_end", "turn_end", "input"])
    pi.on(name, (event) => { record(name, { event }); });
  ${
		watchdogPath
			? `registerWatchdog(new Proxy(pi, { get(target, key) {
    if (key === "sendMessage") return (message, options) => {
      record("submission", { message, options });
      const result = target.sendMessage(message, options);
      record("accepted", { message, options });
      submissions.push({ message, options });
      writeFileSync(tracePath + ".submissions.json", JSON.stringify(submissions));
      return result;
    };
    if (key === "appendEntry") return (customType, data) => {
      const result = target.appendEntry(customType, data);
      record("entry", { customType, data });
      return result;
    };
    return Reflect.get(target, key);
  } }));
  pi.on("context", (event) => { record("context", { messages: event.messages }); });`
			: ""
	}
  pi.events.on("pi:semantic-hook:v1", (envelope) => {
    appendFileSync(tracePath, JSON.stringify(envelope) + "\\n");
  });
  pi.on("agent_settled", (_event, ctx) => {
    writeFileSync(tracePath + ".entries.json", JSON.stringify(ctx.sessionManager.getEntries()));
  });
  ${fixtureSource}
}
`,
	);
	const settingsPath = path.join(agentDir, "settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8"));
	if (watchdogPath) settings.packages = [];
	settings.packages.push(tracerDir);
	await writeJson(settingsPath, settings);
	return path.join(tracerDir, "index.js");
}

async function tracedHooks(tracePath) {
	return (await readFile(tracePath, "utf8").catch(() => ""))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
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

function providerMessageText(message) {
	return typeof message.content === "string"
		? message.content
		: (message.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
}

function requestText(request) {
	return JSON.stringify(request.body.messages);
}

/**
 * Abort boundary fixture: one slow ordinary streaming turn that emits a tool
 * call, so a manual /reflect submitted mid-stream is native-queued (steering)
 * rather than consumed.
 */
async function setupAbortFixture(
	t,
	{
		responsePlan,
		fixtureSource = "",
		images = false,
		trace = false,
		tools = "read",
		persistSession = false,
		config = { rootLoopLimit: 60, allLoopLimit: 300, taskMinutes: 20 },
	},
) {
	assertStockPi();
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-abort-boundary-",
	);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	await writeJson(
		path.join(isolated.agentDir, "pi-reflect-watchdog.json"),
		config,
	);
	const tracePath = path.join(resources.base, "semantic-hooks.jsonl");
	const extensionPath =
		trace || fixtureSource
			? await installHookTracer({
					base: resources.base,
					agentDir: isolated.agentDir,
					tracePath,
					fixtureSource,
					watchdogPath: path.join(artifact.packagePath, "src", "extension.ts"),
				})
			: path.join(artifact.packagePath, "src", "extension.ts");
	const provider = await startFakeProvider({ responsePlan });
	resources.add(() => provider.close());
	const models = modelConfig(provider.baseUrl);
	if (images)
		models.providers["watchdog-fixture"].models[0].input.push("image");
	await writeJson(path.join(isolated.agentDir, "models.json"), models);
	const rpc = new RpcPi({
		cwd: isolated.workspace,
		env: { ...isolated.env, PI_WATCHDOG_HOOK_TRACE: tracePath },
		launcherArgs: [
			"--mode",
			"rpc",
			// A private fork needs the persisted parent session file.
			...(persistSession ? [] : ["--no-session"]),
			"--tools",
			tools,
			"--provider",
			"watchdog-fixture",
			"--model",
			"watchdog-fixture",
		],
	});
	resources.add(() => rpc.close());
	await assertSingleWatchdogCommand(rpc, extensionPath);
	if (process.env.PI_WATCHDOG_ABORT_TRACE_DIR)
		resources.add(async () =>
			writeFile(
				path.join(
					process.env.PI_WATCHDOG_ABORT_TRACE_DIR,
					`${t.name.replace(/[^a-z0-9]+/gi, "-")}.json`,
				),
				JSON.stringify(
					{
						requests: provider.requests,
						events: rpc.events,
						stderr: rpc.stderr,
						actions: await tracedHooks(`${tracePath}.actions.jsonl`),
					},
					null,
					2,
				),
			),
		);
	return { provider, rpc, isolated, tracePath, artifact };
}

async function assertCancelledSilent({ provider, rpc, tracePath }, count) {
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(
		(await rpc.request({ type: "get_state" })).data.isStreaming,
		false,
	);
	assert.equal(
		provider.requests.length,
		count,
		"cancelled work adds no provider requests",
	);
	assert.deepEqual(await tracedHooks(tracePath), []);
	const entries = JSON.parse(
		await readFile(`${tracePath}.entries.json`, "utf8"),
	);
	assert.deepEqual(
		entries.filter(
			(entry) =>
				entry.customType === "pi-reflect-watchdog:reflection" ||
				entry.customType === "pi-reflect-watchdog:reflection-completed",
		),
		[],
	);
	assert.deepEqual(
		rpc.events.filter(
			({ message }) =>
				message.type === "extension_ui_request" &&
				message.method === "notify" &&
				message.notifyType === "warning" &&
				/^Reflection/.test(message.message ?? ""),
		),
		[],
	);
}

function _slowToolCallPlan({ followUps = "ordinary fixture resumed" } = {}) {
	// After the abort, the fresh user run answers with tool-call turns so the
	// agent loop keeps draining the native steering queue (one-at-a-time mode);
	// only then can a stale queued inquiry surface in a provider request.
	let postAbortTurns = 0;
	return ({ requestIndex, request }) => {
		if (requestIndex === 0)
			return {
				delay: 2_500,
				halfway: 100,
				chunks: [
					{
						tool_calls: [
							{
								index: 0,
								id: "abort-read-1",
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
		if (
			request.body.messages.some((message) =>
				providerMessageText(message).includes(
					"fresh user work after the abort",
				),
			)
		) {
			postAbortTurns += 1;
			if (postAbortTurns <= 3)
				return {
					delay: 20,
					chunks: [
						{
							tool_calls: [
								{
									index: 0,
									id: `drain-turn-${postAbortTurns}`,
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
		return { delay: 20, chunks: [{ content: followUps }] };
	};
}

test("text and image input submitted during settlement arrive intact once, fresh /reflect still completes", {
	timeout: 90_000,
}, async (t) => {
	const image = {
		type: "image",
		mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	};
	const fixture = await setupAbortFixture(t, {
		trace: true,
		images: true,
		persistSession: true,
		fixtureSource: `let delayed = false; pi.on("agent_settled", async () => { if (delayed) return; delayed = true; pi.sendMessage({ customType: "fixture:settlement-open", content: "settlement open", display: false }); await new Promise((resolve) => setTimeout(resolve, 500)); });`,
		responsePlan: privateReflectionPlan(
			{
				type: "NO_ISSUE",
				reason: "fresh valid result",
				done: "checked",
				current_step: "fresh",
				next_step: "continue",
			},
			(_request, requestIndex) =>
				requestIndex === 0
					? {
							delay: 5_000,
							halfway: 20,
							chunks: [{ content: "partial" }, { content: "unused" }],
						}
					: { delay: 20, chunks: [{ content: "ordinary response" }] },
		),
	});
	// The aborted run is ordinary work; reflection runs privately (main
	// inquiry turns are retired), so main requests exclude the child.
	const mainRequests = () =>
		provider.requests.filter((request) => !isPrivateReflectionRequest(request));
	const { provider, rpc } = fixture;
	assert.equal(
		(
			await rpc.request({
				type: "prompt",
				message: "slow ordinary work before image abort",
			})
		).success,
		true,
	);
	await waitForProviderRequests(provider, 1);
	const abort = rpc.request({ type: "abort" });
	await rpc.waitFor(
		(message) =>
			message.type === "message_start" &&
			message.message?.customType === "fixture:settlement-open",
		20_000,
	);
	const reentry = rpc.request({
		type: "prompt",
		message: "exact text with image after abort",
		images: [image],
	});
	assert.equal((await abort).success, true);
	assert.equal((await reentry).success, true);
	await waitForProviderRequests(provider, 2);
	const after = performance.now();
	await rpc.waitFor(
		(message, at) => at > after - 100 && message.type === "agent_settled",
		20_000,
	);
	assert.equal(provider.requests.length, 2);
	const payload = provider.requests[1].body.messages;
	assert.equal(
		payload.filter((message) =>
			providerMessageText(message).includes(
				"exact text with image after abort",
			),
		).length,
		1,
	);
	const images = payload
		.flatMap((message) =>
			typeof message.content === "string" ? [] : message.content,
		)
		.filter((block) => block.type === "image_url");
	assert.deepEqual(images, [
		{
			type: "image_url",
			image_url: { url: `data:${image.mimeType};base64,${image.data}` },
		},
	]);
	assert.doesNotMatch(
		requestText(provider.requests[1]),
		/Trigger source\(s\): USER_REQUEST/,
	);
	assert.deepEqual(await tracedHooks(fixture.tracePath), []);
	const freshAt = performance.now();
	assert.equal(
		(
			await rpc.request({
				type: "prompt",
				message: "/reflect fresh after image",
			})
		).success,
		true,
	);
	const deadline = performance.now() + 30_000;
	while (mainRequests().length < 3 && performance.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 20));
	await rpc.waitFor(
		(message, at) =>
			at > freshAt &&
			message.type === "agent_settled" &&
			mainRequests().length === 3,
		20_000,
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(
		mainRequests().length,
		3,
		"fresh result creates exactly one ordinary continuation",
	);
	assert.equal((await tracedHooks(fixture.tracePath)).length, 1);
	const child = provider.requests.find(isPrivateReflectionRequest);
	assert.match(requestText(child), /fresh after image/);
	assert.doesNotMatch(
		requestText(mainRequests()[2]),
		/Trigger source\(s\): USER_REQUEST|private_inquiry_result_file/,
	);
});

test("packed stock Pi ordinary abort freezes all-idle clocks", {
	timeout: 60_000,
}, async (t) => {
	const fixture = await setupAbortFixture(t, {
		trace: true,
		responsePlan: () => ({
			delay: 5000,
			halfway: 20,
			chunks: [{ content: "partial work" }],
		}),
	});
	const { provider, rpc } = fixture;
	await rpc.request({
		type: "prompt",
		message: "ordinary work then stop",
	});
	await waitForProviderRequests(provider, 1);
	await rpc.request({ type: "abort" });
	await rpc.waitFor((message) => message.type === "agent_settled", 10_000);
	const statuses = () =>
		rpc.events
			.map(({ message }) => message)
			.filter(
				(message) =>
					message.type === "extension_ui_request" &&
					message.method === "setStatus",
			)
			.map(({ statusText }) => statusText);
	const frozen = statuses().at(-1);
	assert.match(frozen ?? "", /active 0s\/0 loops.*task 0s\//);
	const start = statuses().length;
	await new Promise((resolve) => setTimeout(resolve, 2400));
	assert.ok(
		statuses()
			.slice(start)
			.every((status) => status === frozen),
		"authoritative all-idle settlement stops clock cadence, not only dispatch",
	);
	await assertCancelledSilent(fixture, 1);
});
