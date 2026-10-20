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

// Focused regression coverage for the private-inquiry drain/admission
// contract: immediate abort with slot retained, no overlap before drain,
// stale settlement silence, fresh admission after drain, late-runtime-create
// disposal, and pre-await frozen source capture. The production seam is the
// injected `privateInquiry` services surface — no internals exported.

class MiniPi {
	currentCtx: any;
	readonly handlers = new Map<string, (event: any, ctx: any) => any>();
	readonly commands: Array<{
		name: string;
		handler: (args: string, ctx: any) => any;
	}> = [];
	readonly messages: Array<{ message: any; options: any }> = [];
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly actions: string[] = [];
	readonly bus = new Map<string, Set<(data: unknown) => void>>();

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
		options: {
			getBusy: () => boolean;
			source: any;
			onFatal: (e: Error) => void;
		},
	) {
		void options;
		this.busy.add(instance);
	}
	async detach(instance: object) {
		this.busy.delete(instance);
	}
	async setBusy(_instance: object, busy: boolean) {
		this.activityWrites.push(busy);
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
		this.countersValue = zeroCounters();
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
	/** Fresh ordinary completion carrying threshold counters. */
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

function zeroCounters(): ReflectDomainCounters {
	return makeCounters(0n, 0n);
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
			setStatus() {},
			setWidget() {},
		},
		notifications,
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

class FakePrivateInquiry {
	readonly calls: Array<{
		options: any;
		resolve: (result: any) => void;
	}> = [];
	runtimeCreations = 0;
	runtimeDisposals = 0;
	private pendingCreates: Array<{
		resolve: (runtime: any) => void;
	}> = [];

	readonly service = {
		createRuntime: () => {
			this.runtimeCreations += 1;
			if (this.parkCreate)
				return new Promise<any>((resolve) => {
					this.pendingCreates.push({ resolve });
				});
			return Promise.resolve(this.makeRuntime());
		},
		run: (options: any) => this.execute(options),
	};
	parkCreate = false;

	private makeRuntime() {
		return {
			fork: async () => ({}),
			dispose: () => {
				this.runtimeDisposals += 1;
			},
		};
	}

	private execute(options: any): Promise<any> {
		const record = { options, resolve: (_r: any) => {} };
		this.calls.push(record);
		// The child keeps draining after abort until the test settles it —
		// mirroring a real private child that takes time to die.
		return new Promise<any>((resolve) => {
			record.resolve = resolve;
		});
	}

	finishCreate() {
		const pending = this.pendingCreates.shift();
		assert.ok(pending, "no runtime creation pending");
		pending.resolve(this.makeRuntime());
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

/** Trigger a private reflection via a fresh completion crossing the threshold. */
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

const validDecision = {
	type: "NO_ISSUE",
	reason: "sound",
	done: "checked",
	current_step: "verify",
	next_step: "continue",
};

test("revocation aborts immediately while the slot stays occupied until drain", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	assert.equal(fake.calls.length, 1, "private run launched");
	assert.equal(fake.calls[0].options.signal.aborted, false);

	// Explicit user input revokes: abort fires now, but the slot must keep
	// a fresh trigger from overlapping the draining child.
	await pi.emit("input", { source: "rpc", text: "user" }, ctx);
	assert.equal(
		fake.calls[0].options.signal.aborted,
		true,
		"abort signalled immediately",
	);
	assert.equal(fake.calls.length, 1, "no new run before the old run settles");

	// A fresh ordinary event while the revoked run drains cannot overlap.
	await triggerReflection(pi, ctx, domain);
	assert.equal(
		fake.calls.length,
		1,
		"fresh event during drain launches nothing",
	);

	// Stale settlement releases the slot in silence: no parent traffic, no
	// counter reset, no auto-relaunch — exactly the drained run ends.
	const beforeSettle =
		pi.messages.length + pi.entries.length + ctx.notifications.length;
	fake.settle({ kind: "decision", decision: validDecision });
	await flushAsync();
	const parentTraffic =
		pi.messages.length + pi.entries.length + ctx.notifications.length;
	assert.equal(
		parentTraffic,
		beforeSettle,
		"revoked run writes nothing upstream on settlement",
	);
	assert.equal(fake.calls.length, 1, "stale settlement did not relaunch");
	assert.notEqual(
		domain.countersValue?.rootLoops.value,
		0n,
		"settlement never touches counters",
	);

	// After the drain, a fresh ordinary threshold event admits normally.
	await pi.emit("input", { source: "rpc", text: "resume" }, ctx);
	await triggerReflection(pi, ctx, domain);
	assert.equal(
		fake.calls.length,
		2,
		"fresh event after drain admits a new run",
	);
	fake.settle({ kind: "cancelled" });
	await flushAsync();
});

test("late runtime creation after shutdown is disposed, not leaked", async () => {
	const fake = new FakePrivateInquiry();
	fake.parkCreate = true;
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	assert.equal(fake.runtimeCreations, 1);

	// Extension unload while createRuntime is still in flight.
	await pi.emit("session_shutdown", {}, ctx);
	fake.finishCreate();
	await flushAsync();
	assert.equal(
		fake.runtimeDisposals,
		1,
		"late-created runtime is disposed on unload",
	);
	assert.equal(
		fake.calls.length,
		0,
		"run never launched: the unloaded runtime was disposed first",
	);
});

test("setup fields are frozen synchronously before the first await", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	assert.equal(fake.calls.length, 1);

	// Mutate ctx after admission; the frozen fork fields must not move.
	const captured = fake.calls[0].options.fork;
	assert.equal(captured.cwd, "/work/root");
	assert.equal(captured.parent, ctx.sessionManager);
	assert.equal(captured.model, "fixture-provider/fixture-model:medium");
	assert.equal(captured.anchorId, "loop-1", "latest replayable leaf frozen");
	assert.equal(captured.profile.kind, "read-only-evidence");
	ctx.setBranch([]);
	const prompt = fake.calls[0].options.prompt("/tmp/result.jsonl");
	assert.match(prompt, /\/sessions\/root\.jsonl/);
});

test("failure settlement releases the slot without relaunch or traffic", async () => {
	const fake = new FakePrivateInquiry();
	const { pi, ctx, domain } = install(fake);
	await startSession(pi, ctx);
	await triggerReflection(pi, ctx, domain);
	fake.settle({ kind: "decision-failed", error: "bad payload" });
	await flushAsync();
	assert.equal(fake.calls.length, 1);
	assert.equal(
		pi.entries.filter(
			(e) =>
				e.customType === "pi-reflect-watchdog:reflection" ||
				e.customType === "pi-reflect-watchdog:reflection-completed",
		).length,
		0,
	);
	assert.equal(pi.messages.length, 0);
});
