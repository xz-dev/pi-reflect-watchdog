import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Explicit isolated SDK input: never resolve this probe against global Pi.
const sdkRoot = process.env.PI_REFLECT_PROBE_SDK_ROOT;
assert.ok(
	sdkRoot,
	"Set PI_REFLECT_PROBE_SDK_ROOT to stock Pi 1.3.0 package directory.",
);
const sdk = await import(
	pathToFileURL(join(resolve(sdkRoot), "dist/index.js"))
);
const ai = await import(
	pathToFileURL(join(resolve(sdkRoot), "../pi-ai/dist/index.js"))
);
const metadata = JSON.parse(
	await readFile(join(sdkRoot, "package.json"), "utf8"),
);
assert.equal(metadata.version, "1.3.0");
assert.equal(metadata.name, "@earendil-works/pi-coding-agent");
const hash = createHash("sha256")
	.update(await readFile(join(sdkRoot, "dist/core/agent-session.js")))
	.digest("hex");
console.log(
	JSON.stringify({
		sdk: metadata.version,
		sdkRoot: resolve(sdkRoot),
		agentSessionSha256: hash,
	}),
);

const marker = "reflect-feasibility-slot";
const text = (value) => [{ type: "text", text: value }];
const messageText = (message) =>
	typeof message.content === "string"
		? message.content
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
const call = (id) => ({
	type: "toolCall",
	id,
	name: "lookup",
	arguments: { id },
});
const deferred = () => Promise.withResolvers();
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function fixture(t) {
	const root = await mkdtemp("/var/tmp/reflect-feasibility-");
	const sessions = [];
	const errors = [];
	t.after(async () => {
		for (const session of sessions) {
			await session.abort();
			session.dispose();
		}
		await rm(root, { recursive: true, force: true });
		assert.deepEqual(
			errors,
			[],
			"Probe extension handlers must not fail silently",
		);
	});
	return {
		root,
		async session({
			name,
			reply,
			extension = () => {},
			manager,
			retry = false,
			tools = [],
			customTools = [],
		}) {
			const agentDir = join(root, name);
			await mkdir(agentDir);
			const runtime = await sdk.ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: null,
			});
			const requests = [];
			runtime.registerProvider("reflect-feasibility", {
				baseUrl: "http://127.0.0.1:1",
				apiKey: "local-fixture-not-a-credential",
				api: "openai-completions",
				models: [
					{
						id: "fixture",
						name: "Local fixture",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 32768,
						maxTokens: 1024,
					},
				],
				streamSimple(model, context, options) {
					requests.push(structuredClone(context));
					const stream = ai.createAssistantMessageEventStream();
					queueMicrotask(async () => {
						try {
							stream.push({
								type: "start",
								partial: {
									role: "assistant",
									content: [],
									provider: model.provider,
									api: model.api,
									model: model.id,
									timestamp: Date.now(),
									usage,
									stopReason: "pending",
								},
							});
							const response = await reply(requests.length, context, options);
							const content = response.content ?? text("ordinary reply");
							const stopReason =
								response.stopReason ??
								(content.some((part) => part.type === "toolCall")
									? "toolUse"
									: "stop");
							const message = {
								role: "assistant",
								content,
								provider: model.provider,
								api: model.api,
								model: model.id,
								timestamp: Date.now(),
								usage,
								stopReason,
								...(response.errorMessage
									? { errorMessage: response.errorMessage }
									: {}),
							};

							stream.push(
								stopReason === "error" || stopReason === "aborted"
									? { type: "error", reason: stopReason, error: message }
									: { type: "done", reason: stopReason, message },
							);
						} catch (error) {
							stream.end();
							errors.push(String(error));
						}
					});
					return stream;
				},
			});
			const settings = sdk.SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: retry, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
			});
			let api;
			let context;
			const loader = new sdk.DefaultResourceLoader({
				cwd: root,
				agentDir,
				settingsManager: settings,
				noExtensions: true,
				noSkills: true,
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(pi) => {
						api = pi;
						pi.on("session_start", (_event, ctx) => {
							context = ctx;
						});
						extension(pi);
					},
				],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const { session } = await sdk.createAgentSession({
				cwd: root,
				agentDir,
				modelRuntime: runtime,
				model: runtime.getModel("reflect-feasibility", "fixture"),
				settingsManager: settings,
				resourceLoader: loader,
				sessionManager:
					manager ??
					sdk.SessionManager.create(root, join(agentDir, "sessions")),
				tools,
				customTools,
			});
			sessions.push(session);
			await session.bindExtensions({
				mode: "print",
				onError: (error) => errors.push(error),
			});
			return { session, api, context, requests };
		},
	};
}

function registerLookup(pi, execute) {
	pi.registerTool({
		name: "lookup",
		label: "Probe lookup",
		description: "Read-only probe capability",
		parameters: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		execute,
	});
}

for (const mode of ["one-at-a-time", "all"]) {
	test(`1.1 marker preserves ${mode} queue order but still forces an empty-result parent request`, {
		timeout: 15000,
	}, async (t) => {
		const f = await fixture(t);
		const first = deferred();
		const second = deferred();
		const started = deferred();
		const trace = [];
		let child;
		let source;
		const parent = await f.session({
			name: "parent",
			tools: ["lookup"],
			reply: async (number, context) => {
				trace.push(`parent-request:${number}`);
				assert.ok(!JSON.stringify(context).includes(marker));
				return {
					content:
						number === 1
							? [call("first"), call("second")]
							: text(`ordinary:${number}`),
				};
			},
			extension(pi) {
				registerLookup(pi, async (_id, args) => {
					trace.push(`tool-start:${args.id}`);
					if (args.id === "first") started.resolve();
					await (args.id === "first" ? first.promise : second.promise);
					trace.push(`tool-end:${args.id}`);
					return { content: text(args.id), details: undefined };
				});
				pi.on("message_end", async (event, ctx) => {
					if (
						event.message.role !== "custom" ||
						event.message.customType !== marker
					)
						return;
					trace.push("slot");
					source = ctx.sessionManager.buildSessionContext().messages;
					const manager = sdk.SessionManager.forkFrom(
						ctx.sessionManager.getSessionFile(),
						f.root,
						join(f.root, "child-sessions"),
					);
					child = await f.session({
						name: "private-child",
						manager,
						reply: async () => {
							trace.push("private-request");
							return { content: text("NO_RESULT") };
						},
					});
					await child.session.prompt(
						"PRIVATE_PROBE: no valid result; authorize no parent continuation.",
					);
					trace.push("private-finished-without-result");
				});
				pi.on("context", (event) => ({
					messages: event.messages.filter(
						(message) =>
							message.role !== "custom" || message.customType !== marker,
					),
				}));
			},
		});
		parent.session.setSteeringMode(mode);
		t.after(() => {
			first.resolve();
			second.resolve();
		});
		const run = parent.session.prompt("ordinary work");
		await started.promise;
		await parent.session.steer("EARLIER_USER_STEERING");
		parent.api.sendMessage(
			{ customType: marker, content: "", display: false },
			{ deliverAs: "steer", triggerTurn: true },
		);
		second.resolve();
		first.resolve();
		await run;
		assert.ok(child);
		assert.notEqual(child.session.sessionId, parent.session.sessionId);
		assert.ok(trace.indexOf("slot") > trace.indexOf("tool-end:first"));
		assert.ok(trace.indexOf("slot") > trace.indexOf("tool-end:second"));
		assert.equal(
			source.filter((message) => message.role === "toolResult").length,
			2,
		);
		assert.ok(
			source.some(
				(message) =>
					message.role === "user" &&
					messageText(message) === "EARLIER_USER_STEERING",
			),
		);
		assert.equal(
			source.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.text === "ordinary:2"),
			),
			mode === "one-at-a-time",
		);
		assert.equal(parent.requests.length, mode === "one-at-a-time" ? 3 : 2);
		assert.ok(
			trace.at(-1).startsWith("parent-request:"),
			"Context exclusion does not cancel the slot's model request",
		);
		assert.ok(
			!JSON.stringify(parent.session.messages).includes("PRIVATE_PROBE"),
		);
		t.diagnostic(
			JSON.stringify({
				gate: "BLOCKED_NO_RESULT_SLOT",
				mode,
				trace,
				parentRequests: parent.requests.length,
			}),
		);
	});
}

test("1.1 awaited turn_end work overtakes earlier queued steering", {
	timeout: 10000,
}, async (t) => {
	const f = await fixture(t);
	const generating = deferred();
	const release = deferred();
	let source;
	const parent = await f.session({
		name: "parent",
		reply: async (number) => {
			if (number === 1) {
				generating.resolve();
				await release.promise;
			}
			return { content: text(`ordinary:${number}`) };
		},
		extension(pi) {
			pi.on("turn_end", async (event, ctx) => {
				if (event.turnIndex !== 0) return;
				source = ctx.sessionManager.buildSessionContext().messages;
				assert.ok(
					event.context.pendingMessages.some(
						(message) => message.role === "user",
					),
				);
			});
		},
	});
	t.after(() => release.resolve());
	const run = parent.session.prompt("ordinary work");
	await generating.promise;
	await parent.session.steer("EARLIER_USER_STEERING");
	release.resolve();
	await run;
	assert.ok(
		!source.some(
			(message) =>
				message.role === "user" &&
				messageText(message) === "EARLIER_USER_STEERING",
		),
	);
	t.diagnostic(
		"BLOCKED_TURN_END_ORDER: awaitability does not deliver earlier native steering first",
	);
});

test("1.1 idle marker also forces a provider request when its private operation yields no result", {
	timeout: 10000,
}, async (t) => {
	const f = await fixture(t);
	let consumed = 0;
	const parent = await f.session({
		name: "parent",
		reply: async () => ({ content: text("spurious assessment") }),
		extension(pi) {
			pi.on("message_end", (event) => {
				if (
					event.message.role === "custom" &&
					event.message.customType === marker
				)
					consumed++;
			});
			pi.on("context", (event) => ({
				messages: event.messages.filter(
					(message) =>
						message.role !== "custom" || message.customType !== marker,
				),
			}));
		},
	});
	await parent.session.sendCustomMessage(
		{ customType: marker, content: "", display: false },
		{ deliverAs: "steer", triggerTurn: true },
	);
	assert.equal(consumed, 1);
	assert.equal(parent.requests.length, 1);
	t.diagnostic(
		"BLOCKED_IDLE_SLOT: triggerTurn consumes an empty scheduling marker and still invokes provider",
	);
});

test("1.2 SDK built-in is callable; inherited extension declaration is not a callable capability", {
	timeout: 10000,
}, async (t) => {
	const f = await fixture(t);
	let factoryLoads = 0;
	let executions = 0;
	const parent = await f.session({
		name: "parent",
		tools: ["lookup"],
		reply: async () => ({}),
		extension(pi) {
			factoryLoads++;
			registerLookup(pi, async () => {
				executions++;
				return { content: text("lookup"), details: undefined };
			});
		},
	});
	const lookup = parent.api
		.getAllTools()
		.find((tool) => tool.name === "lookup");
	assert.ok(lookup);
	assert.equal(lookup.execute, undefined);
	assert.equal(parent.context.executeTool, undefined);
	const reader = sdk.createReadTool(f.root);
	const result = await reader.execute(
		"read-fixture",
		{ path: join(sdkRoot, "package.json") },
		new AbortController().signal,
	);
	assert.match(JSON.stringify(result.content), /1\.3\.0/);
	assert.equal(factoryLoads, 1);
	assert.equal(executions, 0);
	t.diagnostic(
		"BLOCKED_EXTENSION_HELPER: getAllTools is metadata; lifecycle context has no executeTool. Built-in read works independently; shared ten-call/batch/cancel profile remains unavailable.",
	);
});

test("1.3 idle parent's official state does not observe a separate working child", {
	timeout: 10000,
}, async (t) => {
	const f = await fixture(t);
	const working = deferred();
	const release = deferred();
	const parent = await f.session({ name: "parent", reply: async () => ({}) });
	const child = await f.session({
		name: "private-child",
		reply: async () => {
			working.resolve();
			await release.promise;
			return {};
		},
	});
	t.after(() => release.resolve());
	const run = child.session.prompt("private work");
	await working.promise;
	assert.equal(parent.context.isIdle(), true);
	assert.equal(child.context.isIdle(), false);
	assert.equal(
		parent.session.messages.filter((message) => message.role === "assistant")
			.length,
		0,
	);
	release.resolve();
	await run;
	assert.equal(child.context.isIdle(), true);
	t.diagnostic(
		"SHARED_INPUT_REQUIRED: exact child's official idle observation; parent isIdle alone omits child working time",
	);
});

for (const succeeds of [true, false]) {
	test(`1.3 stock native provider retry ${succeeds ? "recovers" : "exhausts"} without a normal failed turn`, {
		timeout: 10000,
	}, async (t) => {
		const f = await fixture(t);
		const observations = [];
		const events = [];
		const parent = await f.session({
			name: "parent",
			retry: true,
			reply: async (number) =>
				number === 3 && succeeds
					? { content: text("valid terminal response") }
					: {
							content: [],
							stopReason: "error",
							errorMessage: "503 overloaded",
						},
			extension(pi) {
				pi.on("turn_end", (event, ctx) =>
					observations.push({ outcome: event.outcome, idle: ctx.isIdle() }),
				);
			},
		});
		parent.session.subscribe((event) => {
			if (event.type.startsWith("auto_retry")) events.push(event.type);
		});
		await parent.session.prompt("probe native retry");
		assert.equal(parent.requests.length, 3);
		assert.deepEqual(
			observations.map((entry) => entry.outcome),
			["error", "error", succeeds ? "completed" : "error"],
		);
		assert.ok(observations.every((entry) => entry.idle === false));
		assert.equal(parent.context.isIdle(), true);
		assert.equal(
			events.filter((event) => event === "auto_retry_start").length,
			2,
		);
		t.diagnostic(
			JSON.stringify({
				scope: "native SDK only; shared profile not implemented",
				succeeds,
				observations,
				events,
			}),
		);
	});
}

// Round 2 tests only public alternatives and producer-supplied capabilities.
test("1.1 continue:false does not consume a reserved steering slot without a request", {
	timeout: 10000,
}, async (t) => {
	const release = deferred();
	t.after(() => release.resolve());
	const f = await fixture(t);
	const started = deferred();
	let sawPendingSlot = false;
	const parent = await f.session({
		name: "parent",
		reply: async (number) => {
			if (number === 1) {
				started.resolve();
				await release.promise;
			}
			return { content: text(`ordinary:${number}`) };
		},
		extension(pi) {
			pi.on("turn_end", (event) => {
				sawPendingSlot ||= event.context.pendingMessages.some(
					(message) =>
						message.role === "custom" && message.customType === marker,
				);
				return { continue: false };
			});
			pi.on("context", (event) => ({
				messages: event.messages.filter(
					(message) =>
						message.role !== "custom" || message.customType !== marker,
				),
			}));
		},
	});
	const run = parent.session.prompt("ordinary work");
	await started.promise;
	parent.api.sendMessage(
		{ customType: marker, content: "", display: false },
		{ deliverAs: "steer", triggerTurn: true },
	);
	release.resolve();
	await run;
	assert.equal(sawPendingSlot, true);
	assert.equal(parent.requests.length, 2);
	t.diagnostic(
		"BLOCKED_BOUNDARY_FALSE: false withdraws explicit continuation, not native queued work",
	);
});

test("1.1 nextTurn does not wake an idle parent even with triggerTurn:true", {
	timeout: 10000,
}, async (t) => {
	const f = await fixture(t);
	let delivered = 0;
	const parent = await f.session({
		name: "parent",
		reply: async () => ({}),
		extension(pi) {
			pi.on("message_end", (event) => {
				if (
					event.message.role === "custom" &&
					event.message.customType === marker
				)
					delivered++;
			});
		},
	});
	await parent.session.sendCustomMessage(
		{ customType: marker, content: "", display: false },
		{ deliverAs: "nextTurn", triggerTurn: true },
	);
	assert.equal(parent.context.isIdle(), true);
	assert.equal(delivered, 0);
	assert.equal(parent.requests.length, 0);
	await parent.session.prompt("later explicit user input");
	assert.equal(delivered, 1);
	t.diagnostic(
		"BLOCKED_NEXTTURN_IDLE: marker only delivers when another run starts",
	);
});

test("1.1 busy nextTurn marker misses the next assistant boundary", {
	timeout: 10000,
}, async (t) => {
	const release = deferred();
	t.after(() => release.resolve());
	const f = await fixture(t);
	const started = deferred();
	const deliveredAt = [];
	let requests = 0;
	const parent = await f.session({
		name: "parent",
		tools: ["lookup"],
		reply: async (number) => {
			requests = number;
			return {
				content: number === 1 ? [call("first")] : text(`ordinary:${number}`),
			};
		},
		extension(pi) {
			registerLookup(pi, async () => {
				started.resolve();
				await release.promise;
				return { content: text("read done"), details: undefined };
			});
			pi.on("message_end", (event) => {
				if (
					event.message.role === "custom" &&
					event.message.customType === marker
				)
					deliveredAt.push(requests);
			});
		},
	});
	const run = parent.session.prompt("ordinary work");
	await started.promise;
	await parent.session.sendCustomMessage(
		{ customType: marker, content: "", display: false },
		{ deliverAs: "nextTurn", triggerTurn: true },
	);
	release.resolve();
	await run;
	assert.equal(parent.requests.length, 2);
	assert.deepEqual(deliveredAt, []);
	await parent.session.prompt("later explicit user input");
	assert.deepEqual(deliveredAt, [2]);
	assert.equal(parent.requests.length, 3);
	t.diagnostic(
		"BLOCKED_NEXTTURN_BUSY: ordinary tool follow-up runs before marker; marker waits for new run",
	);
});

test("1.2 explicit built-in evidence tools execute inside an isolated SDK child", {
	timeout: 10000,
}, async (t) => {
	const f = await fixture(t);
	const child = await f.session({
		name: "private-child",
		tools: ["read", "ls"],
		reply: async (number) => ({
			content:
				number === 1
					? [
							{
								type: "toolCall",
								id: "read-package",
								name: "read",
								arguments: { path: join(sdkRoot, "package.json") },
							},
							{
								type: "toolCall",
								id: "list-fixture",
								name: "ls",
								arguments: { path: f.root },
							},
						]
					: text("evidence obtained"),
		}),
	});
	await child.session.prompt("read local evidence only");
	const results = child.session.messages.filter(
		(message) => message.role === "toolResult",
	);
	assert.equal(results.length, 2);
	assert.ok(results.every((result) => !result.isError));
	assert.match(
		messageText(results.find((result) => result.toolName === "read")),
		/1\.3\.0/,
	);
	assert.match(
		messageText(results.find((result) => result.toolName === "ls")),
		/private-child/,
	);
	assert.deepEqual(child.api.getActiveTools().sort(), ["ls", "read"]);
	t.diagnostic(
		"SDK_CAPABILITY_SUPPORTED: explicit local read/ls; not an approved complete Reflect helper profile",
	);
});

test("1.2 explicitly supplied cooperative helper gets child context and exact-child cancellation", {
	timeout: 10000,
}, async (t) => {
	const releaseParent = deferred();
	t.after(() => releaseParent.resolve());
	const f = await fixture(t);
	const parentStarted = deferred();
	const helperStarted = deferred();
	let parentFactoryLoads = 0;
	let observedSession;
	let helperSignal;
	let childAborted = false;
	const capability = {
		name: "lookup",
		label: "Cooperative lookup",
		description: "Explicit producer-supplied fixture capability",
		parameters: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		execute(_id, _args, signal, _update, ctx) {
			observedSession = ctx.sessionManager.getSessionId();
			helperSignal = signal;
			helperStarted.resolve();
			return new Promise((_resolve, reject) => {
				if (signal.aborted) reject(new Error("Operation aborted"));
				else
					signal.addEventListener(
						"abort",
						() => reject(new Error("Operation aborted")),
						{ once: true },
					);
			});
		},
	};
	const parent = await f.session({
		name: "parent",
		tools: ["lookup"],
		reply: async () => {
			parentStarted.resolve();
			await releaseParent.promise;
			return {};
		},
		extension(pi) {
			parentFactoryLoads++;
			pi.registerTool(capability);
		},
	});
	const child = await f.session({
		name: "private-child",
		tools: ["lookup"],
		customTools: [capability],
		reply: async () => ({ content: [call("cooperative-read")] }),
	});
	child.session.subscribe((event) => {
		if (event.type === "agent_settled") childAborted = event.aborted;
	});
	const parentRun = parent.session.prompt("ordinary work");
	await parentStarted.promise;
	const childRun = child.session.prompt("bounded cooperative lookup");
	await helperStarted.promise;
	assert.equal(observedSession, child.session.sessionId);
	assert.notEqual(observedSession, parent.session.sessionId);
	await child.session.abort();
	await childRun;
	assert.equal(helperSignal.aborted, true);
	assert.equal(childAborted, true);
	assert.equal(parent.context.isIdle(), false);
	assert.equal(parentFactoryLoads, 1);
	assert.equal(child.requests.length, 1);
	releaseParent.resolve();
	await parentRun;
	t.diagnostic(
		"SDK_CAPABILITY_SUPPORTED: explicit producer reference, no factory reload; arbitrary installed extension tools remain unavailable",
	);
});

// Round 3: approved background/result-only delivery; these fixtures are not the shared executor.
function publishCandidate(parent, trace) {
	parent.api.appendEntry("probe:reflection", { type: "NO_ISSUE" });
	parent.api.appendEntry("probe:reflection-completed", { completed: true });
	trace.push("durable", "hook");
	parent.api.sendMessage(
		{
			customType: "probe:feedback",
			content: "ACCEPTED_REPORT\nContinue ordinary work.",
			display: false,
		},
		{ deliverAs: "steer", triggerTurn: true },
	);
}

test("background: parent progresses independently, frozen source stays fixed, busy feedback follows whole batch and earlier steering", {
	timeout: 15000,
}, async (t) => {
	const releaseTool = deferred();
	const releaseChild = deferred();
	t.after(() => {
		releaseTool.resolve();
		releaseChild.resolve();
	});
	const f = await fixture(t);
	const toolStarted = deferred();
	const childStarted = deferred();
	const trace = [];
	let independentToolFinished = false;
	const parent = await f.session({
		name: "parent",
		tools: ["lookup"],
		reply: async (number) => ({
			content:
				number === 1
					? [call("slow"), call("independent")]
					: text(`ordinary:${number}`),
		}),
		extension(pi) {
			registerLookup(pi, async (_id, args) => {
				if (args.id === "slow") {
					toolStarted.resolve();
					await releaseTool.promise;
				} else independentToolFinished = true;
				trace.push(`tool-end:${args.id}`);
				return { content: text(args.id), details: undefined };
			});
			pi.on("message_start", (event) => {
				if (
					event.message.role === "custom" &&
					event.message.customType === "probe:feedback"
				)
					trace.push("feedback-delivered");
			});
		},
	});
	parent.session.setSteeringMode("one-at-a-time");
	const parentRun = parent.session.prompt(
		"ordinary source before open tool batch",
	);
	await toolStarted.promise;
	await parent.session.steer("EARLIER_USER_STEERING");
	const branch = parent.session.sessionManager.getBranch();
	const openBatch = branch.findIndex(
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	assert.ok(openBatch > 0);
	const anchor = branch[openBatch - 1];
	const frozenFile = sdk.SessionManager.open(
		parent.session.sessionFile,
	).createBranchedSession(anchor.id);
	const child = await f.session({
		name: "private-child",
		manager: sdk.SessionManager.open(frozenFile),
		reply: async () => {
			childStarted.resolve();
			await releaseChild.promise;
			return { content: text("SCRIPTED_VALID_CANDIDATE") };
		},
	});
	const childRun = child.session.prompt("PRIVATE_BACKGROUND_PROBE");
	await childStarted.promise;
	assert.equal(independentToolFinished, true);
	assert.equal(parent.requests.length, 1);
	assert.equal(parent.context.isIdle(), false);
	// The earlier input was queued before capture; result completes before that input is delivered.
	releaseChild.resolve();
	await childRun;
	publishCandidate(parent, trace);
	assert.equal(
		parent.requests.length,
		1,
		"feedback does not interrupt an open tool batch",
	);
	releaseTool.resolve();
	await parentRun;
	assert.equal(
		parent.requests.length,
		3,
		"ordinary, earlier steering, then one feedback request",
	);
	assert.ok(
		trace.indexOf("feedback-delivered") > trace.indexOf("tool-end:slow"),
	);
	assert.ok(
		trace.indexOf("feedback-delivered") > trace.indexOf("tool-end:independent"),
	);
	assert.ok(trace.indexOf("durable") < trace.indexOf("hook"));
	assert.ok(trace.indexOf("hook") < trace.indexOf("feedback-delivered"));
	assert.ok(!JSON.stringify(parent.requests[1]).includes("ACCEPTED_REPORT"));
	assert.ok(JSON.stringify(parent.requests[2]).includes("ACCEPTED_REPORT"));
	assert.ok(!JSON.stringify(child.requests).includes("EARLIER_USER_STEERING"));
	assert.ok(!JSON.stringify(child.requests).includes("tool-end:"));
	assert.ok(
		!child.requests[0].messages.some(
			(message) => message.role === "toolResult",
		),
	);
	assert.ok(
		!JSON.stringify(parent.requests).includes("PRIVATE_BACKGROUND_PROBE"),
	);
	t.diagnostic(
		JSON.stringify({
			scope:
				"SDK background/frozen-source/delivery seam; scripted current candidate",
			trace,
		}),
	);
});

test("background: idle successful feedback starts exactly one parent request", {
	timeout: 10000,
}, async (t) => {
	const f = await fixture(t);
	const parent = await f.session({ name: "parent", reply: async () => ({}) });
	const child = await f.session({
		name: "private-child",
		reply: async () => ({ content: text("SCRIPTED_VALID_CANDIDATE") }),
	});
	await child.session.prompt("private inquiry");
	assert.equal(parent.requests.length, 0);
	const trace = [];
	publishCandidate(parent, trace);
	await parent.session.waitForIdle();
	assert.equal(parent.requests.length, 1);
	assert.deepEqual(trace, ["durable", "hook"]);
});

for (const outcome of ["no-result", "provider-failure"]) {
	test(`background: ${outcome} inserts nothing and makes zero parent requests`, {
		timeout: 10000,
	}, async (t) => {
		const f = await fixture(t);
		const parent = await f.session({ name: "parent", reply: async () => ({}) });
		const child = await f.session({
			name: "private-child",
			reply: async () =>
				outcome === "provider-failure"
					? {
							content: [],
							stopReason: "error",
							errorMessage: "fixture provider failed",
						}
					: { content: [] },
		});
		await child.session.prompt("private inquiry");
		assert.equal(parent.requests.length, 0);
		assert.equal(parent.context.isIdle(), true);
		assert.equal(
			parent.session.sessionManager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom" || entry.type === "custom_message",
				).length,
			0,
		);
	});
}

test("background: SDK grep/find read local evidence in isolated child", {
	timeout: 10000,
}, async (t) => {
	const f = await fixture(t);
	await writeFile(
		join(f.root, "evidence.txt"),
		"qualified local evidence needle\n",
	);
	const child = await f.session({
		name: "private-child",
		tools: ["read", "ls", "grep", "find"],
		reply: async (number) => ({
			content:
				number === 1
					? [
							{
								type: "toolCall",
								id: "grep-evidence",
								name: "grep",
								arguments: { pattern: "evidence needle", path: f.root },
							},
							{
								type: "toolCall",
								id: "find-evidence",
								name: "find",
								arguments: { pattern: "evidence.txt", path: f.root },
							},
						]
					: text("local evidence checked"),
		}),
	});
	await child.session.prompt("inspect local evidence");
	const results = child.session.messages.filter(
		(message) => message.role === "toolResult",
	);
	assert.equal(results.length, 2);
	assert.ok(results.every((message) => !message.isError));
	for (const result of results)
		assert.match(messageText(result), /evidence\.txt/);
	assert.deepEqual(child.api.getActiveTools().sort(), [
		"find",
		"grep",
		"ls",
		"read",
	]);
});

for (const phase of ["provider", "helper"]) {
	test(`background: queued user input immediately aborts private ${phase}, not parent`, {
		timeout: 10000,
	}, async (t) => {
		const releaseParent = deferred();
		t.after(() => releaseParent.resolve());
		const f = await fixture(t);
		const parentStarted = deferred();
		const childStarted = deferred();
		let child;
		let authority = false;
		let signalObserved = false;
		let abortedSettlement = false;
		let acceptedFiles = 0;
		const resultFile = join(f.root, "staged-result.json");
		await writeFile(
			resultFile,
			JSON.stringify({
				type: "NO_ISSUE",
				reason: "staged",
				done: "checked",
				current_step: "wait",
				next_step: "continue",
			}),
		);
		const trace = [];
		const cancel = new AbortController();
		cancel.signal.addEventListener(
			"abort",
			() => {
				void child.session.abort();
			},
			{ once: true },
		);
		const parent = await f.session({
			name: "parent",
			reply: async (number) => {
				if (number === 1) {
					parentStarted.resolve();
					await releaseParent.promise;
				}
				return {};
			},
			extension(pi) {
				pi.on("input", () => {
					if (!authority) return;
					authority = false;
					trace.push("authority-revoked");
					cancel.abort();
				});
			},
		});
		const awaitAbort = (signal) =>
			new Promise((resolve) => {
				childStarted.resolve();
				const onAbort = () => {
					signalObserved = true;
					trace.push(`${phase}-signal-aborted`);
					resolve();
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			});
		child = await f.session({
			name: "private-child",
			tools: phase === "helper" ? ["lookup"] : [],
			reply: async (_number, _context, options) => {
				if (phase === "helper") return { content: [call("slow-read")] };
				await awaitAbort(options.signal);
				return { content: [], stopReason: "aborted" };
			},
			extension(pi) {
				if (phase === "helper")
					registerLookup(pi, async (_id, _args, signal) => {
						await awaitAbort(signal);
						throw new Error("Operation aborted");
					});
			},
		});
		child.session.subscribe((event) => {
			if (event.type === "agent_settled") {
				abortedSettlement = event.aborted;
				trace.push("child-settled");
			}
		});
		const parentRun = parent.session.prompt("ordinary work");
		await parentStarted.promise;
		authority = true;
		const childRun = child.session
			.prompt("private background work")
			.then(async () => {
				if (authority) {
					JSON.parse(await readFile(resultFile, "utf8"));
					acceptedFiles++;
				}
			});
		await childStarted.promise;
		await parent.session.steer("new user direction");
		assert.equal(
			signalObserved,
			true,
			"input dispatch requests cancellation before returning",
		);
		assert.equal(authority, false);
		await childRun;
		assert.equal(abortedSettlement, true);
		assert.equal(
			child.requests.length,
			1,
			"no correction or helper follow-up after revocation",
		);
		assert.equal(acceptedFiles, 0);
		assert.equal(
			JSON.parse(await readFile(resultFile, "utf8")).reason,
			"staged",
			"even a staged valid file does not restore authority",
		);
		assert.equal(parent.context.isIdle(), false);
		assert.equal(parent.requests.length, 1);
		releaseParent.resolve();
		await parentRun;
		assert.equal(
			parent.requests.length,
			2,
			"only original work and actual user steering, no reflection wake",
		);
		assert.ok(
			trace.indexOf("authority-revoked") <
				trace.indexOf(`${phase}-signal-aborted`),
		);
		assert.ok(
			trace.indexOf(`${phase}-signal-aborted`) < trace.indexOf("child-settled"),
		);
		t.diagnostic(
			JSON.stringify({
				phase,
				trace,
				acceptedFiles,
				childRequests: child.requests.length,
			}),
		);
	});
}

test("background: stale drop retains admission reset and cannot relaunch until fresh ordinary crossing", async () => {
	const { ACCOUNTING_BOUNDARY_ENTRY, deriveBranchAccounting } = await import(
		"../../src/branch-accounting.ts"
	);
	const manager = sdk.SessionManager.inMemory();
	let active = false;
	let launches = 0;
	const view = () =>
		deriveBranchAccounting(manager.getBranch(), {
			boundaryPolicy: "recorded",
			cooldownLoops: 10,
		});
	const ordinary = () => {
		manager.appendMessage({
			role: "assistant",
			content: text("ordinary"),
			stopReason: "stop",
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			timestamp: Date.now(),
			usage,
		});
		if (
			!active &&
			view().reminderLoops >= 2n &&
			!view().cooldown.skipAutomatic
		) {
			active = true;
			launches++;
			manager.appendCustomEntry(ACCOUNTING_BOUNDARY_ENTRY, {
				version: 1,
				window: "reminder",
			});
		}
	};
	const dropStale = () => {
		active = false;
	};
	ordinary();
	ordinary();
	assert.equal(launches, 1);
	const atAdmission = view();
	assert.equal(atAdmission.reminderLoops, 0n);
	for (let index = 0; index < 5; index++) dropStale();
	assert.deepEqual(view(), atAdmission);
	assert.equal(launches, 1);
	ordinary();
	assert.equal(launches, 1, "one fresh ordinary loop is still below threshold");
	ordinary();
	assert.equal(
		launches,
		2,
		"only a new ordinary threshold crossing admits replacement work",
	);
});
