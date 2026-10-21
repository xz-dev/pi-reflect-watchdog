/* biome-ignore-all lint/suspicious/noExplicitAny: focused lifecycle fake */
import assert from "node:assert/strict";
import test from "node:test";

import type { WatchdogConfig } from "../src/config.js";
import { createWatchdogExtension } from "../src/extension.js";
import { createObservableAgentHub } from "../src/hub.js";
import type {
	ReflectBranchDomainCoordinator,
	ReflectDomainCounters,
} from "../src/process-domain.js";
import { DEFAULT_REFLECTION_PROMPT } from "../src/prompts.js";

// Focused regression coverage for exact-child working observation: the thin
// fork proxy maps official child session events (agent_start/turn_start/
// auto_retry_start/compaction_end/agent_end/agent_settled) onto the op's
// working flag, forwards live getters, unsubscribes exactly once, and never
// lets a stale callback reach another operation.

class MiniPi {
	currentCtx: any;
	readonly handlers = new Map<string, (event: any, ctx: any) => any>();
	readonly commands: Array<{
		name: string;
		handler: (args: string, ctx: any) => any;
	}> = [];
	readonly messages: Array<{ message: any; options: any }> = [];
	readonly entries: Array<{ customType: string; data: unknown }> = [];

	readonly events = {
		on: (channel: string, handler: (data: unknown) => void) => {
			const handlers = this.bus.get(channel) ?? new Set();
			handlers.add(handler);
			this.bus.set(channel, handlers);
			return () => handlers.delete(handler);
		},
		emit: (channel: string, data: unknown) => {
			for (const handler of this.bus.get(channel) ?? []) handler(data);
		},
	};
	readonly bus = new Map<string, Set<(data: unknown) => void>>();

	on(name: string, handler: (event: any, ctx: any) => any) {
		this.handlers.set(name, handler);
	}
	registerCommand(name: string, command: any) {
		this.commands.push({ name, handler: command.handler });
	}
	registerTool() {}
	registerMessageRenderer() {}
	registerShortcut() {}
	getThinkingLevel() {
		return "medium";
	}
	sendMessage(message: unknown) {
		this.messages.push({ message, options: undefined });
	}
	appendEntry(customType: string, data: unknown) {
		this.entries.push({ customType, data });
	}
	async emit(name: string, event: any, ctx: any) {
		this.currentCtx = ctx;
		const handler = this.handlers.get(name);
		if (handler === undefined) return undefined;
		return handler(event, ctx);
	}
}

class MiniDomain {
	readonly rootProcess = true;
	countersValue: ReflectDomainCounters | undefined;
	private readonly listeners = new Set<
		(counters: ReflectDomainCounters) => void
	>();
	private readonly completionListeners = new Set<(event: any) => void>();
	private readonly busy = new Set<object>();
	readonly activityWrites: boolean[] = [];

	async attach(
		instance: object,
		_options: {
			getBusy: () => boolean;
			source: any;
			onFatal: (e: Error) => void;
		},
	) {
		this.busy.add(instance);
	}
	async detach(instance: object) {
		this.busy.delete(instance);
	}
	async setBusy(_instance: object, busy: boolean) {
		this.activityWrites.push(busy);
	}
	get busyNow() {
		return this.activityWrites.at(-1);
	}
	counters() {
		return this.countersValue;
	}
	subscribe(listener: (counters: ReflectDomainCounters) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	setIdleResetGapSeconds(_seconds: number) {}
	async resetReminderCycle() {
		return this.countersValue;
	}
	async resetCycleOnUserTakeover() {
		this.countersValue = makeCounters(0n, 0n);
		return this.countersValue;
	}
	async refreshBranch() {
		return this.countersValue;
	}
	async rebaseBranch() {
		return this.countersValue;
	}
	async completeTurn() {
		return this.countersValue;
	}
	subscribeCompletions(listener: (event: any) => void) {
		this.completionListeners.add(listener);
		return () => this.completionListeners.delete(listener);
	}
	setCounters(counters: ReflectDomainCounters) {
		this.countersValue = counters;
		for (const listener of this.listeners) listener(counters);
	}
	emitCompletion(rootLoops: bigint, allLoops: bigint) {
		const counters = makeCounters(rootLoops, allLoops);
		this.countersValue = counters;
		for (const listener of this.completionListeners)
			listener({
				contributorId: "root",
				attachmentId: "att",
				scope: "scope",
				messageEntryId: "entry",
				snapshotSeq: 1n,
				accountingGeneration: 1n,
				counters,
			});
	}
}

function makeCounters(
	rootLoops: bigint,
	allLoops: bigint,
): ReflectDomainCounters {
	return {
		domainEpoch: "epoch",
		revision: 1n,
		generation: 1n,
		anyBusy: false,
		localBusy: false,
		otherBusy: false,
		endLoopTimeMs: null,
		fence: { domainEpoch: "epoch", generation: 1n },
		activeMs: { value: 0n },
		activeLoops: { value: 0n },
		taskMs: { value: 0n },
		rootLoops: { value: rootLoops },
		allLoops: { value: allLoops },
	};
}

function makeContext() {
	let idle = true;
	let branch: any[] = [
		{
			type: "message",
			id: "anchor-1",
			parentId: null,
			message: { role: "assistant", stopReason: "stop", content: [] },
		},
	];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const manager = {
		getSessionId: () => "root",
		getSessionFile: () => "/sessions/root.jsonl",
		getLeafId: (): string | null => branch.at(-1)?.id ?? null,
		getBranch: () => branch,
		getEntries: () => branch,
	};
	return {
		hasUI: true,
		mode: "rpc",
		cwd: "/work/root",
		model: { provider: "fixture-provider", id: "fixture-model" },
		modelRegistry: {},
		isProjectTrusted: () => false,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		abort() {},
		setIdle(value: boolean) {
			idle = value;
		},
		setBranch(entries: any[]) {
			branch = entries;
		},
		getBranch() {
			return branch;
		},
		sessionManager: manager,
		ui: {
			notify(text: string) {
				notifications.push(text);
			},
			setStatus(_key: string, text?: string) {
				statuses.push(text);
			},
			setWidget() {},
		},
		notifications,
		statuses,
	} as any;
}

const config: WatchdogConfig = {
	rootLoopLimit: 2,
	allLoopLimit: 100,
	taskMinutes: 20,
	idleResetGapSeconds: 60,
	reflectionPrompt: DEFAULT_REFLECTION_PROMPT,
	cancelShortcut: "alt+x",
};

/** Scripted fake child session with a controllable event emitter. */
class FakeChild {
	readonly listeners = new Set<(event: any) => void>();
	promptCalls = 0;
	abortCalls = 0;
	disposeCalls = 0;
	disposeThrows = false;
	private mutable = {
		messages: [{ role: "user", content: "hi" }] as any[],
		sessionFile: "/tmp/child.jsonl" as string | undefined,
		sessionId: "child-1",
		modelId: "fixture-provider/fixture-model" as string | undefined,
		inheritedProvider: "fixture-provider" as string | undefined,
		attemptError: undefined as string | undefined,
		helperCalls: 0,
	};

	emit(event: any) {
		for (const listener of this.listeners) listener(event);
	}

	mutate(patch: Partial<typeof this.mutable>) {
		Object.assign(this.mutable, patch);
	}

	session(): any {
		const self = this;
		return {
			async prompt() {
				self.promptCalls += 1;
			},
			async abort() {
				self.abortCalls += 1;
			},
			async dispose() {
				self.disposeCalls += 1;
				if (self.disposeThrows) throw new Error("dispose failed");
			},
			subscribe(listener: (event: any) => void) {
				self.listeners.add(listener);
				return () => self.listeners.delete(listener);
			},
			get messages() {
				return self.mutable.messages;
			},
			get sessionFile() {
				return self.mutable.sessionFile;
			},
			get sessionId() {
				return self.mutable.sessionId;
			},
			get modelId() {
				return self.mutable.modelId;
			},
			get inheritedProvider() {
				return self.mutable.inheritedProvider;
			},
			get attemptError() {
				return self.mutable.attemptError;
			},
			get helperCalls() {
				return self.mutable.helperCalls;
			},
		};
	}
}

class FakePrivateInquiry {
	readonly calls: Array<{
		options: any;
		resolve: (result: any) => void;
	}> = [];
	children: FakeChild[] = [];
	childFactory: () => any = () => new FakeChild().session();
	runtimeCreations = 0;
	runtimeDisposals = 0;
	/** Exposed for tests: the runtime object the executor received. */
	lastForkRuntime: any;

	readonly service = {
		createRuntime: () => {
			this.runtimeCreations += 1;
			const self = this;
			return Promise.resolve({
				fork: async () => self.childFactory(),
				dispose: () => {
					self.runtimeDisposals += 1;
				},
			});
		},
		run: (options: any) => this.execute(options),
	};

	private async execute(options: any): Promise<any> {
		this.lastForkRuntime = options.runtime;
		const record = { options, resolve: (_r: any) => {} };
		this.calls.push(record);
		return new Promise<any>((resolve) => {
			record.resolve = resolve;
		});
	}

	settle(result: any) {
		const call = this.calls.at(-1);
		assert.ok(call, "no private reflection pending");
		call.resolve(result);
	}
}

async function flushAsync() {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function install(privateInquiry = new FakePrivateInquiry()) {
	const pi = new MiniPi();
	const ctx = makeContext();
	const domain = new MiniDomain();
	createWatchdogExtension({
		hub: createObservableAgentHub(),
		processDomain: domain as unknown as ReflectBranchDomainCoordinator,
		privateInquiry: privateInquiry.service as any,
		services: { loadConfig: async () => ({ config, diagnostics: [] }) },
	})(pi as any);
	return { pi, ctx, domain, privateInquiry };
}

async function startSession(pi: MiniPi, ctx: any) {
	await pi.emit("session_start", {}, ctx);
	await flushAsync();
}

async function triggerReflection(pi: MiniPi, ctx: any, domain: MiniDomain) {
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit(
		"turn_end",
		{
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "work" }],
			},
		},
		ctx,
	);
	ctx.setBranch([
		...ctx.getBranch(),
		{
			type: "message",
			id: `loop-${ctx.getBranch().length}`,
			parentId: ctx.getBranch().at(-1)?.id ?? null,
			message: { role: "assistant", stopReason: "stop", content: [] },
		},
	]);
	ctx.setIdle(true);
	domain.emitCompletion(2n, 2n);
	await pi.emit("agent_settled", {}, ctx);
	await flushAsync();
}

test("setup pending is not working; child events flip official working", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	assert.equal(fake.calls.length, 1);

	// Setup/pending is NOT working: the slot is held, no child event yet,
	// and the parent is idle — busy must stay false (no active-op duration).
	await pi.emit("agent_settled", {}, ctx);
	await flushAsync();
	assert.equal(
		domain.busyNow,
		false,
		"admitted but silent operation charges no working time",
	);

	// Fork the child through the executor's runtime façade, then verify the
	// working flag follows official events only.
	const child = new FakeChild();
	fake.childFactory = () => child.session();
	const observed = await fake.lastForkRuntime.fork({});
	assert.ok(observed, "observed child proxy returned");
	child.emit({ type: "agent_start" });
	await flushAsync();
	assert.equal(domain.busyNow, true, "agent_start marks child working");

	child.emit({ type: "agent_end", willRetry: true });
	await flushAsync();
	assert.equal(domain.busyNow, true, "willRetry keeps working");

	child.emit({ type: "auto_retry_start" });
	await flushAsync();
	assert.equal(domain.busyNow, true);

	// auto_retry_end means nothing about the run; working persists.
	child.emit({ type: "auto_retry_end", success: true });
	await flushAsync();
	assert.equal(domain.busyNow, true, "auto_retry_end does not settle");

	// agent_end is never official idle: the SDK run stays active until
	// agent_settled (finalization is still working time).
	child.emit({ type: "agent_end" });
	await flushAsync();
	assert.equal(domain.busyNow, true, "agent_end keeps working");

	child.emit({ type: "turn_start" });
	await flushAsync();
	assert.equal(domain.busyNow, true, "turn_start marks working");

	child.emit({ type: "agent_settled" });
	await flushAsync();
	assert.equal(domain.busyNow, false);
});

test("revoked child still working charges until the official drain ends", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	const child = new FakeChild();
	fake.childFactory = () => child.session();
	const observed = await fake.lastForkRuntime.fork({});
	child.emit({ type: "agent_start" });
	await flushAsync();
	assert.equal(domain.busyNow, true);

	// Authority revoked: the child keeps officially working while it drains,
	// so the domain still counts it — working, not active-op presence.
	await pi.emit("input", { source: "rpc", text: "user" }, ctx);
	await flushAsync();
	assert.equal(
		domain.busyNow,
		true,
		"revoked but officially working child still counts",
	);

	// The real drain finishes with the child's own terminal settlement,
	// then the run result releases the slot; working stops with the child,
	// not before.
	child.emit({ type: "agent_settled" });
	await flushAsync();
	assert.equal(domain.busyNow, false);
	fake.settle({ kind: "cancelled" });
	await flushAsync();
	assert.equal(domain.busyNow, false);
	void observed;
});

test("compaction retry latch keeps working across agent_settled", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	const child = new FakeChild();
	fake.childFactory = () => child.session();
	await fake.lastForkRuntime.fork({});

	child.emit({ type: "agent_start" });
	child.emit({ type: "compaction_end", willRetry: true });
	child.emit({ type: "agent_settled" });
	await flushAsync();
	assert.equal(
		domain.busyNow,
		true,
		"agent_settled during compaction retry stays working",
	);
	child.emit({ type: "agent_end" });
	await flushAsync();
	assert.equal(
		domain.busyNow,
		true,
		"agent_end clears the latch but working persists to settlement",
	);
	child.emit({ type: "agent_settled" });
	await flushAsync();
	assert.equal(domain.busyNow, false);
});

test("delayed agent_end to agent_settled keeps working with no ordinary charges", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	const child = new FakeChild();
	fake.childFactory = () => child.session();
	await fake.lastForkRuntime.fork({});
	child.emit({ type: "agent_start" });
	await flushAsync();
	assert.equal(domain.busyNow, true);

	// Finalization gap: agent_end emitted while the SDK run is still active
	// (agent-session.js ~685 clears _isAgentRunActive only at agent_settled).
	// Working must persist and produce no parent traffic or loop charges.
	const before = pi.entries.length + pi.messages.length;
	child.emit({ type: "agent_end" });
	await flushAsync();
	assert.equal(
		domain.busyNow,
		true,
		"agent_end finalization is still official working",
	);
	assert.equal(
		pi.entries.length + pi.messages.length,
		before,
		"no entries or messages during the finalization gap",
	);
	assert.equal(
		domain.countersValue?.rootLoops.value,
		2n,
		"no ordinary-loop charges added",
	);

	child.emit({ type: "agent_settled" });
	await flushAsync();
	assert.equal(domain.busyNow, false, "agent_settled ends official working");
});

test("stale child events after disposal cannot affect the operation", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	const child = new FakeChild();
	fake.childFactory = () => child.session();
	const observed = await fake.lastForkRuntime.fork({});

	child.emit({ type: "agent_start" });
	await flushAsync();
	assert.equal(domain.busyNow, true);

	await observed.dispose();
	await flushAsync();
	assert.equal(domain.busyNow, false, "disposal clears working");
	assert.equal(child.listeners.size, 0, "unsubscribed exactly once");
	assert.equal(child.disposeCalls, 1);

	child.emit({ type: "agent_start" });
	await flushAsync();
	assert.equal(domain.busyNow, false, "stale event ignored");
});

test("dispose still unsubscribes when child.dispose throws", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	const child = new FakeChild();
	child.disposeThrows = true;
	fake.childFactory = () => child.session();
	const observed = await fake.lastForkRuntime.fork({});
	child.emit({ type: "agent_start" });
	await flushAsync();
	await assert.rejects(() => observed.dispose(), /dispose failed/);
	assert.equal(child.listeners.size, 0, "off ran before the throw");
	assert.equal(domain.busyNow, false);
});

test("live getters delegate; bound prompt/abort/subscribe unchanged", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	const child = new FakeChild();
	fake.childFactory = () => child.session();
	const observed = await fake.lastForkRuntime.fork({});

	child.mutate({ helperCalls: 3, attemptError: "boom", modelId: "p/m2" });
	assert.equal(observed.helperCalls, 3, "helperCalls live");
	assert.equal(observed.attemptError, "boom", "attemptError live");
	assert.equal(observed.modelId, "p/m2", "modelId live");
	assert.equal(observed.sessionId, "child-1");
	assert.equal(observed.sessionFile, "/tmp/child.jsonl");
	assert.equal(observed.inheritedProvider, "fixture-provider");
	assert.equal(observed.messages.length, 1);

	await observed.prompt("x");
	assert.equal(child.promptCalls, 1);
	await observed.abort();
	assert.equal(child.abortCalls, 1);
	const seen: any[] = [];
	const off = observed.subscribe((event: any) => seen.push(event));
	child.emit({ type: "ping" });
	assert.equal(seen.length, 1, "subscribe delegated");
	off();
});

test("fork returning after slot release disposes the orphan child", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	assert.equal(fake.calls.length, 1);

	// The child factory parks; revoke while the fork is in flight.
	const child = new FakeChild();
	let resolveFork: (() => void) | undefined;
	fake.childFactory = () =>
		new Promise<any>((resolve) => {
			resolveFork = () => resolve(child.session());
		});
	const forkPromise = fake.lastForkRuntime.fork({});
	await pi.emit("input", { source: "rpc", text: "user" }, ctx);
	fake.settle({ kind: "cancelled" });
	await flushAsync();
	assert.ok(resolveFork, "fork pending");
	resolveFork();
	await assert.rejects(() => forkPromise, /slot released/);
	assert.equal(child.disposeCalls, 1, "orphan disposed");
});

// Own-response boundary: only an assistant appended at/after the LAST
// forwarded prompt may supply the private continuation source. Inherited
// context and earlier rejected replies never qualify.

const ownAssistant = (overrides: any = {}) => ({
	role: "assistant",
	api: "openai-completions",
	provider: "fixture-provider",
	model: "fixture-model",
	responseId: "own-1",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	content: [{ type: "text", text: "reply" }],
	stopReason: "stop",
	timestamp: 9,
	...overrides,
});

const boundaryDecision = {
	type: "NO_ISSUE",
	reason: "sound",
	done: "checked",
	current_step: "verify",
	next_step: "continue",
};

const markerOf = (pi: MiniPi) =>
	pi.messages.find(
		(m: any) => m.message.customType === "pi-reflect-watchdog:continuation",
	)?.message;

test("inherited-only assistant cannot supply the private source", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	const child = new FakeChild();
	// Pre-existing assistant lives before any prompt — inherited context.
	child.mutate({ messages: [{ role: "user" }, ownAssistant()] });
	fake.childFactory = () => child.session();
	const observed = await fake.lastForkRuntime.fork({});
	await observed.prompt("p");
	await observed.dispose();
	fake.settle({
		kind: "decision",
		decision: boundaryDecision,
		sessionId: "child-1",
	});
	await flushAsync();
	assert.equal(
		markerOf(pi),
		undefined,
		"inherited assistant before promptStart never publishes a source",
	);
});

test("earlier rejected reply cannot supply the missing later reply", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	const child = new FakeChild();
	child.mutate({ messages: [{ role: "user" }] });
	fake.childFactory = () => child.session();
	const observed = await fake.lastForkRuntime.fork({});
	await observed.prompt("p1");
	// First attempt's (rejected) assistant lands before the next prompt.
	child.mutate({
		messages: [
			...child.session().messages,
			ownAssistant({ responseId: "bad" }),
		],
	});
	await observed.prompt("p2-correction");
	// No assistant after p2 — the invalid earlier reply must not leak.
	await observed.dispose();
	fake.settle({
		kind: "decision",
		decision: boundaryDecision,
		sessionId: "child-1",
	});
	await flushAsync();
	assert.equal(
		markerOf(pi),
		undefined,
		"earlier assistant before the last promptStart never supplies source",
	);
});

test("accepted own latest reply supplies the validated source", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	const child = new FakeChild();
	child.mutate({ messages: [{ role: "user" }] });
	fake.childFactory = () => child.session();
	const observed = await fake.lastForkRuntime.fork({});
	await observed.prompt("p1");
	child.mutate({
		messages: [
			...child.session().messages,
			ownAssistant({ responseId: "old" }),
		],
	});
	await observed.prompt("p2-correction");
	// Accepted reply lands after the last prompt.
	child.mutate({
		messages: [
			...child.session().messages,
			ownAssistant({ responseId: "accepted-2" }),
		],
	});
	await observed.dispose();
	fake.settle({
		kind: "decision",
		decision: boundaryDecision,
		sessionId: "child-1",
	});
	await flushAsync();
	const marker = markerOf(pi);
	assert.ok(marker, "continuation marker published");
	const source = marker.details?.private;
	assert.equal(source?.sessionId, "child-1");
	assert.equal(source?.responseId, "accepted-2", "latest own reply wins");
	assert.equal(source?.provider, "fixture-provider");
	assert.equal(source?.model, "fixture-model");
	assert.equal(source?.usage?.totalTokens, 2);
	assert.equal(
		(source as any)?.content,
		undefined,
		"no content/thinking fields copied",
	);
});

test("mismatched result sessionId cannot publish", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	const child = new FakeChild();
	fake.childFactory = () => child.session();
	const observed = await fake.lastForkRuntime.fork({});
	await observed.prompt("p");
	child.mutate({ messages: [...child.session().messages, ownAssistant()] });
	await observed.dispose();
	fake.settle({
		kind: "decision",
		decision: boundaryDecision,
		sessionId: "different-child",
	});
	await flushAsync();
	assert.equal(
		markerOf(pi),
		undefined,
		"source bound to a different session must not publish",
	);
});

test("malformed terminal metadata fails closed", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	const child = new FakeChild();
	child.mutate({ messages: [{ role: "user" }] });
	fake.childFactory = () => child.session();
	const observed = await fake.lastForkRuntime.fork({});
	await observed.prompt("p");
	// Own reply but broken metadata: bad stopReason + negative usage.
	child.mutate({
		messages: [
			...child.session().messages,
			ownAssistant({ stopReason: "aborted", usage: { input: -1 } }),
		],
	});
	await observed.dispose();
	fake.settle({
		kind: "decision",
		decision: boundaryDecision,
		sessionId: "child-1",
	});
	await flushAsync();
	assert.equal(markerOf(pi), undefined, "invalid own metadata fails closed");
});

test("private progress observes overlapping safe helpers and authorized result attempts", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	const row = () => ctx.statuses.at(-1) ?? "";
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	assert.match(row(), /preparing/);
	assert.doesNotMatch(row(), /[123]\/3/);
	const child = new FakeChild();
	fake.childFactory = () => child.session();
	const observed = await fake.lastForkRuntime.fork({});
	const stale = [...child.listeners];
	await observed.prompt("private prompt secret");
	assert.match(row(), /waiting for model.*1\/3/);
	for (const type of [
		"agent_start",
		"turn_start",
		"auto_retry_start",
		"auto_retry_end",
	])
		child.emit({ type });
	assert.match(row(), /waiting for model.*1\/3/);
	const traffic =
		pi.entries.length + pi.messages.length + ctx.notifications.length;
	for (const [toolCallId, toolName] of [
		["a", "read"],
		["b", "grep"],
		["c", "read"],
	])
		child.emit({
			type: "tool_execution_start",
			toolCallId,
			toolName,
			args: { path: "/secret/path" },
			output: "private output",
		});
	assert.match(row(), /tools: read, grep/);
	child.emit({
		type: "tool_execution_start",
		toolCallId: "unsafe",
		toolName: "secret/private\n\x1b[31m",
	});
	child.emit({ type: "tool_execution_end", toolCallId: "unknown" });
	child.emit({ type: "tool_execution_end", toolCallId: "a" });
	child.emit({ type: "turn_start" });
	assert.match(row(), /tools: grep, read/);
	child.emit({ type: "tool_execution_end", toolCallId: "b" });
	assert.match(row(), /tools: read/);
	child.emit({ type: "tool_execution_end", toolCallId: "c" });
	assert.match(row(), /waiting for model.*1\/3/);
	assert.equal(
		pi.entries.length + pi.messages.length + ctx.notifications.length,
		traffic,
	);
	assert.equal(domain.countersValue?.rootLoops.value, 2n);
	assert.ok(
		ctx.statuses.every(
			(text: string | undefined) =>
				!text || !(/secret|private output/.test(text) || text.includes("\x1b")),
		),
	);

	const options = fake.calls[0].options;
	options.validate({});
	assert.match(row(), /validating.*1\/3/);
	options.onResponse({
		attempt: 1,
		outcome: { kind: "invalid", error: "Missing fields." },
	});
	assert.doesNotMatch(
		row(),
		/2\/3/,
		"a rejected result alone does not authorize a prompt",
	);
	options.correction("Missing fields.");
	await observed.prompt("private correction secret");
	child.emit({ type: "turn_start" });
	assert.match(row(), /correcting.*2\/3/);
	child.emit({ type: "auto_retry_start" });
	child.emit({ type: "auto_retry_end" });
	assert.match(row(), /2\/3/);
	assert.equal(
		child.promptCalls,
		2,
		"helper turns/native retries add no result attempts",
	);

	await pi.emit("input", { source: "rpc", text: "takeover" }, ctx);
	assert.match(row(), /cancelling/);
	child.emit({
		type: "tool_execution_start",
		toolCallId: "late",
		toolName: "find",
	});
	assert.match(row(), /cancelling/);
	await observed.dispose();
	fake.settle({ kind: "cancelled" });
	await flushAsync();
	assert.doesNotMatch(row(), /cancelling|waiting for model|tools:/);
	await triggerReflection(pi, ctx, domain);
	assert.match(row(), /preparing/);
	for (const callback of stale)
		callback({
			type: "tool_execution_start",
			toolCallId: "late",
			toolName: "find",
		});
	assert.match(row(), /preparing/, "old callback cannot repaint successor");
	fake.settle({ kind: "cancelled" });
	await flushAsync();
	await pi.emit("session_shutdown", {}, ctx);
});
