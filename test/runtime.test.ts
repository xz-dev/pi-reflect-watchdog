/* biome-ignore-all lint/suspicious/noExplicitAny: focused dynamic Pi lifecycle fake */
import assert from "node:assert/strict";
import test from "node:test";

import { createWatchdogExtension } from "../src/extension.js";
import {
	createObservableAgentHub,
	type ObservableAgentHub,
} from "../src/hub.js";
import type {
	ReflectDomainCoordinator,
	ReflectDomainCounters,
} from "../src/process-domain.js";
import { DEFAULT_REFLECTION_PROMPT } from "../src/prompts.js";

class Pi {
	readonly handlers = new Map<string, (event: any, ctx: any) => any>();
	readonly commands: Array<{
		name: string;
		handler: (args: string, ctx: any) => any;
	}> = [];
	readonly messages: Array<{ message: any; options: any }> = [];

	on(name: string, handler: (event: any, ctx: any) => any) {
		this.handlers.set(name, handler);
	}

	registerCommand(name: string, command: any) {
		this.commands.push({ name, handler: command.handler });
	}

	sendMessage(message: unknown, options: unknown) {
		this.messages.push({ message, options });
	}

	async emit(name: string, event: any, ctx: any) {
		return await this.handlers.get(name)?.(event, ctx);
	}
}

function counter(value = 0n) {
	return { value };
}

class FakeDomain implements ReflectDomainCoordinator {
	readonly rootProcess = true;
	readonly activityWrites: boolean[] = [];
	rootWrites = 0;
	allWrites = 0;
	resetWrites = 0;
	private revision = 1n;
	private readonly attachments = new Map<object, boolean>();
	private readonly listeners = new Set<
		(counters: ReflectDomainCounters) => void
	>();
	private value: ReflectDomainCounters = this.snapshot();

	async attach(
		instance: object,
		options: { getBusy: () => boolean; onFatal: (error: Error) => void },
	) {
		this.attachments.set(instance, options.getBusy());
		this.refreshBusy();
	}

	async detach(instance: object) {
		this.attachments.delete(instance);
		this.refreshBusy();
	}

	async setBusy(instance: object, busy: boolean) {
		this.activityWrites.push(busy);
		this.attachments.set(instance, busy);
		this.refreshBusy();
	}

	async recordRootLoop() {
		this.rootWrites += 1;
		this.value = this.next({
			activeLoops: this.value.activeLoops.value + 1n,
			rootLoops: this.value.rootLoops.value + 1n,
			allLoops: this.value.allLoops.value + 1n,
		});
		this.publish();
		return this.value;
	}

	async recordAllLoop() {
		this.allWrites += 1;
		this.value = this.next({
			activeLoops: this.value.activeLoops.value + 1n,
			allLoops: this.value.allLoops.value + 1n,
		});
		this.publish();
		return this.value;
	}

	counters() {
		return this.value;
	}

	subscribe(listener: (counters: ReflectDomainCounters) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setIdleResetGapSeconds() {}

	async resetReminderCycle() {
		this.resetWrites += 1;
		this.value = this.next({ taskMs: 0n, rootLoops: 0n, allLoops: 0n });
		this.publish();
		return this.value;
	}

	setRemoteBusy(value: boolean) {
		this.value = {
			...this.value,
			revision: ++this.revision,
			generation: this.revision,
			anyBusy: this.value.localBusy || value,
			otherBusy: value,
			fence: { domainEpoch: "domain", generation: this.revision },
		};
		this.publish();
	}

	setCounters(input: {
		activeMs?: bigint;
		activeLoops?: bigint;
		taskMs?: bigint;
		rootLoops?: bigint;
		allLoops?: bigint;
	}) {
		this.value = this.next(input);
		this.publish();
	}

	private refreshBusy() {
		const localBusy = [...this.attachments.values()].some(Boolean);
		if (localBusy === this.value.localBusy) return;
		this.value = {
			...this.value,
			revision: ++this.revision,
			generation: this.revision,
			anyBusy: localBusy || this.value.otherBusy,
			localBusy,
			fence: { domainEpoch: "domain", generation: this.revision },
		};
		this.publish();
	}

	private next(input: {
		activeMs?: bigint;
		activeLoops?: bigint;
		taskMs?: bigint;
		rootLoops?: bigint;
		allLoops?: bigint;
	}): ReflectDomainCounters {
		this.revision += 1n;
		return {
			...this.value,
			revision: this.revision,
			generation: this.revision,
			fence: { domainEpoch: "domain", generation: this.revision },
			activeMs: counter(input.activeMs ?? this.value.activeMs.value),
			activeLoops: counter(input.activeLoops ?? this.value.activeLoops.value),
			taskMs: counter(input.taskMs ?? this.value.taskMs.value),
			rootLoops: counter(input.rootLoops ?? this.value.rootLoops.value),
			allLoops: counter(input.allLoops ?? this.value.allLoops.value),
		};
	}

	private snapshot(): ReflectDomainCounters {
		return {
			domainEpoch: "domain",
			revision: this.revision,
			generation: this.revision,
			certain: true,
			anyBusy: false,
			localBusy: false,
			otherBusy: false,
			endLoopTimeMs: null,
			fence: { domainEpoch: "domain", generation: this.revision },
			activeMs: counter(),
			activeLoops: counter(),
			taskMs: counter(),
			rootLoops: counter(),
			allLoops: counter(),
		};
	}

	private publish() {
		for (const listener of this.listeners) listener(this.value);
	}
}

function context(
	sessionId = "root",
	options: { idle?: boolean; hasUI?: boolean } = {},
) {
	let idle = options.idle ?? true;
	let pendingMessages = false;
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const widgets: Array<unknown> = [];
	const manager = { getSessionId: () => sessionId, getBranch: () => [] };
	return {
		hasUI: options.hasUI ?? true,
		mode: "rpc",
		cwd: `/work/${sessionId}`,
		isProjectTrusted: () => false,
		isIdle: () => idle,
		hasPendingMessages: () => pendingMessages,
		abort() {},
		setIdle(value: boolean) {
			idle = value;
		},
		setPendingMessages(value: boolean) {
			pendingMessages = value;
		},
		sessionManager: manager,
		ui: {
			notify(text: string) {
				notifications.push(text);
			},
			setStatus(_key: string, text?: string) {
				statuses.push(text);
			},
			setWidget(_key: string, value?: unknown) {
				widgets.push(value);
			},
		},
		notifications,
		statuses,
		widgets,
	};
}

const config = {
	rootLoopLimit: 2,
	allLoopLimit: 3,
	taskMinutes: 30,
	idleResetGapSeconds: 60,
	reflectionPrompt: DEFAULT_REFLECTION_PROMPT,
};

function install(
	options: {
		hub?: ObservableAgentHub;
		domain?: FakeDomain;
		ctx?: ReturnType<typeof context>;
		limits?: Partial<typeof config>;
	} = {},
) {
	const pi = new Pi();
	const ctx = options.ctx ?? context();
	const domain = options.domain ?? new FakeDomain();
	createWatchdogExtension({
		hub: options.hub ?? createObservableAgentHub(),
		processDomain: domain,
		services: {
			loadConfig: async () => ({
				config: { ...config, ...options.limits },
				diagnostics: [],
			}),
		},
	})(pi as any);
	return { pi, ctx, domain };
}

function turnEnd(stopReason: string) {
	return { message: { role: "assistant", stopReason } };
}

function lastInquiry(pi: Pi) {
	return pi.messages.findLast(({ message }) =>
		String(message.customType ?? "").endsWith(":inquiry"),
	)?.message;
}

async function correlateReflection(pi: Pi, ctx: ReturnType<typeof context>) {
	const prompt = lastInquiry(pi);
	assert.ok(prompt);
	await pi.emit(
		"message_start",
		{
			message: {
				role: "custom",
				customType: prompt.customType,
				details: prompt.details,
			},
		},
		ctx,
	);
}

function assistant(text: string) {
	return { message: { role: "assistant", content: [{ type: "text", text }] } };
}

const validNoIssue =
	"<reflection><type>NO_ISSUE</type><reason>sound</reason><done>checked</done><current_step>verify</current_step><next_step>continue</next_step></reflection>";
const validCorrection =
	"<reflection><type>ROUTE_CORRECTION</type><reason>change route</reason><done>checked</done><current_step>verify</current_step><next_step>continue differently</next_step></reflection>";

async function startReflectionRun(pi: Pi, ctx: ReturnType<typeof context>) {
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await correlateReflection(pi, ctx);
}

test("minimal core exposes only /reflect and no model tools", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	assert.deepEqual(
		pi.commands.map((command) => command.name),
		["reflect"],
	);
	assert.equal("registerTool" in pi, false);
});

test("authoritative domain loops trigger the ask from ordinary work", async () => {
	const { pi, ctx, domain } = install();
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(pi.messages.length, 0, "one loop remains below threshold");
	await pi.emit("turn_end", turnEnd("toolUse"), ctx);
	assert.equal(domain.rootWrites, 2);
	assert.equal(domain.allWrites, 0);
	assert.match(
		lastInquiry(pi)?.content ?? "",
		/ROOT_LOOP_LIMIT/,
		"threshold reflection steers the current ordinary run",
	);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await correlateReflection(pi, ctx);
	await pi.emit("message_end", assistant(validNoIssue), ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(domain.resetWrites, 1);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		1,
		"the reset cycle re-arms threshold latches without an immediate duplicate",
	);
});

test("failed and unknown assistant outcomes never reach domain counters", async () => {
	const { pi, ctx, domain } = install();
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	for (const reason of [
		"error",
		"aborted",
		"length",
		"pending",
		"deferred",
		"unknown-value",
	])
		await pi.emit("turn_end", turnEnd(reason), ctx);
	assert.equal(domain.rootWrites, 0);
	assert.equal(domain.allWrites, 0);
});

test("observer and subagent successful loops increment all but not root", async () => {
	const hub = createObservableAgentHub();
	const domain = new FakeDomain();
	const root = install({
		hub,
		domain,
		ctx: context("root", { hasUI: true }),
		limits: { allLoopLimit: 1, rootLoopLimit: 100 },
	});
	const child = install({
		hub,
		domain,
		ctx: context("child", { hasUI: false }),
		limits: { allLoopLimit: 1, rootLoopLimit: 100 },
	});
	await root.pi.emit("session_start", {}, root.ctx);
	await child.pi.emit("session_start", {}, child.ctx);
	child.ctx.setIdle(false);
	await child.pi.emit("agent_start", {}, child.ctx);
	await child.pi.emit("turn_end", turnEnd("stop"), child.ctx);
	assert.equal(domain.rootWrites, 0);
	assert.equal(domain.allWrites, 1);
	assert.equal(root.pi.messages.length, 0);
	child.ctx.setIdle(true);
	await child.pi.emit("agent_settled", {}, child.ctx);
	assert.match(lastInquiry(root.pi)?.content ?? "", /ALL_LOOP_LIMIT/);
});

test("cross-process child busy keeps reflection queued until aggregate idle", async () => {
	const { pi, ctx, domain } = install({
		limits: { allLoopLimit: 1, rootLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	domain.setRemoteBusy(true);
	await domain.recordAllLoop();
	assert.equal(lastInquiry(pi), undefined);
	domain.setRemoteBusy(false);
	assert.match(lastInquiry(pi)?.content ?? "", /ALL_LOOP_LIMIT/);
});

test("provisional reflection, valid response, and its turn_end add no activity or loops", async () => {
	const { pi, ctx, domain } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	assert.equal(domain.activityWrites.includes(true), false);
	const replacement = await pi.emit(
		"message_end",
		assistant(validNoIssue),
		ctx,
	);
	assert.deepEqual(replacement.message.content, []);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(
		domain.rootWrites,
		0,
		"message_end must not clear internal identity",
	);
	assert.equal(domain.allWrites, 0);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(domain.counters().activeMs.value, 0n);
	assert.equal(domain.counters().taskMs.value, 0n);
});

test("provisional reflection never captures an uncorrelated ordinary assistant", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	// Reflection dispatched while an ordinary run is busy stays provisional
	// until its own prompt is correlated via message_start; the ordinary
	// assistant reply must pass through untouched.
	const replacement = await pi.emit(
		"message_end",
		assistant("ordinary work in progress"),
		ctx,
	);
	assert.equal(
		replacement,
		undefined,
		"provisional run must not rewrite the ordinary assistant",
	);
	// The steer prompt then starts its own turn and is correlated.
	await pi.emit("agent_start", {}, ctx);
	await correlateReflection(pi, ctx);
	const captured = await pi.emit("message_end", assistant(validNoIssue), ctx);
	assert.deepEqual(captured.message.content, []);
	assert.equal(
		captured.message.stopReason ?? "stop",
		"stop",
		"neutralized inquiry assistant keeps a non-abort terminal state",
	);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
});

test("confirmed neutralized assistant never synthesizes aborted stopReason", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	const replacement = await pi.emit(
		"message_end",
		{ message: { role: "assistant", content: [{ type: "text", text: validNoIssue }], stopReason: "stop" } },
		ctx,
	);
	assert.equal(replacement.message.stopReason, "stop");
	assert.equal(replacement.message.errorMessage, undefined);
});

test("invalid XML re-ask remains internal through its successful turn", async () => {
	const { pi, ctx, domain } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	await pi.emit("message_end", assistant("not XML"), ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.rootWrites, 0);
	assert.equal(domain.allWrites, 0);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		2,
		"invalid XML dispatches one correlated re-ask after settlement",
	);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await correlateReflection(pi, ctx);
	await pi.emit("message_end", assistant(validNoIssue), ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.rootWrites, 0);
	assert.equal(domain.allWrites, 0);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
});

test("route correction starts one ordinary continuation that counts normally", async () => {
	const { pi, ctx, domain } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	await pi.emit("message_end", assistant(validCorrection), ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.rootWrites, 0);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":correction"),
		).length,
		1,
	);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.rootWrites, 1);
});

test("domain snapshots, not local wall-clock state, drive status text", async () => {
	const { pi, ctx, domain } = install({
		limits: { rootLoopLimit: 100, allLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	domain.setCounters({
		activeMs: 12_000n,
		activeLoops: 9n,
		taskMs: 7_000n,
		rootLoops: 7n,
		allLoops: 9n,
	});
	assert.match(
		ctx.statuses.filter(Boolean).at(-1) ?? "",
		/active 12s\/9 loops · task 7s\/30m · root 7\/100 · all 9\/100/,
	);
});

test("surviving observer reclaims main and owns /reflect after shutdown", async () => {
	const hub = createObservableAgentHub();
	const domain = new FakeDomain();
	const root = install({
		hub,
		domain,
		ctx: context("root", { hasUI: true }),
	});
	const observer = install({
		hub,
		domain,
		ctx: context("observer", { hasUI: false }),
	});
	await root.pi.emit("session_start", {}, root.ctx);
	await observer.pi.emit("session_start", {}, observer.ctx);
	await root.pi.emit("session_shutdown", {}, root.ctx);
	await root.pi.commands[0]?.handler("old owner", root.ctx);
	assert.equal(root.pi.messages.length, 0);
	await observer.pi.commands[0]?.handler("new owner", observer.ctx);
	assert.match(lastInquiry(observer.pi)?.content ?? "", /new owner/);
});

test("reflection tool budget blocks call eleven", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	for (let index = 0; index < 10; index += 1)
		assert.equal(await pi.emit("tool_call", {}, ctx), undefined);
	assert.deepEqual(await pi.emit("tool_call", {}, ctx), {
		block: true,
		reason: "Reflection tool-call budget exhausted.",
	});
});
