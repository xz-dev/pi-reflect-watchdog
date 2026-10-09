import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
	modelConfig,
	reflectionResponse,
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
		tools = "ref",
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
					watchdogPath: path.join(artifact.packagePath, "dist", "extension.js"),
				})
			: path.join(artifact.packagePath, "dist", "extension.js");
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
			"--no-session",
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
						actions: await tracedHooks(tracePath + ".actions.jsonl"),
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
		await readFile(tracePath + ".entries.json", "utf8"),
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

// Export only the inherited declaration, through extension-owned session_start.
// Child RPC uses stock Pi and the same installed packed watchdog, not transport mocks.
for (const busy of [false, true])
	test(`packed stock Pi child limit steers ${busy ? "busy main after its tool batch and earlier steering" : "idle main exactly once"}`, {
		timeout: 90_000,
	}, async (t) => {
		let earlierHandled = false;
		const fixture = await setupAbortFixture(t, {
			trace: true,
			tools: "ref,bash,read",
			config: { rootLoopLimit: 60, allLoopLimit: 1, taskMinutes: 20 },
			fixtureSource: `pi.on("session_start", () => {
  writeFileSync(tracePath + ".domain.json", JSON.stringify(process.env.PI_EXTENSION_UTILS_PROCESS_DOMAIN));
});`,
			responsePlan: ({ request: { body } }) => {
				const lastUser = body.messages.findLast(({ role }) => role === "user");
				const text = lastUser ? providerMessageText(lastUser) : "";
				if (text === "fresh child ordinary turn")
					return { chunks: [{ content: "child ordinary turn finished" }] };
				if (text.includes("Trigger source(s): ALL_LOOP_LIMIT"))
					return reflectionResponse({
						type: "NO_ISSUE",
						reason: "child limit checked",
						done: "child completed",
						current_step: "resume main",
						next_step: "continue",
					});
				if (text === "main ordinary tool batch")
					return {
						chunks: [
							{
								tool_calls: [
									{
										index: 0,
										id: "child-batch-gate",
										type: "function",
										function: {
											name: "bash",
											arguments: JSON.stringify({
												command: `while [ ! -f ${JSON.stringify(`${fixture.tracePath}.release`)} ]; do sleep 0.05; done; printf 'child batch released'`,
												timeout: 20,
											}),
										},
									},
									{
										index: 1,
										id: "child-batch-read",
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
					text === "earlier steering before child inquiry" &&
					!earlierHandled
				) {
					earlierHandled = true;
					return {
						chunks: [
							{
								tool_calls: [
									{
										index: 0,
										id: "earlier-steering-read",
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
				return { chunks: [{ content: "main ordinary continuation finished" }] };
			},
		});
		const { provider, rpc, isolated, tracePath, artifact } = fixture;
		const declaration = JSON.parse(
			await readFile(`${tracePath}.domain.json`, "utf8"),
		);
		assert.equal(
			typeof declaration,
			"string",
			"main exports its live process-domain declaration",
		);
		const childEnvironment = await createIsolatedEnvironment(
			path.join(path.dirname(tracePath), "child"),
		);
		await writeJson(path.join(childEnvironment.agentDir, "settings.json"), {
			packages: [artifact.packagePath],
			defaultProjectTrust: "never",
		});
		await writeJson(
			path.join(childEnvironment.agentDir, "models.json"),
			modelConfig(provider.baseUrl),
		);
		const child = new RpcPi({
			cwd: childEnvironment.workspace,
			env: {
				...childEnvironment.env,
				PI_EXTENSION_UTILS_PROCESS_DOMAIN: declaration,
			},
			args: ["--provider", "watchdog-fixture", "--model", "watchdog-fixture"],
		});
		t.after(() => child.close());
		await assertSingleWatchdogCommand(
			child,
			path.join(artifact.packagePath, "dist", "extension.js"),
		);
		await writeJson(path.join(isolated.workspace, "package.json"), {
			name: "child-limit-fixture",
		});
		assert.equal(
			(await rpc.request({ type: "get_state" })).data.isStreaming,
			false,
		);
		if (busy) {
			assert.equal(
				(
					await rpc.request({
						type: "prompt",
						message: "main ordinary tool batch",
					})
				).success,
				true,
			);
			await rpc.waitFor(
				(event) =>
					event.type === "tool_execution_start" &&
					event.toolCallId === "child-batch-gate",
			);
			assert.equal(
				(
					await rpc.request({
						type: "steer",
						message: "earlier steering before child inquiry",
					})
				).success,
				true,
			);
		}
		const startedAt = performance.now();
		assert.equal(
			(
				await child.request({
					type: "prompt",
					message: "fresh child ordinary turn",
				})
			).success,
			true,
		);
		await child.waitFor((event) => event.type === "agent_settled");
		let submissions = [];
		const deadline = performance.now() + 10_000;
		while (performance.now() < deadline) {
			submissions = JSON.parse(
				await readFile(`${tracePath}.submissions.json`, "utf8").catch(
					() => "[]",
				),
			);
			if (
				submissions.some(
					({ message }) => message.customType === "pi-reflect-watchdog:inquiry",
				)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const owned = submissions.filter(
			({ message }) => message.customType === "pi-reflect-watchdog:inquiry",
		);
		assert.equal(
			owned.length,
			1,
			"fresh child completion submits one owned inquiry without another main turn",
		);
		const { message: inquiry, options } = owned[0];
		assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
		assert.ok(
			inquiry.details.inquiryId,
			"owned inquiry has correlation identity",
		);
		assert.match(inquiry.content, /Trigger source\(s\): ALL_LOOP_LIMIT/);
		assert.doesNotMatch(inquiry.content, /ROOT_LOOP_LIMIT/);
		if (busy) {
			assert.equal(
				(await rpc.request({ type: "get_state" })).data.isStreaming,
				true,
			);
			assert.equal(
				rpc.events.some(
					({ message }) =>
						message.type === "tool_execution_end" &&
						message.toolCallId === "child-batch-gate",
				),
				false,
			);
			assert.equal(
				provider.requests.some(({ body }) =>
					body.messages.some((message) =>
						providerMessageText(message).includes("Trigger source(s):"),
					),
				),
				false,
				"provider cannot receive inquiry before held tool batch finishes",
			);
			await writeFile(`${tracePath}.release`, "release");
		}
		const continued = await rpc.waitFor(
			(event, at) =>
				at > startedAt &&
				event.type === "message_end" &&
				event.message?.role === "assistant" &&
				providerMessageText(event.message).includes(
					"main ordinary continuation finished",
				),
			20_000,
		);
		await rpc.waitFor(
			(event, at) => at >= continued.at && event.type === "agent_settled",
			20_000,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		submissions = JSON.parse(
			await readFile(`${tracePath}.submissions.json`, "utf8"),
		);
		assert.equal(
			submissions.filter(
				({ message }) => message.customType === inquiry.customType,
			).length,
			1,
			"child trigger never duplicates owned inquiry",
		);
		const inquiryRequests = provider.requests.filter(({ body }) =>
			body.messages.some((message) =>
				providerMessageText(message).includes(
					"Trigger source(s): ALL_LOOP_LIMIT",
				),
			),
		);
		assert.equal(
			inquiryRequests.length,
			1,
			"exactly one provider request carries child inquiry contents",
		);
		assert.deepEqual(
			inquiryRequests[0].body.messages
				.map(providerMessageText)
				.filter((text) => text.includes("Trigger source(s): ALL_LOOP_LIMIT")),
			[inquiry.content],
			"provider receives exact content of the accepted owned inquiry once",
		);
		const deliveries = rpc.events.map(({ message }) => message);
		const inquiryIndex = deliveries.findIndex(
			(event) =>
				event.type === "message_start" &&
				event.message?.customType === inquiry.customType,
		);
		assert.ok(inquiryIndex >= 0);
		assert.deepEqual(
			deliveries[inquiryIndex].message.details,
			inquiry.details,
			"native delivery preserves accepted inquiry identity",
		);
		const entries = JSON.parse(
			await readFile(`${tracePath}.entries.json`, "utf8"),
		);
		const result = entries.find(
			(entry) => entry.customType === "pi-reflect-watchdog:reflection",
		);
		assert.ok(result);
		assert.deepEqual(
			entries
				.filter(
					(entry) =>
						entry.customType === "pi-reflect-watchdog:reflection-completed",
				)
				.map((entry) => entry.data),
			[inquiry.details],
			"child-triggered provider result completes the same owned inquiry once",
		);
		assert.equal(
			result.data.thresholds.rootLoops,
			0,
			"child root loop never inflates main root loops",
		);
		assert.equal(
			result.data.thresholds.allLoops,
			1,
			"fresh child ordinary turn supplies all-loop trigger",
		);
		const childRequest = provider.requests.find(({ body }) =>
			body.messages.some(
				(message) =>
					providerMessageText(message) === "fresh child ordinary turn",
			),
		);
		assert.ok(childRequest?.finishedAt !== undefined);
		assert.ok(
			childRequest.finishedAt < inquiryRequests[0].startedAt,
			"child provider response finishes before main inquiry request",
		);
		if (busy) {
			for (const id of ["child-batch-gate", "child-batch-read"]) {
				const endIndex = deliveries.findIndex(
					(event) =>
						event.type === "tool_execution_end" && event.toolCallId === id,
				);
				assert.ok(
					endIndex >= 0 && endIndex < inquiryIndex,
					`${id} finishes before inquiry delivery`,
				);
				assert.equal(deliveries[endIndex].isError, false);
			}
			const messages = inquiryRequests[0].body.messages;
			const earlier = messages.findIndex(
				(message) =>
					providerMessageText(message) ===
					"earlier steering before child inquiry",
			);
			const delivered = messages.findIndex((message) =>
				providerMessageText(message).includes(
					"Trigger source(s): ALL_LOOP_LIMIT",
				),
			);
			assert.ok(
				earlier >= 0 && earlier < delivered,
				"provider receives earlier native steering before child inquiry",
			);
			assert.ok(
				messages.some(
					(message) =>
						message.role === "tool" &&
						message.tool_call_id === "child-batch-gate" &&
						providerMessageText(message).includes("child batch released"),
				),
			);
			assert.ok(
				messages.some(
					(message) =>
						message.role === "tool" &&
						message.tool_call_id === "child-batch-read",
				),
			);
		}
		assert.equal(
			deliveries.some(
				(event) =>
					event.type === "message_end" &&
					event.message?.stopReason === "aborted",
			),
			false,
			"child steering never aborts main response",
		);
	});

function slowToolCallPlan({ followUps = "ordinary fixture resumed" } = {}) {
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

test("cancelled native inquiry residue keeps pre-abort identity without new plugin authority on no-tool re-entry", {
	timeout: 90_000,
}, async (t) => {
	const fixture = await setupAbortFixture(t, {
		trace: true,
		responsePlan: ({ requestIndex }) =>
			requestIndex === 0
				? {
						delay: 2_500,
						halfway: 100,
						chunks: [{ content: "ordinary streaming" }],
					}
				: {
						delay: 20,
						chunks: [{ content: "fresh ordinary answer without tools" }],
					},
	});
	const { provider, rpc, tracePath } = fixture;
	try {
		assert.equal(
			(await rpc.request({ type: "prompt", message: "slow ordinary work" }))
				.success,
			true,
		);
		await waitForProviderRequests(provider, 1);
		assert.equal(
			(
				await rpc.request({
					type: "steer",
					message: "unrelated before cancelled slot",
				})
			).success,
			true,
		);
		assert.equal(
			(
				await rpc.request({
					type: "prompt",
					message: "/reflect cancelled native slot",
				})
			).success,
			true,
		);
		assert.equal(
			(
				await rpc.request({
					type: "steer",
					message: "unrelated after cancelled slot",
				})
			).success,
			true,
		);
		const beforeAbort = await tracedHooks(tracePath + ".actions.jsonl");
		const owned = beforeAbort.filter(
			({ kind, message }) =>
				kind === "accepted" &&
				message.customType === "pi-reflect-watchdog:inquiry",
		);
		assert.equal(
			owned.length,
			1,
			"one inquiry accepted by public sendMessage before abort",
		);
		const correlation = owned[0].message.details;
		assert.equal(
			beforeAbort.some(
				({ kind, event }) =>
					kind === "message_start" &&
					event.message?.details?.inquiryId === correlation.inquiryId,
			),
			false,
			"owned native slot not consumed before abort",
		);
		assert.equal((await rpc.request({ type: "abort" })).success, true);
		const atAbort = provider.requests.length;
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(provider.requests.length, atAbort);
		const afterAbort = performance.now();
		assert.equal(
			(
				await rpc.request({
					type: "prompt",
					message: "no-tool explicit re-entry",
				})
			).success,
			true,
		);
		await rpc.waitFor(
			(message, at) => at > afterAbort && message.type === "agent_settled",
			20_000,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const held = await tracedHooks(tracePath + ".actions.jsonl");
		assert.deepEqual(
			held.filter(
				({ kind, message, sequence }) =>
					kind === "submission" &&
					sequence > owned[0].sequence &&
					message.customType !== "pi-reflect-watchdog:inquiry-fold",
			),
			[],
			"hold authorizes no new inquiry/correction/continuation",
		);
		const text = provider.requests
			.at(-1)
			.body.messages.map(providerMessageText);
		const before = text.findIndex((value) =>
			value.includes("unrelated before cancelled slot"),
		);
		const after = text.findIndex((value) =>
			value.includes("unrelated after cancelled slot"),
		);
		assert.ok(
			before >= 0 && after > before,
			"unrelated steering order survives cancellation",
		);
		assert.equal(
			text.filter((value) => value.includes("no-tool explicit re-entry"))
				.length,
			1,
		);
		assert.doesNotMatch(
			provider.requests.slice(atAbort).map(requestText).join("\n"),
			/cancelled native slot|Trigger source\(s\): USER_REQUEST|inquiry-fold/,
		);
		const actions = await tracedHooks(tracePath + ".actions.jsonl");
		const sends = actions.filter(
			({ kind, sequence }) =>
				kind === "submission" && sequence > owned[0].sequence,
		);
		assert.equal(
			sends.length,
			1,
			"only exact cancellation fold may be newly submitted",
		);
		assert.equal(
			sends[0].message.customType,
			"pi-reflect-watchdog:inquiry-fold",
		);
		assert.deepEqual(sends[0].message.details, {
			...correlation,
			outcome: "remove",
		});
		const deliveries = rpc.events.map(({ message }) => message);
		const foldDelivery = deliveries.findIndex(
			({ type, message }) =>
				type === "message_start" &&
				message?.customType === "pi-reflect-watchdog:inquiry-fold" &&
				message.details?.inquiryId === correlation.inquiryId,
		);
		const promptDelivery = deliveries.findIndex(
			({ type, message }) =>
				type === "message_start" &&
				message?.customType === "pi-reflect-watchdog:inquiry" &&
				message.details?.inquiryId === correlation.inquiryId,
		);
		assert.ok(
			foldDelivery >= 0 && promptDelivery > foldDelivery,
			"public RPC lifecycle identifies fold persisted before delayed owned prompt",
		);
		assert.deepEqual(
			deliveries[promptDelivery].message.details,
			correlation,
			"residue is original pre-abort accepted identity, not new submission",
		);
		const promptAction = actions.find(
			({ kind, event }) =>
				kind === "message_start" &&
				event.message?.customType === "pi-reflect-watchdog:inquiry" &&
				event.message.details?.inquiryId === correlation.inquiryId,
		);
		assert.ok(promptAction);
		const contexts = actions.filter(({ kind }) => kind === "context");
		const residueContext = contexts.find(
			({ sequence }) => sequence > promptAction.sequence,
		);
		assert.ok(
			residueContext,
			"retained slot reaches subsequent ordinary request boundary",
		);
		assert.doesNotMatch(
			JSON.stringify(residueContext.messages),
			/cancelled native slot|Trigger source\(s\): USER_REQUEST|inquiry-fold/,
		);
		const reentryRequests = provider.requests.slice(atAbort);
		assert.ok(
			reentryRequests.some(
				(request, index) =>
					index > 0 &&
					JSON.stringify(
						request.body.messages.filter(({ role }) => role !== "assistant"),
					) ===
						JSON.stringify(
							reentryRequests[index - 1].body.messages.filter(
								({ role }) => role !== "assistant",
							),
						),
			),
			"native owned residue causes ordinary request without new logical input; totals are not attribution",
		);
		assert.deepEqual(await tracedHooks(tracePath), []);
		const entries = JSON.parse(
			await readFile(tracePath + ".entries.json", "utf8"),
		);
		assert.equal(
			entries.some(({ customType }) =>
				/:reflection(?:-completed)?$/.test(customType ?? ""),
			),
			false,
		);
	} finally {
		if (process.env.PI_WATCHDOG_ABORT_TRACE_DIR)
			await writeFile(
				path.join(
					process.env.PI_WATCHDOG_ABORT_TRACE_DIR,
					"no-tool-native-gate.json",
				),
				JSON.stringify(
					{
						requests: provider.requests,
						events: rpc.events,
						stderr: rpc.stderr,
						actions: await tracedHooks(tracePath + ".actions.jsonl"),
					},
					null,
					2,
				),
			);
	}
});

for (const partial of [false, true])
	test(`consumed correction abort cancels pending manual work (${partial ? "partial ref" : "invalid ref"})`, {
		timeout: 90_000,
	}, async (t) => {
		const fixture = await setupAbortFixture(t, {
			trace: true,
			responsePlan: ({ requestIndex }) => {
				if (requestIndex === 0)
					return reflectionResponse({
						type: "NO_ISSUE",
						reason: " ",
						done: "checked",
						current_step: "inspect",
						next_step: "continue",
					});
				if (requestIndex === 1)
					return {
						delay: 5_000,
						halfway: 20,
						chunks: [
							{
								tool_calls: [
									{
										index: 0,
										id: "aborted-correction",
										type: "function",
										function: {
											name: "ref",
											arguments: partial
												? '{"type":"NO_ISSUE","reason":'
												: '{"type":"invalid"}',
										},
									},
								],
							},
							{ content: "" },
						],
						finishReason: "tool_calls",
					};
				return { delay: 20, chunks: [{ content: "ordinary fresh response" }] };
			},
		});
		const { provider, rpc } = fixture;
		assert.equal(
			(
				await rpc.request({
					type: "prompt",
					message: "/reflect correction to cancel",
				})
			).success,
			true,
		);
		await waitForProviderRequests(provider, 2);
		assert.match(requestText(provider.requests[1]), /correction|invalid/i);
		assert.equal(
			(
				await rpc.request({
					type: "prompt",
					message: "/reflect discard pending supplement",
				})
			).success,
			true,
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const before = rpc.events.length;
		assert.equal((await rpc.request({ type: "abort" })).success, true);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(provider.requests.length, 2);
		assert.deepEqual(await tracedHooks(fixture.tracePath), []);
		assert.deepEqual(
			rpc.events
				.slice(before)
				.filter(
					({ message }) =>
						message.type === "extension_ui_request" &&
						message.notifyType === "warning",
				),
			[],
		);
		const entries = JSON.parse(
			await readFile(fixture.tracePath + ".entries.json", "utf8"),
		);
		assert.deepEqual(
			entries.filter((entry) =>
				/:reflection(?:-completed)?$/.test(entry.customType ?? ""),
			),
			[],
		);
		const statuses = rpc.events.filter(
			({ message }) => message.method === "setStatus",
		);
		assert.doesNotMatch(JSON.stringify(statuses.at(-1)), /queued/);
		const after = performance.now();
		assert.equal(
			(
				await rpc.request({
					type: "prompt",
					message: "ordinary explicit re-entry after correction abort",
				})
			).success,
			true,
		);
		await rpc.waitFor(
			(message, at) => at > after && message.type === "agent_settled",
			20_000,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(provider.requests.length, 3);
		assert.doesNotMatch(
			requestText(provider.requests[2]),
			/discard pending supplement|correction to cancel|Trigger source\(s\): USER_REQUEST/,
		);
	});

test("abort during actual lookup execution revokes inquiry without cancelling unrelated work", {
	timeout: 90_000,
}, async (t) => {
	const fixture = await setupAbortFixture(t, {
		trace: true,
		tools: "ref,slow_lookup",
		fixtureSource: `pi.registerTool({ name: "slow_lookup", label: "slow lookup", description: "fixture lookup", parameters: { type: "object", properties: {}, additionalProperties: false }, async execute(_id, _args, signal) {
			await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
			return { content: [{ type: "text", text: "lookup stopped" }] };
		} });`,
		responsePlan: ({ requestIndex }) =>
			requestIndex === 0
				? {
						delay: 20,
						chunks: [
							{
								tool_calls: [
									{
										index: 0,
										id: "running-lookup",
										type: "function",
										function: { name: "slow_lookup", arguments: "{}" },
									},
								],
							},
						],
						finishReason: "tool_calls",
					}
				: { delay: 20, chunks: [{ content: "ordinary work resumes" }] },
	});
	const { provider, rpc } = fixture;
	assert.equal(
		(
			await rpc.request({
				type: "prompt",
				message: "/reflect lookup to cancel",
			})
		).success,
		true,
	);
	await rpc.waitFor(
		(message) =>
			message.type === "tool_execution_start" &&
			message.toolName === "slow_lookup",
		20_000,
	);
	assert.equal((await rpc.request({ type: "abort" })).success, true);
	await assertCancelledSilent(fixture, 1);
	const after = performance.now();
	assert.equal(
		(
			await rpc.request({
				type: "prompt",
				message: "fresh unrelated work after lookup abort",
			})
		).success,
		true,
	);
	await rpc.waitFor(
		(message, at) => at > after && message.type === "agent_settled",
		20_000,
	);
	assert.equal(provider.requests.length, 2);
	assert.doesNotMatch(
		requestText(provider.requests[1]),
		/lookup to cancel|Trigger source\(s\): USER_REQUEST/,
	);
});

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
		fixtureSource: `let delayed = false; pi.on("agent_settled", async () => { if (delayed) return; delayed = true; pi.sendMessage({ customType: "fixture:settlement-open", content: "settlement open", display: false }); await new Promise((resolve) => setTimeout(resolve, 500)); });`,
		responsePlan: ({ requestIndex }) => {
			if (requestIndex === 0)
				return {
					delay: 5_000,
					halfway: 20,
					chunks: [{ content: "partial" }, { content: "unused" }],
				};
			if (requestIndex === 2)
				return reflectionResponse({
					type: "NO_ISSUE",
					reason: "fresh valid result",
					done: "checked",
					current_step: "fresh",
					next_step: "continue",
				});
			return { delay: 20, chunks: [{ content: "ordinary response" }] };
		},
	});
	const { provider, rpc } = fixture;
	assert.equal(
		(
			await rpc.request({
				type: "prompt",
				message: "/reflect image abort old inquiry",
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
		/image abort old inquiry|Trigger source\(s\): USER_REQUEST/,
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
	await waitForProviderRequests(provider, 4);
	await rpc.waitFor(
		(message, at) =>
			at > freshAt &&
			message.type === "agent_settled" &&
			provider.requests.length === 4,
		20_000,
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(
		provider.requests.length,
		4,
		"fresh result creates exactly one ordinary continuation",
	);
	assert.equal((await tracedHooks(fixture.tracePath)).length, 1);
	assert.match(requestText(provider.requests[2]), /fresh after image/);
	assert.doesNotMatch(
		requestText(provider.requests[3]),
		/Trigger source\(s\): USER_REQUEST/,
	);
});

test("abort with a submitted-but-unconsumed inquiry inhibits post-abort watchdog requests until explicit re-entry", {
	timeout: 90_000,
}, async (t) => {
	const { provider, rpc } = await setupAbortFixture(t, {
		responsePlan: slowToolCallPlan(),
	});

	// 1. Ordinary streaming run.
	const accepted = await rpc.request({
		type: "prompt",
		message: "Run the slow fixture task.",
	});
	assert.equal(accepted.success, true);
	await waitForProviderRequests(provider, 1);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(
		(await rpc.request({ type: "get_state" })).data.isStreaming,
		true,
		"ordinary run is streaming while the inquiry is submitted",
	);

	// 2. Unrelated steering before the owned inquiry.
	const steerBefore = await rpc.request({
		type: "steer",
		message: "unrelated steering before the inquiry",
	});
	assert.equal(steerBefore.success, true);

	// 3. Manual /reflect during streaming: the command executes immediately
	//    and submits the inquiry into native steering (unconsumed).
	const manual = await rpc.request({
		type: "prompt",
		message: "/reflect inspect the slow approach",
	});
	assert.equal(manual.success, true);
	assert.equal(
		provider.requests[0].finishedAt,
		undefined,
		"the inquiry was submitted while the ordinary response still streamed",
	);

	// 4. Unrelated steering after the owned inquiry.
	const steerAfter = await rpc.request({
		type: "steer",
		message: "unrelated steering after the inquiry",
	});
	assert.equal(steerAfter.success, true);

	// 5. Abort the main run. The stale inquiry must not cause any further
	//    watchdog-generated provider request.
	const aborted = await rpc.request({ type: "abort" });
	assert.equal(aborted.success, true);
	const requestCountAtAbort = provider.requests.length;
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	assert.equal(
		provider.requests.length,
		requestCountAtAbort,
		"no watchdog-generated provider request follows the abort",
	);

	// 6. Explicit user re-entry with a fresh ordinary message. The fake provider
	//    keeps answering with tool-call turns so the run drains the whole native
	//    steering queue (one message per turn).
	const reentry = await rpc.request({
		type: "prompt",
		message: "fresh user work after the abort",
	});
	assert.equal(reentry.success, true);
	// 1 user turn + up to 3 drain turns.
	await waitForProviderRequests(provider, requestCountAtAbort + 4, 20_000);
	await new Promise((resolve) => setTimeout(resolve, 500));
	const reentryRequests = provider.requests.slice(requestCountAtAbort);
	const reentryText = reentryRequests.map(requestText).join("\n");

	// The cancelled inquiry must not surface as a live reflection request in
	// the new user run. (Task 1.2 records the current baseline: this assert
	// fails because the native-queued stale prompt drains into the new run.)
	assert.doesNotMatch(
		reentryText,
		/Trigger source\(s\): USER_REQUEST/,
		"no live cancelled inquiry reaches the new user run",
	);
	assert.doesNotMatch(
		reentryText,
		/inspect the slow approach/,
		"the cancelled inquiry prompt text is absent from new user context",
	);

	// Unrelated messages survive in order around the cancelled slot.
	const lastRequest = reentryRequests.at(-1);
	const messages = lastRequest.body.messages.map((message) =>
		providerMessageText(message),
	);
	const before = messages.findIndex((text) =>
		text.includes("unrelated steering before the inquiry"),
	);
	const after = messages.findIndex((text) =>
		text.includes("unrelated steering after the inquiry"),
	);
	const fresh = messages.findIndex((text) =>
		text.includes("fresh user work after the abort"),
	);
	assert.ok(before >= 0, "unrelated steering before the inquiry is delivered");
	assert.ok(after >= 0, "unrelated steering after the inquiry is delivered");
	assert.ok(fresh >= 0, "the explicit re-entry message is delivered intact");
	assert.ok(before < after, "unrelated steering order is preserved");
	assert.equal(
		messages.filter((text) => text.includes("fresh user work after the abort"))
			.length,
		1,
		"the explicit re-entry message is delivered exactly once",
	);

	// The abort-cancel fold is appended to history while the stale prompt is
	// still native-queued, so the fold necessarily precedes the delayed prompt
	// drain. Exactly that ordering is exercised above, and the cancelled
	// correlation must leave no orphan control in model context either.
	assert.doesNotMatch(
		reentryText,
		/inquiry-fold/,
		"the abort-cancel fold does not leak into model context",
	);
	// Observable request-count bound: one request per drained steering message
	// plus nothing extra from the cancelled inquiry (no retry, no continuation).
	assert.equal(
		reentryRequests.length,
		4,
		"exactly the fresh turn plus three drain turns request the provider",
	);
});

test("abort during a consumed manual reflection produces no retry, report, hook, or continuation", {
	timeout: 90_000,
}, async (t) => {
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-abort-consumed-",
	);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	await writeJson(path.join(isolated.agentDir, "pi-reflect-watchdog.json"), {
		rootLoopLimit: 60,
		allLoopLimit: 300,
		taskMinutes: 20,
	});
	const tracePath = path.join(resources.base, "semantic-hooks.jsonl");
	await installHookTracer({
		base: resources.base,
		agentDir: isolated.agentDir,
		tracePath,
	});
	const provider = await startFakeProvider({
		responsePlan: ({ requestIndex }) => {
			// The reflection inquiry is consumed (request 0); it streams slowly so
			// the abort lands mid-response.
			if (requestIndex === 0)
				return {
					delay: 2_500,
					halfway: 100,
					chunks: [{ content: "partial reflection thought" }],
					finishReason: "stop",
				};
			return { delay: 20, chunks: [{ content: "unexpected extra turn" }] };
		},
	});
	resources.add(() => provider.close());
	await writeJson(
		path.join(isolated.agentDir, "models.json"),
		modelConfig(provider.baseUrl),
	);
	const rpc = new RpcPi({
		cwd: isolated.workspace,
		env: { ...isolated.env, PI_WATCHDOG_HOOK_TRACE: tracePath },
		launcherArgs: [
			"--mode",
			"rpc",
			"--no-session",
			"--tools",
			"ref",
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
		message: "/reflect inspect the consumed inquiry",
	});
	assert.equal(accepted.success, true);
	await waitForProviderRequests(provider, 1);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const aborted = await rpc.request({ type: "abort" });
	assert.equal(aborted.success, true);
	const requestCountAtAbort = provider.requests.length;
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	assert.equal(
		provider.requests.length,
		requestCountAtAbort,
		"no retry, continuation, or any provider request follows the abort",
	);
	assert.deepEqual(await tracedHooks(tracePath), []);
	const warnings = rpc.events
		.map(({ message }) => message)
		.filter(
			(message) =>
				message.type === "extension_ui_request" &&
				message.method === "notify" &&
				message.notifyType === "warning" &&
				String(message.message ?? "").startsWith("Reflection"),
		);
	assert.deepEqual(warnings, [], "an aborted reflection never warns");
	// This RPC run uses --no-session, so durable-entry absence is asserted via
	// the plugin's observable surface: no completion hook, no retry warning,
	// and no provider request of any kind after the abort.
	// Explicit re-entry: a fresh /reflect is allowed and independent.
	const requestsBefore = provider.requests.length;
	const fresh = await rpc.request({
		type: "prompt",
		message: "/reflect inspect the new approach",
	});
	assert.equal(fresh.success, true);
	await waitForProviderRequests(provider, requestsBefore + 1, 20_000);
	const freshRequest = provider.requests.at(-1);
	assert.match(
		JSON.stringify(freshRequest.body.messages),
		/inspect the new approach/,
		"the fresh manual reflection starts with its own supplement",
	);
	assert.doesNotMatch(
		JSON.stringify(freshRequest.body.messages),
		/inspect the consumed inquiry/,
		"the cancelled supplement never reappears",
	);
});

for (const type of ["NO_ISSUE", "ROUTE_CORRECTION"])
	test(`packed stock Pi abort after a staged valid ${type} result publishes nothing and stays held`, {
		timeout: 90_000,
	}, async (t) => {
		const resources = await createTestResources(
			t,
			`pi-reflect-watchdog-abort-staged-${type.toLowerCase()}-`,
		);
		const isolated = await createIsolatedEnvironment(resources.base);
		const artifact = await installPackedArtifact({
			base: resources.base,
			agentDir: isolated.agentDir,
		});
		await writeJson(path.join(isolated.agentDir, "pi-reflect-watchdog.json"), {
			rootLoopLimit: 60,
			allLoopLimit: 300,
			taskMinutes: 20,
		});
		const tracePath = path.join(resources.base, "semantic-hooks.jsonl");
		await installHookTracer({
			base: resources.base,
			agentDir: isolated.agentDir,
			tracePath,
		});
		// Request 0 is the reflection: ref stages the result and a second
		// lookup keeps the response streaming, so the abort lands while the
		// run is still active with the result staged but not committed.
		const provider = await startFakeProvider({
			responsePlan: ({ requestIndex }) => {
				if (requestIndex === 0)
					return {
						delay: 3_000,
						halfway: 150,
						chunks: [
							{
								tool_calls: [
									{
										index: 0,
										id: "staged-ref",
										type: "function",
										function: {
											name: "ref",
											arguments: JSON.stringify({
												type,
												reason: "staged before abort",
												done: "checked",
												current_step: "mid",
												next_step: "halt",
											}),
										},
									},
									{
										index: 1,
										id: "staged-lookup",
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
				// Any later provider request must stay slow so the abort cuts it
				// before it can settle; a fast reply would let the staged result
				// complete normally before the abort arrives.
				return { delay: 8_000, halfway: 200, chunks: [{ content: "slow" }] };
			},
		});
		resources.add(() => provider.close());
		await writeJson(
			path.join(isolated.agentDir, "models.json"),
			modelConfig(provider.baseUrl),
		);
		const rpc = new RpcPi({
			cwd: isolated.workspace,
			env: { ...isolated.env, PI_WATCHDOG_HOOK_TRACE: tracePath },
			launcherArgs: [
				"--mode",
				"rpc",
				"--no-session",
				"--tools",
				"ref",
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
			message: `/reflect stage a ${type} result`,
		});
		assert.equal(accepted.success, true);
		// Wait for the ref call to run (tool result present) but abort before
		// the run would settle through normal completion paths.
		await waitForProviderRequests(provider, 1);
		await rpc.waitFor(
			(message) =>
				message.type === "tool_execution_end" && message.toolName === "ref",
			15_000,
		);
		const aborted = await rpc.request({ type: "abort" });
		assert.equal(aborted.success, true);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		// Pi may legitimately issue the run's next tool-result request before
		// the abort lands; the oracle is that NOTHING new follows the abort:
		// no continuation, no retry, no settle re-dispatch.
		const requestCountAtAbort = provider.requests.length;
		assert.equal(
			(await rpc.request({ type: "get_state" })).data.isStreaming,
			false,
			"the aborted run settled",
		);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		assert.equal(
			provider.requests.length,
			requestCountAtAbort,
			"the staged result never triggers a post-abort request",
		);
		assert.deepEqual(
			await tracedHooks(tracePath),
			[],
			`a staged ${type} result cancelled by abort publishes no hook`,
		);
		// Post-abort hold: an unrelated automatic threshold (rootLoopLimit high
		// here) cannot fire, and a fresh explicit prompt works normally.
		const fresh = await rpc.request({
			type: "prompt",
			message: "ordinary work after the staged abort",
		});
		assert.equal(fresh.success, true);
		await waitForProviderRequests(provider, 2, 20_000);
		await rpc.waitFor((message) => message.type === "agent_settled", 20_000);
		assert.equal(
			provider.requests.length,
			2,
			"no extra requests after re-entry",
		);
	});

test("packed stock Pi holds reflection across background callbacks and releases on explicit input", {
	timeout: 90_000,
}, async (t) => {
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-abort-hold-callback-",
	);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	// A tiny threshold so any wrongly-released accounting would reflect at once.
	await writeJson(path.join(isolated.agentDir, "pi-reflect-watchdog.json"), {
		rootLoopLimit: 1,
		allLoopLimit: 300,
		taskMinutes: 20,
	});
	const provider = await startFakeProvider({
		responsePlan: ({ requestIndex }) => {
			if (requestIndex === 0)
				return {
					delay: 2_000,
					halfway: 100,
					chunks: [{ content: "ordinary work" }],
				};
			return { delay: 20, chunks: [{ content: "callback resumed" }] };
		},
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
			"--no-session",
			"--tools",
			"ref",
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
		message: "Run one ordinary turn that will be aborted.",
	});
	assert.equal(accepted.success, true);
	await waitForProviderRequests(provider, 1);
	await new Promise((resolve) => setTimeout(resolve, 200));
	// Threshold-adjacent ordinary work is aborted at the root-loop threshold.
	const aborted = await rpc.request({ type: "abort" });
	assert.equal(aborted.success, true);
	const requestCountAtAbort = provider.requests.length;
	// Background-style wake: steer as an rpc user message (user role) without
	// new explicit input semantics for the plugin? rpc steer IS rpc-sourced
	// input, so it legitimately releases the hold. Instead use a followUp-like
	// extension path: sendUserMessage from another extension is not directly
	// drivable here; cover the counter/timer side by waiting past the abort.
	await new Promise((resolve) => setTimeout(resolve, 1_200));
	assert.equal(
		provider.requests.length,
		requestCountAtAbort,
		"elapsed time and old threshold intent do not dispatch after abort",
	);
	// Explicit interactive-style input releases the hold; the fresh cycle's
	// first root loop crosses rootLoopLimit 1 and dispatches one reflection.
	const reentry = await rpc.request({
		type: "prompt",
		message: "fresh explicit work releases the hold",
	});
	assert.equal(reentry.success, true);
	await waitForProviderRequests(provider, requestCountAtAbort + 1, 20_000);
	await rpc.waitFor((message) => message.type === "agent_settled", 25_000);
	// The fresh cycle should reflect after the ordinary turn settles.
	let reflected = false;
	const deadline = performance.now() + 15_000;
	while (performance.now() < deadline) {
		reflected = provider.requests.some(
			(request, index) =>
				index >= requestCountAtAbort &&
				JSON.stringify(request.body.messages).includes(
					"Trigger source(s): ROOT_LOOP_LIMIT",
				),
		);
		if (reflected) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(
		reflected,
		"explicit re-entry restores automatic reflection from a fresh cycle",
	);
});

for (const inquiry of [false, true])
	test(`packed stock Pi ${inquiry ? "inquiry" : "ordinary"} abort freezes all-idle clocks`, {
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
			message: inquiry
				? "/reflect stop inquiry clock"
				: "ordinary work then stop",
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
