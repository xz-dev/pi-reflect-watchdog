/* biome-ignore-all lint/suspicious/noExplicitAny: focused dynamic Pi lifecycle fake */
import assert from "node:assert/strict";
import test from "node:test";

import { publishSemanticHook } from "pi-extension-utils/semantic-hook";
import type { WatchdogConfig } from "../src/config.js";
import {
	createWatchdogExtension,
	reflectCooldownState,
} from "../src/extension.js";
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
	readonly bus = new Map<string, Set<(data: unknown) => void>>();
	readonly commands: Array<{
		name: string;
		handler: (args: string, ctx: any) => any;
	}> = [];
	readonly messages: Array<{ message: any; options: any }> = [];
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly actions: string[] = [];

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

	sendMessage(message: unknown, options: unknown) {
		this.messages.push({ message, options });
		const customType = String(
			(message as { customType?: unknown })?.customType ?? "",
		);
		if (customType.endsWith(":inquiry-fold")) this.actions.push("fold");
		else if (customType.endsWith(":inquiry")) this.actions.push("inquiry");
		else if (customType === "pi-reflect-watchdog:route-correction")
			this.actions.push("route-correction");
	}

	appendEntry(customType: string, data: unknown) {
		this.entries.push({ customType, data });
		this.actions.push(`entry:${customType}`);
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
	paused = false;
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
		if (this.attachments.size === 0) {
			this.paused = false;
			this.value = { ...this.value, paused: false };
		}
		this.refreshBusy();
	}

	async setBusy(instance: object, busy: boolean) {
		this.activityWrites.push(busy);
		this.attachments.set(instance, busy);
		this.refreshBusy();
	}

	async recordRootLoop() {
		if (this.paused) return this.value;
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
		if (this.paused) return this.value;
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

	async setPaused(paused: boolean) {
		this.paused = paused;
		this.value = { ...this.value, paused };
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
			paused: this.paused,
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
	options: { idle?: boolean; hasUI?: boolean; mode?: "rpc" | "tui" } = {},
) {
	let idle = options.idle ?? true;
	let pendingMessages = false;
	let branch: any[] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const widgets: Array<unknown> = [];
	const manager = {
		getSessionId: () => sessionId,
		getBranch: () => branch,
	};
	return {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "rpc",
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
		setBranch(entries: any[]) {
			branch = entries;
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

const config: WatchdogConfig = {
	rootLoopLimit: 2,
	allLoopLimit: 3,
	taskMinutes: 30,
	idleResetGapSeconds: 60,
	reflectionPrompt: DEFAULT_REFLECTION_PROMPT,
	hookPauses: [],
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

function publishHook(pi: Pi, name: string) {
	publishSemanticHook(pi.events, { name });
}

async function flushAsync() {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function turnEnd(stopReason: string) {
	return { message: { role: "assistant", stopReason } };
}

function lastInquiry(pi: Pi) {
	return pi.messages.findLast(({ message }) =>
		String(message.customType ?? "").endsWith(":inquiry"),
	)?.message;
}

function lastInquiryFold(pi: Pi) {
	return pi.messages.findLast(({ message }) =>
		String(message.customType ?? "").endsWith(":inquiry-fold"),
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

function branchMessage(message: any, id: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-30T00:00:00.000Z",
		message,
	};
}

function completedReflect(id = "reflect") {
	const correlation = {
		version: 1,
		namespace: "pi-reflect-watchdog",
		inquiryId: id,
		attempt: 1,
	};
	return [
		branchMessage(
			{
				role: "assistant",
				stopReason: "stop",
				content: [],
				details: { piInquiry: correlation },
			},
			`${id}-assistant`,
		),
		{
			type: "custom",
			id: `${id}-completed`,
			parentId: null,
			timestamp: "2026-08-30T00:00:00.000Z",
			customType: "pi-reflect-watchdog:reflection-completed",
			data: correlation,
		},
	];
}

function ordinaryLoop(id: string, stopReason = "stop") {
	return branchMessage(
		{ role: "assistant", stopReason, content: [{ type: "text", text: id }] },
		id,
	);
}

const validNoIssue =
	"<reflection><type>NO_ISSUE</type><reason>sound</reason><done>checked</done><current_step>verify</current_step><next_step>continue</next_step></reflection>";
const validCorrection =
	"<reflection><type>ROUTE_CORRECTION</type><reason>change route</reason><done>checked</done><current_step>verify</current_step><next_step>continue differently</next_step></reflection>";

async function completeReflectionAttempt(
	pi: Pi,
	ctx: ReturnType<typeof context>,
	text: string,
) {
	const captured = await pi.emit("message_end", assistant(text), ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	return captured;
}

async function startReflectionRun(pi: Pi, ctx: ReturnType<typeof context>) {
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await correlateReflection(pi, ctx);
}

test("Reflect cooldown follows completed inquiry blocks and the inclusive ten-loop boundary", () => {
	const completed = completedReflect();
	assert.deepEqual(reflectCooldownState(completed as any), {
		skipAutomatic: true,
		remainingLoops: 10,
	});
	const nineLoops = [
		...completed,
		...Array.from({ length: 9 }, (_, index) =>
			ordinaryLoop(`ordinary-${index}`),
		),
	];
	assert.deepEqual(reflectCooldownState(nineLoops as any), {
		skipAutomatic: true,
		remainingLoops: 1,
	});
	assert.deepEqual(
		reflectCooldownState([...nineLoops, ordinaryLoop("ordinary-10")] as any),
		{ skipAutomatic: true, remainingLoops: 0 },
	);
	assert.deepEqual(
		reflectCooldownState([
			...nineLoops,
			ordinaryLoop("ordinary-10"),
			ordinaryLoop("ordinary-11", "toolUse"),
		] as any),
		{ skipAutomatic: false, remainingLoops: 0 },
	);
	const invalidMarker = branchMessage(
		{
			role: "assistant",
			stopReason: "stop",
			content: [],
			details: {
				piInquiry: {
					version: 1,
					namespace: "pi-reflect-watchdog",
					inquiryId: "invalid",
					attempt: 1,
				},
			},
		},
		"invalid-assistant",
	);
	assert.deepEqual(reflectCooldownState([invalidMarker] as any), {
		skipAutomatic: false,
		remainingLoops: 0,
	});
	const orphanCompletion = completedReflect("orphan")[1];
	const laterIncomplete = branchMessage(
		{
			role: "assistant",
			stopReason: "stop",
			content: [],
			details: {
				piInquiry: {
					version: 1,
					namespace: "pi-reflect-watchdog",
					inquiryId: "later-incomplete",
					attempt: 1,
				},
			},
		},
		"later-incomplete",
	);
	assert.deepEqual(
		reflectCooldownState([
			...completed,
			ordinaryLoop("after-valid"),
			laterIncomplete,
			orphanCompletion,
		] as any),
		{ skipAutomatic: true, remainingLoops: 9 },
	);
});

test("automatic Reflect is consumed during cooldown while manual Reflect bypasses", async () => {
	const ctx = context("root", { mode: "tui" });
	const { pi, domain } = install({
		ctx,
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	ctx.setBranch([...completedReflect(), ordinaryLoop("ordinary-1")]);
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(lastInquiry(pi), undefined);
	assert.equal(domain.resetWrites, 1);
	assert.equal(
		ctx.notifications.filter(
			(message) => message === "Reflect skipped during cooldown.",
		).length,
		1,
	);
	await pi.commands[0]?.handler("manual bypass", ctx);
	assert.match(lastInquiry(pi)?.content ?? "", /manual bypass/);
});

test("paired semantic hooks nest independently, overlap, and keep manual reflect available", async () => {
	const { pi, ctx, domain } = install({
		limits: {
			rootLoopLimit: 1,
			hookPauses: [
				{ pause: "inquiry-started", resume: "inquiry-finished" },
				{ pause: "inquiry-started", resume: "review-finished" },
			],
		},
	});
	await pi.emit("session_start", {}, ctx);
	publishHook(pi, "inquiry-finished");
	publishHook(pi, "inquiry-started");
	publishHook(pi, "inquiry-started");
	await flushAsync();
	assert.equal(domain.paused, true);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.rootWrites, 0);
	assert.equal(lastInquiry(pi), undefined);

	await pi.commands[0]?.handler("manual during pause", ctx);
	assert.match(lastInquiry(pi)?.content ?? "", /USER_REQUEST/);
	const manualCount = pi.messages.length;
	publishHook(pi, "inquiry-finished");
	publishHook(pi, "review-finished");
	await flushAsync();
	assert.equal(domain.paused, true, "one nested depth remains");
	publishHook(pi, "inquiry-finished");
	publishHook(pi, "review-finished");
	await flushAsync();
	assert.equal(domain.paused, false);
	assert.equal(pi.messages.length, manualCount);
});

test("paused lifecycle observations do not reopen process-domain activity", async () => {
	const { pi, ctx, domain } = install({
		limits: {
			hookPauses: [{ pause: "work-paused", resume: "work-resumed" }],
		},
	});
	await pi.emit("session_start", {}, ctx);
	publishHook(pi, "work-paused");
	await flushAsync();
	const writesBefore = domain.activityWrites.length;
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(domain.activityWrites.length, writesBefore);
	publishHook(pi, "work-resumed");
	await flushAsync();
	assert.equal(domain.paused, false);
});

test("observer lifecycle is gated by authoritative domain pause", async () => {
	const hub = createObservableAgentHub();
	const domain = new FakeDomain();
	const root = install({
		hub,
		domain,
		ctx: context("root", { hasUI: true }),
		limits: {
			hookPauses: [{ pause: "work-paused", resume: "work-resumed" }],
		},
	});
	const child = install({
		hub,
		domain,
		ctx: context("child", { hasUI: false }),
		limits: {
			hookPauses: [{ pause: "work-paused", resume: "work-resumed" }],
		},
	});
	await root.pi.emit("session_start", {}, root.ctx);
	await child.pi.emit("session_start", {}, child.ctx);
	publishHook(root.pi, "work-paused");
	await flushAsync();
	const writesBefore = domain.activityWrites.length;
	child.ctx.setIdle(false);
	await child.pi.emit("agent_start", {}, child.ctx);
	await child.pi.emit("turn_end", turnEnd("stop"), child.ctx);
	child.ctx.setIdle(true);
	await child.pi.emit("agent_settled", {}, child.ctx);
	assert.equal(domain.activityWrites.length, writesBefore);
	assert.equal(domain.allWrites, 0);
	publishHook(root.pi, "work-resumed");
	await flushAsync();
	child.ctx.setIdle(false);
	await child.pi.emit("agent_start", {}, child.ctx);
	assert.equal(domain.activityWrites.at(-1), true);
});

test("resume re-evaluates frozen threshold and shutdown unsubscribes and resumes", async () => {
	const { pi, ctx, domain } = install({
		limits: {
			rootLoopLimit: 1,
			hookPauses: [{ pause: "work-paused", resume: "work-resumed" }],
		},
	});
	await pi.emit("session_start", {}, ctx);
	publishHook(pi, "work-paused");
	await flushAsync();
	domain.setCounters({ rootLoops: 1n, allLoops: 1n });
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.rootWrites, 0);
	assert.equal(lastInquiry(pi), undefined);
	pi.events.emit("pi:semantic-hook:v1", { version: 9, name: "work-resumed" });
	assert.equal(domain.paused, true);
	publishHook(pi, "work-resumed");
	await flushAsync();
	assert.equal(domain.paused, false);
	assert.match(lastInquiry(pi)?.content ?? "", /ROOT_LOOP_LIMIT/);

	publishHook(pi, "work-paused");
	await flushAsync();
	assert.equal(domain.paused, true);
	await pi.emit("session_shutdown", {}, ctx);
	await flushAsync();
	assert.equal(domain.paused, false);
	publishHook(pi, "work-paused");
	await flushAsync();
	assert.equal(domain.paused, false);
});

test("observer shutdown preserves owner pause until final domain detach", async () => {
	const hub = createObservableAgentHub();
	const domain = new FakeDomain();
	const root = install({
		hub,
		domain,
		ctx: context("root", { hasUI: true }),
		limits: {
			hookPauses: [{ pause: "work-paused", resume: "work-resumed" }],
		},
	});
	const child = install({
		hub,
		domain,
		ctx: context("child", { hasUI: false }),
		limits: {
			hookPauses: [{ pause: "work-paused", resume: "work-resumed" }],
		},
	});
	await root.pi.emit("session_start", {}, root.ctx);
	await child.pi.emit("session_start", {}, child.ctx);
	publishHook(root.pi, "work-paused");
	await flushAsync();
	assert.equal(domain.paused, true);
	await child.pi.emit("session_shutdown", {}, child.ctx);
	await flushAsync();
	assert.equal(domain.paused, true, "observer cannot resume the owner pause");
	await root.pi.emit("session_shutdown", {}, root.ctx);
	await flushAsync();
	assert.equal(
		domain.paused,
		false,
		"final detach destroys paused domain state",
	);
});

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

test("same-process child threshold queues reflection while the child stays busy", async () => {
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
	assert.match(lastInquiry(root.pi)?.content ?? "", /ALL_LOOP_LIMIT/);
});

test("cross-process child threshold queues reflection while the child stays busy", async () => {
	const { pi, ctx, domain } = install({
		limits: { allLoopLimit: 1, rootLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	domain.setRemoteBusy(true);
	await domain.recordAllLoop();
	assert.match(lastInquiry(pi)?.content ?? "", /ALL_LOOP_LIMIT/);
});

test("native Pi steering queue accepts reflection despite an existing pending message", async () => {
	const { pi, ctx, domain } = install({
		limits: { allLoopLimit: 1, rootLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	ctx.setPendingMessages(true);
	await pi.emit("agent_start", {}, ctx);
	await domain.recordAllLoop();
	const inquiry = lastInquiry(pi);
	assert.match(inquiry?.content ?? "", /ALL_LOOP_LIMIT/);
	assert.deepEqual(pi.messages[pi.messages.length - 1]?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});
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
	assert.ok(lastInquiryFold(pi));
	assert.equal(
		pi.entries.filter(
			(entry) =>
				entry.customType === "pi-reflect-watchdog:reflection-completed",
		).length,
		1,
	);
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
		{
			message: {
				role: "assistant",
				content: [{ type: "text", text: validNoIssue }],
				stopReason: "stop",
			},
		},
		ctx,
	);
	assert.equal(replacement.message.stopReason, "stop");
	assert.equal(replacement.message.errorMessage, undefined);
});

test("invalid XML re-ask folds every attempt out of later context", async () => {
	const { pi, ctx, domain } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	const firstCaptured = await pi.emit("message_end", assistant("not XML"), ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.rootWrites, 0);
	assert.equal(domain.allWrites, 0);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(pi.entries.length, 0);
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
	const secondCaptured = await pi.emit(
		"message_end",
		assistant(validNoIssue),
		ctx,
	);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.rootWrites, 0);
	assert.equal(domain.allWrites, 0);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		pi.entries.filter(
			(entry) =>
				entry.customType === "pi-reflect-watchdog:reflection-completed",
		).length,
		1,
	);

	let timestamp = 1;
	const transcript = pi.messages
		.filter(({ message }) => {
			const type = String(message.customType ?? "");
			return type.endsWith(":inquiry") || type.endsWith(":inquiry-fold");
		})
		.flatMap(({ message }) => {
			const control = { role: "custom", ...message, timestamp: timestamp++ };
			if (!String(message.customType).endsWith(":inquiry")) return [control];
			const captured =
				message.details.attempt === 1
					? firstCaptured.message
					: secondCaptured.message;
			return [control, { ...captured, timestamp: timestamp++ }];
		});
	const folded = await pi.emit("context", { messages: transcript }, ctx);
	assert.deepEqual(
		folded.messages,
		[],
		"reflection retries and control messages must not reach later model context",
	);
});

test("three-attempt XML correction chain emits one final fold and leaves no context", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	const captured = [
		await completeReflectionAttempt(pi, ctx, "invalid attempt one"),
	];
	await startReflectionRun(pi, ctx);
	captured.push(
		await completeReflectionAttempt(pi, ctx, "invalid attempt two"),
	);
	await startReflectionRun(pi, ctx);
	captured.push(await completeReflectionAttempt(pi, ctx, validNoIssue));

	const controls = pi.messages.filter(({ message }) => {
		const type = String(message.customType ?? "");
		return type.endsWith(":inquiry") || type.endsWith(":inquiry-fold");
	});
	assert.equal(
		controls.filter(({ message }) =>
			String(message.customType).endsWith(":inquiry"),
		).length,
		3,
	);
	assert.equal(
		controls.filter(({ message }) =>
			String(message.customType).endsWith(":inquiry-fold"),
		).length,
		1,
	);
	let timestamp = 1;
	let assistantIndex = 0;
	const transcript = controls.flatMap(({ message }) => {
		const control = { role: "custom", ...message, timestamp: timestamp++ };
		if (!String(message.customType).endsWith(":inquiry")) return [control];
		const reply = captured[assistantIndex++];
		assert.ok(reply);
		return [control, { ...reply.message, timestamp: timestamp++ }];
	});
	const folded = await pi.emit("context", { messages: transcript }, ctx);
	assert.deepEqual(folded.messages, []);
});

test("three invalid XML attempts emit one final fold without result evidence", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await startReflectionRun(pi, ctx);
		await completeReflectionAttempt(pi, ctx, `invalid attempt ${attempt}`);
	}

	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		3,
	);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry-fold"),
		).length,
		1,
	);
	assert.equal(pi.entries.length, 0);
	assert.match(ctx.notifications.join("\n"), /Reflection failed:/);
});

test("route correction starts one ordinary continuation without XML priming", async () => {
	const { pi, ctx, domain } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	await pi.emit("message_end", assistant(validCorrection), ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.rootWrites, 0);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	const correction = [...pi.messages]
		.reverse()
		.find(
			({ message }) =>
				message.customType === "pi-reflect-watchdog:route-correction",
		);
	assert.ok(correction);
	assert.equal(
		pi.entries.filter(
			(entry) => entry.customType === "pi-reflect-watchdog:reflection",
		).length,
		1,
		"route correction persists exactly one context-excluded result",
	);
	assert.deepEqual(pi.actions.slice(-4), [
		"fold",
		"route-correction",
		"entry:pi-reflect-watchdog:reflection",
		"entry:pi-reflect-watchdog:reflection-completed",
	]);
	assert.deepEqual(correction.options, {
		deliverAs: "steer",
		triggerTurn: true,
	});
	const firstLine = correction.message.content.split("\n", 1)[0];
	assert.equal(
		firstLine,
		"Continue the current task using this corrected route.",
	);
	assert.doesNotMatch(firstLine, /reflection|xml/i);
	assert.doesNotMatch(
		correction.message.customType,
		/:inquiry(?::|$)/,
		"ordinary continuation is outside the internal inquiry namespace",
	);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.rootWrites, 1);
});

test("completed reflection becomes the next prompt's leading branch reference", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	await pi.emit("message_end", assistant(validNoIssue), ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);

	const result = pi.entries.find(
		(entry) => entry.customType === "pi-reflect-watchdog:reflection",
	);
	assert.ok(result, "valid reflection must persist a context-excluded result");
	const data = result.data as {
		readonly timestamp: string;
		readonly decision: { readonly reason: string };
		readonly report: string;
	};
	assert.equal(data.decision.reason, "sound");
	assert.match(data.report, /Reason: sound/);
	ctx.setBranch([
		{
			type: "custom",
			id: "malformed-reflection",
			parentId: null,
			timestamp: data.timestamp,
			customType: result.customType,
			data: { report: "poison" },
		},
		{
			type: "custom",
			id: "previous-reflection",
			parentId: null,
			timestamp: data.timestamp,
			customType: result.customType,
			data: result.data,
		},
		{
			type: "custom",
			id: "newer-malformed-reflection",
			parentId: null,
			timestamp: data.timestamp,
			customType: result.customType,
			data: { version: 1, report: "newer poison" },
		},
	]);

	await pi.commands[0]?.handler("", ctx);
	const prompt = lastInquiry(pi)?.content ?? "";
	const previous = prompt.indexOf(data.report);
	const current = prompt.indexOf("[Plugin-generated reflection context]");
	assert.ok(previous >= 0, "latest valid branch reflection must be included");
	assert.ok(
		previous < current,
		"previous reflection must precede current context",
	);
	assert.doesNotMatch(prompt, /poison/);
});

test("queued second reflection dispatches after completed evidence is visible", async () => {
	const ctx = context();
	const { pi } = install({ ctx });
	const branch: any[] = [];
	const originalAppendEntry = pi.appendEntry.bind(pi);
	pi.appendEntry = (customType: string, data: unknown) => {
		originalAppendEntry(customType, data);
		branch.push({ type: "custom", customType, data });
		ctx.setBranch(branch);
	};
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("first supplement", ctx);
	await startReflectionRun(pi, ctx);
	await pi.commands[0]?.handler("second supplement", ctx);
	await completeReflectionAttempt(pi, ctx, validNoIssue);

	const inquiries = pi.messages.filter(({ message }) =>
		String(message.customType ?? "").endsWith(":inquiry"),
	);
	assert.equal(inquiries.length, 2);
	assert.match(inquiries[1]?.message.content ?? "", /Reason: sound/);
	assert.match(inquiries[1]?.message.content ?? "", /second supplement/);
	assert.deepEqual(pi.actions.slice(-4), [
		"fold",
		"entry:pi-reflect-watchdog:reflection",
		"entry:pi-reflect-watchdog:reflection-completed",
		"inquiry",
	]);
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
