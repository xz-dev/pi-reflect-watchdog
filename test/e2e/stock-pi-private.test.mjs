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
		const value = await predicate();
		if (value) return value;
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
  let sessionManager;
  const record = (kind, value) =>
    appendFileSync(trace + ".events.jsonl", JSON.stringify({ sequence: ++sequence, kind, ...value }) + "\\n");
  // Ordered Reflect entries of the whole session (positions preserved).
  const reflectEntries = () => (sessionManager?.getEntries() ?? [])
    .filter((entry) => entry.type === "custom" && /^pi-reflect-watchdog:reflection/.test(entry.customType))
    .map((entry) => ({ customType: entry.customType, data: entry.data }));
  pi.on("session_start", (_event, ctx) => { sessionManager = ctx.sessionManager; });
  pi.events.on("pi:semantic-hook:v1", (envelope) => {
    if (envelope?.name === "reflection-completed") hookCount += 1;
    appendFileSync(trace, JSON.stringify(envelope) + "\\n");
    // Entries already durable when the hook fires.
    record("hook", { envelope, entries: reflectEntries() });
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "custom") record("custom-message", { customType: event.message.customType, details: event.message.details });
  });
  // Main-session provider requests only: the tracer is not loaded in private children.
  pi.on("before_provider_request", () => {
    record("main-request", { hookCount, entries: reflectEntries() });
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

/** Entries of every private child (fork) transcript under the session dir. */
async function forkEntries(sessionDir) {
	const files = (await readdir(sessionDir, { recursive: true })).filter(
		(file) => file.endsWith(".jsonl") && file.split(path.sep).includes("forks"),
	);
	const entries = [];
	for (const file of files)
		for (const line of (
			await readFile(path.join(sessionDir, file), "utf8")
		).split("\n"))
			if (line) entries.push(JSON.parse(line));
	return entries;
}

async function traceEvents(tracePath) {
	return (await readFile(`${tracePath}.events.jsonl`, "utf8").catch(() => ""))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * For the n-th completed reflection: result entry → completion marker (same
 * correlation, later position) are durable when the hook fires → hook →
 * exactly one continuation message → the wake request. Totals are exact.
 */
async function assertDeliveryOrder(tracePath, index = 0) {
	const findWake = (events, continuation) =>
		continuation &&
		events.find(
			(event) =>
				event.kind === "main-request" &&
				event.sequence > continuation.sequence &&
				event.entries.some(
					(entry) =>
						entry.customType === "pi-reflect-watchdog:reflection-completed" &&
						JSON.stringify(entry.data) ===
							JSON.stringify(continuation.details.correlation),
				),
		);
	// A hook/continuation may be visible before its asynchronous wake request.
	const events = await until(
		async () => {
			const snapshot = await traceEvents(tracePath);
			const continuation = snapshot.filter(
				(event) =>
					event.kind === "custom-message" &&
					event.customType === "pi-reflect-watchdog:continuation",
			)[index];
			return findWake(snapshot, continuation) && snapshot;
		},
		30_000,
		`reflection ${index + 1} correlated wake request`,
	);
	const hookEvents = events.filter(
		(event) =>
			event.kind === "hook" && event.envelope?.name === "reflection-completed",
	);
	const continuations = events.filter(
		(event) =>
			event.kind === "custom-message" &&
			event.customType === "pi-reflect-watchdog:continuation",
	);
	const hook = hookEvents[index];
	const continuation = continuations[index];
	assert.ok(hook, `hook ${index + 1}`);
	assert.ok(continuation, `continuation ${index + 1}`);
	const correlation = continuation.details.correlation;
	// Durable pair at hook time, in append order, for this correlation.
	const positions = (type) =>
		hook.entries
			.map((entry, position) => ({ entry, position }))
			.filter(
				({ entry }) =>
					entry.customType === type &&
					JSON.stringify(
						type === "pi-reflect-watchdog:reflection"
							? entry.data.correlation
							: entry.data,
					) === JSON.stringify(correlation),
			)
			.map(({ position }) => position);
	const result = positions("pi-reflect-watchdog:reflection");
	const marker = positions("pi-reflect-watchdog:reflection-completed");
	assert.equal(result.length, 1, "one durable result when the hook fires");
	assert.equal(marker.length, 1, "one durable marker when the hook fires");
	assert.ok(result[0] < marker[0], "result entry precedes completion marker");
	assert.ok(
		hook.sequence < continuation.sequence,
		"hook precedes continuation",
	);
	if (continuations[index + 1])
		assert.ok(
			hookEvents[index + 1]?.sequence > continuation.sequence,
			"next hook follows this continuation",
		);
	const wake = findWake(events, continuation);
	assert.ok(wake, "a main request follows the continuation");
	assert.equal(
		wake.hookCount,
		index + 1,
		"hook published before the wake request",
	);
	// Exactly-once durable completion: the wake's session holds exactly n
	// results and n markers in total, one of each per correlation.
	const final = (type) =>
		wake.entries.filter((entry) => entry.customType === type);
	const results = final("pi-reflect-watchdog:reflection");
	const markers = final("pi-reflect-watchdog:reflection-completed");
	assert.equal(results.length, index + 1, "exact durable result count");
	assert.equal(markers.length, index + 1, "exact durable marker count");
	assert.deepEqual(
		markers.map((entry) => JSON.stringify(entry.data)),
		results.map((entry) => JSON.stringify(entry.data.correlation)),
		"one marker per result, same correlation and order",
	);
	assert.equal(
		new Set(markers.map((entry) => JSON.stringify(entry.data))).size,
		markers.length,
		"no correlation completes twice",
	);
	assert.deepEqual(
		markers[index].data,
		correlation,
		"this reflection's own pair",
	);
	assert.equal(
		hookEvents.length,
		continuations.length,
		"one hook per continuation",
	);
	return { wake, continuations: continuations.length };
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
		artifact,
		base: resources.base,
		resources,
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

/**
 * Exactly one report of `decision` with `role` and exactly one two-line wake
 * directly after it; the report body carries the decision's plain fields and
 * no raw result transport.
 */
function wakeAfterReport(messages, type, role, decision) {
	const reports = messages
		.map((message, index) => ({ message, index }))
		.filter(({ message }) => text(message).startsWith("Reflection · "));
	const matching = reports.filter(
		({ message }) =>
			message.role === role &&
			text(message).startsWith(`Reflection · ${type}\n`),
	);
	assert.equal(
		matching.length,
		1,
		`one ${type} report reaches main with role ${role}`,
	);
	const reportIndex = matching[0].index;
	const body = text(messages[reportIndex]);
	if (decision !== undefined) {
		const lines = body.split("\n");
		assert.deepEqual(lines.slice(-4), [
			`Reason: ${decision.reason}`,
			`Done: ${decision.done}`,
			`Current step: ${decision.current_step}`,
			`Next step: ${decision.next_step}`,
		]);
	}
	assert.doesNotMatch(
		body,
		/"type"\s*:|"current_step"|private_inquiry_result_file/,
	);
	assert.equal(text(messages[reportIndex + 1]), "[assistant]\ncontinue");
	assert.equal(messages[reportIndex + 1].role, "user");
	assert.equal(
		messages.filter((message) => text(message) === "[assistant]\ncontinue")
			.length,
		reports.length,
		"one wake per delivered report",
	);
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
	assert.deepEqual(
		(await assertDeliveryOrder(tracePath)).continuations,
		1,
		"exact continuation count",
	);
	wakeAfterReport(
		fixture.mainRequests()[1].body.messages,
		"NO_ISSUE",
		"user",
		VALID,
	);
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
		{ ...VALID, type: "ROUTE_CORRECTION" },
	);
	assert.deepEqual(
		(await assertDeliveryOrder(tracePath)).continuations,
		1,
		"exact continuation count",
	);
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
	assert.deepEqual(
		(await assertDeliveryOrder(tracePath, 1)).continuations,
		2,
		"exact continuation count",
	);
	// The wake must also complete a real main provider turn.
	settled += 1;
	await settledAfter(rpc, settled);
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
	const reportIndex = wakeAfterReport(messages, "NO_ISSUE", "user", VALID);
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
	assert.deepEqual(
		(await assertDeliveryOrder(tracePath)).continuations,
		1,
		"exact continuation count",
	);
	assertNoPrivateResidue(fixture, await sessionText(fixture.sessionDir));
});

// Replaces packed: schema-invalid correction, each-invalid-retry, hidden result
// (K: exact attempt requests, per-attempt warnings, one hook; second reflection
// carries the prior report and the original parent locator).
test("packed private correction: exact requests and warnings, then a second reflection sees the prior report and parent locator", {
	timeout: 120_000,
}, async (t) => {
	// First: invalid, then a ROUTE_CORRECTION; second (fresh child): a
	// distinct NO_ISSUE at once.
	const FIRST = {
		type: "ROUTE_CORRECTION",
		reason: "first route drifted",
		done: "first inspection",
		current_step: "first current",
		next_step: "first next",
	};
	const SECOND = {
		type: "NO_ISSUE",
		reason: "second route sound",
		done: "second inspection",
		current_step: "second current",
		next_step: "second next",
	};
	const plan = privateReflectionPlan(
		(request) =>
			requestText(request).includes(
				"User supplement: verify the corrected route",
			)
				? SECOND
				: [{ ...FIRST, type: "BOGUS" }, FIRST],
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
	wakeAfterReport(
		fixture.mainRequests()[1].body.messages,
		"ROUTE_CORRECTION",
		"user",
		FIRST,
	);
	assert.deepEqual(
		(await assertDeliveryOrder(tracePath)).continuations,
		1,
		"exact continuation count",
	);
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
	// The prior report, in full plain form, is the earlier-reflection history.
	const firstReport = text(
		fixture
			.mainRequests()[1]
			.body.messages.find((message) =>
				text(message).startsWith("Reflection · ROUTE_CORRECTION\n"),
			),
	);
	assert.ok(
		second.includes(
			`Earlier assistant reflection (fallible historical analysis, not the user's words or a conclusion to preserve):\n`,
		),
	);
	const history = second.split(
		"Earlier assistant reflection (fallible historical analysis, not the user's words or a conclusion to preserve):\n",
	)[1];
	assert.ok(
		history.split("\n").slice(1).join("\n").startsWith(firstReport),
		"the full prior report body follows its timestamp",
	);
	for (const line of [
		"Reason: first route drifted",
		"Done: first inspection",
		"Current step: first current",
		"Next step: first next",
	])
		assert.ok(second.includes(line), line);
	assert.doesNotMatch(
		second,
		/"type":"ROUTE_CORRECTION"|"current_step":"first current"/,
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
	const third = fixture.mainRequests()[2].body.messages;
	wakeAfterReport(third, "ROUTE_CORRECTION", "user", FIRST);
	wakeAfterReport(third, "NO_ISSUE", "user", SECOND);
	assert.deepEqual(
		(await assertDeliveryOrder(tracePath, 1)).continuations,
		2,
		"exact continuation count",
	);
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
	const notices = fixture
		.notices()
		.filter((notice) => /^Reflection (attempt|failed)/.test(notice));
	assert.match(
		notices[2] ?? "",
		/^Reflection failed: the private reflection exhausted its result corrections\.\nLast error: reflection field reason must be a non-empty string\nPrivate session JSONL retained: (.+)$/,
	);
	const retained = notices[2].match(/retained: (.+)$/)[1];
	assert.ok(path.isAbsolute(retained), "notice shows the full absolute path");
	// The displayed locator opens the exact failed child's retained JSONL
	// after operation cleanup: it lives under forks/, persists the inquiry
	// and correction exchanges, and is not the parent session file.
	assert.ok(
		retained.split(path.sep).includes("forks"),
		"retained evidence is the private fork, never the parent session",
	);
	const retainedEntries = (await readFile(retained, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const retainedText = JSON.stringify(retainedEntries);
	assert.match(
		retainedText,
		/previous reflection response was invalid/,
		"correction exchanges persisted in the exact child",
	);
	assert.doesNotMatch(
		notices.join("\n"),
		/private_inquiry_result_file|fixture checked|route is sound/,
		"notices carry no private content, only the path and safe summary",
	);
	assert.deepEqual(notices.slice(0, 2), [
		"Reflection attempt 1/3 invalid: reflection field reason must be a non-empty string; retrying.",
		"Reflection attempt 2/3 invalid: reflection field reason must be a non-empty string; retrying.",
	]);
	assert.deepEqual(await completedHooks(tracePath), []);
	assert.equal(fixture.mainRequests().length, 1, "no main traffic");
	assertNoPrivateResidue(fixture, await sessionText(fixture.sessionDir));
});

// A returned execution failure after the native fork JSONL exists notifies
// once with the verified retained path; the file opens the exact child.
test("packed private provider failure: one failure notice with the retained child JSONL", {
	timeout: 90_000,
}, async (t) => {
	const plan = ({ request }) =>
		isPrivateReflectionRequest(request)
			? {
					delay: 20,
					chunks: [{ content: "partial private reply" }],
					finishReason: "error",
				}
			: ordinary();
	const fixture = await startPrivateFixture(
		t,
		"pi-reflect-private-exec-fail-",
		plan,
	);
	const { rpc, tracePath } = fixture;
	await prompt(rpc, "first ordinary turn");
	await settledAfter(rpc, 1);
	await prompt(rpc, "/reflect fail");
	await until(
		() => fixture.notices().some((notice) => /^Reflection failed/.test(notice)),
		60_000,
		"execution failure notice",
	);
	await sleep(1_000);
	const failures = fixture
		.notices()
		.filter((notice) => /^Reflection (failed|attempt)/.test(notice));
	assert.equal(failures.length, 1, "one bounded terminal notice");
	assert.match(
		failures[0],
		/^Reflection failed: the private reflection ended in an execution error\.\nLast error: .+\nPrivate session JSONL retained: /,
		"host-owned summary plus the bounded final-error preview",
	);
	const previewRows = failures[0]
		.split("\n")
		.slice(1)
		.filter((line) => !line.startsWith("Private session"));
	assert.ok(
		previewRows.length <= 2,
		`error preview stays within two rows: ${JSON.stringify(failures[0])}`,
	);
	assert.equal(
		previewRows.length >= 1 && previewRows[0].startsWith("Last error: "),
		true,
		"error preview carries its label on the first row",
	);
	const retained = failures[0].match(/retained: (.+)$/)?.[1];
	assert.ok(retained, `notice carries a retained path: ${failures[0]}`);
	assert.ok(path.isAbsolute(retained));
	assert.ok(retained.split(path.sep).includes("forks"));
	const entries = (await readFile(retained, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	assert.ok(
		JSON.stringify(entries).includes("private_inquiry_result_file"),
		"the exact child's persisted inquiry is inside the retained file",
	);
	assert.doesNotMatch(
		failures[0],
		/partial private reply|private_inquiry_result_file/,
		"the notice echoes no provider body or private content",
	);
	assert.deepEqual(await completedHooks(tracePath), []);
	assert.equal(fixture.mainRequests().length, 1, "no main traffic");
	assertNoPrivateResidue(fixture, await sessionText(fixture.sessionDir));
});

// Replaces packed: child limit steers idle main exactly once (R: inquiry
// reservation/consumption; K: child-triggered completion, accounting snapshot,
// durable pair, one hook, one wake).
test("packed private child-triggered reflection: a peer Pi turn crosses the all-loop limit; idle main reflects and wakes once", {
	timeout: 120_000,
}, async (t) => {
	const CHILD = {
		type: "NO_ISSUE",
		reason: "child limit checked",
		done: "child completed",
		current_step: "resume main",
		next_step: "continue",
	};
	const plan = privateReflectionPlan(CHILD, (request) =>
		requestText(request).includes("fresh child ordinary turn")
			? { delay: 20, chunks: [{ content: "child ordinary turn finished" }] }
			: ordinary(),
	);
	const fixture = await startPrivateFixture(
		t,
		"pi-reflect-private-child-",
		plan,
		{ rootLoopLimit: 60, allLoopLimit: 2 },
		installFromPack,
		`pi.on("session_start", () => {
  appendFileSync(process.env.PI_WATCHDOG_HOOK_TRACE + ".domain", String(process.env.PI_EXTENSION_UTILS_PROCESS_DOMAIN ?? ""));
});`,
	);
	const { rpc, tracePath, provider } = fixture;
	const declaration = await until(
		async () =>
			(await readFile(`${tracePath}.domain`, "utf8").catch(() => "")) ||
			undefined,
		10_000,
		"main process-domain declaration",
	);
	const childEnv = await createIsolatedEnvironment(
		path.join(fixture.base, "peer"),
	);
	await writeJson(path.join(childEnv.agentDir, "settings.json"), {
		packages: [fixture.artifact.packagePath],
		defaultProjectTrust: "never",
	});
	await writeJson(
		path.join(childEnv.agentDir, "models.json"),
		modelConfig(provider.baseUrl),
	);
	const peer = new RpcPi({
		cwd: childEnv.workspace,
		env: { ...childEnv.env, PI_EXTENSION_UTILS_PROCESS_DOMAIN: declaration },
		launcherArgs: [
			"--mode",
			"rpc",
			"--provider",
			"watchdog-fixture",
			"--model",
			"watchdog-fixture",
		],
	});
	fixture.resources.add(() => peer.close());
	await assertSingleWatchdogCommand(peer, fixture.artifact.entry);
	// Private execution forks from main's latest persisted anchor, so main
	// first persists one ordinary loop (all=1/2); the peer's turn crosses it.
	await prompt(rpc, "first ordinary turn");
	await settledAfter(rpc, 1);
	assert.equal(
		(await rpc.request({ type: "get_state" })).data.isStreaming,
		false,
		"main idle",
	);
	await prompt(peer, "fresh child ordinary turn");
	await until(
		async () => (await completedHooks(tracePath)).length === 1,
		30_000,
		"hook",
	);
	const isPeer = (request) =>
		requestText(request).includes("fresh child ordinary turn");
	await until(
		() =>
			fixture.mainRequests().filter((request) => !isPeer(request)).length === 2,
		30_000,
		"main wake",
	);
	await settledAfter(rpc, 2);
	await sleep(1_000);
	assertPrivateRequests(fixture, plan, 1);
	const privateRequest = fixture.privateRequests()[0];
	assert.match(
		text(privateRequest.body.messages.at(-1)),
		/Trigger source\(s\): ALL_LOOP_LIMIT\n/,
	);
	const childRequest = provider.requests.find(
		(request) =>
			!isPrivateReflectionRequest(request) &&
			requestText(request).includes("fresh child ordinary turn"),
	);
	assert.ok(
		childRequest.finishedAt < privateRequest.startedAt,
		"peer response finished before the reflection started",
	);
	const mainRequests = fixture
		.mainRequests()
		.filter((request) => !isPeer(request));
	assert.equal(mainRequests.length, 2, "ordinary turn, then exactly one wake");
	assert.ok(mainRequests[1].startedAt > privateRequest.finishedAt);
	wakeAfterReport(
		mainRequests[1].body.messages,
		"NO_ISSUE",
		"assistant",
		CHILD,
	);
	const { wake } = await assertDeliveryOrder(tracePath);
	const result = wake.entries.find(
		(entry) => entry.customType === "pi-reflect-watchdog:reflection",
	);
	assert.equal(
		result.data.thresholds.rootLoops,
		1,
		"only main's own loop counts as root; the peer loop never inflates it",
	);
	assert.equal(
		result.data.thresholds.allLoops,
		2,
		"peer turn crossed the all-loop limit",
	);
	assert.equal(
		rpc.events.some(
			({ message }) =>
				message.type === "message_end" &&
				message.message?.stopReason === "aborted",
		),
		false,
	);
	assert.deepEqual(await completedHooks(tracePath), [
		{
			version: 1,
			name: "reflection-completed",
			values: {
				REFLECTION_TYPE: "NO_ISSUE",
				REASON: "child limit checked",
				NEXT_STEP: "continue",
			},
		},
	]);
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
	assert.deepEqual(
		(await assertDeliveryOrder(tracePath)).continuations,
		1,
		"exact continuation count",
	);
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
	// Start receipt: the child persisted the helper call and no result yet;
	// with no FIFO writer the read cannot settle normally.
	const helperResultOf = (entries) =>
		entries.find(
			(entry) =>
				entry.message?.role === "toolResult" &&
				entry.message.toolCallId === "helper-0-0-0",
		);
	await until(
		async () =>
			(await forkEntries(fixture.sessionDir)).some((entry) =>
				(entry.message?.content ?? []).some?.(
					(part) => part.id === "helper-0-0-0",
				),
			),
		10_000,
		"helper call persisted in the child",
	);
	await sleep(500);
	assert.equal(
		helperResultOf(await forkEntries(fixture.sessionDir)),
		undefined,
		"helper still running",
	);
	assert.equal(fixture.privateRequests().length, 1);
	await abortAndAssertHeld(fixture, plan, {});
	// Receipt from the exact child transcript: the helper itself settled
	// through its abort signal while the FIFO still had no writer (the read
	// cannot complete normally before the test opens one below).
	const childEntries = await until(
		async () => {
			const entries = await forkEntries(fixture.sessionDir);
			return helperResultOf(entries) ? entries : undefined;
		},
		5_000,
		"helper settled by abort while the FIFO had no writer",
	);
	const helperResult = helperResultOf(childEntries).message;
	assert.equal(
		text(helperResult),
		"Operation aborted",
		"helper cancelled by its abort signal",
	);
	assert.equal(helperResult.isError, true);
	const childAssistants = childEntries.filter(
		(entry) => entry.message?.role === "assistant",
	);
	assert.equal(
		childAssistants.length,
		2,
		"helper call, then one terminal child settlement",
	);
	assert.notEqual(
		childAssistants[1].message.stopReason,
		"stop",
		"the child did not finish normally",
	);
	// Free the SDK's abandoned fs open (the read tool cannot cancel it); any
	// late bytes must never reach a provider request.
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
