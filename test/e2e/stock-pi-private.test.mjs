import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
	access,
	mkdir,
	open,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	isPrivateReflectionRequest,
	modelConfig,
	privateReflectionPlan,
	requestText,
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

// Packed replacements for retired main-session inquiry/`ref` scenarios.
// Mapping: PLAN/reflect-private-test-migration.md ("Packed E2E replacements").

const VALID = {
	type: "NO_ISSUE",
	reason: "route is sound",
	done: "fixture checked",
	current_step: "finish",
	next_step: "stop",
};

const ordinary = (text = "ordinary fixture resumed") => ({
	delay: 20,
	chunks: [{ content: text }],
});

function text(message) {
	return typeof message.content === "string"
		? message.content
		: (message.content ?? []).map((block) => block?.text ?? "").join("\n");
}

async function sleep(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate, timeoutMs, label) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (await predicate()) return;
		await sleep(20);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function installHookTracer(base, agentDir, _tracePath, extraSource = "") {
	const dir = path.join(base, "hook-tracer");
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({
			name: "watchdog-hook-tracer",
			version: "1.0.0",
			type: "module",
			pi: { extensions: ["./index.js"] },
		}),
	);
	await writeFile(
		path.join(dir, "index.js"),
		`import { appendFileSync } from "node:fs";
export default function tracer(pi) {
  const trace = process.env.PI_WATCHDOG_HOOK_TRACE;
  let sequence = 0;
  let hookCount = 0;
  const record = (kind, value) =>
    appendFileSync(trace + ".events.jsonl", JSON.stringify({ sequence: ++sequence, kind, ...value }) + "\\n");
  pi.events.on("pi:semantic-hook:v1", (envelope) => {
    if (envelope?.name === "reflection-completed") hookCount += 1;
    appendFileSync(trace, JSON.stringify(envelope) + "\\n");
    record("hook", { envelope });
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "custom") record("custom-message", { customType: event.message.customType, details: event.message.details });
  });
  // Main-session provider requests only: the tracer is not loaded in private children.
  pi.on("before_provider_request", (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch()
      .filter((entry) => entry.type === "custom" && /^pi-reflect-watchdog:reflection/.test(entry.customType))
      .map((entry) => ({ customType: entry.customType, data: entry.data }));
    record("main-request", { hookCount, entries });
  });
  ${extraSource}
}
`,
	);
	const settingsPath = path.join(agentDir, "settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8"));
	settings.packages.push(dir);
	await writeJson(settingsPath, settings);
}

async function traceEvents(tracePath) {
	return (await readFile(`${tracePath}.events.jsonl`, "utf8").catch(() => ""))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * Durable result → completion marker (same correlation) → hook → continuation
 * message, with the wake request carrying both entries and the hook already
 * published. `index` selects the n-th completed reflection.
 */
async function assertDeliveryOrder(tracePath, index = 0) {
	const events = await traceEvents(tracePath);
	const hookEvents = events.filter(
		(event) =>
			event.kind === "hook" && event.envelope?.name === "reflection-completed",
	);
	const continuations = events.filter(
		(event) =>
			event.kind === "custom-message" &&
			event.customType === "pi-reflect-watchdog:continuation",
	);
	assert.ok(hookEvents[index], `hook ${index + 1}`);
	assert.ok(continuations[index], `continuation ${index + 1}`);
	assert.ok(
		hookEvents[index].sequence < continuations[index].sequence,
		"hook precedes continuation",
	);
	const wake = events.find(
		(event) =>
			event.kind === "main-request" &&
			event.sequence > continuations[index].sequence,
	);
	assert.ok(wake, "a main request follows the continuation");
	assert.equal(
		wake.hookCount,
		index + 1,
		"hook published before the wake request",
	);
	const results = wake.entries.filter(
		(entry) => entry.customType === "pi-reflect-watchdog:reflection",
	);
	const markers = wake.entries.filter(
		(entry) => entry.customType === "pi-reflect-watchdog:reflection-completed",
	);
	assert.equal(results.length, index + 1);
	assert.equal(markers.length, index + 1);
	assert.deepEqual(results[index].data.correlation, markers[index].data);
	assert.deepEqual(
		continuations[index].details.correlation,
		markers[index].data,
		"continuation carries the durable correlation",
	);
	return wake;
}

async function hooks(tracePath) {
	return (await readFile(tracePath, "utf8").catch(() => ""))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function sessionText(sessionDir) {
	const files = [];
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(
			() => [],
		)) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.name.endsWith(".jsonl")) files.push(full);
		}
	};
	await walk(sessionDir);
	// Main session files only: private children live under forks/.
	const main = files.filter((file) => !file.split(path.sep).includes("forks"));
	assert.ok(main.length >= 1, "a persisted main session file exists");
	const text = (
		await Promise.all(main.map((file) => readFile(file, "utf8")))
	).join("\n");
	assert.match(
		text,
		/ordinary fixture resumed|first ordinary turn|ordinary work/,
	);
	return text;
}

// Packed shape: npm pack → production root install → Pi loads ./src/extension.ts.
async function installFromPack(resources, isolated) {
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	const manifest = JSON.parse(
		await readFile(path.join(artifact.packagePath, "package.json"), "utf8"),
	);
	assert.deepEqual(manifest.pi.extensions, ["./src/extension.ts"]);
	return {
		packagePath: artifact.packagePath,
		entry: path.join(artifact.packagePath, "src", "extension.ts"),
	};
}

async function startPrivateFixture(
	t,
	prefix,
	plan,
	config = {},
	install = installFromPack,
	extraSource = "",
) {
	assertStockPi();
	const resources = await createTestResources(t, prefix);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await install(resources, isolated);
	await writeJson(path.join(isolated.agentDir, "pi-reflect-watchdog.json"), {
		rootLoopLimit: 60,
		allLoopLimit: 300,
		taskMinutes: 20,
		...config,
	});
	const tracePath = path.join(resources.base, "semantic-hooks.jsonl");
	await installHookTracer(
		resources.base,
		isolated.agentDir,
		tracePath,
		extraSource,
	);
	const provider = await startFakeProvider({ responsePlan: plan });
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
			"--provider",
			"watchdog-fixture",
			"--model",
			"watchdog-fixture",
		],
	});
	resources.add(() => rpc.close());
	await assertSingleWatchdogCommand(rpc, artifact.entry);
	const sessionDir = isolated.env.PI_CODING_AGENT_SESSION_DIR;
	const privateRequests = () =>
		provider.requests.filter((request) => isPrivateReflectionRequest(request));
	const mainRequests = () =>
		provider.requests.filter((request) => !isPrivateReflectionRequest(request));
	const notices = () =>
		rpc.events
			.map(({ message }) => message)
			.filter(
				(message) =>
					message.type === "extension_ui_request" &&
					message.method === "notify",
			)
			.map((message) => message.message);
	return {
		provider,
		rpc,
		workspace: isolated.workspace,
		tracePath,
		sessionDir,
		privateRequests,
		mainRequests,
		notices,
	};
}

async function prompt(rpc, message) {
	const response = await rpc.request({ type: "prompt", message }, 30_000);
	assert.equal(response.success, true, JSON.stringify(response));
}

async function settledAfter(rpc, count) {
	await until(
		() =>
			rpc.events.filter(({ message }) => message.type === "agent_settled")
				.length >= count,
		30_000,
		`${count} agent_settled events`,
	);
}

function assertNoPrivateResidue(fixture, mainText) {
	for (const request of fixture.mainRequests()) {
		assert.equal(
			request.body.tools?.some((tool) => tool.function.name === "ref") ?? false,
			false,
			"no owned ref declaration reaches main",
		);
		assert.doesNotMatch(
			JSON.stringify(request.body.messages),
			/private_inquiry_result_file|Plugin-generated reflection context|previous reflection response was invalid/,
		);
	}
	assert.doesNotMatch(
		mainText,
		/private_inquiry_result_file|Plugin-generated reflection context|pi-reflect-inquiry/,
	);
}

const completedHooks = async (tracePath) =>
	(await hooks(tracePath)).filter(
		(hook) => hook.name === "reflection-completed",
	);

function wakeAfterReport(messages, type, role) {
	const reportIndex = messages.findIndex(
		(message) =>
			message.role === role && text(message).includes(`Reflection · ${type}`),
	);
	assert.ok(reportIndex >= 0, `report reaches main with role ${role}`);
	assert.equal(text(messages[reportIndex + 1]), "[assistant]\ncontinue");
	return reportIndex;
}

/** Exact private provider requests; any post-write acknowledgement fails. */
function assertPrivateRequests(fixture, plan, expected) {
	assert.deepEqual(
		plan.violations,
		[],
		"no acknowledgement after the result write",
	);
	assert.equal(fixture.privateRequests().length, expected);
}

function toolResults(request) {
	return (request.body.messages ?? []).filter(
		(message) => message.role === "tool",
	);
}

// Replaces packed: raw EventBus final hook (K hook values/order).
test("packed private manual reflection: one request, durable pair, hook, then one wake", {
	timeout: 90_000,
}, async (t) => {
	const plan = privateReflectionPlan(VALID, () => ordinary());
	const fixture = await startPrivateFixture(
		t,
		"pi-reflect-private-manual-",
		plan,
	);
	const { rpc, tracePath } = fixture;
	await prompt(rpc, "first ordinary turn");
	await settledAfter(rpc, 1);
	await prompt(rpc, "/reflect verify private path");
	await until(() => fixture.mainRequests().length >= 2, 30_000, "idle wake");
	await settledAfter(rpc, 2);
	await sleep(500);
	assert.deepEqual(await hooks(tracePath), [
		{
			version: 1,
			name: "reflection-completed",
			values: {
				REFLECTION_TYPE: "NO_ISSUE",
				REASON: "route is sound",
				NEXT_STEP: "stop",
			},
		},
	]);
	assert.equal(fixture.mainRequests().length, 2, "exactly one continuation");
	assertPrivateRequests(fixture, plan, 1);
	await assertDeliveryOrder(tracePath);
	wakeAfterReport(fixture.mainRequests()[1].body.messages, "NO_ISSUE", "user");
	assertNoPrivateResidue(fixture, await sessionText(fixture.sessionDir));
});

/** Main plan: a prompt containing "paired" makes one tool round, then text. */
function pairedMain(request) {
	const messages = request.body.messages ?? [];
	const last = messages.at(-1);
	if (last?.role === "user" && text(last).includes("paired"))
		return {
			delay: 20,
			chunks: [
				{
					tool_calls: [
						{
							index: 0,
							id: `paired-${messages.length}`,
							type: "function",
							function: {
								name: "read",
								arguments: '{"path":"package.json","limit":1}',
							},
						},
					],
				},
			],
			finishReason: "tool_calls",
		};
	return ordinary();
}

// Replaces packed: automatic ROUTE_CORRECTION report-before-wake, root-loop
// cooldown (inhibit, expire after the floor, re-arm with exact counters) and
// legacy counting-pause hooks.
test("packed private automatic reflection: assistant report, cooldown expires and re-arms, legacy pause ignored", {
	timeout: 180_000,
}, async (t) => {
	const plan = privateReflectionPlan(
		{ ...VALID, type: "ROUTE_CORRECTION" },
		(request) => pairedMain(request),
	);
	const fixture = await startPrivateFixture(
		t,
		"pi-reflect-private-automatic-",
		plan,
		{
			rootLoopLimit: 2,
			hookPauses: [{ pause: "fixture-pause", resume: "fixture-resume" }],
		},
		installFromPack,
		`pi.on("session_start", () => pi.events.emit("pi:semantic-hook:v1", { version: 1, name: "fixture-pause" }));`,
	);
	const { rpc, tracePath } = fixture;
	const reflections = () =>
		fixture
			.privateRequests()
			.filter((request) =>
				text(request.body.messages.at(-1)).includes(
					"Trigger source(s): ROOT_LOOP_LIMIT",
				),
			);
	// Every rpc prompt is explicit input and resets the cycle, so a threshold
	// inside one prompt needs two loops: one tool round, then the answer.
	let settled = 0;
	const turn = async (message) => {
		await prompt(rpc, message);
		settled += 1;
		await settledAfter(rpc, settled);
	};
	await turn("paired ordinary work crosses the root limit");
	await until(
		async () => (await completedHooks(tracePath)).length === 1,
		30_000,
		"first reflection hook",
	);
	settled += 1; // the wake's own settlement
	await settledAfter(rpc, settled);
	await sleep(500);
	assert.equal(reflections().length, 1);
	assert.match(
		text(reflections()[0].body.messages.at(-1)),
		/Threshold snapshot: active=\d+s\/2 loops; task=\d+s\/20m; root=2\/2; all=2\/300/,
	);
	const wakeIndex = fixture.mainRequests().length - 1;
	wakeAfterReport(
		fixture.mainRequests()[wakeIndex].body.messages,
		"ROUTE_CORRECTION",
		"assistant",
	);
	await assertDeliveryOrder(tracePath);
	// Inside cooldown a paired prompt crosses the limit again without a reflection.
	await turn("paired ordinary work during cooldown");
	await sleep(1_000);
	assert.equal(
		reflections().length,
		1,
		"cooldown inhibits automatic reflection",
	);
	// The cooldown floor is ten ordinary loops after the completion.
	for (let index = 0; index < 8; index += 1)
		await turn(`ordinary follow-up ${index}`);
	await sleep(500);
	assert.equal(reflections().length, 1, "still inside the cooldown floor");
	await turn("paired ordinary work after cooldown");
	await until(() => reflections().length === 2, 30_000, "re-armed reflection");
	assert.match(
		text(reflections()[1].body.messages.at(-1)),
		/root=2\/2; all=2\/300/,
	);
	await until(
		async () => (await completedHooks(tracePath)).length === 2,
		30_000,
		"second hook",
	);
	await assertDeliveryOrder(tracePath, 1);
	assert.deepEqual(plan.violations, []);
	assertNoPrivateResidue(fixture, await sessionText(fixture.sessionDir));
});

// Replaces packed: busy-manual NO_ISSUE/ROUTE_CORRECTION report-before-wake,
// manual mid-tool-turn steering and child-limit busy steering (K: result-time
// steering after the whole tool batch and earlier native messages).
test("packed private busy manual reflection: child runs during a held tool batch; feedback follows the batch and earlier steering", {
	timeout: 120_000,
}, async (t) => {
	const plan = privateReflectionPlan(VALID, (_request, index) => {
		if (index === 0)
			// Two parallel tool calls; the second is slow to hold the batch open.
			return {
				delay: 20,
				chunks: [
					{
						tool_calls: [
							{
								index: 0,
								id: "batch-read",
								type: "function",
								function: {
									name: "read",
									arguments: '{"path":"package.json","limit":1}',
								},
							},
							{
								index: 1,
								id: "batch-sleep",
								type: "function",
								function: {
									name: "bash",
									arguments: '{"command":"sleep 8; echo batch-done"}',
								},
							},
						],
					},
				],
				finishReason: "tool_calls",
			};
		return ordinary();
	});
	const fixture = await startPrivateFixture(
		t,
		"pi-reflect-private-busy-",
		plan,
		{},
		installFromPack,
	);
	const { rpc, tracePath } = fixture;
	await prompt(rpc, "ordinary batch work");
	await until(() => fixture.mainRequests().length === 1, 10_000, "main batch");
	await until(
		() =>
			rpc.events.some(
				({ message }) =>
					message.type === "tool_execution_start" &&
					message.toolCallId === "batch-sleep",
			),
		10_000,
		"held tool running",
	);
	assert.equal(
		(
			await rpc.request({
				type: "steer",
				message: "earlier unrelated steering",
			})
		).success,
		true,
	);
	await prompt(rpc, "/reflect check while the batch runs");
	await until(
		async () => (await completedHooks(tracePath)).length === 1,
		30_000,
		"reflection completes while the batch is held",
	);
	const toolDone = () =>
		rpc.events.some(
			({ message }) =>
				message.type === "tool_execution_end" &&
				message.toolCallId === "batch-sleep",
		);
	assert.equal(
		toolDone(),
		false,
		"the private result completed during the held batch",
	);
	assert.equal(
		fixture.mainRequests().length,
		1,
		"no main request while the batch is open",
	);
	// Pi's default steeringMode is one-at-a-time: one queued steering message
	// per completed assistant turn, in queue order.
	await until(
		() => fixture.mainRequests().length >= 3,
		30_000,
		"feedback request",
	);
	await settledAfter(rpc, 1);
	await sleep(500);
	assert.equal(
		fixture.mainRequests().length,
		3,
		"batch+steer request, then one feedback request",
	);
	const [, afterBatch, afterFeedback] = fixture.mainRequests();
	const batchMessages = afterBatch.body.messages;
	const results = batchMessages.filter((message) => message.role === "tool");
	assert.deepEqual(
		results.map((message) => message.tool_call_id),
		["batch-read", "batch-sleep"],
		"both tool results intact",
	);
	assert.match(text(results[1]), /batch-done/);
	const lastTool = batchMessages.findLastIndex(
		(message) => message.role === "tool",
	);
	assert.equal(
		text(batchMessages.at(-1)),
		"earlier unrelated steering",
		"earlier steering is delivered first, after the whole batch",
	);
	assert.ok(lastTool < batchMessages.length - 1);
	assert.doesNotMatch(
		JSON.stringify(batchMessages),
		/Reflection · /,
		"feedback waits behind earlier steering",
	);
	const messages = afterFeedback.body.messages;
	const steerIndex = messages.findIndex(
		(message) => text(message) === "earlier unrelated steering",
	);
	const reportIndex = wakeAfterReport(messages, "NO_ISSUE", "user");
	assert.ok(
		steerIndex >= 0 && steerIndex < reportIndex,
		"feedback follows earlier steering",
	);
	assert.equal(
		reportIndex + 2,
		messages.length,
		"report and continue end the request",
	);
	assert.equal(
		rpc.events.some(
			({ message }) =>
				message.type === "message_end" &&
				message.message?.stopReason === "aborted",
		),
		false,
		"main response was not aborted",
	);
	assertPrivateRequests(fixture, plan, 1);
	await assertDeliveryOrder(tracePath);
	assertNoPrivateResidue(fixture, await sessionText(fixture.sessionDir));
});

// Replaces packed: schema-invalid correction, each-invalid-retry, hidden result
// (K: exact attempt requests, per-attempt warnings, one hook; second reflection
// carries the prior report and the original parent locator).
test("packed private correction: exact requests and warnings, then a second reflection sees the prior report and parent locator", {
	timeout: 120_000,
}, async (t) => {
	// The second reflection is a fresh child that answers validly at once.
	const plan = privateReflectionPlan(
		(request) =>
			requestText(request).includes(
				"User supplement: verify the corrected route",
			)
				? VALID
				: [{ ...VALID, type: "BOGUS" }, VALID],
		() => ordinary(),
	);
	const fixture = await startPrivateFixture(
		t,
		"pi-reflect-private-correction-",
		plan,
	);
	const { rpc, tracePath } = fixture;
	await prompt(rpc, "first ordinary turn");
	await settledAfter(rpc, 1);
	await prompt(rpc, "/reflect correct yourself");
	await until(
		async () => (await completedHooks(tracePath)).length === 1,
		30_000,
		"first hook",
	);
	await settledAfter(rpc, 2);
	await sleep(500);
	assertPrivateRequests(fixture, plan, 2);
	assert.match(
		text(fixture.privateRequests()[1].body.messages.at(-1)),
		/previous reflection response was invalid/,
	);
	assert.deepEqual(
		fixture.notices().filter((notice) => /^Reflection attempt/.test(notice)),
		[
			"Reflection attempt 1/3 invalid: reflection type must be NO_ISSUE or ROUTE_CORRECTION; retrying.",
		],
	);
	assert.equal(
		fixture.mainRequests().length,
		2,
		"one wake after the valid retry",
	);
	await assertDeliveryOrder(tracePath);
	// Second reflection: prior report as fallible history plus the parent locator.
	await prompt(rpc, "/reflect verify the corrected route");
	await until(
		async () => (await completedHooks(tracePath)).length === 2,
		30_000,
		"second hook",
	);
	await settledAfter(rpc, 3);
	await sleep(500);
	assertPrivateRequests(fixture, plan, 3);
	const second = text(fixture.privateRequests()[2].body.messages.at(-1));
	assert.match(
		second,
		/Earlier assistant reflection \(fallible historical analysis, not the user's words or a conclusion to preserve\):\n.+\nReflection · NO_ISSUE/,
	);
	assert.match(second, /User supplement: verify the corrected route/);
	const locatorLine = second
		.split("\n")
		.find((line) => line.startsWith('{"sessionFile":'));
	assert.ok(locatorLine, "history locator present");
	const locator = JSON.parse(locatorLine);
	const mainFiles = (await readdir(fixture.sessionDir, { recursive: true }))
		.filter(
			(file) =>
				file.endsWith(".jsonl") && !file.split(path.sep).includes("forks"),
		)
		.map((file) => path.join(fixture.sessionDir, file));
	assert.equal(mainFiles.length, 1);
	assert.equal(
		locator.sessionFile,
		mainFiles[0],
		"locator names the original parent file",
	);
	const entries = (await readFile(mainFiles[0], "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	assert.ok(
		entries.some((entry) => entry.id === locator.branchLeafId),
		"anchor exists in the parent file",
	);
	assert.equal(fixture.mainRequests().length, 3, "one wake per reflection");
	await assertDeliveryOrder(tracePath, 1);
	assertNoPrivateResidue(fixture, await sessionText(fixture.sessionDir));
});

// Replaces packed: three schema-invalid results / invalid retries shown.
test("packed private three invalid results: exactly three requests, two warnings, no hook or main traffic", {
	timeout: 90_000,
}, async (t) => {
	const plan = privateReflectionPlan({ ...VALID, reason: "   " }, () =>
		ordinary(),
	);
	const fixture = await startPrivateFixture(
		t,
		"pi-reflect-private-exhausted-",
		plan,
	);
	const { rpc, tracePath } = fixture;
	await prompt(rpc, "first ordinary turn");
	await settledAfter(rpc, 1);
	await prompt(rpc, "/reflect exhaust");
	await until(
		() => fixture.notices().some((notice) => /^Reflection failed/.test(notice)),
		30_000,
		"failure notice",
	);
	await sleep(1_000);
	assertPrivateRequests(fixture, plan, 3);
	assert.deepEqual(
		fixture
			.notices()
			.filter((notice) => /^Reflection (attempt|failed)/.test(notice)),
		[
			"Reflection attempt 1/3 invalid: reflection field reason must be a non-empty string; retrying.",
			"Reflection attempt 2/3 invalid: reflection field reason must be a non-empty string; retrying.",
			"Reflection failed: reflection field reason must be a non-empty string",
		],
	);
	assert.deepEqual(await completedHooks(tracePath), []);
	assert.equal(fixture.mainRequests().length, 1, "no main traffic");
	assertNoPrivateResidue(fixture, await sessionText(fixture.sessionDir));
});

// K (response contract): ten executed helpers shared across corrections, the
// eleventh and any forbidden/mixed batch execute nothing, and the result write
// is still accepted after the budget is exhausted.
test("packed private evidence budget: ten helpers across corrections, eleventh and forbidden calls execute nothing, result still accepted", {
	timeout: 120_000,
}, async (t) => {
	const marker = path.join(
		os.tmpdir(),
		`reflect-forbidden-${process.pid}-${Date.now()}`,
	);
	const reads = (count, offset) =>
		Array.from({ length: count }, (_, index) => ({
			name: "read",
			args: { path: "evidence.txt", offset: offset + index + 1, limit: 1 },
		}));
	const plan = privateReflectionPlan(
		[
			// Attempt 1: five helpers execute; the mixed batch runs nothing.
			{
				steps: [
					reads(5, 0),
					[
						{
							name: "read",
							args: { path: "evidence.txt", offset: 20, limit: 1 },
						},
						{ name: "bash", args: { command: `touch ${marker}` } },
					],
				],
			},
			// Attempt 2: helpers six to ten execute; the eleventh is refused.
			{ steps: [reads(5, 5), reads(1, 10)] },
			// Attempt 3: the result write is accepted after exhaustion.
			VALID,
		],
		() => ordinary(),
	);
	const fixture = await startPrivateFixture(
		t,
		"pi-reflect-private-budget-",
		plan,
	);
	const { rpc, tracePath } = fixture;
	await writeFile(
		path.join(fixture.workspace, "evidence.txt"),
		Array.from({ length: 30 }, (_, index) => `evidence-line-${index + 1}`).join(
			"\n",
		),
	);
	await prompt(rpc, "first ordinary turn");
	await settledAfter(rpc, 1);
	await prompt(rpc, "/reflect use evidence");
	await until(
		async () => (await completedHooks(tracePath)).length === 1,
		60_000,
		"hook",
	);
	await settledAfter(rpc, 2);
	await sleep(500);
	await assert.rejects(access(marker), "the forbidden bash call never ran");
	// Requests: initial → five reads; tool results → mixed batch (refused);
	// correction → five reads; tool results → eleventh (refused);
	// correction → valid write (accepted with no further request).
	assertPrivateRequests(fixture, plan, 5);
	const requests = fixture.privateRequests();
	const executedLines = new Set(
		requests
			.flatMap((request) => toolResults(request))
			.flatMap((message) => text(message).match(/evidence-line-\d+/g) ?? []),
	);
	assert.deepEqual(
		[...executedLines].sort(),
		Array.from(
			{ length: 10 },
			(_, index) => `evidence-line-${index + 1}`,
		).sort(),
		"exactly helpers 1-10 executed; the mixed-batch read and the eleventh did not",
	);
	assert.match(
		text(requests[2].body.messages.at(-1)),
		/previous reflection response was invalid: A response must be either one write call to the designated result file, or only read\/ls\/grep\/find evidence calls; nothing was executed/,
	);
	assert.match(
		text(requests[4].body.messages.at(-1)),
		/previous reflection response was invalid: The evidence lookup budget \(10\) is exhausted or would be exceeded; nothing was executed/,
	);
	assert.deepEqual(
		fixture
			.notices()
			.filter((notice) => /^Reflection (attempt|failed)/.test(notice)),
		[
			"Reflection attempt 1/3 invalid: A response must be either one write call to the designated result file, or only read/ls/grep/find evidence calls; nothing was executed; retrying.",
			"Reflection attempt 2/3 invalid: The evidence lookup budget (10) is exhausted or would be exceeded; nothing was executed. Write the result file now; retrying.",
		],
	);
	assert.equal(fixture.mainRequests().length, 2, "accepted result: one wake");
	await assertDeliveryOrder(tracePath);
	assertNoPrivateResidue(fixture, await sessionText(fixture.sessionDir));
});

/** Child whose first response streams slowly (abort target). */
function slowPrivate() {
	return {
		delay: 30_000,
		halfway: 20,
		chunks: [{ content: "thinking " }, { content: "late" }],
	};
}

async function abortAndAssertHeld(fixture, plan, { childRequest }) {
	const { rpc, tracePath } = fixture;
	assert.equal((await rpc.request({ type: "abort" })).success, true);
	if (childRequest)
		await until(
			() => childRequest().abortedAt !== undefined,
			5_000,
			"the child's own stream aborted",
		);
	await sleep(1_500);
	assert.deepEqual(plan.violations, []);
	assert.deepEqual(await completedHooks(tracePath), []);
	assert.equal(
		fixture
			.notices()
			.some((notice) => /^Reflection (failed|attempt)/.test(notice)),
		false,
	);
	const events = await traceEvents(tracePath);
	assert.equal(
		events.some(
			(event) =>
				event.kind === "custom-message" &&
				event.customType === "pi-reflect-watchdog:continuation",
		),
		false,
	);
}

// K (private execution): main abort revokes the exact child — its provider
// stream is closed — publishes nothing, and holds until explicit input.
test("packed private main abort closes the exact child stream, publishes nothing and holds until input", {
	timeout: 120_000,
}, async (t) => {
	const plan = privateReflectionPlan(VALID, (_request, index) =>
		index === 0
			? {
					delay: 6_000,
					halfway: 20,
					chunks: [{ content: "working " }, { content: "done" }],
				}
			: ordinary(),
	);
	let slowOnce = true;
	const routed = (input) => {
		if (isPrivateReflectionRequest(input.request) && slowOnce) {
			slowOnce = false;
			return slowPrivate();
		}
		return plan(input);
	};
	routed.violations = plan.violations;
	const fixture = await startPrivateFixture(
		t,
		"pi-reflect-private-abort-",
		routed,
		{ rootLoopLimit: 1 },
	);
	const { rpc } = fixture;
	await prompt(rpc, "slow ordinary work");
	await until(() => fixture.mainRequests().length === 1, 10_000, "main work");
	await prompt(rpc, "/reflect then abort");
	await until(
		() => fixture.privateRequests().length === 1,
		10_000,
		"private child streaming",
	);
	await abortAndAssertHeld(fixture, plan, {
		childRequest: () => fixture.privateRequests()[0],
	});
	assert.equal(
		fixture.privateRequests().length,
		1,
		"no retry or replacement child",
	);
	assert.equal(fixture.mainRequests().length, 1, "no wake after abort");
	await prompt(rpc, "fresh explicit work");
	await until(
		() => fixture.mainRequests().length === 2,
		10_000,
		"explicit re-entry request",
	);
	assert.doesNotMatch(
		JSON.stringify(fixture.mainRequests()[1].body.messages),
		/then abort|Trigger source/,
	);
	// Explicit input released the hold: the fresh cycle reflects again (root limit 1).
	await until(
		() => fixture.privateRequests().length === 2,
		20_000,
		"fresh cycle",
	);
	assert.match(
		text(fixture.privateRequests()[1].body.messages.at(-1)),
		/Trigger source\(s\): ROOT_LOOP_LIMIT/,
	);
	assertNoPrivateResidue(fixture, await sessionText(fixture.sessionDir));
});

// K (private execution): abort while an admitted helper runs stops the child
// without cancelling unrelated main work.
test("packed private abort during a running helper stops the child and keeps unrelated work", {
	timeout: 120_000,
}, async (t) => {
	const plan = privateReflectionPlan(
		{
			steps: [[{ name: "read", args: { path: "evidence.fifo" } }]],
			result: VALID,
		},
		(_request, index) =>
			index === 0
				? {
						delay: 30_000,
						halfway: 20,
						chunks: [{ content: "working " }, { content: "done" }],
					}
				: ordinary(),
	);
	const fixture = await startPrivateFixture(
		t,
		"pi-reflect-private-helper-",
		plan,
	);
	const { rpc } = fixture;
	const fifo = path.join(fixture.workspace, "evidence.fifo");
	execFileSync("mkfifo", [fifo]);
	// Main is busy streaming; aborting it revokes the exact child.
	await prompt(rpc, "slow ordinary work");
	await until(() => fixture.mainRequests().length === 1, 10_000, "main work");
	await prompt(rpc, "/reflect run a slow helper");
	// Receipt that the admitted helper is executing: the helper call was
	// served and a FIFO with no writer blocks its read indefinitely, so no
	// follow-up request can exist until the test opens a writer.
	await until(
		() => fixture.privateRequests()[0]?.finishedAt !== undefined,
		15_000,
		"helper call served",
	);
	await sleep(1_000);
	assert.equal(fixture.privateRequests().length, 1, "helper still blocked");
	await abortAndAssertHeld(fixture, plan, {});
	// Unblock any still-waiting reader; a late helper result must not reach
	// the provider.
	const writer = await open(
		fifo,
		constants.O_WRONLY | constants.O_NONBLOCK,
	).catch(() => undefined);
	if (writer !== undefined) {
		await writer.write("late-helper-output\n").catch(() => {});
		await writer.close();
	}
	await sleep(2_000);
	assert.equal(
		fixture.privateRequests().length,
		1,
		"no request after the cancelled helper",
	);
	assert.equal(fixture.mainRequests().length, 1, "no wake");
	await prompt(rpc, "unrelated work continues");
	await until(
		() => fixture.mainRequests().length === 2,
		10_000,
		"unrelated work request",
	);
	assert.doesNotMatch(
		JSON.stringify(
			fixture.provider.requests.map((request) => request.body.messages),
		),
		/late-helper-output/,
	);
	assertNoPrivateResidue(fixture, await sessionText(fixture.sessionDir));
});

export { startPrivateFixture, VALID };
