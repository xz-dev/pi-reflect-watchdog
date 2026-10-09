/* biome-ignore-all lint/suspicious/noExplicitAny: focused dynamic Pi lifecycle fake */
import assert from "node:assert/strict";
import test from "node:test";

import {
	createAssistantMessageEventStream,
	normalizeContext,
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
import { deriveBranchAccounting } from "../src/branch-accounting.js";
import type { WatchdogConfig } from "../src/config.js";
import {
	createWatchdogExtension,
	reflectCooldownLoops,
	reflectCooldownState,
} from "../src/extension.js";
import {
	createObservableAgentHub,
	type ObservableAgentHub,
} from "../src/hub.js";
import {
	createReflectDomainCoordinator,
	type ReflectBranchDomainCoordinator,
	type ReflectBranchSource,
	type ReflectDomainCounters,
	type ReflectFreshCompletion,
} from "../src/process-domain.js";

import { DEFAULT_REFLECTION_PROMPT } from "../src/prompts.js";

class Pi {
	currentCtx: any;
	entrySequence = 0;
	capturedMessage: any;
	confirmed = false;
	readonly tools = new Map<string, any>();
	readonly handlers = new Map<string, (event: any, ctx: any) => any>();
	readonly bus = new Map<string, Set<(data: unknown) => void>>();
	readonly commands: Array<{
		name: string;
		handler: (args: string, ctx: any) => any;
	}> = [];
	readonly messages: Array<{ message: any; options: any }> = [];
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly actions: string[] = [];
	readonly shortcuts: Array<{
		key: string;
		description?: string;
		handler: (ctx: any) => any;
	}> = [];

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

	registerShortcut(key: string, options: any) {
		this.shortcuts.push({ key, ...options });
	}

	registerTool(tool: any) {
		this.tools.set(tool.name, tool);
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
		if (this.currentCtx)
			this.currentCtx.setBranch([
				...this.currentCtx.sessionManager.getBranch(),
				{
					type: "custom",
					id: `fixture-custom-${++this.entrySequence}`,
					customType,
					data,
				},
			]);
		this.actions.push(`entry:${customType}`);
	}

	async emit(name: string, event: any, ctx: any) {
		this.currentCtx = ctx;
		if (
			name === "message_start" &&
			String(event.message.customType).endsWith(":inquiry")
		)
			this.confirmed = true;
		if (name === "agent_settled") this.confirmed = false;
		if (name === "turn_end" && event.messageEntryId === undefined) {
			if (this.confirmed && this.capturedMessage)
				event.message = this.capturedMessage;
			event.messageEntryId = `fixture-turn-${++this.entrySequence}`;
			event.toolResultEntryIds = [];
			ctx.setBranch([
				...ctx.sessionManager.getBranch(),
				branchMessage(event.message, event.messageEntryId),
			]);
		}
		const result = await this.handlers.get(name)?.(event, ctx);
		if (name === "message_end") {
			this.capturedMessage = result?.message ?? event.message;
			for (const block of (result?.message ?? event.message).content ?? []) {
				if (block.type !== "toolCall" || !this.tools.has(block.name)) continue;
				const blocked = await this.emit(
					"tool_call",
					{
						toolName: block.name,
						toolCallId: block.id,
						input: block.arguments,
					},
					ctx,
				);
				if (!blocked?.block)
					await this.tools
						.get(block.name)
						.execute(block.id, block.arguments, undefined, undefined, ctx);
			}
		}
		return result;
	}
}

function counter(value = 0n) {
	return { value };
}

class FakeDomain implements ReflectBranchDomainCoordinator {
	readonly rootProcess = true;
	readonly activityWrites: boolean[] = [];
	rootWrites = 0;
	allWrites = 0;
	resetWrites = 0;
	private revision = 1n;
	private readonly attachments = new Map<object, boolean>();
	private readonly sources = new Map<object, ReflectBranchSource>();
	private readonly seen = new Set<string>();
	private readonly completionListeners = new Set<
		(event: ReflectFreshCompletion) => void
	>();
	private readonly baselines = new Map<
		object,
		{
			fullAfterEntryId: string | null;
			reminderAfterEntryId: string | null;
			full: bigint;
			reminder: bigint;
		}
	>();
	private readonly listeners = new Set<
		(counters: ReflectDomainCounters) => void
	>();
	private value: ReflectDomainCounters = this.snapshot();

	async attach(
		instance: object,
		options: {
			getBusy: () => boolean;
			source: ReflectBranchSource;
			onFatal: (error: Error) => void;
		},
	) {
		this.sources.set(instance, options.source);
		this.baselines.set(instance, {
			fullAfterEntryId: options.source.getLeafId(),
			reminderAfterEntryId: options.source.getLeafId(),
			full: 0n,
			reminder: 0n,
		});
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

	async refreshBranch(instance: object) {
		const source = this.sources.get(instance);
		const base = this.baselines.get(instance);
		if (!source || !base) return this.value;
		const view = deriveBranchAccounting(source.getBranch(), {
			boundaryPolicy: source.isMain() ? "recorded" : "baselines",
			cooldownLoops: 0,
			...base,
		});
		const full = view.activeLoops - base.full;
		const reminder = view.reminderLoops - base.reminder;
		base.full = view.activeLoops;
		base.reminder = view.reminderLoops;
		if (full === 0n && reminder === 0n) return this.value;
		if (source.isMain()) this.rootWrites += Number(full);
		else this.allWrites += Number(full);
		this.value = this.next({
			activeLoops: this.value.activeLoops.value + full,
			rootLoops: this.value.rootLoops.value + (source.isMain() ? reminder : 0n),
			allLoops: this.value.allLoops.value + reminder,
		});
		this.publish();
		return this.value;
	}
	async rebaseBranch(
		instance: object,
		options: {
			adoptHistory?: boolean;
			fullAfterEntryId?: string | null;
			reminderAfterEntryId?: string | null;
		} = {},
	) {
		const source = this.sources.get(instance);
		if (source)
			this.baselines.set(instance, {
				fullAfterEntryId: options.adoptHistory
					? (options.fullAfterEntryId ?? null)
					: source.getLeafId(),
				reminderAfterEntryId: options.adoptHistory
					? (options.reminderAfterEntryId ?? null)
					: source.getLeafId(),
				full: 0n,
				reminder: 0n,
			});
		return this.refreshBranch(instance);
	}
	async completeTurn(instance: object, messageEntryId: string) {
		await this.refreshBranch(instance);
		const source = this.sources.get(instance);
		const base = this.baselines.get(instance);
		if (!source || !base || this.seen.has(messageEntryId)) return this.value;
		const view = deriveBranchAccounting(source.getBranch(), {
			boundaryPolicy: source.isMain() ? "recorded" : "baselines",
			cooldownLoops: 0,
			...base,
		});
		if (!view.reminder.entryIds.includes(messageEntryId)) return this.value;
		this.seen.add(messageEntryId);
		for (const listener of this.completionListeners)
			listener({
				attachmentInstance: instance,
				contributorId: "fixture",
				attachmentId: "fixture",
				scope: "0",
				messageEntryId,
				snapshotSeq: this.revision,
				accountingGeneration: this.revision,
				counters: this.value,
			});
		return this.value;
	}
	subscribeCompletions(listener: (event: ReflectFreshCompletion) => void) {
		this.completionListeners.add(listener);
		return () => this.completionListeners.delete(listener);
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
		for (const [instance, base] of this.baselines) {
			base.reminderAfterEntryId =
				this.sources.get(instance)?.getLeafId() ?? null;
			base.reminder = 0n;
		}
		this.value = this.next({ taskMs: 0n, rootLoops: 0n, allLoops: 0n });
		this.publish();
		return this.value;
	}

	async resetCycleOnUserTakeover() {
		for (const [instance, base] of this.baselines) {
			base.fullAfterEntryId = base.reminderAfterEntryId =
				this.sources.get(instance)?.getLeafId() ?? null;
			base.full = base.reminder = 0n;
		}
		this.value = this.next({
			activeMs: 0n,
			activeLoops: 0n,
			taskMs: 0n,
			rootLoops: 0n,
			allLoops: 0n,
		});
		this.publish();
		return this.value;
	}

	remoteCompletion() {
		this.setCounters({ allLoops: this.value.allLoops.value + 1n });
		for (const listener of this.completionListeners)
			listener({
				contributorId: "remote",
				attachmentId: "remote",
				scope: "0",
				messageEntryId: `remote-${this.revision}`,
				snapshotSeq: this.revision,
				accountingGeneration: this.revision,
				counters: this.value,
			});
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
	taskMinutes: 20,
	idleResetGapSeconds: 60,
	reflectionPrompt: DEFAULT_REFLECTION_PROMPT,
	cancelShortcut: "alt+x",
};

function install(
	options: {
		hub?: ObservableAgentHub;
		domain?: ReflectBranchDomainCoordinator;
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
	return { pi, ctx, domain: domain as FakeDomain };
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

function reflectionArguments({
	type = "NO_ISSUE",
	reason = "sound",
	nextStep = "continue",
}: {
	type?: "NO_ISSUE" | "ROUTE_CORRECTION";
	reason?: string;
	nextStep?: string;
} = {}) {
	return {
		type,
		reason,
		done: "checked",
		current_step: "verify",
		next_step: nextStep,
	};
}

async function flushAsync() {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function turnEnd(stopReason: string, extra: Record<string, unknown> = {}) {
	return {
		message: {
			role: "assistant",
			stopReason,
			content: [{ type: "text", text: "agent output" }],
			...extra,
		},
	};
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

function runtimeQueuedState(pi: Pi, ctx: ReturnType<typeof context>) {
	void pi;
	return ctx.statuses.filter(Boolean).at(-1)?.includes("queued") ?? false;
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

function assistant(text: string | ReturnType<typeof reflectionArguments>) {
	return {
		message: {
			role: "assistant",
			content:
				typeof text === "string"
					? [{ type: "text", text }]
					: [
							{
								type: "toolCall",
								id: "reflect-result",
								name: "ref",
								arguments: text,
							},
						],
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
			stopReason: typeof text === "string" ? "stop" : "toolUse",
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

const validNoIssue = reflectionArguments();
const validCorrection = reflectionArguments({
	type: "ROUTE_CORRECTION",
	reason: "change route",
	nextStep: "continue differently",
});

async function completeReflectionAttempt(
	pi: Pi,
	ctx: ReturnType<typeof context>,
	text: string | ReturnType<typeof reflectionArguments>,
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

const EXPLANATORY_SCHEMA_KEYWORDS = [
	"description",
	"title",
	"examples",
	"default",
] as const;

test("result tool declares structural constraints without explanatory annotations", () => {
	const { pi } = install();
	const tool = pi.tools.get("ref");
	assert.ok(tool, "result tool must be registered");
	assert.equal(tool.description, "don't use unless ask");
	const parameters = JSON.parse(JSON.stringify(tool.parameters));
	assert.equal(parameters.type, "object");
	assert.equal(parameters.additionalProperties, false);
	const fields = ["type", "reason", "done", "current_step", "next_step"];
	assert.deepEqual([...parameters.required].sort(), [...fields].sort());
	assert.deepEqual(
		Object.keys(parameters.properties).sort(),
		[...fields].sort(),
	);
	assert.deepEqual(parameters.properties.type, {
		type: "string",
		enum: ["NO_ISSUE", "ROUTE_CORRECTION"],
	});
	for (const field of fields.slice(1))
		assert.deepEqual(parameters.properties[field], {
			type: "string",
			minLength: 1,
			pattern: "\\S",
		});
	const serialized = JSON.stringify(parameters);
	for (const keyword of EXPLANATORY_SCHEMA_KEYWORDS)
		assert.doesNotMatch(serialized, new RegExp(`"${keyword}":`));
	assert.equal(tool.promptSnippet, undefined);
	assert.equal(tool.promptGuidelines, undefined);
	assert.equal(typeof tool.prepareArguments, "function");
	assert.deepEqual(
		tool.prepareArguments({
			TYPE: " no_issue ",
			Reason: " sound ",
			done: "checked",
			current_step: "verify",
			NEXT_STEP: "continue",
		}),
		{
			type: "NO_ISSUE",
			reason: "sound",
			done: "checked",
			current_step: "verify",
			next_step: "continue",
		},
	);
});

test("schema-invalid owned result is captured before dispatch and corrected within the attempt bound", async () => {
	const { pi, ctx } = install();
	const tool = pi.tools.get("ref");
	const executed: unknown[] = [];
	const execute = tool.execute;
	tool.execute = (...args: unknown[]) => {
		executed.push(args[1]);
		return execute(...args);
	};
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	const notificationsBefore = ctx.notifications.length;
	await startReflectionRun(pi, ctx);
	const { next_step: _omitted, ...missingNextStep } = validNoIssue;
	const captured = await pi.emit(
		"message_end",
		{
			message: {
				...assistant(validNoIssue).message,
				content: [
					{ type: "thinking", thinking: "private" },
					{
						type: "toolCall",
						id: "lookup",
						name: "read",
						arguments: { path: "README.md" },
					},
					{
						type: "toolCall",
						id: "reflect-result",
						name: "ref",
						arguments: missingNextStep,
					},
				],
			},
		},
		ctx,
	);
	assert.deepEqual(captured.message.content, []);
	assert.equal(captured.message.stopReason, "stop");
	assert.deepEqual(
		executed,
		[],
		"no call from the invalid response is dispatched",
	);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(ctx.notifications.slice(notificationsBefore), [
		"Reflection attempt 1/3 invalid: reflection result must contain exactly the five required fields; retrying.",
	]);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		2,
	);
	assert.equal(pi.entries.length, 0);
	assert.equal(continuationMessages(pi).length, 0);
	assert.doesNotMatch(lastInquiry(pi).content, /checked|verify/);

	await startReflectionRun(pi, ctx);
	const corrected = await completeReflectionAttempt(pi, ctx, {
		...validNoIssue,
		type: "bogus" as "NO_ISSUE",
	});
	assert.deepEqual(corrected.message.content, []);
	await startReflectionRun(pi, ctx);
	await completeReflectionAttempt(pi, ctx, validNoIssue);
	assert.deepEqual(executed, [validNoIssue]);
	assert.equal(continuationMessages(pi).length, 1);
	assert.equal(
		pi.entries.filter(
			(entry) =>
				entry.customType === "pi-reflect-watchdog:reflection-completed",
		).length,
		1,
	);
});

test("three schema-invalid owned results end through failure cleanup", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	const notificationsBefore = ctx.notifications.length;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await startReflectionRun(pi, ctx);
		const captured = await completeReflectionAttempt(pi, ctx, {
			...validNoIssue,
			reason: 42 as unknown as string,
		});
		assert.deepEqual(captured.message.content, []);
	}
	assert.deepEqual(ctx.notifications.slice(notificationsBefore), [
		"Reflection attempt 1/3 invalid: reflection field reason must be a non-empty string; retrying.",
		"Reflection attempt 2/3 invalid: reflection field reason must be a non-empty string; retrying.",
		"Reflection failed: reflection field reason must be a non-empty string",
	]);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		3,
	);
	assert.equal(pi.entries.length, 0);
	assert.equal(continuationMessages(pi).length, 0);
});

test("reserved result tool reveals no usage and rejects calls outside confirmed reflection", async () => {
	const { pi, ctx } = install();
	const tool = pi.tools.get("ref");
	assert.ok(tool, "result tool must be registered");
	assert.equal(tool.description, "don't use unless ask");
	assert.equal(tool.promptSnippet, undefined);
	assert.equal(tool.promptGuidelines, undefined);
	const declaration = JSON.stringify(tool.parameters);
	const reject = () =>
		assert.rejects(
			() => tool.execute("reserved", {}, undefined, undefined, ctx),
			{
				message:
					"This function is reserved for the plugin. Please try another function.",
			},
		);
	await reject();
	await pi.emit("session_start", {}, ctx);
	await reject();
	await pi.commands[0]?.handler("", ctx);
	await reject();
	assert.equal(pi.entries.length, 0);
	await startReflectionRun(pi, ctx);
	assert.match(lastInquiry(pi).content, /ref/);
	assert.match(lastInquiry(pi).content, /current_step/);
	const result = await tool.execute(
		"result",
		{
			type: "NO_ISSUE",
			reason: "sound",
			done: "checked",
			current_step: "verify",
			next_step: "continue",
		},
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.terminate, true);
	assert.equal(result.isError, undefined);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(continuationMessages(pi).length, 1);
	assert.equal(JSON.stringify(tool.parameters), declaration);
	assert.equal(pi.tools.size, 1);
	await reject();
	await pi.emit("session_shutdown", {}, ctx);
	await reject();
});

test("Reflect cooldown follows completed inquiry blocks and the inclusive ten-loop boundary", () => {
	const cooldownLoops = 10;
	const completed = completedReflect();
	assert.deepEqual(reflectCooldownState(completed as any, cooldownLoops), {
		skipAutomatic: true,
		remainingLoops: 10,
	});
	const nineLoops = [
		...completed,
		...Array.from({ length: 9 }, (_, index) =>
			ordinaryLoop(`ordinary-${index}`),
		),
	];
	assert.deepEqual(reflectCooldownState(nineLoops as any, cooldownLoops), {
		skipAutomatic: true,
		remainingLoops: 1,
	});
	assert.deepEqual(
		reflectCooldownState(
			[
				...nineLoops,
				branchMessage(
					{ role: "assistant", stopReason: "stop", content: [] },
					"empty",
				),
				branchMessage(
					{
						role: "assistant",
						stopReason: "stop",
						errorMessage: "pi-continue-watchdog:preempted",
						content: [{ type: "text", text: "x" }],
					},
					"rewritten",
				),
				ordinaryLoop("gateway", "error"),
			] as any,
			cooldownLoops,
		),
		{ skipAutomatic: true, remainingLoops: 1 },
		"non-agent replies never advance the cooldown",
	);
	assert.deepEqual(
		reflectCooldownState(
			[...nineLoops, ordinaryLoop("ordinary-10")] as any,
			cooldownLoops,
		),
		{ skipAutomatic: true, remainingLoops: 0 },
	);
	assert.deepEqual(
		reflectCooldownState(
			[
				...nineLoops,
				ordinaryLoop("ordinary-10"),
				ordinaryLoop("ordinary-11", "toolUse"),
			] as any,
			cooldownLoops,
		),
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
	assert.deepEqual(reflectCooldownState([invalidMarker] as any, 10), {
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
		reflectCooldownState(
			[
				...completed,
				ordinaryLoop("after-valid"),
				laterIncomplete,
				orphanCompletion,
			] as any,
			cooldownLoops,
		),
		{ skipAutomatic: true, remainingLoops: 9 },
	);
});

test("Reflect cooldown length clamps to [10, 30] at rootLoopLimit/3", () => {
	assert.equal(reflectCooldownLoops(60), 20);
	assert.equal(reflectCooldownLoops(30), 10);
	assert.equal(reflectCooldownLoops(90), 30);
	assert.equal(reflectCooldownLoops(120), 30);
	assert.equal(reflectCooldownLoops(2), 10);
	assert.equal(reflectCooldownLoops(0), 10);
	assert.equal(reflectCooldownLoops(3), 10);
	assert.equal(reflectCooldownLoops(33), 11);
	assert.equal(reflectCooldownLoops(Number.POSITIVE_INFINITY), 30);
});

test("automatic Reflect is consumed during cooldown while manual Reflect bypasses", async () => {
	const ctx = context("root", { mode: "tui" });
	const { pi, domain } = install({
		ctx,
		limits: { rootLoopLimit: 3, allLoopLimit: 100 },
	});
	ctx.setBranch([...completedReflect(), ordinaryLoop("ordinary-1")]);
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	domain.setCounters({ rootLoops: 3n });
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
	assert.match(
		lastInquiry(pi)?.content ?? "",
		/manual bypass/,
		"busy manual reflection submits immediately during cooldown",
	);
});

test("legacy pause hooks neither subscribe nor alter accounting or hold", async () => {
	const { pi, ctx, domain } = install({ limits: { rootLoopLimit: 1 } });
	await pi.emit("session_start", {}, ctx);
	assert.equal(pi.bus.get("pi:semantic-hook:v1")?.size ?? 0, 0);
	publishHook(pi, "work-paused");
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.rootWrites, 1);
	assert.ok(lastInquiry(pi));
});

test("minimal core exposes /reflect, /cancel-reflect and one reserved tool", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	assert.deepEqual(
		pi.commands.map((command) => command.name),
		["reflect", "cancel-reflect"],
	);
	assert.deepEqual([...pi.tools.keys()], ["ref"]);
});

test("ordinary user message resets the full cycle without touching reflection-owned messages", async () => {
	const { pi, ctx, domain } = install({
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	domain.setCounters({
		activeMs: 1_000n,
		activeLoops: 2n,
		taskMs: 3_000n,
		rootLoops: 4n,
		allLoops: 5n,
	});
	await pi.emit("input", { source: "rpc", text: "user" }, ctx);
	assert.equal(domain.counters().activeMs.value, 0n);
	assert.equal(domain.counters().activeLoops.value, 0n);
	assert.equal(domain.counters().taskMs.value, 0n);
	assert.equal(domain.counters().rootLoops.value, 0n);
	assert.equal(domain.counters().allLoops.value, 0n);

	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.match(lastInquiry(pi)?.content ?? "", /ROOT_LOOP_LIMIT/);
	const resetBeforeReflection = domain.counters().revision;
	await correlateReflection(pi, ctx);
	assert.equal(
		domain.counters().revision,
		resetBeforeReflection,
		"matching the reflection inquiry must not self-reset",
	);
});

test("takeover discards stale automatic intent while preserving the manual queue", async () => {
	const { pi, ctx, domain } = install({
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.match(lastInquiry(pi)?.content ?? "", /ROOT_LOOP_LIMIT/);

	await pi.commands[0]?.handler("manual stays", ctx);
	const manualInquiries = pi.messages.filter(({ message }) =>
		String(message.customType ?? "").endsWith(":inquiry"),
	).length;
	assert.equal(runtimeQueuedState(pi, ctx), true);
	await pi.emit("input", { source: "rpc", text: "user" }, ctx);
	assert.equal(domain.counters().rootLoops.value, 0n);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		manualInquiries,
		"user takeover does not dispatch the stale automatic reflection",
	);
	assert.equal(
		runtimeQueuedState(pi, ctx),
		true,
		"manual request remains queued after takeover",
	);
});

test("non-main user message does not request a takeover reset", async () => {
	const hub = createObservableAgentHub();
	const domain = new FakeDomain();
	const root = install({
		hub,
		domain,
		ctx: context("root", { hasUI: true }),
	});
	const child = install({
		hub,
		domain,
		ctx: context("child", { hasUI: false }),
	});
	await root.pi.emit("session_start", {}, root.ctx);
	await child.pi.emit("session_start", {}, child.ctx);
	domain.setCounters({ rootLoops: 1n, allLoops: 1n });
	const revision = domain.counters().revision;
	await child.pi.emit(
		"message_start",
		{ message: { role: "user" } },
		child.ctx,
	);
	assert.equal(domain.counters().revision, revision);
	assert.equal(domain.counters().rootLoops.value, 1n);
	assert.equal(domain.counters().allLoops.value, 1n);
});

test("terminal abort resets while non-abort and missing boundary preserve counters", async () => {
	const { pi, ctx, domain } = install();
	await pi.emit("session_start", {}, ctx);
	ctx.setBranch([ordinaryLoop("before")]);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	ctx.setBranch([
		ordinaryLoop("before"),
		ordinaryLoop("aborted-tail", "aborted"),
	]);
	domain.setCounters({
		activeMs: 1_000n,
		activeLoops: 2n,
		taskMs: 3_000n,
		rootLoops: 4n,
		allLoops: 5n,
	});
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(domain.counters().activeMs.value, 0n);
	assert.equal(domain.counters().activeLoops.value, 0n);
	assert.equal(domain.counters().taskMs.value, 0n);
	assert.equal(domain.counters().rootLoops.value, 0n);
	assert.equal(domain.counters().allLoops.value, 0n);

	ctx.setBranch([ordinaryLoop("before")]);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	ctx.setBranch([
		ordinaryLoop("before"),
		ordinaryLoop("ordinary-tail", "stop"),
	]);
	domain.setCounters({ rootLoops: 1n, allLoops: 1n });
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(domain.counters().rootLoops.value, 1n);
	assert.equal(domain.counters().allLoops.value, 1n);

	ctx.setBranch([ordinaryLoop("aborted-without-capture", "aborted")]);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(domain.counters().rootLoops.value, 1n);
	assert.equal(domain.counters().allLoops.value, 1n);
});

test("abort cancels a staged reflection result before persistence or continuation", async () => {
	const { pi, ctx, domain } = install({
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	const branch: any[] = [ordinaryLoop("before")];
	ctx.setBranch(branch);
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.match(lastInquiry(pi)?.content ?? "", /ROOT_LOOP_LIMIT/);
	await correlateReflection(pi, ctx);
	const captured = await pi.emit("message_end", assistant(validNoIssue), ctx);
	assert.ok(captured);
	ctx.setBranch([
		...branch,
		branchMessage(
			{
				...captured.message,
				stopReason: "aborted",
			},
			"reflection-aborted-tail",
		),
	]);
	domain.setCounters({ rootLoops: 1n, allLoops: 1n });
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	// A main-run abort cancels the staged result before it can act: no
	// durable reflection entries, no ordinary continuation, and the cancelled
	// inquiry's controls are withheld from later model-visible context.
	assert.equal(
		pi.entries.filter(
			(entry) =>
				entry.customType === "pi-reflect-watchdog:reflection" ||
				entry.customType === "pi-reflect-watchdog:reflection-completed",
		).length,
		0,
		"an aborted staged result leaves no durable reflection entries",
	);
	assert.equal(continuationMessages(pi).length, 0);
	assert.equal(domain.counters().rootLoops.value, 0n);
	assert.equal(domain.counters().allLoops.value, 0n);
	assert.deepEqual(
		pi.actions.filter((action) => action === "continuation").length,
		0,
	);
	const cancelled = await pi.emit(
		"context",
		{
			messages: [lastInquiryFold(pi), lastInquiry(pi)]
				.filter((message) => message !== undefined)
				.map((message) => ({ role: "custom", ...message, timestamp: 1 })),
		},
		ctx,
	);
	assert.deepEqual(
		cancelled.messages,
		[],
		"cancelled correlated controls stay out of model context",
	);
});

async function abortSettledRun(
	pi: Pi,
	ctx: ReturnType<typeof context>,
	branch: any[],
	capturedMessage: any,
) {
	ctx.setBranch([
		...branch,
		branchMessage({ ...capturedMessage, stopReason: "aborted" }, "abort-tail"),
	]);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
}

test("post-abort hold blocks dispatch until explicit input or /reflect releases it", async () => {
	const { pi, ctx, domain } = install({
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	const branch: any[] = [ordinaryLoop("before")];
	ctx.setBranch(branch);
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await correlateReflection(pi, ctx);
	const captured = await pi.emit("message_end", assistant(validNoIssue), ctx);
	await abortSettledRun(pi, ctx, branch, captured.message);
	const requestsAtAbort = pi.messages.length;

	// Counters observed during the hold must not retain work for release.
	domain.setCounters({ rootLoops: 5n, allLoops: 5n });
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(pi.messages.length, requestsAtAbort, "hold blocks dispatch");

	// A user-role message alone does not release the hold (extension wakes).
	await pi.emit("input", { source: "rpc", text: "user" }, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		pi.messages.length,
		requestsAtAbort,
		"role-only user message keeps the hold",
	);

	// Explicit rpc input releases it and resets the cycle.
	await pi.emit("input", { type: "input", source: "rpc", text: "resume" }, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(domain.counters().rootLoops.value, 0n);
});

test("extension-sourced input and repeated settlement cannot release the hold", async () => {
	const { pi, ctx } = install({
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	const branch: any[] = [ordinaryLoop("before")];
	ctx.setBranch(branch);
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await correlateReflection(pi, ctx);
	const captured = await pi.emit("message_end", assistant(validNoIssue), ctx);
	await abortSettledRun(pi, ctx, branch, captured.message);
	const requestsAtAbort = pi.messages.length;

	await pi.emit(
		"input",
		{ type: "input", source: "extension", text: "plugin wake" },
		ctx,
	);
	await pi.emit("agent_settled", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		pi.messages.length,
		requestsAtAbort,
		"extension input and repeated settlement keep the hold",
	);

	await pi.emit(
		"input",
		{ type: "input", source: "interactive", text: "real user" },
		ctx,
	);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	// rootLoopLimit is 1: one ordinary loop in the fresh cycle crosses it, so
	// a released hold would produce exactly one new inquiry; a still-held
	// cycle produces none. Either way nothing before release dispatched.
	const inquiryCount = pi.messages.length - requestsAtAbort;
	assert.ok(
		inquiryCount === 0 || inquiryCount === 1,
		`unexpected inquiry count after release: ${inquiryCount}`,
	);
});

test("extension input before abort settlement cannot bypass the hold", async () => {
	const { pi, ctx, domain } = install({
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await correlateReflection(pi, ctx);
	await pi.emit("input", { source: "extension", text: "callback" }, ctx);
	await abortSettledRun(pi, ctx, [], assistant(validNoIssue).message);
	const count = pi.messages.length;
	domain.setCounters({ rootLoops: 5n, allLoops: 5n });
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		pi.messages.length,
		count,
		"extension input must not count as explicit re-entry",
	);
});

test("abort inhibition and re-entry reset precede synchronous counter notifications", async () => {
	const { pi, ctx, domain } = install({
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await correlateReflection(pi, ctx);
	const reset = domain.resetCycleOnUserTakeover.bind(domain);
	const inquiriesAtReset: number[] = [];
	domain.resetCycleOnUserTakeover = async () => {
		// Reentrant observers can see the old snapshot before reset is published.
		domain.setCounters({ rootLoops: 5n, allLoops: 5n });
		inquiriesAtReset.push(
			pi.messages.filter(({ message }) =>
				String(message.customType).endsWith(":inquiry"),
			).length,
		);
		return reset();
	};
	await abortSettledRun(pi, ctx, [], assistant(validNoIssue).message);
	assert.deepEqual(
		inquiriesAtReset,
		[1],
		"abort must hold before reset notifications",
	);
	await pi.emit("input", { source: "rpc", text: "resume" }, ctx);
	assert.deepEqual(
		inquiriesAtReset,
		[1, 1],
		"re-entry must reset while still held",
	);
	assert.equal(domain.counters().rootLoops.value, 0n);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType).endsWith(":inquiry"),
		).length,
		2,
	);
});

test("explicit input submitted during abort settlement is not re-held", async () => {
	const { pi, ctx } = install({
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	const branch: any[] = [ordinaryLoop("before")];
	ctx.setBranch(branch);
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await correlateReflection(pi, ctx);
	const captured = await pi.emit("message_end", assistant(validNoIssue), ctx);
	ctx.setBranch([
		...branch,
		branchMessage(
			{ ...captured.message, stopReason: "aborted" },
			"abort-tail-input",
		),
	]);
	ctx.setIdle(true);
	// The user submits while the aborted run is still settling.
	await pi.emit("input", { type: "input", source: "rpc", text: "quick" }, ctx);
	await pi.emit("agent_settled", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	// rootLoopLimit is 1: the first ordinary loop of the fresh cycle crosses it,
	// so a cycle NOT re-held by the older settlement dispatches exactly one new
	// inquiry (2 total). A wrongly installed hold would leave it at 1 forever.
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		2,
		"the older settlement did not re-hold the user's new cycle",
	);
});

test("new /reflect during abort settlement cancels old requests and survives old settlement", async () => {
	const { pi, ctx, domain } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("old approach", ctx);
	await startReflectionRun(pi, ctx);
	await pi.commands[0]?.handler("discard waiting", ctx);
	ctx.setBranch([
		branchMessage(assistant(validNoIssue).message, "abort-manual"),
	]);
	ctx.setBranch([
		branchMessage(
			{ ...assistant(validNoIssue).message, stopReason: "aborted" },
			"abort-manual",
		),
	]);
	ctx.setIdle(true);
	await pi.commands[0]?.handler("new approach", ctx);
	const fresh = lastInquiry(pi);
	assert.match(fresh.content, /new approach/);
	assert.doesNotMatch(fresh.content, /old approach|discard waiting/);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(lastInquiry(pi), fresh);
	assert.equal(domain.counters().rootLoops.value, 0n);
	await startReflectionRun(pi, ctx);
	await completeReflectionAttempt(pi, ctx, validNoIssue);
	assert.equal(continuationMessages(pi).length, 1);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType).endsWith(":inquiry"),
		).length,
		2,
	);
});

test("aborted correction attempt neither reasks nor warns", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	const invalid = { ...validNoIssue, reason: "   " };
	// The owned response is aborted mid-correction instead of settling clean.
	const abortedAssistant = {
		...assistant(invalid).message,
		stopReason: "aborted",
		content: [
			{
				type: "toolCall",
				id: "ref-aborted",
				name: "ref",
				arguments: JSON.stringify(invalid),
			},
		],
	};
	const rewritten = await pi.emit(
		"message_end",
		{ message: abortedAssistant },
		ctx,
	);
	assert.equal(rewritten?.message.stopReason, "aborted");
	assert.deepEqual(rewritten?.message.content, []);
	const branch: any[] = [
		branchMessage(abortedAssistant, "correction-abort-tail"),
	];
	ctx.setBranch(branch);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(
		ctx.notifications.filter(
			(text) =>
				text.startsWith("Reflection attempt") ||
				text.startsWith("Reflection failed"),
		),
		[],
		"an aborted attempt issues no retry warning",
	);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		1,
		"no correction reask follows the abort",
	);
});

test("late correlated result and tool calls preserve a fresh confirmed inquiry and its budgets", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("old", ctx);
	await startReflectionRun(pi, ctx);
	const oldReply = assistant(validNoIssue);
	oldReply.message.content = [
		{
			type: "toolCall",
			id: "old-result",
			name: "ref",
			arguments: validNoIssue,
		},
	];
	const captured = await pi.emit("message_end", oldReply, ctx);
	await abortSettledRun(pi, ctx, [], captured.message);
	// Stock Pi completes old settlement before running deferred /reflect.
	await pi.emit("agent_settled", {}, ctx);
	await pi.commands[0]?.handler("fresh", ctx);
	await startReflectionRun(pi, ctx);
	const freshPrompt = lastInquiry(pi);
	const requests = pi.messages.length;
	await pi.handlers.get("message_end")?.({ message: captured.message }, ctx);
	await assert.rejects(
		() => pi.tools.get("ref").execute("old-result", validNoIssue),
		/reserved for the plugin/,
	);
	assert.equal(
		(
			await pi.emit(
				"tool_call",
				{ toolCallId: "old-result", toolName: "read", input: {} },
				ctx,
			)
		)?.block,
		true,
	);
	await pi.emit(
		"tool_result",
		{
			toolCallId: "old-result",
			toolName: "ref",
			input: validNoIssue,
			content: [],
			isError: false,
		},
		ctx,
	);
	assert.equal(lastInquiry(pi), freshPrompt);
	assert.equal(
		pi.messages.length,
		requests,
		"old callbacks cannot send a retry or replace fresh authority",
	);
	for (let index = 0; index < 10; index++)
		assert.equal(
			(
				await pi.emit(
					"tool_call",
					{ toolCallId: `fresh-${index}`, toolName: "read", input: {} },
					ctx,
				)
			)?.block,
			undefined,
		);
	assert.equal(
		(
			await pi.emit(
				"tool_call",
				{ toolCallId: "fresh-11", toolName: "read", input: {} },
				ctx,
			)
		)?.block,
		true,
	);
	await completeReflectionAttempt(pi, ctx, validCorrection);
	assert.equal(continuationMessages(pi).length, 1);
	assert.equal(
		pi.entries.filter(
			(entry) => entry.customType === "pi-reflect-watchdog:reflection",
		).length,
		1,
	);
	assert.deepEqual(
		ctx.notifications.filter((value) => value.startsWith("Reflection attempt")),
		[],
	);
});

test("late result call from a cancelled inquiry stays reserved with no active inquiry", async () => {
	const { pi, ctx } = install({
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	const branch: any[] = [ordinaryLoop("before")];
	ctx.setBranch(branch);
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await correlateReflection(pi, ctx);
	const captured = await pi.emit("message_end", assistant(validNoIssue), ctx);
	await abortSettledRun(pi, ctx, branch, captured.message);

	// The stale ref call arrives after the hold; it must be reserved-rejected.
	let rejection: unknown;
	try {
		await pi.emit(
			"message_end",
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{
							type: "toolCall",
							id: "stale-ref",
							name: "ref",
							arguments: JSON.stringify(validNoIssue),
						},
					],
				},
			},
			ctx,
		);
	} catch (error) {
		rejection = error;
	}
	assert.match(
		String(rejection),
		/This function is reserved for the plugin\. Please try another function\./,
	);
	assert.equal(
		pi.entries.filter((entry) =>
			entry.customType.startsWith("pi-reflect-watchdog:reflection"),
		).length,
		0,
		"a cancelled inquiry's late submission records nothing",
	);
});

test("cancel-reflect keeps withdrawal-only behavior after abort cancellation", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	const cancel = pi.commands.find(
		(command) => command.name === "cancel-reflect",
	);
	assert.ok(cancel);
	cancel.handler("", ctx);
	assert.match(
		ctx.notifications.at(-1) ?? "",
		/No queued reflection to cancel\./,
	);
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
	await pi.emit("input", { source: "rpc", text: "user" }, ctx);
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

test("only agent-produced text or tool calls count as loops", async () => {
	const { pi, ctx, domain } = install({
		limits: { rootLoopLimit: 100, allLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	const inquiry = {
		version: 1,
		namespace: "pi-continue-watchdog",
		inquiryId: "other",
		attempt: 1,
	};
	for (const extra of [
		{ errorMessage: "pi-continue-watchdog:preempted" },
		{ details: { piInquiry: inquiry } },
		{ content: [] },
		{ content: [{ type: "thinking", thinking: "x" }] },
		{ content: [{ type: "text", text: "   " }] },
	])
		await pi.emit("turn_end", turnEnd("stop", extra), ctx);
	assert.equal(domain.rootWrites, 0);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await pi.emit(
		"turn_end",
		turnEnd("toolUse", {
			content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }],
		}),
		ctx,
	);
	assert.equal(domain.rootWrites, 2);
});

test("same-process child threshold queues reflection while the child stays busy", async () => {
	const hub = createObservableAgentHub();
	const domain = new FakeDomain();
	const root = install({
		hub,
		domain,
		ctx: context("root", { hasUI: true }),
		limits: { allLoopLimit: 1, rootLoopLimit: 60 },
	});
	const child = install({
		hub,
		domain,
		ctx: context("child", { hasUI: false }),
		limits: { allLoopLimit: 1, rootLoopLimit: 60 },
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
		limits: { allLoopLimit: 1, rootLoopLimit: 60 },
	});
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	domain.setRemoteBusy(true);
	domain.remoteCompletion();
	assert.match(lastInquiry(pi)?.content ?? "", /ALL_LOOP_LIMIT/);
});

test("native Pi steering queue accepts reflection despite an existing pending message", async () => {
	const { pi, ctx, domain } = install({
		limits: { allLoopLimit: 1, rootLoopLimit: 60 },
	});
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	ctx.setPendingMessages(true);
	await pi.emit("agent_start", {}, ctx);
	domain.remoteCompletion();
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
		assert.deepEqual(pi.actions.slice(-4), [
			"entry:pi-reflect-watchdog:reflection",
			"entry:pi-reflect-watchdog:reflection-completed",
			"hook:reflection-completed",
			"continuation",
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
			reflectionArguments({ reason: item.reason, nextStep: item.nextStep }),
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
	for (const args of [validNoIssue, validCorrection])
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
			await pi.emit("message_end", assistant(args), ctx);
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
				0,
				"failed persistence cannot authorize a continuation",
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

test("inquiry activity is officially busy while confirmed replies add no ordinary loops", async () => {
	const { pi, ctx, domain } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	assert.equal(domain.activityWrites.includes(true), true);
	const replacement = await pi.emit(
		"message_end",
		assistant(validNoIssue),
		ctx,
	);
	assert.deepEqual(
		replacement.message.content,
		assistant(validNoIssue).message.content,
	);
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
	assert.deepEqual(
		captured.message.content,
		assistant(validNoIssue).message.content,
	);
	assert.equal(
		captured.message.stopReason ?? "stop",
		"toolUse",
		"neutralized inquiry assistant keeps a non-abort terminal state",
	);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
});

for (const terminal of ["success", "error"] as const) {
	test(`reflection provider retries preserve the attempt until ${terminal} settlement`, async () => {
		const { pi, ctx, domain } = install();
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		await pi.commands[0]?.handler("", ctx);
		await startReflectionRun(pi, ctx);
		const notifications = [...ctx.notifications];
		const errorMessage =
			"Error Code model_not_found: unknown provider for model axis/gpt-6-astra\n\n[pi-retry] provider returned error";
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const failed = {
				role: "assistant",
				stopReason: "error",
				errorMessage,
				content: [],
			};
			const replacement = await pi.emit(
				"message_end",
				{ message: failed },
				ctx,
			);
			const delivered = replacement?.message ?? failed;
			assert.equal(delivered.stopReason, "error");
			assert.equal(delivered.errorMessage, errorMessage);
			await pi.emit("turn_end", { message: failed }, ctx);
			await pi.emit("agent_end", { messages: [failed] }, ctx);
			assert.equal(domain.rootWrites, 0);
			assert.equal(domain.allWrites, 0);
			assert.equal(
				pi.messages.length,
				1,
				"no correction prompt during retries",
			);
			assert.deepEqual(ctx.notifications, notifications);
			assert.deepEqual(hooks, []);
			if (attempt < 3) await pi.emit("agent_start", {}, ctx);
		}
		if (terminal === "success") {
			await pi.emit("agent_start", {}, ctx);
			await completeReflectionAttempt(pi, ctx, validCorrection);
			assert.equal(hooks.length, 1);
			assert.equal(continuationMessages(pi).length, 1);
		} else {
			ctx.setIdle(true);
			await pi.emit("agent_settled", {}, ctx);
			assert.deepEqual(hooks, []);
			assert.equal(continuationMessages(pi).length, 0);
			assert.equal(pi.entries.length, 0);
		}
		assert.equal(lastInquiry(pi).details.attempt, 1);
		assert.ok(lastInquiryFold(pi));
		assert.equal(domain.rootWrites, 0);
		assert.equal(domain.allWrites, 0);
		assert.deepEqual(ctx.notifications, notifications);
		const messages = pi.messages.length;
		await pi.emit("agent_settled", {}, ctx);
		assert.equal(
			pi.messages.length,
			messages,
			"terminal cleanup is idempotent",
		);
		await pi.emit("session_shutdown", {}, ctx);
	});
}

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
				content: assistant(validNoIssue).message.content,
				stopReason: "stop",
			},
		},
		ctx,
	);
	assert.equal(replacement.message.stopReason, "stop");
	assert.equal(replacement.message.errorMessage, undefined);
});

test("invalid result re-ask folds every attempt out of later context", async () => {
	const { pi, ctx, domain } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	const firstCaptured = await pi.emit(
		"message_end",
		assistant("not result"),
		ctx,
	);
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
		"invalid result dispatches one correlated re-ask after settlement",
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

test("three-attempt result correction chain emits one final fold and leaves no context", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	const captured = [
		await completeReflectionAttempt(pi, ctx, { ...validNoIssue, reason: "" }),
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

test("three invalid result attempts emit one final fold without result evidence", async () => {
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
		"Reflection attempt 1/3 invalid: reflection must be submitted with ref; retrying.",
		"Reflection attempt 2/3 invalid: reflection must be submitted with ref; retrying.",
		"Reflection failed: reflection must be submitted with ref",
	]);
});

for (const type of ["ROUTE_CORRECTION", "NO_ISSUE"] as const)
	for (const trigger of ["automatic", "busy-manual", "idle-manual"] as const)
		test(`${trigger} ${type} resumes once with a trigger-specific report`, async () => {
			const origin = trigger === "automatic" ? "automatic" : "manual";
			const args = reflectionArguments({
				type,
				nextStep: "wait for the existing callback",
			});
			const { pi, ctx, domain } = install({
				limits:
					origin === "automatic"
						? { rootLoopLimit: 2, allLoopLimit: 100 }
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
				if (trigger === "busy-manual") {
					assert.ok(
						lastInquiry(pi),
						"busy manual submits immediately without waiting for settlement",
					);
				}
			} else {
				ctx.setIdle(false);
				await pi.emit("agent_start", {}, ctx);
				await pi.emit("turn_end", turnEnd("stop"), ctx);
				// The first loop stays below the limit; the second crosses it.
				await pi.emit("turn_end", turnEnd("stop"), ctx);
			}
			await startReflectionRun(pi, ctx);
			const captured = await pi.emit("message_end", assistant(args), ctx);
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
				JSON.stringify(providerMessages).includes(JSON.stringify(args)),
				false,
				"raw reflection result stays folded",
			);
			const writesBefore = domain.rootWrites;
			assert.equal(writesBefore, origin === "automatic" ? 2 : 0);
			ctx.setBranch([
				...ctx.sessionManager.getBranch(),
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
			assert.equal(
				pi.entries.filter((entry) =>
					entry.customType.startsWith("pi-reflect-watchdog:reflection"),
				).length,
				2,
			);
			assert.equal(hooks.length, 1);
		});

test("native wake reenters only after durable completion with internal state released", async () => {
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
				pi.entries.filter((entry) =>
					entry.customType.startsWith("pi-reflect-watchdog:reflection"),
				).length,
				2,
				"wake requires both durable entries first",
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
		assert.equal(
			pi.entries.filter((entry) =>
				entry.customType.startsWith("pi-reflect-watchdog:reflection"),
			).length,
			2,
		);
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

test("built-in compaction and branch summaries do not project the report for either trigger", async () => {
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
			captured.push(
				providerMessageTextForRuntime(
					request.messages.find((message: any) => message.role === "user"),
				),
			);
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
			assert.match(prompt, /ref\(/);
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
					...assistant(validNoIssue).message.content,
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
					normalizeContext({
						messages,
						tools: [
							{
								name: "read",
								description: "Read fixture notes",
								parameters: Type.Object({ path: Type.String() }),
							},
						],
					}),
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
				assert.equal(wire.includes(JSON.stringify(validNoIssue)), false);
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
		"entry:pi-reflect-watchdog:reflection",
		"entry:pi-reflect-watchdog:reflection-completed",
		"hook:reflection-completed",
		"continuation",
		"inquiry",
	]);
});

test("domain snapshots, not local wall-clock state, drive status text", async () => {
	const { pi, ctx, domain } = install({
		limits: { rootLoopLimit: 60, allLoopLimit: 100 },
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
		/active 12s\/9 loops · task 7s\/20m · root 7\/60 · all 9\/100/,
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

test("reflection tool budget and history hint stay shared across result attempts", async () => {
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
	await completeReflectionAttempt(pi, ctx, "invalid result");
	await startReflectionRun(pi, ctx);
	assert.doesNotMatch(
		lastInquiry(pi)?.content ?? "",
		/history locator|later-anchor/i,
	);
	for (let index = 0; index < 5; index += 1)
		assert.equal(await pi.emit("tool_call", {}, ctx), undefined);
	assert.deepEqual(await pi.emit("tool_call", {}, ctx), {
		block: true,
		reason:
			"Reflection tool-call budget exhausted. If reflection is complete, call ref alone to submit your result and end reflection.",
	});
	await completeReflectionAttempt(pi, ctx, validNoIssue);
	assert.equal(
		continuationMessages(pi).length,
		1,
		"submission survives lookup budget exhaustion",
	);
});

test("busy manual reflection submits one native steer and completes after consumption", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	ctx.setPendingMessages(true);
	await pi.commands[0]?.handler("queued supplement", ctx);
	const inquiries = pi.messages.filter(({ message }) =>
		String(message.customType ?? "").endsWith(":inquiry"),
	);
	assert.equal(inquiries.length, 1, "busy invocation submits exactly once");
	assert.match(inquiries[0]?.message.content ?? "", /queued supplement/);
	assert.match(inquiries[0]?.message.content ?? "", /USER_REQUEST/);
	assert.deepEqual(inquiries[0]?.options, {
		triggerTurn: true,
		deliverAs: "steer",
	});
	assert.ok(
		ctx.notifications.includes("Reflection queued."),
		"submitted request is not advertised as cancellable",
	);
	assert.equal(
		runtimeQueuedState(pi, ctx),
		false,
		"submitted request leaves the plugin-pending slot",
	);
	// The ordinary reply sharing the run passes through uncaptured while the
	// inquiry stays provisional, then the inquiry is consumed and completed.
	const ordinaryReplacement = await pi.emit(
		"message_end",
		assistant("ordinary work in progress"),
		ctx,
	);
	assert.equal(
		ordinaryReplacement,
		undefined,
		"provisional inquiry never captures the ordinary assistant",
	);
	await correlateReflection(pi, ctx);
	const captured = await completeReflectionAttempt(pi, ctx, validNoIssue);
	assert.ok(captured, "consumed inquiry completes normally");
	assert.ok(
		pi.entries.some(
			(entry) => entry.customType === "pi-reflect-watchdog:reflection",
		),
		"the submitted request stores its result after consumption",
	);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		1,
		"consumption adds no second submission",
	);
	assert.equal(continuationMessages(pi).length, 1);
});

test("ordinary settlement cannot cancel an unconsumed native inquiry", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	ctx.setPendingMessages(true);
	await pi.commands[0]?.handler("never consumed", ctx);
	assert.ok(lastInquiry(pi), "busy invocation submits immediately");
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		lastInquiryFold(pi),
		undefined,
		"native queued inquiry remains outstanding until consumption or true abort",
	);
	assert.equal(
		pi.entries.some(
			(entry) => entry.customType === "pi-reflect-watchdog:reflection",
		),
		false,
		"no result is recorded for an unconsumed inquiry",
	);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		1,
		"settlement of an unconsumed inquiry starts no second reflection",
	);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		1,
		"a repeated settlement observation adds nothing",
	);
});

test("duplicate /reflect behind an outstanding inquiry coalesces and keeps the first supplement", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("initial request", ctx);
	await startReflectionRun(pi, ctx);
	await pi.commands[0]?.handler("first supplement", ctx);
	await pi.commands[0]?.handler("second supplement", ctx);
	assert.ok(
		ctx.notifications.includes("A reflection is already queued."),
		"duplicate invocation is reported",
	);
	ctx.setIdle(true);
	await completeReflectionAttempt(pi, ctx, validNoIssue);
	const inquiries = pi.messages.filter(({ message }) =>
		String(message.customType ?? "").endsWith(":inquiry"),
	);
	assert.equal(
		inquiries.length,
		2,
		"waiting request dispatches after completion",
	);
	assert.match(inquiries[1]?.message.content ?? "", /first supplement/);
	assert.doesNotMatch(inquiries[1]?.message.content ?? "", /second supplement/);
});

test("/cancel-reflect discards a plugin-pending request behind an outstanding inquiry", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("initial request", ctx);
	await startReflectionRun(pi, ctx);
	await pi.commands[0]?.handler("withdrawn", ctx);
	await pi.commands[1]?.handler("", ctx);
	assert.ok(ctx.notifications.includes("Queued reflection cancelled."));
	ctx.setIdle(true);
	await completeReflectionAttempt(pi, ctx, validNoIssue);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		1,
		"cancelled request never sends an inquiry; the outstanding one remains",
	);
});

test("/cancel-reflect with empty queue no-ops and never touches an active reflection", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[1]?.handler("", ctx);
	assert.ok(ctx.notifications.includes("No queued reflection to cancel."));
	await pi.commands[0]?.handler("active run", ctx);
	await startReflectionRun(pi, ctx);
	await pi.commands[1]?.handler("", ctx);
	assert.equal(
		ctx.notifications.filter(
			(message) => message === "No queued reflection to cancel.",
		).length,
		2,
		"cancel with an active reflection and empty queue stays a no-op",
	);
	const captured = await completeReflectionAttempt(pi, ctx, validNoIssue);
	assert.ok(captured, "the active reflection completes unaffected");
});

test("cancel shortcut registers from config and cancels; false disables registration", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	assert.equal(pi.shortcuts.length, 1);
	assert.equal(pi.shortcuts[0]?.key, "alt+x");
	await pi.commands[0]?.handler("initial request", ctx);
	await startReflectionRun(pi, ctx);
	await pi.commands[0]?.handler("shortcut target", ctx);
	await pi.shortcuts[0]?.handler(ctx);
	assert.ok(ctx.notifications.includes("Queued reflection cancelled."));
	ctx.setIdle(true);
	await completeReflectionAttempt(pi, ctx, validNoIssue);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		1,
		"cancelled waiting request never sends an inquiry",
	);

	const disabled = install({ limits: { cancelShortcut: false } });
	await disabled.pi.emit("session_start", {}, disabled.ctx);
	assert.equal(
		disabled.pi.shortcuts.length,
		0,
		"false disables shortcut registration",
	);
	await disabled.pi.commands[0]?.handler("initial request", disabled.ctx);
	await startReflectionRun(disabled.pi, disabled.ctx);
	await disabled.pi.commands[0]?.handler("still queued", disabled.ctx);
	assert.ok(
		disabled.ctx.notifications.includes(
			"Reflection queued · /cancel-reflect to cancel",
		),
		"disabled shortcut falls back to the command name in the notification",
	);
	await disabled.pi.commands[1]?.handler("", disabled.ctx);
	assert.ok(
		disabled.ctx.notifications.includes("Queued reflection cancelled."),
		"/cancel-reflect still cancels when the shortcut is disabled",
	);
});

test("queued state surfaces in the status text and clears on dispatch and cancel", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("initial request", ctx);
	await startReflectionRun(pi, ctx);
	await pi.commands[0]?.handler("visible", ctx);
	assert.match(
		ctx.statuses.filter(Boolean).at(-1) ?? "",
		/· queued · alt\+x to cancel$/,
		"status row shows the queued state with the effective key",
	);
	await pi.commands[1]?.handler("", ctx);
	assert.doesNotMatch(
		ctx.statuses.filter(Boolean).at(-1) ?? "",
		/queued/,
		"status clears on cancel",
	);
	await pi.commands[0]?.handler("visible again", ctx);
	assert.match(
		ctx.statuses.filter(Boolean).at(-1) ?? "",
		/· queued · alt\+x to cancel$/,
	);
	ctx.setIdle(true);
	await completeReflectionAttempt(pi, ctx, validNoIssue);
	assert.ok(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length >= 2,
		"waiting request dispatches after finalization",
	);
	assert.doesNotMatch(
		ctx.statuses.filter(Boolean).at(-1) ?? "",
		/queued/,
		"status clears on dispatch",
	);
});

test("queued manual reflection is discarded on session shutdown", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("initial request", ctx);
	await startReflectionRun(pi, ctx);
	await pi.commands[0]?.handler("doomed", ctx);
	await pi.emit("session_shutdown", {}, ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		pi.messages.filter(({ message }) =>
			String(message.customType ?? "").endsWith(":inquiry"),
		).length,
		1,
		"no further inquiry after the session is torn down; only the outstanding one remains",
	);
});

function liveDomain(now: () => number = () => 0) {
	return createReflectDomainCoordinator({
		now,
		open: async () => ({
			nodeId: "host",
			role: "host",
			transport: "tcp-loopback",
			endpoint: "tcp://127.0.0.1:1",
			declaration: {
				version: 1,
				domainId: "live-runtime",
				hostNodeId: "host",
				capability: "fixture",
				endpoint: "tcp://127.0.0.1:1",
			},
			peers: () => [],
			send: async () => {},
			broadcast: async () => {},
			reportLifecycle: async () => {},
			subscribe: () => () => {},
			subscribeEvents: () => () => {},
			close: async () => {},
		}),
	});
}

for (const mainBusy of [false, true])
	test(`real B-to-runtime fresh child completion steers ${mainBusy ? "busy" : "idle"} main; repair never sends`, async () => {
		const hub = createObservableAgentHub();
		const domain = liveDomain();
		const main = install({
			hub,
			domain,
			ctx: context("live-main"),
			limits: { allLoopLimit: 1, rootLoopLimit: 60 },
		});
		const child = install({
			hub,
			domain,
			ctx: context("live-child", { hasUI: false }),
		});
		await main.pi.emit("session_start", {}, main.ctx);
		await child.pi.emit("session_start", {}, child.ctx);
		main.ctx.setIdle(!mainBusy);
		await main.pi.emit("agent_start", {}, main.ctx);
		main.pi.sendMessage(
			{ customType: "unrelated", content: "earlier steering" },
			{ deliverAs: "steer", triggerTurn: true },
		);
		child.ctx.setIdle(false);
		await child.pi.emit("agent_start", {}, child.ctx);
		child.ctx.setBranch([ordinaryLoop("child-fresh")]);
		// Ordinary public observations can count before the whole tool batch ends.
		await child.pi.emit("session_compact", {}, child.ctx);
		assert.equal(domain.counters()?.allLoops.value, 1n);
		assert.equal(lastInquiry(main.pi), undefined);
		await main.pi.emit("agent_settled", {}, main.ctx);
		assert.equal(lastInquiry(main.pi), undefined);
		const event = {
			message: child.ctx.sessionManager.getBranch()[0].message,
			messageEntryId: "child-fresh",
			toolResultEntryIds: [],
		};
		await child.pi.emit("turn_end", event, child.ctx);
		assert.match(lastInquiry(main.pi)?.content ?? "", /all=1\/1/);
		assert.equal(lastInquiry(child.pi), undefined);
		assert.deepEqual(
			main.pi.messages.map((item) => item.message.customType),
			["unrelated", "pi-reflect-watchdog:inquiry"],
		);
		assert.deepEqual(main.pi.messages[1].options, {
			deliverAs: "steer",
			triggerTurn: true,
		});
		await child.pi.emit("turn_end", event, child.ctx);
		await main.pi.emit("agent_settled", {}, main.ctx);
		assert.equal(
			main.pi.messages.length,
			2,
			"duplicate and settlement do not replay decision or cancel provisional inquiry",
		);
		assert.equal(domain.counters()?.rootLoops.value, 0n);
		await child.pi.emit("session_shutdown", {}, child.ctx);
		await main.pi.emit("session_shutdown", {}, main.ctx);
	});

test("real held child completion remains counted; withdrawal/synthetic input/navigation cannot release; explicit input resets before release", async () => {
	let now = 0;
	const domain = liveDomain(() => now),
		hub = createObservableAgentHub();
	const main = install({
		hub,
		domain,
		ctx: context("held-main"),
		limits: { allLoopLimit: 1 },
	});
	const child = install({
		hub,
		domain,
		ctx: context("held-child", { hasUI: false }),
	});
	await main.pi.emit("session_start", {}, main.ctx);
	await child.pi.emit("session_start", {}, child.ctx);
	main.ctx.setIdle(false);
	await main.pi.emit("agent_start", {}, main.ctx);
	main.ctx.setBranch([ordinaryLoop("main-abort", "aborted")]);
	main.ctx.setIdle(true);
	await main.pi.emit("agent_settled", {}, main.ctx);
	child.ctx.setIdle(false);
	await child.pi.emit("agent_start", {}, child.ctx);
	now = 2500;
	await child.pi.emit("turn_end", turnEnd("stop"), child.ctx);
	assert.equal(domain.counters()?.allLoops.value, 1n);
	assert.equal(domain.counters()?.activeMs.value, 2500n);
	assert.equal(lastInquiry(main.pi), undefined);
	await main.pi.commands
		.find((command) => command.name === "cancel-reflect")
		?.handler("", main.ctx);
	await main.pi.emit(
		"input",
		{ source: "extension", text: "callback", images: [] },
		main.ctx,
	);
	await main.pi.emit("message_start", { message: { role: "user" } }, main.ctx);
	publishHook(main.pi, "work-resumed");
	await main.pi.emit(
		"session_tree",
		{ oldLeafId: "old", newLeafId: "new" },
		main.ctx,
	);
	await child.pi.emit("turn_end", turnEnd("stop"), child.ctx);
	assert.equal(lastInquiry(main.pi), undefined);
	const resetObservations: bigint[] = [];
	const unsubscribe = domain.subscribe((counters) =>
		resetObservations.push(counters.allLoops.value),
	);
	const input = {
		source: "rpc",
		text: "fresh",
		images: [{ type: "image", data: "image", mimeType: "image/png" }],
	};
	const before = JSON.stringify(input);
	await main.pi.emit("input", input, main.ctx);
	assert.equal(JSON.stringify(input), before, "input text/images untouched");
	assert.equal(domain.counters()?.allLoops.value, 0n);
	assert.equal(domain.counters()?.activeMs.value, 0n);
	assert.equal(lastInquiry(main.pi), undefined, "reset/release is not trigger");
	assert.equal(resetObservations.at(-1), 0n);
	await child.pi.emit("turn_end", turnEnd("stop"), child.ctx);
	assert.ok(
		lastInquiry(main.pi),
		"fresh post-reentry child completion wakes main",
	);
	unsubscribe();
	await child.pi.emit("session_shutdown", {}, child.ctx);
	await main.pi.emit("session_shutdown", {}, main.ctx);
});

test("real final main turn uses fresh OR snapshot, finalized tools, reserved authority and no deferred outstanding decision", async () => {
	let now = 0;
	const domain = liveDomain(() => now);
	const { pi, ctx } = install({
		domain,
		limits: { rootLoopLimit: 1, allLoopLimit: 1, taskMinutes: 1 },
	});
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	for (let index = 1; index <= 60; index++) {
		now = index * 1000;
		await pi.emit("session_compact", {}, ctx);
	}
	assert.equal(lastInquiry(pi), undefined, "clock observations never send");
	const reply = ordinaryLoop("final-tool").message;
	ctx.setBranch([branchMessage(reply, "final-tool")]);
	await pi.emit(
		"turn_end",
		{
			message: reply,
			messageEntryId: "final-tool",
			toolResultEntryIds: ["not-persisted"],
		},
		ctx,
	);
	assert.equal(
		lastInquiry(pi),
		undefined,
		"missing finalized result cannot authorize boundary",
	);
	ctx.setBranch([
		...ctx.sessionManager.getBranch(),
		branchMessage(
			{ role: "toolResult", toolCallId: "t", content: [] },
			"persisted-tool",
		),
	]);
	let reentered = false;
	const reset = domain.resetReminderCycle.bind(domain);
	domain.resetReminderCycle = async () => {
		if (!reentered) {
			reentered = true;
			ctx.setBranch([
				...ctx.sessionManager.getBranch(),
				ordinaryLoop("simultaneous"),
			]);
			await pi.handlers.get("turn_end")?.(
				{
					message: ordinaryLoop("simultaneous").message,
					messageEntryId: "simultaneous",
					toolResultEntryIds: [],
				},
				ctx,
			);
		}
		return reset();
	};
	await pi.emit(
		"turn_end",
		{
			message: reply,
			messageEntryId: "final-tool",
			toolResultEntryIds: ["persisted-tool"],
		},
		ctx,
	);
	await flushAsync();
	assert.match(
		lastInquiry(pi)?.content ?? "",
		/ROOT_LOOP_LIMIT, ALL_LOOP_LIMIT, TASK_TIME_LIMIT/,
	);
	assert.equal(
		pi.messages.filter((item) => item.message.customType.endsWith(":inquiry"))
			.length,
		1,
	);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await startReflectionRun(pi, ctx);
	await completeReflectionAttempt(pi, ctx, validNoIssue);
	assert.equal(continuationMessages(pi).length, 1);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		pi.messages.filter((item) => item.message.customType.endsWith(":inquiry"))
			.length,
		1,
		"missed outstanding completion is never replayed",
	);
	await pi.emit("session_shutdown", {}, ctx);
});

test("real scope replacement resets clocks/rebuilds branch; append, compaction, cancelled navigation do not", async () => {
	let now = 0;
	const domain = liveDomain(() => now);
	const { pi, ctx } = install({ domain, limits: { rootLoopLimit: 100 } });
	ctx.setBranch([ordinaryLoop("historical")]);
	await pi.emit("session_start", {}, ctx);
	assert.equal(domain.counters()?.rootLoops.value, 1n);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	now = 3200;
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	assert.equal(domain.counters()?.activeMs.value, 3200n);
	await pi.emit("session_compact", {}, ctx);
	await pi.emit("session_before_tree", {}, ctx);
	assert.equal(domain.counters()?.activeMs.value, 3200n);
	ctx.setBranch([ordinaryLoop("selected")]);
	await pi.emit(
		"session_tree",
		{ oldLeafId: "old", newLeafId: "selected" },
		ctx,
	);
	assert.equal(domain.counters()?.activeMs.value, 0n);
	assert.equal(domain.counters()?.rootLoops.value, 1n);
	for (const reason of ["new", "fork", "resume", "reload"]) {
		const next = context(`replacement-${reason}`);
		next.setBranch(reason === "new" ? [] : [ordinaryLoop(`branch-${reason}`)]);
		await pi.emit("session_start", { reason }, next);
		assert.equal(domain.counters()?.activeMs.value, 0n);
		assert.equal(
			domain.counters()?.rootLoops.value,
			reason === "new" ? 0n : 1n,
		);
		await pi.emit("turn_end", turnEnd("stop"), ctx);
		assert.equal(
			domain.counters()?.rootLoops.value,
			reason === "new" ? 0n : 1n,
			"old session callback fenced",
		);
	}
	await pi.emit("session_shutdown", {}, ctx);
});

test("one-second display cadence stays scheduled across publications; inquiry busy clocks count without loops", async () => {
	const timers: Array<{
		callback: () => void;
		delay: number;
		cancelled: boolean;
	}> = [];
	let now = 0;
	const domain = liveDomain(() => now),
		pi = new Pi(),
		ctx = context("cadence");
	createWatchdogExtension({
		hub: createObservableAgentHub(),
		processDomain: domain,
		services: {
			loadConfig: async () => ({ config, diagnostics: [] }),
			scheduleTimer: (_role, callback, delay) => {
				const timer = { callback, delay, cancelled: false };
				timers.push(timer);
				return timer as any;
			},
			clearTimeout: (timer) => {
				(timer as any).cancelled = true;
			},
		},
	})(pi as any);
	await pi.emit("session_start", {}, ctx);
	await pi.commands[0]?.handler("", ctx);
	await startReflectionRun(pi, ctx);
	assert.equal(timers.length, 1);
	assert.equal(timers[0].delay, 1000);
	now = 600;
	await pi.emit("session_compact", {}, ctx);
	assert.equal(timers.length, 1);
	assert.equal(
		timers[0].cancelled,
		false,
		"publications cannot postpone deadline",
	);
	now = 1000;
	timers[0].callback();
	await flushAsync();
	assert.equal(domain.counters()?.activeMs.value, 1000n);
	assert.equal(domain.counters()?.rootLoops.value, 0n);
	assert.match(ctx.statuses.at(-1) ?? "", /active 1s\/0 loops/);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(timers.at(-1)?.cancelled, true);
	await pi.emit("session_shutdown", {}, ctx);
});

for (const inquiry of [false, true])
	for (const outcomeAtMessageEnd of [false, true])
		for (const busyChild of [false, true])
			test(`abort idle settlement freezes official clocks (${inquiry ? "inquiry" : "ordinary"}, ${outcomeAtMessageEnd ? "message outcome" : "branch outcome"}, ${busyChild ? "busy child" : "all idle"})`, async () => {
				let now = 0;
				const domain = liveDomain(() => now);
				const hub = createObservableAgentHub();
				const main = install({ hub, domain, limits: { allLoopLimit: 1 } });
				const child = install({
					hub,
					domain,
					ctx: context("abort-clock-child", { hasUI: false }),
				});
				await main.pi.emit("session_start", {}, main.ctx);
				await child.pi.emit("session_start", {}, child.ctx);
				const hooks = captureReflectionHooks(main.pi);
				if (inquiry) {
					await main.pi.commands[0]?.handler("cancel clock inquiry", main.ctx);
					await startReflectionRun(main.pi, main.ctx);
				} else {
					main.ctx.setIdle(false);
					await main.pi.emit("agent_start", {}, main.ctx);
				}
				if (busyChild) {
					child.ctx.setIdle(false);
					await child.pi.emit("agent_start", {}, child.ctx);
				}
				now = 500;
				if (outcomeAtMessageEnd)
					await main.pi.emit(
						"message_end",
						{
							message: {
								...assistant("partial").message,
								stopReason: "aborted",
							},
						},
						main.ctx,
					);
				main.ctx.setBranch([
					...main.ctx.sessionManager.getBranch(),
					ordinaryLoop("clock-abort", "aborted"),
				]);
				main.ctx.setIdle(true);
				await main.pi.emit("agent_settled", {}, main.ctx);
				await flushAsync();
				assert.equal(domain.counters()?.anyBusy, busyChild);
				now = 3500;
				await child.pi.emit("session_compact", {}, child.ctx);
				await flushAsync();
				assert.equal(domain.counters()?.activeMs.value, busyChild ? 3000n : 0n);
				assert.equal(domain.counters()?.taskMs.value, busyChild ? 3000n : 0n);
				if (busyChild) {
					await child.pi.emit("turn_end", turnEnd("stop"), child.ctx);
					child.ctx.setIdle(true);
					await child.pi.emit("agent_settled", {}, child.ctx);
				}
				await flushAsync();
				assert.equal(domain.counters()?.anyBusy, false);
				const frozen = domain.counters();
				now = 6500;
				await child.pi.emit("session_compact", {}, child.ctx);
				await flushAsync();
				assert.equal(domain.counters()?.anyBusy, false);
				assert.equal(domain.counters()?.activeMs.value, frozen?.activeMs.value);
				assert.equal(domain.counters()?.taskMs.value, frozen?.taskMs.value);
				assert.equal(continuationMessages(main.pi).length, 0);
				assert.equal(
					main.pi.messages.filter(({ message }) =>
						message.customType.endsWith(":inquiry"),
					).length,
					inquiry ? 1 : 0,
				);
				assert.deepEqual(hooks, []);
				assert.equal(
					main.pi.entries.some(({ customType }) =>
						/:reflection(?:-completed)?$/.test(customType),
					),
					false,
				);
				await child.pi.emit("session_shutdown", {}, child.ctx);
				await main.pi.emit("session_shutdown", {}, main.ctx);
			});

for (const modern of [false, true])
	test(`selected ${modern ? "recorded" : "legacy"} history keeps startup windows through navigation/resume/fork/reload`, async () => {
		let now = 0;
		const domain = liveDomain(() => now);
		const { pi, ctx } = install({ domain, limits: { rootLoopLimit: 100 } });
		const history = [
			ordinaryLoop("old"),
			branchMessage(
				{ role: "user", content: [{ type: "text", text: "new cycle" }] },
				"user",
			),
			...(modern
				? [
						{
							type: "custom",
							id: "full",
							customType: "pi-reflect-watchdog:accounting-boundary",
							data: { version: 1, window: "full" },
						},
					]
				: []),
			ordinaryLoop("before-reflection"),
			...completedReflect("historical"),
			...(modern
				? [
						{
							type: "custom",
							id: "reminder",
							customType: "pi-reflect-watchdog:accounting-boundary",
							data: { version: 1, window: "reminder" },
						},
						branchMessage(
							{
								role: "user",
								content: [{ type: "text", text: "synthetic role only" }],
							},
							"synthetic",
						),
					]
				: []),
			ordinaryLoop("fresh"),
		];
		ctx.setBranch(history);
		await pi.emit("session_start", {}, ctx);
		assert.equal(domain.counters()?.activeLoops.value, 2n);
		assert.equal(domain.counters()?.rootLoops.value, 1n);
		const expected = deriveBranchAccounting(ctx.sessionManager.getBranch(), {
			boundaryPolicy: "legacy",
			cooldownLoops: reflectCooldownLoops(100),
		});
		assert.equal(expected.cooldown.skipAutomatic, true);
		ctx.setIdle(false);
		await pi.emit("agent_start", {}, ctx);
		now = 1500;
		await pi.emit("session_compact", {}, ctx);
		assert.equal(domain.counters()?.activeMs.value, 1500n);
		ctx.setBranch([ordinaryLoop("away")]);
		await pi.emit(
			"session_tree",
			{ oldLeafId: "fresh", newLeafId: "away" },
			ctx,
		);
		ctx.setBranch(history);
		await pi.emit(
			"session_tree",
			{ oldLeafId: "away", newLeafId: "fresh" },
			ctx,
		);
		for (const reason of ["tree", "resume", "fork", "reload"]) {
			const selected = reason === "tree" ? ctx : context(`history-${reason}`);
			selected.setBranch(history);
			if (reason !== "tree")
				await pi.emit("session_start", { reason }, selected);
			assert.equal(domain.counters()?.activeMs.value, 0n);
			assert.equal(domain.counters()?.taskMs.value, 0n);
			assert.equal(domain.counters()?.activeLoops.value, expected.activeLoops);
			assert.equal(domain.counters()?.rootLoops.value, expected.reminderLoops);
			assert.equal(
				lastInquiry(pi),
				undefined,
				"adoption never authorizes reflection",
			);
		}
		await pi.emit("session_shutdown", {}, ctx);
	});
