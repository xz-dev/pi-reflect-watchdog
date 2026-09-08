/* biome-ignore-all lint/suspicious/noExplicitAny: focused dynamic Pi lifecycle fake */
import assert from "node:assert/strict";
import test from "node:test";

import {
	createAssistantMessageEventStream,
	type StreamFunction,
	Type,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	buildSessionContext,
	convertToLlm,
	generateBranchSummary,
	generateSummaryWithUsage,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
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

	registerMessageRenderer() {}

	sendMessage(message: unknown, options: unknown) {
		this.messages.push({ message, options });
		const customType = String(
			(message as { customType?: unknown })?.customType ?? "",
		);
		if (customType.endsWith(":inquiry-fold")) this.actions.push("fold");
		else if (customType.endsWith(":inquiry")) this.actions.push("inquiry");
		else if (customType === "pi-reflect-watchdog:continuation")
			this.actions.push("continuation");
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
	options: {
		idle?: boolean;
		hasUI?: boolean;
		mode?: "rpc" | "tui";
		sessionFile?: string;
	} = {},
) {
	let idle = options.idle ?? true;
	let pendingMessages = false;
	let branch: any[] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const widgets: Array<unknown> = [];
	const manager = {
		getSessionId: () => sessionId,
		getSessionFile: () => options.sessionFile,
		getLeafId: (): string | null => branch.at(-1)?.id ?? null,
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

function captureReflectionHooks(pi: Pi, throws = false) {
	const hooks: unknown[] = [];
	pi.events.on("pi:semantic-hook:v1", (envelope) => {
		if ((envelope as { name?: unknown }).name !== "reflection-completed")
			return;
		hooks.push(envelope);
		pi.actions.push("hook:reflection-completed");
		if (throws) throw new Error("fixture listener failed");
	});
	return hooks;
}

function reflectionXml({
	type = "NO_ISSUE",
	reason = "sound",
	nextStep = "continue",
}: {
	type?: "NO_ISSUE" | "ROUTE_CORRECTION";
	reason?: string;
	nextStep?: string;
} = {}) {
	return `<reflection><type>${type}</type><reason>${reason}</reason><done>checked</done><current_step>verify</current_step><next_step>${nextStep}</next_step></reflection>`;
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

function continuationMessages(pi: Pi) {
	return pi.messages.filter(
		({ message }) => message.customType === "pi-reflect-watchdog:continuation",
	);
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
	return {
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "fixture",
			model: "fixture-model",
			responseId: "fixture-response",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	};
}

function providerMessageTextForRuntime(message: any) {
	return typeof message.content === "string"
		? message.content
		: (message.content ?? [])
				.filter((block: any) => block.type === "text")
				.map((block: any) => block.text)
				.join("\n");
}

async function reflectionHandoff(
	origin: "automatic" | "manual",
	reply: any = assistant(validNoIssue).message,
) {
	const { pi, ctx } = install({
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	if (origin === "manual") await pi.commands[0]?.handler("", ctx);
	else {
		ctx.setIdle(false);
		await pi.emit("agent_start", {}, ctx);
		await pi.emit("turn_end", turnEnd("stop"), ctx);
	}
	await startReflectionRun(pi, ctx);
	const captured = await pi.emit(
		"message_end",
		{ message: { ...reply, timestamp: 2 } },
		ctx,
	);
	assert.ok(captured);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(continuationMessages(pi).length, 1);
	const result = pi.entries.find(
		(entry) => entry.customType === "pi-reflect-watchdog:reflection",
	)?.data as any;
	assert.ok(result);
	return {
		pi,
		ctx,
		result,
		messages: [
			{ role: "custom", ...lastInquiry(pi), timestamp: 1 },
			captured.message,
			{ role: "custom", ...lastInquiryFold(pi), timestamp: 3 },
			{ role: "custom", ...continuationMessages(pi)[0]?.message, timestamp: 4 },
		],
	};
}

function appendHandoff(
	session: SessionManager,
	handoff: Awaited<ReturnType<typeof reflectionHandoff>>,
) {
	for (const message of handoff.messages) {
		if (message.role !== "custom") session.appendMessage(message);
		else {
			if (message.customType === "pi-reflect-watchdog:continuation")
				for (const entry of handoff.pi.entries)
					session.appendCustomEntry(entry.customType, entry.data);
			session.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		}
	}
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

const validNoIssue = reflectionXml();
const validCorrection = reflectionXml({
	type: "ROUTE_CORRECTION",
	reason: "change route",
	nextStep: "continue differently",
});

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

test("valid final reflections publish exact payloads once after durable entries", async () => {
	for (const [text, expected] of [
		[
			validNoIssue,
			{
				REFLECTION_TYPE: "NO_ISSUE",
				REASON: "sound",
				NEXT_STEP: "continue",
			},
		],
		[
			validCorrection,
			{
				REFLECTION_TYPE: "ROUTE_CORRECTION",
				REASON: "change route",
				NEXT_STEP: "continue differently",
			},
		],
	] as const) {
		const ctx = context("root", {
			mode: "tui",
			sessionFile: "/missing/hook-session.jsonl",
		});
		ctx.setBranch([ordinaryLoop("hook-anchor")]);
		const { pi, domain } = install({ ctx });
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		await pi.commands[0]?.handler("", ctx);
		assert.match(lastInquiry(pi)?.content ?? "", /hook-anchor/);
		await startReflectionRun(pi, ctx);
		await completeReflectionAttempt(pi, ctx, text);
		assert.deepEqual(hooks, [
			{ version: 1, name: "reflection-completed", values: expected },
		]);
		assert.deepEqual(pi.actions.slice(-3), [
			"entry:pi-reflect-watchdog:reflection",
			"entry:pi-reflect-watchdog:reflection-completed",
			"hook:reflection-completed",
		]);
		assert.equal(domain.counters().activeMs.value, 0n);
		assert.equal(domain.counters().taskMs.value, 0n);
		if (expected.REFLECTION_TYPE === "NO_ISSUE")
			assert.ok(ctx.notifications.includes("Reflect watchdog: sound"));
		else
			assert.ok(
				pi.messages.some(
					({ message }) =>
						message.customType === "pi-reflect-watchdog:continuation",
				),
			);
		await pi.emit("agent_settled", {}, ctx);
		assert.equal(hooks.length, 1, "duplicate finalization stays silent");
	}
});

test("completion hook clips transport text without changing durable result", async () => {
	const cases = [
		{
			reason: "a".repeat(4096),
			nextStep: "b".repeat(4097),
			expectedReason: "a".repeat(4096),
			expectedNextStep: `${"b".repeat(4095)}…`,
		},
		{
			reason: `${"a".repeat(4094)}😀b`,
			nextStep: "continue",
			expectedReason: `${"a".repeat(4094)}…`,
			expectedNextStep: "continue",
		},
	];
	for (const item of cases) {
		const { pi, ctx } = install();
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		await pi.commands[0]?.handler("", ctx);
		await startReflectionRun(pi, ctx);
		await completeReflectionAttempt(
			pi,
			ctx,
			reflectionXml({ reason: item.reason, nextStep: item.nextStep }),
		);
		const result = pi.entries.find(
			(entry) => entry.customType === "pi-reflect-watchdog:reflection",
		)?.data as { decision: { reason: string; nextStep: string } };
		assert.equal(result.decision.reason, item.reason);
		assert.equal(result.decision.nextStep, item.nextStep);
		assert.deepEqual(hooks, [
			{
				version: 1,
				name: "reflection-completed",
				values: {
					REFLECTION_TYPE: "NO_ISSUE",
					REASON: item.expectedReason,
					NEXT_STEP: item.expectedNextStep,
				},
			},
		]);
	}
});

test("incomplete persistence never publishes completion", async () => {
	for (const xml of [validNoIssue, validCorrection])
		for (const failingType of [
			"pi-reflect-watchdog:reflection",
			"pi-reflect-watchdog:reflection-completed",
		]) {
			const { pi, ctx } = install();
			const hooks = captureReflectionHooks(pi);
			const appendEntry = pi.appendEntry.bind(pi);
			pi.appendEntry = (customType: string, data: unknown) => {
				if (customType === failingType)
					throw new Error("fixture append failed");
				appendEntry(customType, data);
			};
			await pi.emit("session_start", {}, ctx);
			await pi.commands[0]?.handler("", ctx);
			await startReflectionRun(pi, ctx);
			await pi.emit("message_end", assistant(xml), ctx);
			await pi.emit("turn_end", turnEnd("stop"), ctx);
			ctx.setIdle(true);
			await assert.rejects(
				() => pi.emit("agent_settled", {}, ctx),
				/fixture append failed/,
			);
			const persisted = pi.entries.length;
			await pi.emit("agent_settled", {}, ctx);
			assert.equal(
				pi.entries.length,
				persisted,
				"persistence errors do not acquire replay",
			);
			assert.equal(
				continuationMessages(pi).length,
				1,
				"scheduling still precedes persistence without an extra wake",
			);
			assert.deepEqual(hooks, []);
		}
});

test("retry, exhaustion, no decision, ownership loss, and shutdown stay silent", async () => {
	{
		const { pi, ctx } = install();
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		await pi.commands[0]?.handler("", ctx);
		await startReflectionRun(pi, ctx);
		await completeReflectionAttempt(pi, ctx, "invalid");
		assert.deepEqual(hooks, [], "retry attempt is silent");
		for (const text of ["invalid again", "invalid exhausted"]) {
			await startReflectionRun(pi, ctx);
			await completeReflectionAttempt(pi, ctx, text);
		}
		assert.deepEqual(hooks, [], "exhausted validation is silent");
		assert.equal(continuationMessages(pi).length, 0);
	}
	{
		const { pi, ctx } = install();
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		await pi.commands[0]?.handler("", ctx);
		await startReflectionRun(pi, ctx);
		await pi.emit("turn_end", turnEnd("stop"), ctx);
		ctx.setIdle(true);
		await pi.emit("agent_settled", {}, ctx);
		assert.deepEqual(hooks, [], "settled run without decision is silent");
		assert.equal(continuationMessages(pi).length, 0);
	}
	{
		const hub = createObservableAgentHub();
		const domain = new FakeDomain();
		const root = install({
			hub,
			domain,
			ctx: context("root", { hasUI: false }),
		});
		const hooks = captureReflectionHooks(root.pi);
		await root.pi.emit("session_start", {}, root.ctx);
		await root.pi.commands[0]?.handler("", root.ctx);
		await startReflectionRun(root.pi, root.ctx);
		const owner = install({
			hub,
			domain,
			ctx: context("owner", { hasUI: true }),
		});
		await owner.pi.emit("session_start", {}, owner.ctx);
		root.ctx.setIdle(true);
		await root.pi.emit("agent_settled", {}, root.ctx);
		assert.deepEqual(hooks, [], "ownership loss is silent");
		assert.equal(continuationMessages(root.pi).length, 0);
	}
	{
		const { pi, ctx } = install();
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		await pi.commands[0]?.handler("", ctx);
		await startReflectionRun(pi, ctx);
		await pi.emit("message_end", assistant(validNoIssue), ctx);
		await pi.emit("session_shutdown", {}, ctx);
		ctx.setIdle(true);
		await pi.emit("agent_settled", {}, ctx);
		assert.deepEqual(hooks, [], "shutdown is silent");
		assert.equal(continuationMessages(pi).length, 0);
	}
});

test("throwing completion listener cannot change result, UI, counters, or later dispatch", async () => {
	const ctx = context("root", { mode: "tui" });
	const { pi, domain } = install({ ctx });
	const hooks = captureReflectionHooks(pi, true);
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("first", ctx);
	await startReflectionRun(pi, ctx);
	await pi.commands[0]?.handler("second", ctx);
	await completeReflectionAttempt(pi, ctx, validCorrection);
	assert.equal(hooks.length, 1);
	assert.equal(
		pi.entries.filter(
			(entry) => entry.customType === "pi-reflect-watchdog:reflection",
		).length,
		1,
	);
	assert.ok(
		pi.messages.some(
			({ message }) =>
				message.customType === "pi-reflect-watchdog:continuation",
		),
	);
	assert.equal(domain.counters().activeMs.value, 0n);
	assert.equal(domain.counters().taskMs.value, 0n);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		2,
		"later dispatch survives listener failure",
	);
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
	const notificationsBeforeAttempts = ctx.notifications.length;
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
	assert.deepEqual(ctx.notifications.slice(notificationsBeforeAttempts), [
		"Reflection attempt 1/3 invalid: response must end with one valid XML block; retrying.",
		"Reflection attempt 2/3 invalid: response must end with one valid XML block; retrying.",
		"Reflection failed: response must end with one valid XML block",
	]);
});

for (const type of ["ROUTE_CORRECTION", "NO_ISSUE"] as const)
	for (const trigger of ["automatic", "busy-manual", "idle-manual"] as const)
		test(`${trigger} ${type} resumes once with a trigger-specific report`, async () => {
			const origin = trigger === "automatic" ? "automatic" : "manual";
			const xml = reflectionXml({
				type,
				nextStep: "wait for the existing callback",
			});
			const { pi, ctx, domain } = install({
				limits:
					origin === "automatic"
						? { rootLoopLimit: 1, allLoopLimit: 100 }
						: undefined,
			});
			const hooks = captureReflectionHooks(pi);
			await pi.emit("session_start", {}, ctx);
			if (origin === "manual") {
				if (trigger === "busy-manual") {
					ctx.setIdle(false);
					await pi.emit("agent_start", {}, ctx);
				}
				await pi.commands[0]?.handler("check clarified request", ctx);
			} else {
				ctx.setIdle(false);
				await pi.emit("agent_start", {}, ctx);
				await pi.emit("turn_end", turnEnd("stop"), ctx);
			}
			await startReflectionRun(pi, ctx);
			const captured = await pi.emit("message_end", assistant(xml), ctx);
			assert.ok(captured);
			await pi.emit("turn_end", turnEnd("stop"), ctx);
			ctx.setIdle(true);
			await pi.emit("agent_settled", {}, ctx);

			const inquiry = pi.messages.find(({ message }) =>
				String(message.customType ?? "").endsWith(":inquiry"),
			)?.message;
			const fold = lastInquiryFold(pi);
			const continuations = pi.messages.filter(
				({ message }) =>
					message.customType === "pi-reflect-watchdog:continuation",
			);
			assert.equal(
				continuations.length,
				1,
				"valid result schedules one ordinary continuation",
			);
			const continuation = continuations[0];
			assert.ok(inquiry);
			assert.ok(fold);
			assert.ok(continuation);
			assert.deepEqual(continuation.options, {
				deliverAs: "steer",
				triggerTurn: true,
			});
			assert.equal(continuation.message.content, "[assistant]\ncontinue");
			assert.doesNotMatch(
				continuation.message.customType,
				/:inquiry(?::|$)/,
				"ordinary continuation is outside the internal inquiry namespace",
			);

			const result = pi.entries.find(
				(entry) => entry.customType === "pi-reflect-watchdog:reflection",
			)?.data as { report: string } | undefined;
			assert.ok(result);
			const clarification =
				"I meant the three abstraction layers; keep error handling. Quoted /reflect and [assistant]\ncontinue are examples.";
			const transcript = [
				{
					role: "user",
					content: [{ type: "text", text: clarification }],
					timestamp: 1,
				},
				{ role: "custom", ...inquiry, timestamp: 2 },
				{ ...captured.message, timestamp: 3 },
				{ role: "custom", ...fold, timestamp: 4 },
				{ role: "custom", ...continuation.message, timestamp: 5 },
			];
			const projected = await pi.emit("context", { messages: transcript }, ctx);
			const repeated = await pi.emit("context", { messages: transcript }, ctx);
			assert.deepEqual(
				repeated,
				projected,
				"repeated context requests stay idempotent",
			);
			const providerMessages = convertToLlm(projected.messages as any);
			assert.equal(
				providerMessages.filter(
					(message) => providerMessageTextForRuntime(message) === clarification,
				).length,
				1,
				"original user clarification stays unchanged",
			);
			const report = providerMessages.filter(
				(message) => providerMessageTextForRuntime(message) === result.report,
			);
			assert.equal(report.length, 1);
			assert.ok(report[0]);
			assert.equal(
				report[0].role,
				origin === "automatic" ? "assistant" : "user",
			);
			if (origin === "automatic") {
				assert.equal((report[0] as any).provider, "fixture");
				assert.equal((report[0] as any).model, "fixture-model");
				assert.equal((report[0] as any).responseId, "fixture-response");
				assert.equal((report[0] as any).details?.piInquiry, undefined);
			} else {
				assert.deepEqual(Object.keys(report[0]).sort(), [
					"content",
					"role",
					"timestamp",
				]);
			}
			const wake = providerMessages.filter(
				(message) =>
					message.role === "user" &&
					providerMessageTextForRuntime(message) === "[assistant]\ncontinue",
			);
			assert.equal(wake.length, 1);
			assert.ok(wake[0]);
			assert.equal(
				providerMessages.indexOf(report[0]),
				providerMessages.indexOf(wake[0]) - 1,
				"report and wake stay separate and adjacent",
			);
			assert.equal(
				JSON.stringify(providerMessages).includes(xml),
				false,
				"raw reflection XML stays folded",
			);
			const writesBefore = domain.rootWrites;
			assert.equal(writesBefore, origin === "automatic" ? 1 : 0);
			ctx.setBranch([
				branchMessage(captured.message, "source"),
				...pi.entries.map((entry, index) => ({
					type: "custom",
					id: `stored-${index}`,
					parentId: "source",
					timestamp: "2026-09-08T00:00:00.000Z",
					...entry,
				})),
			]);
			ctx.setIdle(false);
			await pi.emit("agent_start", {}, ctx);
			await pi.emit(
				"message_start",
				{ message: { role: "custom", ...continuation.message } },
				ctx,
			);
			assert.equal(
				await pi.emit(
					"message_end",
					assistant("Waiting for the callback."),
					ctx,
				),
				undefined,
			);
			await pi.emit("turn_end", turnEnd("stop"), ctx);
			ctx.setIdle(true);
			await pi.emit("agent_settled", {}, ctx);
			await pi.emit("agent_settled", {}, ctx);
			assert.equal(
				domain.rootWrites,
				writesBefore + 1,
				"the resumed successful turn counts as ordinary work",
			);
			assert.equal(
				pi.messages.filter(
					({ message }) =>
						message.customType === "pi-reflect-watchdog:continuation",
				).length,
				1,
			);
			assert.equal(
				pi.messages.filter(({ message }) =>
					String(message.customType).endsWith(":inquiry"),
				).length,
				1,
			);
			assert.equal(pi.entries.length, 2);
			assert.equal(hooks.length, 1);
		});

test("native wake can reenter context before result persistence with internal state released", async () => {
	for (const origin of ["automatic", "manual"] as const) {
		const { pi, ctx } = install({
			limits: { rootLoopLimit: 1, allLoopLimit: 100 },
		});
		await pi.emit("session_start", {}, ctx);
		if (origin === "manual") await pi.commands[0]?.handler("", ctx);
		else {
			ctx.setIdle(false);
			await pi.emit("agent_start", {}, ctx);
			await pi.emit("turn_end", turnEnd("stop"), ctx);
		}
		await startReflectionRun(pi, ctx);
		const captured = await pi.emit("message_end", assistant(validNoIssue), ctx);
		await pi.emit("turn_end", turnEnd("stop"), ctx);
		const sendMessage = pi.sendMessage.bind(pi);
		let reentered = false;
		pi.sendMessage = (message: any, options) => {
			sendMessage(message, options);
			if (message.customType !== "pi-reflect-watchdog:continuation") return;
			assert.equal(
				pi.entries.length,
				0,
				"the context hook cannot depend on a later result entry",
			);
			const projected = pi.handlers.get("context")?.(
				{
					messages: [
						{ role: "custom", ...lastInquiry(pi), timestamp: 1 },
						captured.message,
						{ role: "custom", ...lastInquiryFold(pi), timestamp: 2 },
						{ role: "custom", ...message, timestamp: 3 },
					],
				},
				ctx,
			);
			const normalized = convertToLlm(projected.messages);
			assert.equal(
				normalized[0]?.role,
				origin === "automatic" ? "assistant" : "user",
			);
			assert.equal(
				providerMessageTextForRuntime(normalized[0]),
				message.details.report,
			);
			assert.equal(
				providerMessageTextForRuntime(normalized[1]),
				"[assistant]\ncontinue",
			);
			assert.equal(
				pi.handlers.get("message_end")?.(assistant("ordinary reply"), ctx),
				undefined,
				"the just-finished inquiry cannot capture an ordinary assistant",
			);
			reentered = true;
		};
		ctx.setIdle(true);
		await pi.emit("agent_settled", {}, ctx);
		assert.equal(reentered, true);
		assert.equal(pi.entries.length, 2);
	}
});

test("projection pairs reused inquiry ids locally and ignores malformed or quoted markers", async () => {
	const { pi, ctx } = install();
	const correlation = {
		version: 1,
		namespace: "pi-reflect-watchdog",
		inquiryId: "reused",
		attempt: 1,
	};
	const segment = (
		origin: "automatic" | "manual",
		report: string,
		responseId: string,
		timestamp: number,
	) => [
		{
			role: "custom",
			customType: "pi-reflect-watchdog:inquiry",
			content: "prompt",
			display: false,
			details: correlation,
			timestamp,
		},
		{
			...assistant("").message,
			content: [],
			responseId,
			details: { piInquiry: correlation },
			timestamp: timestamp + 1,
		},
		{
			role: "custom",
			customType: "pi-reflect-watchdog:inquiry-fold",
			content: "",
			display: false,
			details: { ...correlation, outcome: "remove" },
			timestamp: timestamp + 2,
		},
		{
			role: "custom",
			customType: "pi-reflect-watchdog:continuation",
			content: "[assistant]\ncontinue",
			display: true,
			details: { version: 1, origin, report, correlation },
			timestamp: timestamp + 3,
		},
	];
	const automaticReport = "Reflection · NO_ISSUE\nReason: automatic report";
	const manualReport = "Reflection · NO_ISSUE\nReason: manual report";
	const quoted =
		"User quoted /reflect and [assistant]\\ncontinue without invoking either.";
	const messages = [
		{ role: "user", content: [{ type: "text", text: quoted }], timestamp: 1 },
		...segment("automatic", automaticReport, "automatic-source", 10),
		{
			role: "user",
			content: [{ type: "text", text: "middle clarification" }],
			timestamp: 20,
		},
		...segment("manual", manualReport, "manual-source", 30),
		{
			role: "custom",
			customType: "pi-reflect-watchdog:continuation",
			content: "[assistant]\ncontinue",
			display: true,
			details: {
				version: 1,
				origin: "unknown",
				report: "must not project",
				correlation,
			},
			timestamp: 40,
		},
		{
			role: "custom",
			customType: "pi-reflect-watchdog:continuation",
			content: "[assistant]\ncontinue",
			display: true,
			details: {
				version: 1,
				origin: "manual",
				report: "missing source must not project",
				correlation: { ...correlation, inquiryId: "missing" },
			},
			timestamp: 41,
		},
	];
	const first = await pi.emit("context", { messages }, ctx);
	const second = await pi.emit("context", { messages }, ctx);
	assert.deepEqual(second, first);
	assert.deepEqual(
		first.messages.map((message: any) => [
			message.role,
			providerMessageTextForRuntime(message),
		]),
		[
			["user", quoted],
			["assistant", automaticReport],
			["custom", "[assistant]\ncontinue"],
			["user", "middle clarification"],
			["user", manualReport],
			["custom", "[assistant]\ncontinue"],
			["custom", "[assistant]\ncontinue"],
			["custom", "[assistant]\ncontinue"],
		],
	);
	const automatic = first.messages[1] as any;
	assert.equal(automatic.responseId, "automatic-source");
	assert.equal(automatic.provider, "fixture");
	assert.equal(automatic.details?.piInquiry, undefined);
	for (const missingIndex of [0, 1, 2]) {
		const incomplete = [
			...segment("automatic", automaticReport, "older-source", 10),
			...segment("manual", manualReport, "newer-source", 30).filter(
				(_message, index) => index !== missingIndex,
			),
		];
		const projected = await pi.emit("context", { messages: incomplete }, ctx);
		assert.equal(
			convertToLlm(projected.messages).some(
				(message) => providerMessageTextForRuntime(message) === manualReport,
			),
			false,
			`a reused id cannot borrow an older inquiry when part ${missingIndex} is missing`,
		);
	}
	assert.deepEqual(Object.keys(first.messages[4] as any).sort(), [
		"content",
		"role",
		"timestamp",
	]);
	assert.equal(
		JSON.stringify(first.messages).includes("must not project"),
		true,
	);
	assert.equal(
		first.messages.filter(
			(message: any) =>
				message.role !== "custom" &&
				providerMessageTextForRuntime(message).includes("must not project"),
		).length,
		0,
	);
});

test("serialized mixed-trigger handoffs restore once without replay or rewriting legacy data", async () => {
	const automatic = await reflectionHandoff("automatic");
	const manual = await reflectionHandoff("manual");
	const session = SessionManager.inMemory("/work/restored");
	session.appendCustomEntry("pi-reflect-watchdog:reflection", {
		...automatic.result,
		report: "legacy version-1 report",
	});
	session.appendCustomMessageEntry(
		"pi-reflect-watchdog:route-correction",
		"legacy correction content",
		true,
	);
	session.appendMessage({
		role: "user",
		content: "Keep the clarification, including quoted /reflect.",
		timestamp: 0,
	});
	appendHandoff(session, automatic);
	session.appendCustomMessageEntry(
		"unrelated-extension:note",
		"foreign context",
		true,
		{ origin: "manual" },
	);
	appendHandoff(session, manual);
	const entries = JSON.parse(JSON.stringify(session.getEntries()));
	const before = JSON.stringify(entries);
	const messages = buildSessionContext(entries).messages;
	const restored = install();
	restored.ctx.setBranch(entries);
	await restored.pi.emit("session_start", {}, restored.ctx);
	for (let request = 0; request < 2; request += 1) {
		const projected = await restored.pi.emit(
			"context",
			{ messages },
			restored.ctx,
		);
		const normalized = convertToLlm(projected.messages);
		for (const [report, role] of [
			[automatic.result.report, "assistant"],
			[manual.result.report, "user"],
		]) {
			const found = normalized.filter(
				(message) => providerMessageTextForRuntime(message) === report,
			);
			assert.equal(found.length, 1);
			assert.equal(found[0]?.role, role);
		}
		assert.deepEqual(
			projected.messages.filter(
				(message: any) => message.customType === "unrelated-extension:note",
			),
			messages.filter(
				(message: any) => message.customType === "unrelated-extension:note",
			),
		);
		assert.equal(
			normalized.filter(
				(message) =>
					providerMessageTextForRuntime(message) ===
					"legacy correction content",
			).length,
			1,
		);
		assert.equal(
			normalized.filter(
				(message) =>
					providerMessageTextForRuntime(message) ===
					"Keep the clarification, including quoted /reflect.",
			).length,
			1,
		);
	}
	assert.deepEqual(
		restored.pi.messages,
		[],
		"reading restored context must not schedule a native wake",
	);
	assert.deepEqual(
		restored.pi.entries,
		[],
		"projection appends no result or completion",
	);
	assert.equal(JSON.stringify(entries), before);
	// Existing version-1 storage remains usable independently of new markers.
	restored.ctx.setBranch([entries[0]]);
	await restored.pi.commands[0]?.handler("", restored.ctx);
	assert.match(lastInquiry(restored.pi).content, /legacy version-1 report/);
});

test("incomplete persisted handoffs omit reports rather than guessing an origin or source", async () => {
	for (const origin of ["automatic", "manual"] as const) {
		const { pi, ctx, messages, result } = await reflectionHandoff(origin);
		const marker = messages[3];
		const details = marker.details;
		const malformed = [
			{ details: undefined },
			{ details: { ...details, version: 2 } },
			{ details: { ...details, origin: undefined } },
			{ details: { ...details, origin: "guessed" } },
			{ details: { ...details, correlation: undefined } },
			...[
				{ version: 2 },
				{ namespace: "other" },
				{ inquiryId: "missing" },
				{ inquiryId: "bad id" },
				{ attempt: 0 },
				{ attempt: 2 },
			].map((patch) => ({
				details: {
					...details,
					correlation: { ...details.correlation, ...patch },
				},
			})),
			{ customType: "other:continuation" },
			{ content: "[assistant]\ncontinue\n" },
		];
		const contexts = malformed.map((patch) => [
			...messages.slice(0, 3),
			{ ...marker, ...patch },
		]);
		contexts.push(messages.filter((message) => message.role !== "assistant"));
		for (const input of contexts) {
			const retained = JSON.parse(JSON.stringify(input));
			const projected = await pi.emit("context", { messages: retained }, ctx);
			assert.equal(
				convertToLlm(projected.messages).some(
					(message) => providerMessageTextForRuntime(message) === result.report,
				),
				false,
			);
			assert.deepEqual(
				projected.messages.at(-1),
				retained.at(-1),
				"no report is copied into the wake",
			);
		}
		assert.equal(
			continuationMessages(pi).length,
			1,
			"restoration tests did not replay the original wake",
		);
	}
});

test("built-in compaction and branch summaries see only the wake for either trigger", async () => {
	const model = openaiProvider()
		.getModels()
		.find((model) => model.id === "gpt-4.1");
	assert.ok(model);
	for (const origin of ["automatic", "manual"] as const) {
		const handoff = await reflectionHandoff(origin);
		const session = SessionManager.inMemory("/work/compaction");
		appendHandoff(session, handoff);
		const messages = session.buildSessionContext().messages;
		const captured: string[] = [];
		const streamFn = (_model: any, request: any) => {
			captured.push(providerMessageTextForRuntime(request.messages[0]));
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: assistant("summary fixture").message as any,
			});
			stream.end();
			return stream;
		};
		const signal = new AbortController().signal;
		await generateSummaryWithUsage(
			messages,
			model,
			1024,
			"offline-fixture",
			undefined,
			signal,
			undefined,
			undefined,
			undefined,
			streamFn,
		);
		await generateBranchSummary(session.getEntries(), {
			model,
			apiKey: "offline-fixture",
			signal,
			streamFn,
			reserveTokens: 1024,
		});
		assert.equal(
			captured.length,
			2,
			"both native summary paths reached the injected offline stream",
		);
		for (const prompt of captured) {
			assert.equal(prompt.split("[assistant]\ncontinue").length - 1, 1);
			assert.equal(prompt.includes(handoff.result.report), false);
			assert.equal(prompt.includes("Reflection · NO_ISSUE"), false);
			assert.equal(prompt.includes(validNoIssue), false);
			assert.equal(prompt.includes('"origin"'), false);
		}
		const marker = session
			.getEntries()
			.find(
				(entry: any) => entry.customType === "pi-reflect-watchdog:continuation",
			);
		assert.ok(marker);
		session.appendCompaction("summary fixture", marker.id, 100);
		handoff.ctx.setBranch(session.getBranch());
		const retained = session.buildSessionContext().messages;
		const projected = await handoff.pi.emit(
			"context",
			{ messages: retained },
			handoff.ctx,
		);
		assert.equal(
			convertToLlm(projected.messages).some(
				(message) =>
					providerMessageTextForRuntime(message) === handoff.result.report,
			),
			false,
			"a report still in private storage is not reconstructed after its source was compacted",
		);
		assert.equal(continuationMessages(handoff.pi).length, 1);
	}
});

for (const [label, provider, modelId, api, adapter] of [
	[
		"OpenAI Chat",
		openaiProvider,
		"gpt-4.1",
		"openai-completions",
		streamCompletions,
	],
	[
		"OpenAI Responses",
		openaiProvider,
		"gpt-4.1",
		"openai-responses",
		streamResponses,
	],
	[
		"Anthropic",
		anthropicProvider,
		"claude-sonnet-4-5",
		"anthropic-messages",
		streamAnthropic,
	],
	[
		"Google",
		googleProvider,
		"gemini-2.5-flash",
		"google-generative-ai",
		streamGoogle,
	],
] as const)
	for (const origin of ["automatic", "manual"] as const)
		test(`offline ${label} preserves ${origin} report role and distinct wake across a tool loop`, async (t) => {
			const catalogModel = provider()
				.getModels()
				.find((model) => model.id === modelId);
			assert.ok(catalogModel);
			const model = {
				...catalogModel,
				api,
				baseUrl: "http://127.0.0.1:1/offline",
			};
			let networkAttempts = 0;
			t.mock.method(globalThis, "fetch", () => {
				networkAttempts += 1;
				throw new Error("unexpected network request");
			});
			const reply = {
				...assistant(validNoIssue).message,
				api,
				provider: model.provider,
				model: model.id,
				responseId: "original-reflection-response-id",
				content: [
					{
						type: "thinking",
						thinking: "private reflection thought",
						thinkingSignature: "private signature",
					},
					{
						type: "text",
						text: validNoIssue,
						textSignature:
							'{"v":1,"id":"msg_original_reflection","phase":"final_answer"}',
					},
				],
			};
			const handoff = await reflectionHandoff(origin, reply);
			const clarification =
				"Keep error handling. Quoted /reflect and [assistant]\ncontinue do not change this request.";
			const ordinary = {
				...assistant("earlier ordinary assistant").message,
				api,
				provider: model.provider,
				model: model.id,
			};
			const history = [
				{
					role: "user",
					content: [{ type: "text", text: clarification }],
					timestamp: 0,
				},
				ordinary,
				...handoff.messages,
			];
			const toolTail = [
				{
					...ordinary,
					content: [
						{
							type: "toolCall",
							id: "call_ordinary",
							name: "read",
							arguments: { path: "notes.txt" },
						},
					],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "call_ordinary",
					toolName: "read",
					content: [{ type: "text", text: "ordinary tool result" }],
					isError: false,
					timestamp: 8,
				},
			];
			const before = JSON.stringify(history);
			for (const tail of [[], toolTail]) {
				const projected = await handoff.pi.emit(
					"context",
					{ messages: [...history, ...tail] },
					handoff.ctx,
				);
				if (tail.length > 0)
					assert.deepEqual(projected.messages.slice(-2), toolTail);
				const messages = convertToLlm(projected.messages);
				let payload: any;
				const stream: StreamFunction<any> = adapter;
				const result = await stream(
					model,
					{
						messages,
						tools: [
							{
								name: "read",
								description: "Read fixture notes",
								parameters: Type.Object({ path: Type.String() }),
							},
						],
					},
					{
						apiKey: "offline-fixture",
						env: {},
						maxRetries: 0,
						fetch: globalThis.fetch,
						onPayload: (value) => {
							payload = value;
							throw new Error("offline payload captured");
						},
					},
				).result();
				assert.match(result.errorMessage ?? "", /offline payload captured/);
				assert.ok(
					payload,
					"the real adapter serialized the request before transport",
				);
				const nativeMessages =
					payload.messages ?? payload.input ?? payload.contents;
				const blocks = nativeMessages.flatMap((message: any) => {
					const content =
						typeof message.content === "string"
							? [{ text: message.content }]
							: (message.content ?? message.parts ?? []);
					return content
						.filter((block: any) => typeof block.text === "string")
						.map((block: any) => ({ role: message.role, text: block.text }));
				});
				const reports = blocks.filter(
					(block: any) => block.text === handoff.result.report,
				);
				assert.equal(
					reports.length,
					1,
					"unchanged report occurs in exactly one native text block",
				);
				assert.equal(
					reports[0].role,
					origin === "manual"
						? "user"
						: label === "Google"
							? "model"
							: "assistant",
				);
				const wakes = blocks.filter(
					(block: any) => block.text === "[assistant]\ncontinue",
				);
				assert.equal(wakes.length, 1);
				assert.equal(wakes[0].role, "user");
				assert.equal(
					blocks.indexOf(wakes[0]),
					blocks.indexOf(reports[0]) + 1,
					"same-role merging must retain distinct report and wake blocks",
				);
				assert.equal(
					blocks.filter(
						(block: any) =>
							block.text === clarification && block.role === "user",
					).length,
					1,
				);
				assert.equal(
					blocks.filter(
						(block: any) => block.text === "earlier ordinary assistant",
					).length,
					1,
				);
				const wire = JSON.stringify(payload);
				assert.doesNotMatch(
					wire,
					/private reflection thought|private signature|msg_original_reflection|original-reflection-response-id/,
				);
				assert.equal(wire.includes(validNoIssue), false);
				if (tail.length > 0) assert.ok(wire.includes("ordinary tool result"));
			}
			assert.equal(
				JSON.stringify(history),
				before,
				"serialization does not rewrite retained source messages",
			);
			assert.equal(networkAttempts, 0);
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

test("manual reflection remains available without a complete history locator", async () => {
	for (const { sessionFile, withLeaf } of [
		{ sessionFile: undefined, withLeaf: true },
		{ sessionFile: "/missing/session.jsonl", withLeaf: false },
		{ sessionFile: undefined, withLeaf: false },
	]) {
		const ctx = context("root", { sessionFile });
		if (withLeaf) ctx.setBranch([ordinaryLoop("current-leaf")]);
		const { pi } = install({ ctx });
		await pi.emit("session_start", {}, ctx);
		await pi.commands[0]?.handler("", ctx);
		assert.match(
			lastInquiry(pi)?.content ?? "",
			/Branch-scoped history recovery unavailable/,
		);
		assert.equal(pi.messages.length, 1);
	}
});

test("queued second reflection dispatches after completed evidence is visible", async () => {
	const ctx = context("root", { sessionFile: "/missing/queued-session.jsonl" });
	const { pi } = install({ ctx });
	const hooks = captureReflectionHooks(pi);
	const branch: any[] = [
		branchMessage(
			{ role: "user", content: "Original request" },
			"original-leaf",
		),
	];
	ctx.setBranch(branch);
	const originalAppendEntry = pi.appendEntry.bind(pi);
	pi.appendEntry = (customType: string, data: unknown) => {
		originalAppendEntry(customType, data);
		branch.push({
			type: "custom",
			id: `saved-${branch.length}`,
			customType,
			data,
		});
		ctx.setBranch(branch);
	};
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("first supplement", ctx);
	await startReflectionRun(pi, ctx);
	await pi.commands[0]?.handler("second supplement", ctx);
	const queuedAtLeaf = ctx.sessionManager.getLeafId();
	await completeReflectionAttempt(pi, ctx, validNoIssue);

	const inquiries = pi.messages.filter(({ message }) =>
		String(message.customType ?? "").endsWith(":inquiry"),
	);
	assert.equal(inquiries.length, 2);
	assert.match(inquiries[1]?.message.content ?? "", /Reason: sound/);
	assert.match(inquiries[1]?.message.content ?? "", /second supplement/);
	assert.notEqual(ctx.sessionManager.getLeafId(), queuedAtLeaf);
	assert.ok(
		inquiries[1]?.message.content.includes(
			JSON.stringify({
				sessionFile: ctx.sessionManager.getSessionFile(),
				branchLeafId: ctx.sessionManager.getLeafId(),
			}),
		),
		"history locator comes from dispatch, not the queued request",
	);
	assert.doesNotMatch(
		JSON.stringify(pi.entries),
		/historyLocator|sessionFile|branchLeafId/,
	);
	assert.equal(hooks.length, 1);
	assert.deepEqual(pi.actions.slice(-6), [
		"fold",
		"continuation",
		"entry:pi-reflect-watchdog:reflection",
		"entry:pi-reflect-watchdog:reflection-completed",
		"hook:reflection-completed",
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

test("reflection tool budget and history hint stay shared across XML attempts", async () => {
	const ctx = context("root", { sessionFile: "/missing/retry-session.jsonl" });
	ctx.setBranch([ordinaryLoop("initial-anchor")]);
	const { pi } = install({ ctx });
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	const initialPrompt = lastInquiry(pi)?.content ?? "";
	assert.match(initialPrompt, /initial-anchor/);
	for (let index = 0; index < 5; index += 1)
		assert.equal(await pi.emit("tool_call", {}, ctx), undefined);
	ctx.setBranch([ordinaryLoop("later-anchor")]);
	await completeReflectionAttempt(pi, ctx, "invalid XML");
	await startReflectionRun(pi, ctx);
	assert.doesNotMatch(
		lastInquiry(pi)?.content ?? "",
		/history locator|later-anchor/i,
	);
	for (let index = 0; index < 5; index += 1)
		assert.equal(await pi.emit("tool_call", {}, ctx), undefined);
	assert.deepEqual(await pi.emit("tool_call", {}, ctx), {
		block: true,
		reason: "Reflection tool-call budget exhausted.",
	});
});
