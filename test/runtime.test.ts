/* biome-ignore-all lint/suspicious/noExplicitAny: focused dynamic Pi lifecycle fake */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	createAssistantMessageEventStream,
	normalizeContext,
	type StreamFunction,
	Type,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import {
	convertMessages as convertCompletionsMessages,
	stream as streamCompletions,
} from "@earendil-works/pi-ai/api/openai-completions";
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
import { captureAnchor } from "pi-extension-utils/private-inquiry";
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
import {
	awaitReflectionOperation,
	createReflectionDriver,
	type ReflectionDriverReply,
	settleReflectionOperation,
} from "./fixtures/private-reflection-driver.js";

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

	getThinkingLevel() {
		return "medium";
	}

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
	const terminalInputs = new Set<
		(data: string) => { consume?: boolean } | undefined
	>();
	const manager = {
		getSessionId: () => sessionId,
		getSessionFile: () => options.sessionFile,
		getLeafId: (): string | null => branch.at(-1)?.id ?? null,
		getBranch: () => branch,
		getEntries: () => branch,
	};
	return {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "rpc",
		cwd: `/work/${sessionId}`,
		model: { provider: "fixture-provider", id: "fixture-model" },
		modelRegistry: {},
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
			onTerminalInput(
				listener: (data: string) => { consume?: boolean } | undefined,
			) {
				terminalInputs.add(listener);
				return () => terminalInputs.delete(listener);
			},
		},
		terminalInputs,
		pressKey(data: string) {
			const results = [...terminalInputs].map((listener) => listener(data));
			return results.some((result) => result?.consume === true);
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

/** Controller-only outcome injection: no file execution, validation, retries
 * or attempt budgets. Shared-runtime integration tests use the real-file
 * driver instead; this stub tests policy under controlled or late outcomes. */
class ControllerOutcomeStub {
	/** When true, the abort signal does not resolve parked runs — the test
	 * keeps the old child draining until it calls `settle` explicitly. */
	suspendAbort = false;
	readonly calls: Array<{
		options: any;
		resolve: (result: any) => void;
		prompt: string;
	}> = [];
	readonly runs: Promise<any>[] = [];
	runtimeCreations = 0;
	private scripts: unknown[] = [];

	private readonly services = {
		createRuntime: async () => {
			this.runtimeCreations += 1;
			return {
				fork: async (_input: any) => {
					// An observed fake child: one own terminal assistant message
					// with realistic provider metadata; nothing else is needed.
					const self: any = {
						sessionId: "fake-child",
						sessionFile: "/var/tmp/fake/child.json",
						modelId: "fixture-model",
						inheritedProvider: "fixture",
						attemptError: undefined,
						helperCalls: 0,
						messages: [],
						prompt: async (text: string) => {
							self.messages.push({
								role: "assistant",
								api: "openai-completions",
								provider: "fixture",
								model: "fixture-model",
								responseId: "fake-child-response",
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 2,
									cost: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										total: 0,
									},
								},
								content: [{ type: "text", text }],
								stopReason: "stop",
								timestamp: 1,
							});
						},
						abort: async () => {},
						subscribe: () => () => {},
						dispose: async () => {},
					};
					return self;
				},
				dispose: () => {},
			} as any;
		},
		run: (options: any) => {
			const run = this.execute(options);
			this.runs.push(run);
			return run;
		},
	};

	private execute(options: any): Promise<any> {
		const decision = this.scripts.shift();
		const record: (typeof this.calls)[number] = {
			options,
			resolve: () => {},
			prompt: options.prompt("/var/tmp/controller-stub/result.json"),
		};
		this.calls.push(record);
		return new Promise<any>((resolve) => {
			record.resolve = (result: any) => {
				if (result?.kind !== "decision") {
					resolve(result);
					return;
				}
				void (async () => {
					try {
						const child = await options.runtime.fork({});
						await child.prompt("settle");
						await child.dispose();
					} catch {
						// Inject even late outcomes to test the controller's stale guard.
					}
					resolve({ ...result, sessionId: "fake-child" });
				})();
			};
			options.signal?.addEventListener(
				"abort",
				() => {
					if (!this.suspendAbort) resolve({ kind: "cancelled" });
				},
				{ once: true },
			);
			if (decision !== undefined)
				record.resolve({
					kind: "decision",
					decision,
					sessionId: "fake-child",
					reconsidered: false,
				});
		});
	}

	get service() {
		return this.services;
	}

	/** Inject an already-decided outcome; this is not a validator seam. */
	respond(decision: unknown) {
		this.scripts.push(decision);
	}

	get pending() {
		return this.calls.at(-1);
	}

	settle(result: any) {
		const call = this.calls.at(-1);
		assert.ok(call, "no private reflection is pending");
		call.resolve(result);
	}

	isCurrent() {
		const call = this.calls.at(-1);
		assert.ok(call, "no private reflection is pending");
		return call.options.isCurrent();
	}
}

function install(
	options: {
		hub?: ObservableAgentHub;
		domain?: ReflectBranchDomainCoordinator;
		ctx?: ReturnType<typeof context>;
		limits?: Partial<typeof config>;
		privateInquiry?: ControllerOutcomeStub;
	} = {},
) {
	const pi = new Pi();
	const ctx = options.ctx ?? context();
	const domain = options.domain ?? new FakeDomain();
	const privateInquiry = options.privateInquiry ?? new ControllerOutcomeStub();
	createWatchdogExtension({
		hub: options.hub ?? createObservableAgentHub(),
		processDomain: domain,
		privateInquiry: privateInquiry.service,
		services: {
			loadConfig: async () => ({
				config: { ...config, ...options.limits },
				diagnostics: [],
			}),
		},
	})(pi as any);
	return { pi, ctx, domain: domain as FakeDomain, privateInquiry };
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

/** Prompt text the private child received for the latest reflection. */
function lastPrompt(privateInquiry: ControllerOutcomeStub): string {
	return privateInquiry.pending?.prompt ?? "";
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

/** Seed one replayable assistant entry so trigger-time anchor capture works. */
function seedAnchor(ctx: ReturnType<typeof context>, id = "seed") {
	ctx.setBranch([
		...ctx.sessionManager.getBranch(),
		branchMessage(
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: id }],
			},
			id,
		),
	]);
}

/** Wait for the async private launch to record its `run` call. */
async function pendingReflection(
	privateInquiry: ControllerOutcomeStub,
): Promise<ControllerOutcomeStub["calls"][number]> {
	await flushAsync();
	const call = privateInquiry.pending;
	assert.ok(call, "no private reflection started");
	return call;
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
	raw: unknown = validNoIssue,
	replyExtras?: Pick<
		ReflectionDriverReply,
		"assistantMeta" | "assistantOpaqueContent"
	>,
) {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	driver.respond({
		write: typeof raw === "string" ? raw : JSON.stringify(raw),
		...replyExtras,
	});
	if (origin === "manual") {
		await pi.commands[0]?.handler("", ctx);
	} else {
		ctx.setIdle(false);
		await pi.emit("agent_start", {}, ctx);
		await pi.emit("turn_end", turnEnd("stop"), ctx);
	}
	await awaitReflectionOperation(driver);
	await settleReflectionOperation(driver);
	assert.equal(continuationMessages(pi).length, 1);
	const result = pi.entries.find(
		(entry) => entry.customType === "pi-reflect-watchdog:reflection",
	)?.data as any;
	assert.ok(result);
	return {
		pi,
		ctx,
		driver,
		result,
		// The private path persists the continuation marker carrying the
		// validated `private` source — no main-thread inquiry chain exists.
		messages: [
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

/** Resolve the pending private reflection with a validated decision. */
/** Emit a counted ordinary turn and wait for the private reflection to park. */
async function triggerAutoReflection(
	pi: Pi,
	ctx: ReturnType<typeof context>,
	privateInquiry: ControllerOutcomeStub,
	options: { id?: string; stopReason?: string } = {},
) {
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	// The fixture appends the turn entry itself when messageEntryId is unset,
	// then fills the ids the production handler needs for completeTurn.
	await pi.emit("turn_end", turnEnd(options.stopReason ?? "stop"), ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	return pendingReflection(privateInquiry);
}

/** Settle the pending private run with a validated decision. */
async function settleDecision(
	privateInquiry: ControllerOutcomeStub,
	raw: unknown = validNoIssue,
) {
	const call = privateInquiry.pending;
	assert.ok(call, "no private reflection is pending");
	call.resolve({
		kind: "decision",
		decision: raw,
		sessionId: "fake-child",
		reconsidered: false,
	});
	await flushAsync();
	return call;
}

test("no public result function is registered and foreign tools stay untouched", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	assert.deepEqual([...pi.tools.keys()], []);
	assert.deepEqual(
		pi.commands.map((command) => command.name),
		["reflect", "cancel-reflect"],
	);
});

test("an invalid private result is corrected inside the bounded attempt chain", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	const { next_step: _omitted, ...missingNextStep } = validNoIssue;
	driver.respond({ write: JSON.stringify(missingNextStep) });
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("", ctx);
	await awaitReflectionOperation(driver);
	assert.equal((await settleReflectionOperation(driver))?.kind, "decision");
	assert.equal(driver.children.length, 1);
	const child = driver.children[0];
	assert.ok(child);
	assert.equal(child.prompts.length, 2, "one same-child correction");
	assert.match(
		child.prompts[1] ?? "",
		/must contain exactly the five required fields/,
	);
	assert.doesNotMatch(child.prompts[1] ?? "", /checked|verify/);
	assert.equal(continuationMessages(pi).length, 1);
	assert.equal(
		pi.entries.filter(
			({ customType }) =>
				customType === "pi-reflect-watchdog:reflection-completed",
		).length,
		1,
	);
	await pi.emit("session_shutdown", {}, ctx);
});

test("three invalid private results exhaust the attempt bound and stay silent", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	const notificationsBefore = ctx.notifications.length;
	for (let attempt = 0; attempt < 3; attempt += 1)
		driver.respond({
			write: JSON.stringify({ ...validNoIssue, reason: 42 }),
		});
	await pi.commands[0]?.handler("", ctx);
	await awaitReflectionOperation(driver);
	const result = await settleReflectionOperation(driver);
	assert.equal(result?.kind, "decision-failed");
	assert.deepEqual(ctx.notifications.slice(notificationsBefore), [
		// Every manual request transits the queue; a directly admitted one
		// is reported as dispatched with the generic queued notice.
		"Reflection queued.",
		"Reflection attempt 1/3 invalid: reflection field reason must be a non-empty string; retrying.",
		"Reflection attempt 2/3 invalid: reflection field reason must be a non-empty string; retrying.",
		"Reflection failed: reflection field reason must be a non-empty string",
	]);
	assert.equal(driver.operations.length, 1);
	assert.equal(
		driver.children.at(-1)?.prompts.length,
		3,
		"three consumed invalid responses in the same child",
	);
	assert.equal(pi.entries.length, 0);
	assert.equal(continuationMessages(pi).length, 0);
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
	const privateInquiry = new ControllerOutcomeStub();
	const ctx = context("root", { mode: "tui" });
	const { pi, domain } = install({
		ctx,
		privateInquiry,
		limits: { rootLoopLimit: 3, allLoopLimit: 100 },
	});
	ctx.setBranch([...completedReflect(), ordinaryLoop("ordinary-1")]);
	await pi.emit("session_start", {}, ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	domain.setCounters({ rootLoops: 3n });
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await flushAsync();
	assert.equal(
		privateInquiry.pending,
		undefined,
		"cooldown consumes the automatic threshold without a child",
	);
	assert.equal(domain.resetWrites, 1);
	assert.equal(
		ctx.notifications.filter(
			(message) => message === "Reflect skipped during cooldown.",
		).length,
		1,
	);
	privateInquiry.respond(validNoIssue);
	await pi.commands[0]?.handler("manual bypass", ctx);
	await flushAsync();
	assert.match(
		lastPrompt(privateInquiry),
		/manual bypass/,
		"busy manual reflection submits immediately during cooldown",
	);
});

test("legacy pause hooks neither subscribe nor alter accounting or hold", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx, domain } = install({
		limits: { rootLoopLimit: 1 },
		privateInquiry,
	});
	await pi.emit("session_start", {}, ctx);
	assert.equal(pi.bus.get("pi:semantic-hook:v1")?.size ?? 0, 0);
	publishHook(pi, "work-paused");
	await triggerAutoReflection(pi, ctx, privateInquiry);
	assert.equal(domain.rootWrites, 1);
});

test("minimal core exposes /reflect and /cancel-reflect with no reserved tool", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	assert.deepEqual(
		pi.commands.map((command) => command.name),
		["reflect", "cancel-reflect"],
	);
	// The owned ref tool is retired: the private child writes the designated
	// result file and only built-in read/ls/grep/find helpers execute.
	assert.deepEqual([...pi.tools.keys()], []);
});

test("ordinary user message resets the full cycle without touching reflection state", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx, domain } = install({
		privateInquiry,
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

	const call = await triggerAutoReflection(pi, ctx, privateInquiry);
	assert.ok(call.prompt.includes("ROOT_LOOP_LIMIT"));
	// Admission's reminder reset has happened; settlement must add none.
	const resetsAtLaunch = domain.resetWrites;
	let fullResets = 0;
	const fullReset = domain.resetCycleOnUserTakeover.bind(domain);
	domain.resetCycleOnUserTakeover = async () => {
		fullResets += 1;
		return fullReset();
	};
	const countersAtLaunch = domain.counters();
	await settleDecision(privateInquiry);
	assert.equal(
		domain.resetWrites,
		resetsAtLaunch,
		"matching the reflection result must not self-reset the reminder cycle",
	);
	assert.equal(fullResets, 0, "nor the full cycle");
	for (const key of ["activeLoops", "rootLoops", "allLoops"] as const)
		assert.equal(domain.counters()[key].value, countersAtLaunch[key].value);
});

test("takeover discards stale automatic intent while preserving the manual queue", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx, domain } = install({
		privateInquiry,
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	const automatic = await triggerAutoReflection(pi, ctx, privateInquiry);
	assert.ok(automatic.prompt.includes("ROOT_LOOP_LIMIT"));

	await pi.commands[0]?.handler("manual stays", ctx);
	assert.equal(privateInquiry.calls.length, 1);
	assert.equal(runtimeQueuedState(pi, ctx), true);
	await pi.emit("input", { source: "rpc", text: "user" }, ctx);
	assert.equal(domain.counters().rootLoops.value, 0n);
	assert.equal(
		automatic.options.signal?.aborted,
		true,
		"takeover aborts the in-flight private child immediately",
	);
	assert.equal(
		privateInquiry.calls.length,
		1,
		"user takeover launches no replacement while the old child drains",
	);
	// The old run settles (abort → cancelled): the takeover's generation
	// bump makes the pre-takeover queued manual stale — it drops silently
	// at drain rather than fulfilling under the new cycle. Coordinator
	// af337239: explicit generation check replaces the earlier
	// 'queue preserved' expectation.
	automatic.resolve({ kind: "cancelled", sessionId: "fake-child" });
	await flushAsync();
	assert.equal(
		privateInquiry.calls.length,
		1,
		"the stale-generation queued manual drops silently at drain — it is\n" +
			"never launched under the new takeover generation",
	);
	// A fresh manual under the new generation still fulfills normally,
	// proving the drain consumed rather than wedged the queue.
	await pi.commands[0]?.handler("fresh after takeover", ctx);
	privateInquiry.calls
		.at(-1)
		?.resolve({ kind: "cancelled", sessionId: "fake-child" });
	await flushAsync();
	assert.equal(
		privateInquiry.calls.length,
		2,
		"the post-takeover request captured the new generation and fulfilled",
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

test("abort cancels a pending private run before persistence or continuation", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx, domain } = install({
		privateInquiry,
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	const branch: any[] = [ordinaryLoop("before")];
	ctx.setBranch(branch);
	await pi.emit("session_start", {}, ctx);
	const call = await triggerAutoReflection(pi, ctx, privateInquiry, {
		id: "staged",
	});
	assert.ok(call.prompt.includes("ROOT_LOOP_LIMIT"));

	// The main run aborts while the private child is still pending.
	domain.setCounters({ rootLoops: 1n, allLoops: 1n });
	await abortSettledRun(
		pi,
		ctx,
		ctx.sessionManager.getBranch(),
		assistant("tail").message,
	);
	assert.equal(
		call.options.signal?.aborted,
		true,
		"abort signals the exact child immediately",
	);

	// The cancelled child settles late: zero parent traffic, no durable
	// entries, no continuation, and the hold keeps dispatch parked.
	call.resolve({ kind: "cancelled", sessionId: "fake-child" });
	await flushAsync();
	assert.equal(
		pi.entries.filter(
			(entry) =>
				entry.customType === "pi-reflect-watchdog:reflection" ||
				entry.customType === "pi-reflect-watchdog:reflection-completed",
		).length,
		0,
		"a cancelled private run leaves no durable reflection entries",
	);
	assert.equal(continuationMessages(pi).length, 0);
	assert.equal(domain.counters().rootLoops.value, 0n);
	assert.equal(domain.counters().allLoops.value, 0n);
	assert.equal(
		pi.messages.filter(({ message }) => message.customType).length,
		0,
		"no main-session inquiry/fold/continuation traffic at all",
	);
});

async function abortSettledRun(
	pi: Pi,
	ctx: ReturnType<typeof context>,
	branch: any[],
	capturedMessage: any,
) {
	const aborted = { ...capturedMessage, stopReason: "aborted" };
	// A fresh run starts (capturing the abort boundary at the current leaf),
	// then its authoritative aborted outcome reaches message_end; the hold +
	// revocation install there, and the trailing agent_settled only settles.
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	ctx.setBranch([...branch, branchMessage(aborted, "abort-tail")]);
	await pi.emit("message_end", { message: aborted }, ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
}

// K (completion hook, staged-result scenario). Packed cannot hold this window:
// the real child's result write and the acceptance of its settled turn are
// one provider response. The real shared runner runs here; only the child is
// a driver that writes a valid file and then holds before settling.
test("abort after a valid result is staged but before acceptance publishes nothing", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx, domain } = install({
		privateInquiry: { service: driver.service } as any,
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	const hooks = captureReflectionHooks(pi);
	ctx.setBranch([ordinaryLoop("before")]);
	await pi.emit("session_start", {}, ctx);
	let release!: () => void;
	driver.respond({
		write: JSON.stringify(validNoIssue),
		writeBeforeHold: true,
		hold: new Promise<void>((resolve) => {
			release = resolve;
		}),
	});
	await pi.commands[0]?.handler("", ctx);
	const operation = await awaitReflectionOperation(driver);
	const child = await (async () => {
		for (let index = 0; index < 2000; index += 1) {
			const found = driver.children[0];
			if (found !== undefined && found.prompts.length === 1) {
				const resultFile = driver.forkInputs[0]?.resultFile ?? "";
				const staged = await readFile(resultFile, "utf8").catch(() => "");
				if (staged === JSON.stringify(validNoIssue)) return found;
			}
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		throw new Error("valid result was never staged");
	})();
	domain.setCounters({ rootLoops: 1n, allLoops: 1n });
	await abortSettledRun(
		pi,
		ctx,
		ctx.sessionManager.getBranch(),
		assistant("tail").message,
	);
	assert.equal(operation.options.signal?.aborted, true);
	release();
	const result = await settleReflectionOperation(driver);
	assert.equal(
		result?.kind,
		"cancelled",
		"the staged valid file is not accepted",
	);
	assert.equal(child.aborted, true, "the exact child was aborted");
	assert.deepEqual(hooks, []);
	assert.equal(
		pi.entries.filter(({ customType }) =>
			customType?.startsWith("pi-reflect-watchdog:reflection"),
		).length,
		0,
	);
	assert.equal(continuationMessages(pi).length, 0);
	assert.equal(driver.children.length, 1, "no replacement child");
	assert.equal(child.prompts.length, 1, "no correction or retry");
});

test("post-abort hold blocks dispatch until explicit input or /reflect releases it", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx, domain } = install({
		privateInquiry,
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	const branch: any[] = [ordinaryLoop("before")];
	ctx.setBranch(branch);
	await pi.emit("session_start", {}, ctx);
	const call = await triggerAutoReflection(pi, ctx, privateInquiry);
	await abortSettledRun(
		pi,
		ctx,
		ctx.sessionManager.getBranch(),
		call.options ? assistant("tail").message : undefined,
	);
	call.resolve({ kind: "cancelled", sessionId: "fake-child" });
	await flushAsync();

	// Counters observed during the hold must not retain work for release.
	domain.setCounters({ rootLoops: 5n, allLoops: 5n });
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		privateInquiry.calls.length,
		1,
		"hold blocks dispatch of a fresh crossing",
	);

	// A user-role message alone does not release the hold (extension wakes).
	await pi.emit("input", { source: "rpc", text: "user" }, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		privateInquiry.calls.length,
		1,
		"role-only user message keeps the hold",
	);

	// Explicit rpc input releases it and resets the cycle.
	await pi.emit("input", { type: "input", source: "rpc", text: "resume" }, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(domain.counters().rootLoops.value, 0n);
});

test("extension-sourced input and repeated settlement cannot release the hold", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx } = install({
		privateInquiry,
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	ctx.setBranch([ordinaryLoop("before")]);
	await pi.emit("session_start", {}, ctx);
	const call = await triggerAutoReflection(pi, ctx, privateInquiry);
	await abortSettledRun(
		pi,
		ctx,
		ctx.sessionManager.getBranch(),
		assistant("tail").message,
	);
	call.resolve({ kind: "cancelled", sessionId: "fake-child" });
	await flushAsync();

	await pi.emit(
		"input",
		{ type: "input", source: "extension", text: "plugin wake" },
		ctx,
	);
	await pi.emit("agent_settled", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		privateInquiry.calls.length,
		1,
		"extension input and repeated settlement keep the hold",
	);

	await pi.emit(
		"input",
		{ type: "input", source: "interactive", text: "real user" },
		ctx,
	);
	await triggerAutoReflection(pi, ctx, privateInquiry, { id: "fresh" });
	// rootLoopLimit is 1: the fresh cycle's ordinary loop crosses it, so a
	// released hold produces exactly one new private run; a still-held cycle
	// produces none. Either way nothing before release dispatched.
	const launches = privateInquiry.calls.length - 1;
	assert.ok(
		launches === 0 || launches === 1,
		`unexpected private launches after release: ${launches}`,
	);
});

test("extension input before abort settlement cannot bypass the hold", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx, domain } = install({
		privateInquiry,
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	const call = await triggerAutoReflection(pi, ctx, privateInquiry);
	await pi.emit("input", { source: "extension", text: "callback" }, ctx);
	await abortSettledRun(pi, ctx, [], assistant("tail").message);
	call.resolve({ kind: "cancelled", sessionId: "fake-child" });
	await flushAsync();
	domain.setCounters({ rootLoops: 5n, allLoops: 5n });
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		privateInquiry.calls.length,
		1,
		"extension input must not count as explicit re-entry",
	);
});

test("abort inhibition and re-entry reset precede synchronous counter notifications", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx, domain } = install({
		privateInquiry,
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	await triggerAutoReflection(pi, ctx, privateInquiry);
	const reset = domain.resetCycleOnUserTakeover.bind(domain);
	const launchesAtReset: number[] = [];
	domain.resetCycleOnUserTakeover = async () => {
		// Reentrant observers can see the old snapshot before reset is published.
		domain.setCounters({ rootLoops: 5n, allLoops: 5n });
		launchesAtReset.push(privateInquiry.calls.length);
		return reset();
	};
	await abortSettledRun(pi, ctx, [], assistant("tail").message);
	assert.deepEqual(
		launchesAtReset,
		[1],
		"abort must hold before reset notifications",
	);
	await pi.emit("input", { source: "rpc", text: "resume" }, ctx);
	assert.deepEqual(
		launchesAtReset,
		[1, 1],
		"re-entry must reset while still held",
	);
	assert.equal(domain.counters().rootLoops.value, 0n);
	await triggerAutoReflection(pi, ctx, privateInquiry, { id: "fresh" });
	assert.equal(privateInquiry.calls.length, 2);
});

test("explicit input submitted during abort settlement is not re-held", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx } = install({
		privateInquiry,
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	ctx.setBranch([ordinaryLoop("before")]);
	await pi.emit("session_start", {}, ctx);
	const call = await triggerAutoReflection(pi, ctx, privateInquiry);
	ctx.setBranch([
		...ctx.sessionManager.getBranch(),
		branchMessage(
			{ ...assistant("tail").message, stopReason: "aborted" },
			"abort-tail-input",
		),
	]);
	ctx.setIdle(true);
	// The user submits while the aborted run is still settling.
	await pi.emit("input", { type: "input", source: "rpc", text: "quick" }, ctx);
	await pi.emit("agent_settled", {}, ctx);
	call.resolve({ kind: "cancelled", sessionId: "fake-child" });
	await flushAsync();
	// rootLoopLimit is 1: the first ordinary loop of the fresh cycle crosses
	// it, so a cycle NOT re-held by the older settlement launches exactly one
	// new private run (2 total). A wrongly installed hold would leave it at 1.
	await triggerAutoReflection(pi, ctx, privateInquiry, { id: "fresh" });
	assert.equal(
		privateInquiry.calls.length,
		2,
		"the older settlement did not re-hold the user's new cycle",
	);
});

test("new /reflect during abort settlement cancels old requests and survives old settlement", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	// The old child stays draining after revocation until `settle` — that is
	// the real during-settlement window this race exercises.
	privateInquiry.suspendAbort = true;
	const { pi, ctx, domain } = install({ privateInquiry });
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	await pi.commands[0]?.handler("old approach", ctx);
	const oldCall = await pendingReflection(privateInquiry);
	assert.match(oldCall.prompt, /old approach/);
	// A second /reflect queues behind the active private run.
	await pi.commands[0]?.handler("discard waiting", ctx);
	// Abort the main run at the authoritative boundary: the aborted
	// message_end installs the hold + revocation, but the old private run
	// is still draining (slot retained until its own settlement).
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	const aborted = { ...assistant("tail").message, stopReason: "aborted" };
	ctx.setBranch([
		...ctx.sessionManager.getBranch(),
		branchMessage(aborted, "abort-tail"),
	]);
	await pi.emit("message_end", { message: aborted }, ctx);
	ctx.setIdle(true);
	assert.equal(
		oldCall.options.signal?.aborted,
		true,
		"old private run was revoked at the abort boundary",
	);
	// The fresh explicit request lands DURING settlement — before the old
	// run's drain and the aborted main run's agent_settled.
	await pi.commands[0]?.handler("new approach", ctx);
	await flushAsync();
	assert.equal(
		privateInquiry.calls.length,
		1,
		"queued manual stays behind the still-draining old run",
	);
	// The old run's own settlement drains the slot; the queued explicit
	// request is the scheduling trigger — no extra user command needed.
	oldCall.resolve({ kind: "cancelled", sessionId: "fake-child" });
	await flushAsync();
	// The aborted main run's settlement must not discard or re-hold the
	// already-admitted fresh reflection.
	await pi.emit("agent_settled", {}, ctx);
	await flushAsync();
	assert.equal(privateInquiry.calls.length, 2, "fresh request launched");
	assert.match(lastPrompt(privateInquiry), /new approach/);
	assert.doesNotMatch(
		lastPrompt(privateInquiry),
		/old approach|discard waiting/,
	);
	assert.equal(domain.counters().rootLoops.value, 0n);
	// The fresh request completes independently of the old settlement.
	await settleDecision(privateInquiry);
	assert.equal(continuationMessages(pi).length, 1);
});

test("aborted correction attempt neither reasks nor warns", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx } = install({ privateInquiry });
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	await pi.commands[0]?.handler("", ctx);
	const call = await pendingReflection(privateInquiry);
	// The child is revoked mid-operation: it reports cancelled instead of a
	// validated payload or a correction attempt.
	await abortSettledRun(
		pi,
		ctx,
		ctx.sessionManager.getBranch(),
		assistant("tail").message,
	);
	assert.equal(call.options.signal?.aborted, true);
	call.resolve({ kind: "cancelled", sessionId: "fake-child" });
	await flushAsync();
	assert.deepEqual(
		ctx.notifications.filter(
			(text) =>
				text.startsWith("Reflection attempt") ||
				text.startsWith("Reflection failed"),
		),
		[],
		"a cancelled private run issues no retry warning",
	);
	assert.equal(
		privateInquiry.calls.length,
		1,
		"no correction reask follows the abort",
	);
});

test("late cancelled outcome preserves a fresh manual reflection and its authority", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx } = install({ privateInquiry });
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	await pi.commands[0]?.handler("old", ctx);
	const oldCall = await pendingReflection(privateInquiry);
	// The main run aborts; the stale private outcome settles after the hold.
	await abortSettledRun(pi, ctx, [], assistant("tail").message);
	oldCall.resolve({ kind: "cancelled", sessionId: "fake-child" });
	await flushAsync();
	await pi.emit("input", { source: "rpc", text: "resume" }, ctx);
	privateInquiry.respond(validCorrection);
	await pi.commands[0]?.handler("fresh", ctx);
	await flushAsync();
	const freshCall = privateInquiry.pending;
	assert.ok(freshCall);
	assert.match(freshCall.prompt, /fresh/);
	assert.notEqual(freshCall, oldCall);
	assert.equal(
		oldCall.options.isCurrent(),
		false,
		"the revoked run's isCurrent can never re-claim authority",
	);
	assert.equal(privateInquiry.calls.length, 2);
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

test("stale private outcome after takeover writes nothing upstream", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx, domain } = install({
		privateInquiry,
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	ctx.setBranch([ordinaryLoop("before")]);
	await pi.emit("session_start", {}, ctx);
	// Keep the run open past revocation so a valid decision truly arrives late.
	privateInquiry.suspendAbort = true;
	const call = await triggerAutoReflection(pi, ctx, privateInquiry);
	await abortSettledRun(
		pi,
		ctx,
		ctx.sessionManager.getBranch(),
		assistant("tail").message,
	);
	const before =
		pi.messages.length + pi.entries.length + ctx.notifications.length;
	assert.equal(
		call.options.signal?.aborted,
		true,
		"revoked before the outcome",
	);
	assert.equal(call.options.isCurrent(), false);
	const counters = domain.counters();
	// The stale child resolves a fully valid decision late; revocation wins.
	call.resolve({
		kind: "decision",
		decision: validNoIssue,
		sessionId: "fake-child",
		reconsidered: false,
	});
	const settled = await privateInquiry.runs.at(-1);
	await flushAsync();
	assert.equal(
		settled?.kind,
		"decision",
		"the late valid decision reached the seam",
	);
	assert.equal(
		pi.messages.length + pi.entries.length + ctx.notifications.length,
		before,
		"a late valid outcome is dropped without traffic",
	);
	assert.equal(privateInquiry.calls.length, 1, "no replacement launch");
	for (const key of ["activeLoops", "rootLoops", "allLoops", "taskMs"] as const)
		assert.equal(domain.counters()[key].value, counters[key].value);
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

test("authoritative domain loops trigger the private run from ordinary work", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx, domain } = install({
		privateInquiry,
		limits: { rootLoopLimit: 1, allLoopLimit: 100 },
	});
	await pi.emit("session_start", {}, ctx);
	const first = await triggerAutoReflection(pi, ctx, privateInquiry, {
		id: "loop-1",
	});
	assert.ok(first.prompt.includes("ROOT_LOOP_LIMIT"));
	assert.equal(domain.rootWrites, 1);
	assert.equal(domain.allWrites, 0);
	await pi.emit("input", { source: "rpc", text: "user" }, ctx);
	first.resolve({ kind: "cancelled", sessionId: "fake-child" });
	await flushAsync();
	await triggerAutoReflection(pi, ctx, privateInquiry, { id: "loop-2" });
	// Each threshold crossing consumes the reminder latch on dispatch.
	assert.equal(domain.resetWrites, 2);
	assert.equal(
		privateInquiry.calls.length,
		2,
		"the reset cycle re-arms threshold latches without a duplicate",
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
	const privateInquiry = new ControllerOutcomeStub();
	const hub = createObservableAgentHub();
	const domain = new FakeDomain();
	const root = install({
		hub,
		domain,
		privateInquiry,
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
	seedAnchor(root.ctx);
	child.ctx.setIdle(false);
	await child.pi.emit("agent_start", {}, child.ctx);
	await child.pi.emit("turn_end", turnEnd("stop"), child.ctx);
	await flushAsync();
	assert.equal(domain.rootWrites, 0);
	assert.equal(domain.allWrites, 1);
	assert.ok(
		privateInquiry.pending?.prompt.includes("ALL_LOOP_LIMIT"),
		"child loop crossed the all-loop threshold on the owner's behalf",
	);
});

test("cross-process child threshold queues reflection while the child stays busy", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx, domain } = install({
		privateInquiry,
		limits: { allLoopLimit: 1, rootLoopLimit: 60 },
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	domain.setRemoteBusy(true);
	domain.remoteCompletion();
	await flushAsync();
	assert.ok(
		privateInquiry.pending?.prompt.includes("ALL_LOOP_LIMIT"),
		"remote completion crossed the all-loop threshold",
	);
});

test("native Pi steering queue accepts reflection despite an existing pending message", async () => {
	const privateInquiry = new ControllerOutcomeStub();
	const { pi, ctx, domain } = install({
		privateInquiry,
		limits: { allLoopLimit: 1, rootLoopLimit: 60 },
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	ctx.setIdle(false);
	ctx.setPendingMessages(true);
	await pi.emit("agent_start", {}, ctx);
	domain.remoteCompletion();
	await flushAsync();
	assert.ok(
		privateInquiry.pending?.prompt.includes("ALL_LOOP_LIMIT"),
		"pending messages never block the private launch",
	);
});

test("valid final reflections publish exact payloads once after durable entries", async () => {
	for (const [decision, expected] of [
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
		const driver = createReflectionDriver();
		const ctx = context("root", {
			mode: "tui",
			sessionFile: "/missing/hook-session.jsonl",
		});
		ctx.setBranch([ordinaryLoop("hook-anchor")]);
		const { pi, domain } = install({
			ctx,
			privateInquiry: { service: driver.service } as any,
		});
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		seedAnchor(ctx);
		driver.respond({ write: JSON.stringify(decision) });
		await pi.commands[0]?.handler("", ctx);
		await awaitReflectionOperation(driver);
		await settleReflectionOperation(driver);
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
		const driver = createReflectionDriver();
		const { pi, ctx } = install({
			privateInquiry: { service: driver.service } as any,
		});
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		seedAnchor(ctx);
		driver.respond({
			write: JSON.stringify(
				reflectionArguments({ reason: item.reason, nextStep: item.nextStep }),
			),
		});
		await pi.commands[0]?.handler("", ctx);
		await awaitReflectionOperation(driver);
		await settleReflectionOperation(driver);
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
			const driver = createReflectionDriver();
			const { pi, ctx } = install({
				privateInquiry: { service: driver.service } as any,
			});
			const hooks = captureReflectionHooks(pi);
			const appendEntry = pi.appendEntry.bind(pi);
			pi.appendEntry = (customType: string, data: unknown) => {
				if (customType === failingType)
					throw new Error("fixture append failed");
				appendEntry(customType, data);
			};
			await pi.emit("session_start", {}, ctx);
			seedAnchor(ctx);
			driver.respond({ write: JSON.stringify(args) });
			await pi.commands[0]?.handler("", ctx);
			await awaitReflectionOperation(driver);
			// The persistence throw surfaces inside the private task; the run
			// settles without durable entries, hook or continuation.
			await settleReflectionOperation(driver);
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
		// Retry + exhaustion: invalid payloads correct in the same child and
		// exhaust the bound; no hook, no continuation, no parent traffic.
		const driver = createReflectionDriver();
		const { pi, ctx } = install({
			privateInquiry: { service: driver.service } as any,
		});
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		seedAnchor(ctx);
		driver.respond({ write: "invalid" });
		driver.respond({ write: "invalid again" });
		driver.respond({ write: "invalid exhausted" });
		await pi.commands[0]?.handler("", ctx);
		await awaitReflectionOperation(driver);
		const result = await settleReflectionOperation(driver);
		assert.equal(result?.kind, "decision-failed");
		assert.deepEqual(hooks, [], "exhausted validation is silent");
		assert.equal(continuationMessages(pi).length, 0);
	}
	{
		// No decision: the child's response throws — a provider/transport
		// execution error, not a published reflection.
		const driver = createReflectionDriver();
		const { pi, ctx } = install({
			privateInquiry: { service: driver.service } as any,
		});
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		seedAnchor(ctx);
		driver.respond({ throw: new Error("provider down") });
		await pi.commands[0]?.handler("", ctx);
		await awaitReflectionOperation(driver);
		const result = await settleReflectionOperation(driver);
		assert.notEqual(result?.kind, "decision");
		assert.deepEqual(hooks, [], "settled run without decision is silent");
		assert.equal(continuationMessages(pi).length, 0);
	}
	{
		// Ownership loss mid-operation: the second install claims the hub
		// before the private run settles — its outcome commits nothing.
		const hub = createObservableAgentHub();
		const domain = new FakeDomain();
		const driver = createReflectionDriver();
		const root = install({
			hub,
			domain,
			privateInquiry: { service: driver.service } as any,
			ctx: context("root", { hasUI: false }),
		});
		const hooks = captureReflectionHooks(root.pi);
		await root.pi.emit("session_start", {}, root.ctx);
		seedAnchor(root.ctx);
		driver.respond({ write: JSON.stringify(validNoIssue) });
		await root.pi.commands[0]?.handler("", root.ctx);
		await awaitReflectionOperation(driver);
		const owner = install({
			hub,
			domain,
			ctx: context("owner", { hasUI: true }),
		});
		await owner.pi.emit("session_start", {}, owner.ctx);
		await settleReflectionOperation(driver);
		assert.deepEqual(hooks, [], "ownership loss is silent");
		assert.equal(continuationMessages(root.pi).length, 0);
	}
	{
		// Shutdown while parked: the private run never publishes.
		const driver = createReflectionDriver();
		const { pi, ctx } = install({
			privateInquiry: { service: driver.service } as any,
		});
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		seedAnchor(ctx);
		await pi.commands[0]?.handler("", ctx);
		const operation = await awaitReflectionOperation(driver);
		await pi.emit("session_shutdown", {}, ctx);
		// Shutdown revokes: the parked child aborts and the run settles
		// cancelled — wait without the never-scripted check (the child IS
		// intentionally parked when the shutdown lands).
		for (let attempt = 0; attempt < 2000 && !operation.settled; attempt += 1)
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		await flushAsync();
		assert.deepEqual(hooks, [], "shutdown is silent");
		assert.equal(continuationMessages(pi).length, 0);
	}
});

test("throwing completion listener cannot change result, UI, counters, or later dispatch", async () => {
	const driver = createReflectionDriver();
	const ctx = context("root", { mode: "tui" });
	const { pi, domain } = install({
		ctx,
		privateInquiry: { service: driver.service } as any,
	});
	const hooks = captureReflectionHooks(pi, true);
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify(validCorrection) });
	// "second" stays unscripted: it parks as a real pending child, exactly
	// the unconsumed later dispatch the original test asserted.
	await pi.commands[0]?.handler("first", ctx);
	await pi.commands[0]?.handler("second", ctx);
	await awaitReflectionOperation(driver);
	await settleReflectionOperation(driver);
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
	// A second queued manual dispatched by the post-drain release proves
	// listener failure never touched the queue.
	assert.equal(
		driver.operations.length,
		2,
		"later dispatch survives listener failure",
	);
});

test("inquiry activity is officially busy while confirmed replies add no ordinary loops", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx, domain } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	await pi.commands[0]?.handler("", ctx);
	const operation = await awaitReflectionOperation(driver);
	// The private child's own working period flips the domain busy flag —
	// official busy while the run is in flight.
	for (
		let turn = 0;
		turn < 2000 && !domain.activityWrites.includes(true);
		turn += 1
	)
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	assert.equal(
		domain.activityWrites.includes(true),
		true,
		"private child work is officially busy",
	);
	const rootBefore = domain.rootWrites;
	const allBefore = domain.allWrites;
	driver.respond({ write: JSON.stringify(validNoIssue) });
	for (let turn = 0; turn < 2000 && !operation.settled; turn += 1)
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	await flushAsync();
	assert.equal(
		domain.rootWrites - rootBefore,
		0,
		"private child replies add no ordinary loops",
	);
	assert.equal(domain.allWrites - allBefore, 0);
	assert.equal(
		pi.entries.filter(
			(entry) =>
				entry.customType === "pi-reflect-watchdog:reflection-completed",
		).length,
		1,
	);
});

test("provisional reflection never captures an uncorrelated ordinary assistant", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	await pi.commands[0]?.handler("", ctx);
	await awaitReflectionOperation(driver);
	// The private path never inspects or rewrites main assistant turns —
	// an ordinary assistant reply passing through the runtime while the
	// private child is in flight stays untouched and is never captured.
	const replacement = await pi.emit(
		"message_end",
		assistant("ordinary work in progress"),
		ctx,
	);
	assert.equal(
		replacement,
		undefined,
		"private run must not rewrite the ordinary assistant",
	);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await settleReflectionOperation(driver);
	assert.equal(driver.operations.length, 1);
});

for (const terminal of ["success", "error"] as const) {
	test(`reflection provider retries preserve the attempt until ${terminal} settlement`, async () => {
		const driver = createReflectionDriver();
		const { pi, ctx, domain } = install({
			privateInquiry: { service: driver.service } as any,
		});
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		seedAnchor(ctx);
		await pi.commands[0]?.handler("", ctx);
		const operation = await awaitReflectionOperation(driver);
		let releaseRetry!: () => void;
		const hold = new Promise<void>((resolve) => {
			releaseRetry = resolve;
		});
		driver.respond({
			nativeRetry: true,
			hold,
			write: JSON.stringify(validCorrection),
			stopReason: terminal === "success" ? "stop" : "error",
			...(terminal === "error"
				? { errorMessage: "native retry exhausted" }
				: {}),
		});
		for (
			let turn = 0;
			turn < 2000 && (driver.children[0]?.messages.length ?? 0) === 0;
			turn += 1
		)
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		const child = driver.children[0];
		assert.ok(child);
		assert.equal(
			(child.messages[0] as { stopReason: string }).stopReason,
			"error",
		);
		assert.equal(
			child.prompts.length,
			1,
			"native retry remains inside the same prompt, not a format correction",
		);
		assert.equal(operation.options.fork.retryPolicy, "native");
		assert.equal(operation.settled, false);
		assert.equal(operation.options.signal?.aborted, false);
		assert.deepEqual(hooks, []);
		assert.equal(
			pi.entries.filter(({ customType }) =>
				/:reflection(?:-completed)?$/.test(customType),
			).length,
			0,
		);
		assert.equal(pi.messages.length, 0);
		const writesBefore = domain.allWrites;
		const notifications = [...ctx.notifications];
		releaseRetry();
		const result = await settleReflectionOperation(driver);
		assert.equal(
			result?.kind,
			terminal === "success" ? "decision" : "execution-error",
		);
		assert.equal(child.prompts.length, 1);
		assert.equal(driver.children.length, 1);
		assert.equal(hooks.length, terminal === "success" ? 1 : 0);
		assert.equal(
			continuationMessages(pi).length,
			terminal === "success" ? 1 : 0,
		);
		assert.equal(
			pi.entries.filter(
				({ customType }) =>
					customType === "pi-reflect-watchdog:reflection-completed",
			).length,
			terminal === "success" ? 1 : 0,
		);
		assert.equal(
			domain.allWrites,
			writesBefore,
			"private native retries add no ordinary loops",
		);
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

test("private terminal source preserves its actual stopReason", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	await pi.commands[0]?.handler("", ctx);
	const operation = await awaitReflectionOperation(driver);
	// The private child's own terminal assistant keeps its real stopReason
	// — a settled "stop" is preserved verbatim; the runtime never
	// synthesizes an aborted state over it.
	driver.respond({
		write: JSON.stringify(validNoIssue),
		stopReason: "stop",
	});
	for (let turn = 0; turn < 2000 && !operation.settled; turn += 1)
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	await flushAsync();
	const result = await operation.result;
	assert.equal(result.kind, "decision");
	assert.equal(operation.options.signal?.aborted, false);
	const marker = pi.messages.find(
		({ message }) => message.customType === "pi-reflect-watchdog:continuation",
	)?.message;
	const source = marker?.details?.private as
		| Record<string, unknown>
		| undefined;
	assert.equal(source?.stopReason, "stop");
	// A cancelled run conversely never reports a synthesized neutralized
	// terminal — kind is cancelled, not decision.
	await pi.emit("session_shutdown", {}, ctx);
});

// Retired triage #40–42: new main inquiry/fold traffic is replaced by private
// same-child correction and silent exhaustion; historical folding tests remain.
for (const invalidAttempts of [1, 2, 3])
	test(`private file correction uses ${invalidAttempts} invalid attempts without parent residue`, async () => {
		const driver = createReflectionDriver();
		const { pi, ctx } = install({
			privateInquiry: { service: driver.service } as any,
		});
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		seedAnchor(ctx);
		await pi.commands[0]?.handler("", ctx);
		const operation = await awaitReflectionOperation(driver);
		const notifications = [...ctx.notifications];
		for (let attempt = 0; attempt < invalidAttempts; attempt += 1)
			driver.respond({ write: `invalid private attempt ${attempt}` });
		if (invalidAttempts < 3)
			driver.respond({ write: JSON.stringify(validNoIssue) });
		const result = await settleReflectionOperation(driver);
		assert.equal(
			result?.kind,
			invalidAttempts === 3 ? "decision-failed" : "decision",
		);
		assert.equal(driver.children.length, 1);
		const child = driver.children[0];
		assert.ok(child);
		assert.equal(child.prompts.length, Math.min(invalidAttempts + 1, 3));
		assert.deepEqual(child.fileStates, Array(child.prompts.length).fill("{}"));
		assert.equal(child.disposed, true);
		assert.equal(operation.options.signal?.aborted, false);
		assert.equal(
			pi.messages.filter(({ message }) =>
				/:inquiry(?:-fold)?$/.test(String(message.customType)),
			).length,
			0,
		);
		// The existing bounded per-attempt warning precedes each correction;
		// the third invalid attempt ends with the terminal failure instead.
		const invalid =
			"decision result file does not contain one complete JSON object";
		const retries = Array.from(
			{ length: Math.min(invalidAttempts, 2) },
			(_, index) =>
				`Reflection attempt ${index + 1}/3 invalid: ${invalid}; retrying.`,
		);
		assert.deepEqual(
			ctx.notifications,
			invalidAttempts === 3
				? [...notifications, ...retries, `Reflection failed: ${invalid}.`]
				: [...notifications, ...retries],
		);
		assert.equal(hooks.length, invalidAttempts === 3 ? 0 : 1);
		assert.equal(
			continuationMessages(pi).length,
			invalidAttempts === 3 ? 0 : 1,
		);
		assert.equal(
			pi.entries.filter(({ customType }) =>
				/:reflection(?:-completed)?$/.test(customType),
			).length,
			invalidAttempts === 3 ? 0 : 2,
		);
		const projected = await pi.emit(
			"context",
			{
				messages: pi.messages.map(({ message }) => ({
					role: "custom",
					...message,
					timestamp: 1,
				})),
			},
			ctx,
		);
		assert.doesNotMatch(
			JSON.stringify(projected),
			/invalid private attempt|private_inquiry_result_file|result\.json/,
		);
		if (invalidAttempts === 3) assert.deepEqual(projected.messages, []);
		await pi.emit("session_shutdown", {}, ctx);
	});

for (const type of ["ROUTE_CORRECTION", "NO_ISSUE"] as const)
	for (const trigger of ["automatic", "busy-manual", "idle-manual"] as const)
		test(`${trigger} ${type} resumes once with a trigger-specific report`, async () => {
			const origin = trigger === "automatic" ? "automatic" : "manual";
			const args = reflectionArguments({
				type,
				nextStep: "wait for the existing callback",
			});
			const driver = createReflectionDriver();
			const { pi, ctx, domain } = install({
				limits:
					origin === "automatic"
						? { rootLoopLimit: 2, allLoopLimit: 100 }
						: undefined,
				privateInquiry: { service: driver.service } as any,
			});
			const hooks = captureReflectionHooks(pi);
			await pi.emit("session_start", {}, ctx);
			seedAnchor(ctx);
			driver.respond({ write: JSON.stringify(args) });
			if (origin === "manual") {
				if (trigger === "busy-manual") {
					ctx.setIdle(false);
					await pi.emit("agent_start", {}, ctx);
				}
				await pi.commands[0]?.handler("check clarified request", ctx);
				if (trigger === "busy-manual") {
					await awaitReflectionOperation(driver);
					assert.ok(
						driver.operations.length === 1,
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
			await awaitReflectionOperation(driver);
			await settleReflectionOperation(driver);
			ctx.setIdle(true);
			await pi.emit("agent_settled", {}, ctx);

			// Private reflections write no main-thread inquiry chain; the
			// continuation marker carries the validated `private` source.
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
			assert.ok(continuation);
			assert.equal(
				pi.messages.filter(({ message }) =>
					String(message.customType ?? "").endsWith(":inquiry"),
				).length,
				0,
				"private reflection leaves no main-thread inquiry messages",
			);
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
				{ role: "custom", ...continuation.message, timestamp: 2 },
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
				assert.equal((report[0] as any).provider, "fixture-provider");
				assert.equal((report[0] as any).model, "fixture-model");
				assert.equal(
					(report[0] as any).responseId,
					"private-child-1-response-1",
				);
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
			// The seeded replay anchor is ordinary prior work: the domain
			// charges it at the first post-reflection refresh, so automatic
			// shows its two crossing turns + the anchor and manual shows the
			// anchor alone.
			assert.equal(writesBefore, origin === "automatic" ? 3 : 1);
			// Persist the durable entries + the continuation marker into the
			// branch the same way reload would — the private source travels
			// inside the marker's own details, not a main-thread chain.
			ctx.setBranch([
				...ctx.sessionManager.getBranch(),
				...pi.entries.map((entry, index) => ({
					type: "custom",
					id: `stored-${index}`,
					parentId: null,
					timestamp: "2026-09-08T00:00:00.000Z",
					...entry,
				})),
				{
					type: "custom-message",
					id: "stored-continuation",
					parentId: null,
					timestamp: "2026-09-08T00:00:01.000Z",
					customType: continuation.message.customType,
					content: continuation.message.content,
					display: continuation.message.display,
					details: continuation.message.details,
				},
			]);
			ctx.setIdle(false);
			await pi.emit("agent_start", {}, ctx);
			await pi.emit(
				"message_start",
				{ message: { role: "custom", ...continuation.message } },
				ctx,
			);
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
				0,
				"private reflection writes no inquiry messages on resume",
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
		const driver = createReflectionDriver();
		const { pi, ctx } = install({
			limits: { rootLoopLimit: 1, allLoopLimit: 100 },
			privateInquiry: { service: driver.service } as any,
		});
		await pi.emit("session_start", {}, ctx);
		seedAnchor(ctx);
		driver.respond({ write: JSON.stringify(validNoIssue) });
		if (origin === "manual") await pi.commands[0]?.handler("", ctx);
		else {
			ctx.setIdle(false);
			await pi.emit("agent_start", {}, ctx);
			await pi.emit("turn_end", turnEnd("stop"), ctx);
		}
		await awaitReflectionOperation(driver);
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
					messages: [{ role: "custom", ...message, timestamp: 1 }],
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
		await settleReflectionOperation(driver);
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
	const privateCorrelation = {
		version: 1,
		namespace: "pi-reflect-watchdog",
		inquiryId: "private-ok",
		attempt: 1,
	};
	const privateSource = {
		sessionId: "child-session-1",
		api: "openai-completions",
		provider: "fixture",
		model: "fixture-model",
		responseId: "child-response",
		// Correlation binding: the embedded source must equal the marker
		// correlation exactly (coordinator cec7d649).
		inquiryId: "private-ok",
		attempt: 1,
		timestamp: 99,
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const privateReport = "Reflection · NO_ISSUE\nReason: private handoff";
	const privateMarker = (origin: string, report: string, source: unknown) => ({
		role: "custom",
		customType: "pi-reflect-watchdog:continuation",
		content: "[assistant]\ncontinue",
		display: true,
		details: {
			version: 1,
			origin,
			report,
			correlation: privateCorrelation,
			private: source,
		},
		timestamp: 42,
	});
	const withPrivate = [
		...messages,
		privateMarker("automatic", privateReport, privateSource),
	];
	const privateResult = await pi.emit(
		"context",
		{ messages: withPrivate },
		ctx,
	);
	const projected = privateResult.messages.at(-2) as any;
	assert.equal(projected?.role, "assistant");
	assert.equal(providerMessageTextForRuntime(projected), privateReport);
	assert.equal(projected.responseId, "child-response");
	assert.equal(projected.provider, "fixture");
	assert.equal(projected.model, "fixture-model");
	// Real provider-adapter serialization: the projected assistant must
	// survive an actual pi-ai message conversion, not only passthrough.
	const serialized = convertCompletionsMessages(
		{
			id: "m",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://example.invalid/v1",
			input: ["text"],
		} as any,
		{ messages: [projected] } as any,
		{ thinkingFormat: "openai" } as any,
		undefined,
	);
	assert.deepEqual(serialized, [{ role: "assistant", content: privateReport }]);
	const manualPrivate = await pi.emit(
		"context",
		{
			messages: [
				...messages,
				privateMarker("manual", privateReport, privateSource),
			],
		},
		ctx,
	);
	assert.equal(manualPrivate.messages.at(-2)?.role, "user");
	assert.equal(
		providerMessageTextForRuntime(manualPrivate.messages.at(-2)),
		privateReport,
	);
	for (const bad of [
		privateMarker("automatic", "bare bool must not project", true),
		privateMarker("automatic", "missing fields must not project", {
			sessionId: "x",
		}),
		privateMarker("automatic", "bad usage must not project", {
			...privateSource,
			usage: { input: -1 },
		}),
		privateMarker("automatic", "bad stop reason must not project", {
			...privateSource,
			stopReason: "aborted",
		}),
	]) {
		const rejected = await pi.emit("context", { messages: [bad] }, ctx);
		assert.equal(
			rejected.messages.some(
				(message: any) =>
					message.role !== "custom" &&
					providerMessageTextForRuntime(message).includes("must not project"),
			),
			false,
		);
	}
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
	const restoredDriver = createReflectionDriver();
	const restored = install({
		privateInquiry: { service: restoredDriver.service } as any,
	});
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
	// Existing version-1 storage remains usable independently of new markers:
	// a fresh private reflection sees the legacy report in its prompt
	// (the prior durable reflection entry feeds the historical section).
	restored.ctx.setBranch([entries[0]]);
	restoredDriver.respond({ write: JSON.stringify(validNoIssue) });
	await restored.pi.commands[0]?.handler("", restored.ctx);
	await awaitReflectionOperation(restoredDriver);
	await settleReflectionOperation(restoredDriver);
	const privatePrompts = restoredDriver.children[0]?.prompts ?? [];
	assert.equal(privatePrompts.length > 0, true);
	assert.match(
		privatePrompts[0] ?? "",
		/legacy version-1 report/,
		"legacy version-1 durable report reaches the private prompt",
	);
});

test("incomplete persisted handoffs omit reports rather than guessing an origin or source", async () => {
	for (const origin of ["automatic", "manual"] as const) {
		const { pi, ctx, messages, result } = await reflectionHandoff(origin);
		// The private handoff is exactly one marker carrying the validated
		// `private` source — corrupting or dropping any part of it must
		// reject the projection rather than guess a report source.
		const marker = messages[0];
		const details = marker.details;
		const malformed = [
			{ details: undefined },
			{ details: { ...details, version: 2 } },
			{ details: { ...details, origin: undefined } },
			{ details: { ...details, origin: "guessed" } },
			{ details: { ...details, correlation: undefined } },
			// A present-but-invalid `private` key rejects the whole marker —
			// no legacy fallthrough, no bare flag accepted.
			{ details: { ...details, private: true } },
			{ details: { ...details, private: { provider: "fixture" } } },
			{ details: { ...details, private: undefined } },
			...[
				{ version: 2 },
				{ namespace: "other" },
				// inquiryId "missing" is a syntactically valid identifier: the
				// private marker is self-contained — there is no legacy chain
				// to contradict it, so it still projects. "bad id" stays
				// malformed (fails the identifier pattern).
				{ inquiryId: "bad id" },
				{ attempt: 0 },
				// attempt 2 is legal private-path metadata: a later attempt's
				// marker is a valid handoff, not corruption (the legacy
				// single-attempt chain bound is gone).
			].map((patch) => ({
				details: {
					...details,
					correlation: { ...details.correlation, ...patch },
				},
			})),
			{ customType: "other:continuation" },
			{ content: "[assistant]\ncontinue\n" },
		];
		const contexts = malformed.map((patch) => [{ ...marker, ...patch }]);
		// A marker stripped of its `private` source entirely also cannot
		// project (there is no legacy chain to back it).
		contexts.push([
			{
				...marker,
				details: Object.fromEntries(
					Object.entries(details).filter(([key]) => key !== "private"),
				),
			},
		]);
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

test("private source binding requires exact marker-correlation match", async () => {
	for (const origin of ["automatic", "manual"] as const) {
		const { pi, ctx, messages, result } = await reflectionHandoff(origin);
		const marker = messages[0];
		const details = marker.details;
		const source = details.private;
		assert.ok(source, "handoff carries the validated private source");
		const validAlternate = {
			details: {
				...details,
				correlation: {
					...details.correlation,
					inquiryId: "bound-alt-1",
					attempt: 2,
				},
				private: {
					...source,
					inquiryId: "bound-alt-1",
					attempt: 2,
				},
			},
		};
		const tamperedMarkerId = {
			details: {
				...details,
				correlation: {
					...details.correlation,
					inquiryId: "tampered",
				},
			},
		};
		const tamperedMarkerAttempt = {
			details: {
				...details,
				correlation: {
					...details.correlation,
					attempt: details.correlation.attempt + 1,
				},
			},
		};
		const tamperedSourceId = {
			details: {
				...details,
				private: { ...source, inquiryId: "forged" },
			},
		};
		const tamperedSourceAttempt = {
			details: {
				...details,
				private: { ...source, attempt: source.attempt + 7 },
			},
		};
		const project = async (patched: Record<string, unknown>) => {
			const projected = await pi.emit(
				"context",
				{ messages: [{ ...marker, ...patched }] },
				ctx,
			);
			return convertToLlm(projected.messages).some(
				(message) => providerMessageTextForRuntime(message) === result.report,
			);
		};
		assert.equal(
			await project(validAlternate),
			true,
			"syntactically valid matching alternatives still project",
		);
		assert.equal(
			await project(tamperedMarkerId),
			false,
			"tampered marker inquiryId rejects",
		);
		assert.equal(
			await project(tamperedMarkerAttempt),
			false,
			"tampered marker attempt rejects",
		);
		assert.equal(
			await project(tamperedSourceId),
			false,
			"tampered source inquiryId rejects",
		);
		assert.equal(
			await project(tamperedSourceAttempt),
			false,
			"tampered source attempt rejects",
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
			// Private reflections leave no inquiry tool-call chain for the
			// summary to serialize — the report must simply not appear.
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
		// The private continuation marker carries its own validated source —
		// compaction at the marker boundary retains the marker, so the
		// report still projects (the legacy chain no longer exists to be
		// destroyed). What compaction must NOT do is replay or re-project
		// beyond the retained boundary: exactly one report, one wake.
		const projectedReports = convertToLlm(projected.messages).filter(
			(message) =>
				providerMessageTextForRuntime(message) === handoff.result.report,
		);
		assert.equal(
			projectedReports.length,
			1,
			"the retained private marker still projects its own report",
		);
		assert.equal(
			projectedReports[0]?.role,
			origin === "automatic" ? "assistant" : "user",
		);
		// Coordinator cec7d649: the marker retained post-boundary projects
		// the same report body/role/order as equivalent content — but a
		// marker EXCLUDED by a deeper compaction boundary must never
		// resurrect from durable storage.
		const lastEntry = session.getEntries().at(-1);
		session.appendCompaction("deeper summary", lastEntry?.id ?? marker.id, 200);
		handoff.ctx.setBranch(session.getBranch());
		const deeperRetained = session.buildSessionContext().messages;
		const deeperProjected = await handoff.pi.emit(
			"context",
			{ messages: deeperRetained },
			handoff.ctx,
		);
		assert.equal(
			convertToLlm(deeperProjected.messages).some(
				(message) =>
					providerMessageTextForRuntime(message) === handoff.result.report,
			),
			false,
			"a marker excluded by the compaction boundary never resurrects",
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
			// The private child's own terminal assistant carries real provider
			// metadata plus opaque thinking/signature blocks — the sanitize
			// gate must strip them before the marker, and the wire assertion
			// is non-vacuous because they exist in the source.
			const handoff = await reflectionHandoff(origin, validNoIssue, {
				assistantMeta: {
					api,
					provider: model.provider,
					model: model.id,
					responseId: "original-reflection-response-id",
				},
				assistantOpaqueContent: [
					{
						type: "thinking",
						thinking: "private reflection thought",
						thinkingSignature: "private signature",
					},
					{
						type: "text",
						text: "private file /var/tmp/pi-reflect-inquiry/result.json",
					},
				],
			});
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
					/private reflection thought|private signature|msg_original_reflection|original-reflection-response-id|pi-reflect-inquiry|result\.json/,
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
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("", ctx);
	await awaitReflectionOperation(driver);
	await settleReflectionOperation(driver);

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

	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("", ctx);
	await awaitReflectionOperation(driver);
	// Wait for the second child's first prompt — the prompt carries the
	// historical reflection forward as its leading reference.
	for (
		let turn = 0;
		turn < 2000 && (driver.children[1]?.prompts.length ?? 0) === 0;
		turn += 1
	)
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	const prompt = driver.children[1]?.prompts[0] ?? "";
	const previous = prompt.indexOf(data.report);
	const current = prompt.indexOf("[Plugin-generated reflection context]");
	assert.ok(previous >= 0, "latest valid branch reflection must be included");
	assert.ok(
		previous < current,
		"previous reflection must precede current context",
	);
	assert.doesNotMatch(prompt, /poison/);
	await settleReflectionOperation(driver);
});

// Retired triage #63: missing full source fails closed; an optional file
// locator is not a substitute for, or a requirement of, a qualified anchor.
test("manual reflection requires a qualified source but not an optional history locator", async () => {
	for (const withLeaf of [false, true]) {
		const ctx = context("root", { sessionFile: undefined });
		if (withLeaf) seedAnchor(ctx);
		const driver = createReflectionDriver();
		const { pi } = install({
			ctx,
			privateInquiry: { service: driver.service } as any,
		});
		const hooks = captureReflectionHooks(pi);
		await pi.emit("session_start", {}, ctx);
		if (!withLeaf)
			assert.throws(() => captureAnchor(ctx.sessionManager), {
				reason: "no-replayable-anchor",
			});
		driver.respond({ write: JSON.stringify(validNoIssue) });
		await pi.commands[0]?.handler("", ctx);
		if (withLeaf) {
			await awaitReflectionOperation(driver);
			assert.equal((await settleReflectionOperation(driver))?.kind, "decision");
			assert.equal(driver.forkInputs[0]?.anchorId, "seed");
			assert.equal(driver.forkInputs[0]?.parent, ctx.sessionManager);
			assert.equal(hooks.length, 1);
		} else {
			await flushAsync();
			assert.equal(driver.operations.length, 0);
			assert.equal(driver.children.length, 0);
			assert.equal(pi.messages.length, 0);
			assert.equal(hooks.length, 0);
		}
		await pi.emit("session_shutdown", {}, ctx);
	}
});

test("queued second reflection dispatches after completed evidence is visible", async () => {
	const ctx = context("root", { sessionFile: "/missing/queued-session.jsonl" });
	const driver = createReflectionDriver();
	const { pi } = install({
		ctx,
		privateInquiry: { service: driver.service } as any,
	});
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
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("first supplement", ctx);
	await awaitReflectionOperation(driver);
	await pi.commands[0]?.handler("second supplement", ctx);
	const queuedAtLeaf = ctx.sessionManager.getLeafId();
	await settleReflectionOperation(driver);

	// The waiting explicit request fulfills at the first run's drain — the
	// second operation's own child prompt carries the second supplement.
	assert.equal(
		driver.operations.length,
		2,
		"queued second reflection launched after the first settled",
	);
	assert.match(driver.children[1]?.prompts[0] ?? "", /Reason: sound/);
	assert.match(driver.children[1]?.prompts[0] ?? "", /second supplement/);
	assert.notEqual(ctx.sessionManager.getLeafId(), queuedAtLeaf);
	// The locator anchors at dispatch time — after the first run's
	// durable entries landed (saved-N ids), not at the queued leaf.
	assert.ok(
		driver.children[1]?.prompts[0]?.includes(
			`"sessionFile":"${ctx.sessionManager.getSessionFile()}"`,
		),
		"history locator carries the qualified parent session file",
	);
	assert.notEqual(
		queuedAtLeaf,
		ctx.sessionManager.getLeafId(),
		"dispatch anchor differs from the queued-at leaf",
	);
	assert.doesNotMatch(
		driver.children[1]?.prompts[0] ?? "",
		new RegExp(`"branchLeafId":"${queuedAtLeaf}"`),
		"locator does not reuse the queued-at leaf",
	);
	assert.doesNotMatch(
		JSON.stringify(pi.entries),
		/historyLocator|sessionFile|branchLeafId/,
	);
	assert.equal(hooks.length, 1);
	assert.deepEqual(pi.actions.slice(-4), [
		"entry:pi-reflect-watchdog:reflection",
		"entry:pi-reflect-watchdog:reflection-completed",
		"hook:reflection-completed",
		"continuation",
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
	const rootDriver = createReflectionDriver();
	const observerDriver = createReflectionDriver();
	const root = install({
		hub,
		domain,
		ctx: context("root", { hasUI: true }),
		privateInquiry: { service: rootDriver.service } as any,
	});
	const observer = install({
		hub,
		domain,
		ctx: context("observer", { hasUI: false }),
		privateInquiry: { service: observerDriver.service } as any,
	});
	await root.pi.emit("session_start", {}, root.ctx);
	await observer.pi.emit("session_start", {}, observer.ctx);
	await root.pi.emit("session_shutdown", {}, root.ctx);
	await root.pi.commands[0]?.handler("old owner", root.ctx);
	assert.equal(root.pi.messages.length, 0);
	seedAnchor(observer.ctx);
	observerDriver.respond({ write: JSON.stringify(validNoIssue) });
	await observer.pi.commands[0]?.handler("new owner", observer.ctx);
	await awaitReflectionOperation(observerDriver);
	await settleReflectionOperation(observerDriver);
	assert.match(
		observerDriver.children[0]?.prompts[0] ?? "",
		/new owner/,
		"the reclaiming observer's private child receives the request",
	);
});

test("reflection tool budget and history hint stay shared across result attempts", async () => {
	const ctx = context("root", { sessionFile: "/missing/retry-session.jsonl" });
	ctx.setBranch([ordinaryLoop("initial-anchor")]);
	const driver = createReflectionDriver();
	const { pi } = install({
		ctx,
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify({ ...validNoIssue, reason: 42 }) });
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("", ctx);
	await awaitReflectionOperation(driver);
	await settleReflectionOperation(driver);
	const child = driver.children[0];
	assert.ok(child);
	const initialPrompt = child.prompts[0] ?? "";
	assert.match(
		initialPrompt,
		/share one budget of \d+ executed evidence calls/,
		"the initial prompt states the shared evidence budget",
	);
	assert.match(
		initialPrompt,
		/History locator \(JSON data/,
		"the initial prompt carries the history hint",
	);
	assert.equal(
		child.prompts.length,
		2,
		"one invalid attempt produced exactly one same-child re-ask",
	);
	assert.match(
		child.prompts[1] ?? "",
		/The same evidence-call budget remains in force/,
		"the correction prompt keeps the shared budget in force",
	);
	// The same-child correction chain does not re-issue the history
	// locator; the budget and file path travel with the re-ask.
	assert.match(child.prompts[1] ?? "", /private_inquiry_result_file/);
	assert.equal(
		continuationMessages(pi).length,
		1,
		"the corrected attempt completes the reflection",
	);
});

// Retired triage #68–69: no trigger-time native slot; ordinary parent progress
// and settlement leave a same-ancestry private child current until its result.
for (const settleParent of [false, true])
	test(`background manual reflection publishes only its result (${settleParent ? "parent settled" : "parent busy"})`, async () => {
		const driver = createReflectionDriver();
		const { pi, ctx } = install({
			privateInquiry: { service: driver.service } as any,
		});
		await pi.emit("session_start", {}, ctx);
		seedAnchor(ctx);
		ctx.setIdle(false);
		await pi.emit("agent_start", {}, ctx);
		ctx.setPendingMessages(true);
		await pi.commands[0]?.handler("queued supplement", ctx);
		const operation = await awaitReflectionOperation(driver);
		for (let turn = 0; turn < 2000 && !driver.awaitingResponse; turn += 1)
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		assert.equal(driver.awaitingResponse, true);
		assert.match(driver.children[0]?.prompts[0] ?? "", /queued supplement/);
		assert.equal(pi.messages.length, 0, "no trigger-time native traffic");
		assert.equal(runtimeQueuedState(pi, ctx), false);
		assert.equal(
			await pi.emit("message_end", assistant("ordinary work in progress"), ctx),
			undefined,
		);
		await pi.emit("turn_end", turnEnd("stop"), ctx);
		if (settleParent) {
			ctx.setIdle(true);
			ctx.setPendingMessages(false);
			await pi.emit("agent_settled", {}, ctx);
			await pi.emit("agent_settled", {}, ctx);
		}
		assert.equal(operation.options.signal?.aborted, false);
		assert.equal(driver.operations.length, 1);
		assert.equal(pi.messages.length, 0);
		driver.respond({ write: JSON.stringify(validNoIssue) });
		assert.equal((await settleReflectionOperation(driver))?.kind, "decision");
		assert.equal(continuationMessages(pi).length, 1);
		assert.deepEqual(continuationMessages(pi)[0]?.options, {
			triggerTurn: true,
			deliverAs: "steer",
		});
		assert.equal(
			pi.entries.filter(({ customType }) =>
				/:reflection(?:-completed)?$/.test(customType),
			).length,
			2,
		);
		await pi.emit("session_shutdown", {}, ctx);
	});

test("duplicate /reflect behind an outstanding inquiry coalesces and keeps the first supplement", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("initial request", ctx);
	await awaitReflectionOperation(driver);
	await pi.commands[0]?.handler("first supplement", ctx);
	await pi.commands[0]?.handler("second supplement", ctx);
	assert.ok(
		ctx.notifications.includes("A reflection is already queued."),
		"duplicate invocation is reported",
	);
	await settleReflectionOperation(driver);
	assert.equal(
		driver.operations.length,
		2,
		"waiting request dispatches after completion",
	);
	assert.match(driver.children[1]?.prompts[0] ?? "", /first supplement/);
	assert.doesNotMatch(
		driver.children[1]?.prompts[0] ?? "",
		/second supplement/,
	);
});

test("/cancel-reflect discards a plugin-pending request behind an outstanding inquiry", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("initial request", ctx);
	await awaitReflectionOperation(driver);
	await pi.commands[0]?.handler("withdrawn", ctx);
	await pi.commands[1]?.handler("", ctx);
	assert.ok(ctx.notifications.includes("Queued reflection cancelled."));
	await settleReflectionOperation(driver);
	assert.equal(
		driver.operations.length,
		1,
		"cancelled request never launches; the outstanding one completes",
	);
	assert.equal(driver.children[0]?.prompts.length, 1);
});

test("/cancel-reflect with empty queue no-ops and never touches an active reflection", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	await pi.commands[1]?.handler("", ctx);
	assert.ok(ctx.notifications.includes("No queued reflection to cancel."));
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("active run", ctx);
	await awaitReflectionOperation(driver);
	await pi.commands[1]?.handler("", ctx);
	assert.equal(
		ctx.notifications.filter(
			(message) => message === "No queued reflection to cancel.",
		).length,
		2,
		"cancel with an active reflection and empty queue stays a no-op",
	);
	const result = await settleReflectionOperation(driver);
	assert.equal(
		result?.kind,
		"decision",
		"the active reflection completes unaffected",
	);
	assert.equal(
		driver.operations[0]?.options.signal?.aborted,
		false,
		"cancel never aborted the active operation",
	);
});

test("cancel shortcut registers from config and cancels; false disables registration", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	assert.equal(pi.shortcuts.length, 1);
	assert.equal(pi.shortcuts[0]?.key, "alt+x");
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("initial request", ctx);
	await awaitReflectionOperation(driver);
	await pi.commands[0]?.handler("shortcut target", ctx);
	await pi.shortcuts[0]?.handler(ctx);
	assert.ok(ctx.notifications.includes("Queued reflection cancelled."));
	await settleReflectionOperation(driver);
	assert.equal(
		driver.operations.length,
		1,
		"cancelled waiting request never launches",
	);

	const disabledDriver = createReflectionDriver();
	const disabled = install({
		limits: { cancelShortcut: false },
		privateInquiry: { service: disabledDriver.service } as any,
	});
	await disabled.pi.emit("session_start", {}, disabled.ctx);
	assert.equal(
		disabled.pi.shortcuts.length,
		0,
		"false disables shortcut registration",
	);
	seedAnchor(disabled.ctx);
	disabledDriver.respond({ write: JSON.stringify(validNoIssue) });
	await disabled.pi.commands[0]?.handler("initial request", disabled.ctx);
	await awaitReflectionOperation(disabledDriver);
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
	await settleReflectionOperation(disabledDriver);
	assert.equal(disabledDriver.operations.length, 1);
});

test("queued state surfaces in the status text and clears on dispatch and cancel", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("initial request", ctx);
	await awaitReflectionOperation(driver);
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
	await settleReflectionOperation(driver);
	assert.equal(
		driver.operations.length,
		2,
		"waiting request dispatches after finalization",
	);
	assert.doesNotMatch(
		ctx.statuses.filter(Boolean).at(-1) ?? "",
		/queued/,
		"status clears on dispatch",
	);
});

test("queued manual reflection is discarded on session shutdown", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	await pi.commands[0]?.handler("initial request", ctx);
	await awaitReflectionOperation(driver);
	await pi.commands[0]?.handler("doomed", ctx);
	await pi.emit("session_shutdown", {}, ctx);
	// The shutdown aborts the parked active child and drops the queue;
	// the drained settle must never dispatch the doomed request.
	for (let turn = 0; turn < 2000 && !driver.operations[0]?.settled; turn += 1)
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	assert.equal(
		driver.operations.length,
		1,
		"no further launch after the session is torn down",
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

async function startIdleEscapeReflection() {
	const driver = createReflectionDriver();
	const ctx = context("escape-root", { mode: "tui" });
	const { pi } = install({
		ctx,
		privateInquiry: { service: driver.service } as any,
	});
	const hooks = captureReflectionHooks(pi);
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	await pi.commands[0]?.handler("first", ctx);
	const operation = await awaitReflectionOperation(driver);
	for (let turn = 0; turn < 2000 && !driver.awaitingResponse; turn += 1)
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	assert.equal(driver.awaitingResponse, true);
	return { driver, ctx, pi, hooks, operation };
}

for (const mainBusy of [false, true])
	test(`real B-to-runtime fresh child completion steers ${mainBusy ? "busy" : "idle"} main; repair never sends`, async () => {
		const driver = createReflectionDriver();
		const hub = createObservableAgentHub();
		const domain = liveDomain();
		const main = install({
			hub,
			domain,
			ctx: context("live-main"),
			limits: { allLoopLimit: 1, rootLoopLimit: 60 },
			privateInquiry: { service: driver.service } as any,
		});
		const child = install({
			hub,
			domain,
			ctx: context("live-child", { hasUI: false }),
			privateInquiry: { service: createReflectionDriver().service } as any,
		});
		await main.pi.emit("session_start", {}, main.ctx);
		await child.pi.emit("session_start", {}, child.ctx);
		seedAnchor(main.ctx);
		main.ctx.setIdle(!mainBusy);
		await main.pi.emit("agent_start", {}, main.ctx);
		main.pi.sendMessage(
			{ customType: "unrelated", content: "earlier steering" },
			{ deliverAs: "steer", triggerTurn: true },
		);
		const seedLoops = domain.counters()?.allLoops.value ?? 0n;
		child.ctx.setIdle(false);
		await child.pi.emit("agent_start", {}, child.ctx);
		child.ctx.setBranch([ordinaryLoop("child-fresh")]);
		// Ordinary public observations can count before the whole tool batch ends.
		await child.pi.emit("session_compact", {}, child.ctx);
		assert.equal(domain.counters()?.allLoops.value, seedLoops + 1n);
		assert.equal(driver.operations.length, 0);
		await main.pi.emit("agent_settled", {}, main.ctx);
		assert.equal(driver.operations.length, 0);
		const event = {
			message: child.ctx.sessionManager.getBranch()[0].message,
			messageEntryId: "child-fresh",
			toolResultEntryIds: [],
		};
		await child.pi.emit("turn_end", event, child.ctx);
		const operation = await awaitReflectionOperation(driver);
		// The private run's child prompt carries the counter snapshot — no
		// main-transport inquiry message ever leaves the runtime.
		for (
			let turn = 0;
			turn < 2000 && (driver.children[0]?.prompts.length ?? 0) < 1;
			turn += 1
		)
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		const prompt = driver.children[0]?.prompts[0] ?? "";
		// Seed anchor loop + the fresh child loop; exact numerator and limit.
		assert.match(prompt, /all=2\/1\b/);
		assert.equal(
			main.pi.messages.filter(({ message }) =>
				String(message.customType ?? "").endsWith(":inquiry"),
			).length,
			0,
			"private path sends no inquiry message",
		);
		assert.equal(main.pi.messages[0]?.message.customType, "unrelated");
		await child.pi.emit("turn_end", event, child.ctx);
		await main.pi.emit("agent_settled", {}, main.ctx);
		assert.equal(
			driver.operations.length,
			1,
			"duplicate and settlement do not launch another run",
		);
		assert.equal(operation.options.signal?.aborted, false);
		assert.equal(domain.counters()?.rootLoops.value, 0n);
		await child.pi.emit("session_shutdown", {}, child.ctx);
		await main.pi.emit("session_shutdown", {}, main.ctx);
	});

test("real held child completion remains counted; withdrawal/synthetic input/navigation cannot release; explicit input resets before release", async () => {
	let now = 0;
	const domain = liveDomain(() => now),
		hub = createObservableAgentHub();
	const driver = createReflectionDriver();
	const main = install({
		hub,
		domain,
		ctx: context("held-main"),
		limits: { allLoopLimit: 1 },
		privateInquiry: { service: driver.service } as any,
	});
	const child = install({
		hub,
		domain,
		ctx: context("held-child", { hasUI: false }),
		privateInquiry: { service: createReflectionDriver().service } as any,
	});
	await main.pi.emit("session_start", {}, main.ctx);
	await child.pi.emit("session_start", {}, child.ctx);
	main.ctx.setBranch([
		branchMessage({ role: "user", content: "task" }, "root-user"),
	]);
	main.ctx.setIdle(false);
	await main.pi.emit("agent_start", {}, main.ctx);
	main.ctx.setBranch([
		...main.ctx.sessionManager.getBranch(),
		ordinaryLoop("main-abort", "aborted"),
	]);
	main.ctx.setIdle(true);
	await main.pi.emit("agent_settled", {}, main.ctx);
	child.ctx.setIdle(false);
	await child.pi.emit("agent_start", {}, child.ctx);
	now = 2500;
	await child.pi.emit("turn_end", turnEnd("stop"), child.ctx);
	assert.equal(domain.counters()?.allLoops.value, 1n);
	assert.equal(domain.counters()?.activeMs.value, 2500n);
	const heldOperations = 0;
	assert.equal(
		driver.operations.length,
		heldOperations,
		"held completion never admits a reflection",
	);
	assert.equal(continuationMessages(main.pi).length, 0);
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
	assert.equal(
		driver.operations.length,
		heldOperations,
		"withdrawal, synthetic input and navigation never release the hold",
	);
	assert.equal(continuationMessages(main.pi).length, 0);
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
	assert.equal(
		driver.operations.length,
		heldOperations,
		"reset/release is not itself a trigger",
	);
	assert.equal(resetObservations.at(-1), 0n);
	await child.pi.emit("turn_end", turnEnd("stop"), child.ctx);
	await awaitReflectionOperation(driver);
	assert.equal(
		driver.operations.length,
		1,
		"fresh post-reentry child completion wakes main",
	);
	unsubscribe();
	await child.pi.emit("session_shutdown", {}, child.ctx);
	await main.pi.emit("session_shutdown", {}, main.ctx);
});

test("real final main turn uses fresh OR snapshot, finalized tools, reserved authority and no deferred outstanding decision", async () => {
	let now = 0;
	const domain = liveDomain(() => now);
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		domain,
		limits: { rootLoopLimit: 1, allLoopLimit: 1, taskMinutes: 1 },
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	for (let index = 1; index <= 60; index++) {
		now = index * 1000;
		await pi.emit("session_compact", {}, ctx);
	}
	assert.equal(driver.operations.length, 0, "clock observations never send");
	const reply = ordinaryLoop("final-tool").message;
	ctx.setBranch([
		...ctx.sessionManager.getBranch(),
		branchMessage(reply, "final-tool"),
	]);
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
		driver.operations.length,
		0,
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
	const operation = await awaitReflectionOperation(driver);
	for (
		let turn = 0;
		turn < 2000 && (driver.children[0]?.prompts.length ?? 0) < 1;
		turn += 1
	)
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	const prompt = driver.children[0]?.prompts[0] ?? "";
	assert.match(
		prompt,
		/Trigger source\(s\): ROOT_LOOP_LIMIT, ALL_LOOP_LIMIT, TASK_TIME_LIMIT\n/,
	);
	assert.equal(driver.operations.length, 1);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	for (let turn = 0; turn < 2000 && !operation.settled; turn += 1)
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	await flushAsync();
	assert.equal(continuationMessages(pi).length, 1);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(
		driver.operations.length,
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
		ctx = context("cadence"),
		driver = createReflectionDriver();
	createWatchdogExtension({
		hub: createObservableAgentHub(),
		processDomain: domain,
		privateInquiry: driver.service,
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
	seedAnchor(ctx);
	await pi.commands[0]?.handler("", ctx);
	await awaitReflectionOperation(driver);
	// The refresh ticker is scheduled once the private child's working
	// period makes the session officially busy.
	for (let turn = 0; turn < 2000 && timers.length < 1; turn += 1)
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
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
	// Only the seeded anchor's own loop counts — the reflection's busy
	// clocks never add ordinary loops.
	assert.equal(domain.counters()?.rootLoops.value, 1n);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	// The cadence timer belongs to the busy window — once the private
	// run completes, the ticker is cleared and never rescheduled.
	driver.respond({ write: JSON.stringify(validNoIssue) });
	for (
		let turn = 0;
		turn < 2000 && timers.at(-1)?.cancelled !== true;
		turn += 1
	)
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
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
				const driver = createReflectionDriver();
				const main = install({
					hub,
					domain,
					limits: { allLoopLimit: 1 },
					privateInquiry: { service: driver.service } as any,
				});
				const child = install({
					hub,
					domain,
					ctx: context("abort-clock-child", { hasUI: false }),
				});
				await main.pi.emit("session_start", {}, main.ctx);
				await child.pi.emit("session_start", {}, child.ctx);
				const hooks = captureReflectionHooks(main.pi);
				if (inquiry) seedAnchor(main.ctx);
				main.ctx.setIdle(false);
				await main.pi.emit("agent_start", {}, main.ctx);
				if (inquiry) {
					await main.pi.commands[0]?.handler("cancel clock inquiry", main.ctx);
					await awaitReflectionOperation(driver);
					for (let turn = 0; turn < 2000 && !driver.awaitingResponse; turn += 1)
						await new Promise<void>((resolve) => setTimeout(resolve, 1));
					assert.equal(
						driver.awaitingResponse,
						true,
						"private child is working before abort",
					);
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
				if (inquiry) {
					const result = await settleReflectionOperation(driver);
					assert.equal(result?.kind, "cancelled");
				}
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
					driver.operations.length,
					inquiry ? 1 : 0,
					"private run count survives abort settlement",
				);
				assert.equal(
					main.pi.messages.filter(({ message }) =>
						String(message.customType ?? "").endsWith(":inquiry"),
					).length,
					0,
					"no inquiry message exists in the private path",
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
		const driver = createReflectionDriver();
		const { pi, ctx } = install({
			domain,
			limits: { rootLoopLimit: 100 },
			privateInquiry: { service: driver.service } as any,
		});
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
				driver.operations.length,
				0,
				"adoption never authorizes reflection",
			);
		}
		await pi.emit("session_shutdown", {}, ctx);
	});

// Coordinator af337239 — manual-only fulfillment conditions: identity-bound
// queue, stale drop, empty-queue silence, at-most-once, cancel isolation.

test("ownership loss makes the queued manual request silently stale", async () => {
	const hub = createObservableAgentHub();
	const domain = new FakeDomain();
	const driver = createReflectionDriver();
	const root = install({
		hub,
		domain,
		privateInquiry: { service: driver.service } as any,
		ctx: context("root", { hasUI: false }),
	});
	await root.pi.emit("session_start", {}, root.ctx);
	seedAnchor(root.ctx);
	// Active run + queued manual behind it.
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await root.pi.commands[0]?.handler("active", root.ctx);
	await awaitReflectionOperation(driver);
	await root.pi.commands[0]?.handler("queued behind active", root.ctx);
	// Another attachment claims main: the pending entry's admission identity
	// no longer matches — settlement drops it silently.
	const owner = install({
		hub,
		domain,
		ctx: context("owner", { hasUI: true }),
	});
	await owner.pi.emit("session_start", {}, owner.ctx);
	const notificationsBeforeSettle = [...root.ctx.notifications];
	await settleReflectionOperation(driver);
	assert.equal(driver.operations.length, 1, "stale queue never launches");
	assert.deepEqual(
		root.ctx.notifications.slice(notificationsBeforeSettle.length),
		[],
		"no warning for the silently dropped queued request",
	);
});

test("provider failure drains with an empty queue: no launch, no counters", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx, domain } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	driver.respond({ throw: new Error("provider down") });
	await pi.commands[0]?.handler("", ctx);
	await awaitReflectionOperation(driver);
	// Quiesce the command's takeover accounting BEFORE the snapshot: the
	// settle-triggered domain refresh must see a fully drained branch so
	// the drain window contains no deferred charge.
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	await flushAsync();
	const counters = domain.counters();
	const root = counters.rootLoops.value;
	const all = counters.allLoops.value;
	const entries = pi.entries.length;
	const result = await settleReflectionOperation(driver);
	assert.equal(result?.kind, "execution-error");
	assert.equal(driver.operations.length, 1, "empty queue never relaunches");
	assert.equal(domain.counters().rootLoops.value, root);
	assert.equal(domain.counters().allLoops.value, all);
	assert.equal(continuationMessages(pi).length, 0);
	assert.equal(pi.entries.length, entries, "failure drain writes no entries");
});

test("stale valid candidate after revoke drains silently", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx, domain } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("", ctx);
	await awaitReflectionOperation(driver);
	// Revoke mid-flight: the decision's source/authority is dead even
	// though a valid file settles.
	await pi.emit("input", { source: "rpc", text: "user" }, ctx);
	// Quiesce the takeover's own accounting BEFORE the snapshot — the
	// revoke is the real external takeover and must not leak into the
	// drain window under test.
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	await flushAsync();
	const counters = domain.counters();
	const root = counters.rootLoops.value;
	const all = counters.allLoops.value;
	const entries = pi.entries.length;
	const result = await settleReflectionOperation(driver);
	assert.equal(result?.kind, "cancelled");
	assert.equal(driver.operations.length, 1, "stale outcome launches nothing");
	assert.equal(domain.counters().rootLoops.value, root);
	assert.equal(domain.counters().allLoops.value, all);
	assert.equal(continuationMessages(pi).length, 0);
	assert.equal(pi.entries.length, entries, "stale candidate writes no entries");
});

test("true cancellation drain leaves an empty queue silent", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx, domain } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	// No reply scripted: the child parks until the abort releases it.
	await pi.commands[0]?.handler("", ctx);
	const operation = await awaitReflectionOperation(driver);
	await pi.emit("session_shutdown", {}, ctx);
	await flushAsync();
	const counters = domain.counters();
	const root = counters.rootLoops.value;
	const all = counters.allLoops.value;
	for (let attempt = 0; attempt < 2000 && !operation.settled; attempt += 1)
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	assert.equal(operation.settled, true);
	assert.equal((await operation.result)?.kind, "cancelled");
	assert.equal(driver.operations.length, 1);
	assert.equal(domain.counters().rootLoops.value, root);
	assert.equal(domain.counters().allLoops.value, all);
	assert.equal(continuationMessages(pi).length, 0);
	assert.equal(pi.entries.length, 0);
});

test("manual queue fulfillment happens at most once per drain", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("first", ctx);
	await pi.commands[0]?.handler("second", ctx);
	await awaitReflectionOperation(driver);
	await settleReflectionOperation(driver);
	assert.equal(driver.operations.length, 2, "queued second launched once");
	// Settle the second operation deterministically — its own drain must
	// not re-dispatch anything, and no third run may appear after a
	// duplicate release/settlement window.
	driver.respond({ write: JSON.stringify(validNoIssue) });
	const second = driver.operations.at(1);
	assert.ok(second, "second operation started");
	for (let turn = 0; turn < 2000 && !second.settled; turn += 1) {
		if (driver.awaitingResponse)
			throw new Error("second child parked unscripted");
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	await flushAsync();
	assert.equal(
		driver.operations.length,
		2,
		"no repeat dispatch from the drained release",
	);
});

test("/cancel-reflect withdraws the pending entry and never aborts the active child", async () => {
	const driver = createReflectionDriver();
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	await pi.commands[0]?.handler("active run", ctx);
	const operation = await awaitReflectionOperation(driver);
	await pi.commands[0]?.handler("withdrawn", ctx);
	await pi.commands[1]?.handler("", ctx);
	assert.ok(ctx.notifications.includes("Queued reflection cancelled."));
	assert.equal(
		operation.options.signal?.aborted,
		false,
		"cancel never touches the active child's signal",
	);
	const result = await settleReflectionOperation(driver);
	assert.equal(
		result?.kind,
		"decision",
		"the active run settles its decision — cancel never aborted it",
	);
	assert.equal(
		driver.operations.length,
		1,
		"the withdrawn request never launches",
	);
	assert.equal(continuationMessages(pi).length, 1);
});

test("non-settling host prompt keeps the revoked slot held without overlap", async () => {
	const driver = createReflectionDriver();
	const baseCreateRuntime = driver.service.createRuntime;
	let releasePrompt!: () => void;
	const stuck = new Promise<void>((resolve) => {
		releasePrompt = resolve;
	});
	let reportSettled!: () => void;
	const childSettled = new Promise<void>((resolve) => {
		reportSettled = resolve;
	});
	driver.service.createRuntime = async () => {
		const runtime = await baseCreateRuntime();
		return {
			...runtime,
			async fork(input) {
				const child = await runtime.fork(input);
				child.subscribe?.((event: unknown) => {
					if ((event as { type?: string }).type === "agent_settled")
						reportSettled();
				});
				return new Proxy(child, {
					get(target, property) {
						if (property === "prompt")
							return async (text: string) => {
								try {
									await target.prompt(text);
								} finally {
									await stuck;
								}
							};
						return Reflect.get(target, property, target);
					},
				});
			},
		};
	};
	const { pi, ctx } = install({
		privateInquiry: { service: driver.service } as any,
	});
	await pi.emit("session_start", {}, ctx);
	seedAnchor(ctx);
	try {
		await pi.commands[0]?.handler("uncooperative child", ctx);
		const operation = await awaitReflectionOperation(driver);
		for (let turn = 0; turn < 2000 && !driver.awaitingResponse; turn += 1)
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		assert.equal(driver.awaitingResponse, true);
		await pi.emit("input", { source: "interactive", text: "take over" }, ctx);
		await childSettled;
		await flushAsync();
		assert.equal(operation.options.signal?.aborted, true);
		// Cooperative liveness: an event cannot prove the prompt promise drained.
		assert.equal(operation.settled, false);
		await pi.commands[0]?.handler("queued behind stuck child", ctx);
		await flushAsync();
		assert.equal(
			driver.operations.length,
			1,
			"never overlap a child whose prompt has not drained",
		);
		assert.equal(pi.messages.length, 0);
		assert.equal(
			pi.entries.some(({ customType }) =>
				/:reflection(?:-completed)?$/.test(customType),
			),
			false,
		);
	} finally {
		releasePrompt();
		await settleReflectionOperation(driver);
		await pi.emit("session_shutdown", {}, ctx);
	}
});

test("idle owned Escape aborts only the exact private child and retires queued manual work", async () => {
	const { driver, ctx, pi, hooks, operation } =
		await startIdleEscapeReflection();
	await pi.commands[0]?.handler("queued before escape", ctx);
	const notifications = ctx.notifications.length;
	assert.equal(ctx.pressKey("x"), false, "other keys pass through");
	assert.equal(ctx.pressKey("\x1b"), true);
	assert.equal(operation.options.signal?.aborted, true);
	assert.equal(
		ctx.pressKey("\x1b"),
		false,
		"repeat Escape is consumed at most once",
	);
	assert.equal((await settleReflectionOperation(driver))?.kind, "cancelled");
	assert.equal(driver.children[0]?.aborted, true);
	assert.equal(
		driver.operations.length,
		1,
		"retired queued request never relaunches",
	);
	assert.equal(runtimeQueuedState(pi, ctx), false);
	assert.deepEqual(hooks, []);
	assert.equal(pi.messages.length, 0);
	assert.equal(
		pi.entries.some(({ customType }) =>
			/:reflection(?:-completed)?$/.test(customType),
		),
		false,
	);
	assert.ok(
		ctx.notifications.length <= notifications + 1,
		"at most one quiet notice",
	);
	await pi.emit("session_shutdown", {}, ctx);
	assert.equal(ctx.terminalInputs.size, 0, "listener disposed on shutdown");
});

test("idle Escape is consumed after main events arrive with fresh host contexts", async () => {
	const { driver, ctx, pi, operation } = await startIdleEscapeReflection();
	// Real Pi builds a new context object for every event.
	const eventCtx = Object.create(ctx);
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, eventCtx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, eventCtx);
	assert.equal(ctx.pressKey("\x1b"), true);
	assert.equal(operation.options.signal?.aborted, true);
	assert.equal((await settleReflectionOperation(driver))?.kind, "cancelled");
	await pi.emit("session_shutdown", {}, ctx);
});

test("busy main Escape passes through without touching the private child", async () => {
	const { driver, ctx, pi, operation } = await startIdleEscapeReflection();
	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	assert.equal(ctx.pressKey("\x1b"), false);
	assert.equal(operation.options.signal?.aborted, false);
	driver.respond({ write: JSON.stringify(validNoIssue) });
	assert.equal((await settleReflectionOperation(driver))?.kind, "decision");
	ctx.setIdle(true);
	assert.equal(
		ctx.pressKey("\x1b"),
		false,
		"Escape after the work ends passes through",
	);
	await pi.emit("session_shutdown", {}, ctx);
});

test("Escape listener is replaced on session replacement", async () => {
	const { driver, ctx, pi, operation } = await startIdleEscapeReflection();
	const next = context("escape-next", { mode: "tui" });
	await pi.emit("session_start", { reason: "new" }, next);
	assert.equal(ctx.terminalInputs.size, 0, "old session listener disposed");
	assert.equal(operation.options.signal?.aborted, true);
	await settleReflectionOperation(driver);
	await pi.emit("session_shutdown", {}, next);
	assert.equal(next.terminalInputs.size, 0);
});
