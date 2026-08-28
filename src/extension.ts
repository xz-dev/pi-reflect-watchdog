import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageEndEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { probePiAgentState } from "pi-extension-utils/pi-agent-state";
import {
	createInquiryRuntime,
	foldInquiryContext,
	type InquiryAttemptHandle,
	type InquiryRuntime,
} from "pi-extension-utils/pi-inquiry";
import { BUILT_IN_CONFIG, type WatchdogConfig } from "./config.js";
import { type LoadedConfig, loadRuntimeConfig } from "./config-loader.js";
import { createFatalExitAdapter, type FatalExitAdapter } from "./fatal-exit.js";
import {
	createHubAttachmentInstance,
	getProcessObservableAgentHub,
	type HubAttachment,
	type HubMainClaim,
	type ObservableAgentHub,
} from "./hub.js";
import {
	getReflectDomainCoordinator,
	isReflectDomainFatalError,
	type ReflectDomainCoordinator,
	type ReflectDomainCounters,
} from "./process-domain.js";
import {
	buildReflectionPrompt,
	buildReflectionReaskPrompt,
	MAX_REFLECTION_REASKS,
	MAX_REFLECTION_TOOL_CALLS,
	parseReflectionXml,
	type ReflectionDecision,
	type ReflectionThresholdSnapshot,
	type ReflectionTriggerReason,
} from "./reflection-protocol.js";
import {
	createWatchdogWidget,
	formatDuration,
	WIDGET_KEY,
	type WidgetState,
} from "./widget.js";

const STATUS_KEY = "pi-reflect-watchdog";
const REFLECT_COMMAND = "reflect";
const REFLECTION_INQUIRY_NAMESPACE = "pi-reflect-watchdog";
const REFLECTION_MESSAGE_TYPE = `${REFLECTION_INQUIRY_NAMESPACE}:inquiry`;
const ACTIVE_TICK_MS = 1_000;
const RPC_STATUS_TICK_MS = 30_000;

type Timer = ReturnType<typeof setTimeout>;
type TimerRole = "tui-refresh" | "rpc-status";
type InternalRun =
	| { readonly kind: "none" }
	| { readonly kind: "provisional" | "confirmed"; readonly attempt: number };

interface UninterruptibleMessageEndAPI {
	on(
		event: "message_end",
		handler: (
			event: MessageEndEvent,
			ctx: ExtensionContext,
		) => { readonly message: MessageEndEvent["message"] } | undefined,
		options: { readonly uninterruptible: true },
	): void;
}

export interface RuntimeServices {
	now(): number;
	setTimeout(callback: () => void, delay: number): Timer;
	clearTimeout(timer: Timer): void;
	loadConfig(cwd: string, trusted: boolean): Promise<LoadedConfig>;
	processDomain: ReflectDomainCoordinator;
	fatalExit: FatalExitAdapter;
	scheduleTimer?(role: TimerRole, callback: () => void, delay: number): Timer;
}

const defaultServices: RuntimeServices = {
	now: () => Date.now(),
	setTimeout: (callback, delay) => setTimeout(callback, delay),
	clearTimeout: (timer) => clearTimeout(timer),
	loadConfig: loadRuntimeConfig,
	processDomain: getReflectDomainCoordinator(),
	fatalExit: createFatalExitAdapter(),
};

interface PendingReflection {
	readonly id: number;
	readonly reasons: ReflectionTriggerReason[];
	readonly thresholds: ReflectionThresholdSnapshot;
	readonly userSupplement?: string;
	readonly timestamp: string;
}

interface ActiveReflection extends PendingReflection {
	attempt: number;
	toolCalls: number;
	readonly inquiry: InquiryRuntime;
	handle: InquiryAttemptHandle;
	planned?: ReflectionDecision | { readonly error: string };
}

interface Runtime {
	readonly pi: ExtensionAPI;
	readonly hub: ObservableAgentHub;
	readonly processDomain: ReflectDomainCoordinator;
	readonly attachmentInstance: object;
	attachment: HubAttachment | null;
	claim: HubMainClaim | null;
	ctx: ExtensionContext | null;
	config: WatchdogConfig;
	configReady: boolean;
	stopped: boolean;
	domainAttached: boolean;
	domainFatal: boolean;
	localBusy: boolean;
	latestCounters?: ReflectDomainCounters;
	latched: Set<Exclude<ReflectionTriggerReason, "USER_REQUEST">>;
	pendingAutomatic?: PendingReflection;
	manualQueue: PendingReflection[];
	activeReflection?: ActiveReflection;
	internalRun: InternalRun;
	reflectionSequence: number;
	ticker?: Timer;
	widgetTui: { requestRender(): void } | null;
	widgetRegistered: boolean;
	unsubscribeHub?: () => void;
	unsubscribeDomain?: () => void;
}

function scheduleTimer(
	services: RuntimeServices,
	role: TimerRole,
	callback: () => void,
	delay: number,
): Timer {
	return (
		services.scheduleTimer?.(role, callback, delay) ??
		services.setTimeout(callback, delay)
	);
}

function localTimestamp(): string {
	const date = new Date();
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const pad = (value: number): string =>
		String(Math.abs(value)).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

function owns(runtime: Runtime): boolean {
	return (
		!runtime.stopped &&
		runtime.processDomain.rootProcess &&
		runtime.claim !== null &&
		runtime.hub.isCurrentMain(runtime.claim)
	);
}

function currentCounters(runtime: Runtime): ReflectDomainCounters | undefined {
	return runtime.processDomain.counters() ?? runtime.latestCounters;
}

function safeNumber(value: bigint | undefined): number {
	if (value === undefined || value <= 0n) return 0;
	return Number(
		value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : value,
	);
}

function thresholdSnapshot(runtime: Runtime): ReflectionThresholdSnapshot {
	const counters = currentCounters(runtime);
	return {
		activeMs: safeNumber(counters?.activeMs.value),
		activeLoops: safeNumber(counters?.activeLoops.value),
		taskMs: safeNumber(counters?.taskMs.value),
		taskMinutes: runtime.config.taskMinutes,
		rootLoops: safeNumber(counters?.rootLoops.value),
		rootLoopLimit: runtime.config.rootLoopLimit,
		allLoops: safeNumber(counters?.allLoops.value),
		allLoopLimit: runtime.config.allLoopLimit,
	};
}

function crossedReasons(
	runtime: Runtime,
): Exclude<ReflectionTriggerReason, "USER_REQUEST">[] {
	const snapshot = thresholdSnapshot(runtime);
	const reasons: Exclude<ReflectionTriggerReason, "USER_REQUEST">[] = [];
	if (snapshot.rootLoops >= runtime.config.rootLoopLimit)
		reasons.push("ROOT_LOOP_LIMIT");
	if (snapshot.allLoops >= runtime.config.allLoopLimit)
		reasons.push("ALL_LOOP_LIMIT");
	if (snapshot.taskMs >= runtime.config.taskMinutes * 60_000)
		reasons.push("TASK_TIME_LIMIT");
	return reasons.filter((reason) => !runtime.latched.has(reason));
}

function latchAutomaticReflection(runtime: Runtime): void {
	if (!owns(runtime) || !runtime.configReady) return;
	const reasons = crossedReasons(runtime);
	if (reasons.length === 0) return;
	for (const reason of reasons) runtime.latched.add(reason);
	if (runtime.pendingAutomatic !== undefined) {
		for (const reason of reasons)
			if (!runtime.pendingAutomatic.reasons.includes(reason))
				runtime.pendingAutomatic.reasons.push(reason);
		return;
	}
	runtime.reflectionSequence += 1;
	runtime.pendingAutomatic = {
		id: runtime.reflectionSequence,
		reasons: [...reasons],
		thresholds: thresholdSnapshot(runtime),
		timestamp: localTimestamp(),
	};
}

function statusState(runtime: Runtime): WidgetState {
	const counters = currentCounters(runtime);
	return {
		activity: {
			active: counters?.anyBusy ?? false,
			elapsedMs: safeNumber(counters?.activeMs.value),
			loops: safeNumber(counters?.activeLoops.value),
		},
		taskElapsedMs: safeNumber(counters?.taskMs.value),
		taskMinutes: runtime.config.taskMinutes,
		rootLoops: safeNumber(counters?.rootLoops.value),
		rootLoopLimit: runtime.config.rootLoopLimit,
		allLoops: safeNumber(counters?.allLoops.value),
		allLoopLimit: runtime.config.allLoopLimit,
	};
}

function statusText(runtime: Runtime): string {
	const state = statusState(runtime);
	return `Reflect Watchdog | active ${formatDuration(state.activity.elapsedMs)}/${state.activity.loops} loops · task ${formatDuration(state.taskElapsedMs)}/${state.taskMinutes}m · root ${state.rootLoops}/${state.rootLoopLimit} · all ${state.allLoops}/${state.allLoopLimit}`;
}

function refreshWidget(runtime: Runtime): void {
	if (!owns(runtime) || runtime.ctx === null) return;
	if (runtime.ctx.mode === "rpc") {
		runtime.ctx.ui.setStatus(STATUS_KEY, statusText(runtime));
		return;
	}
	if (runtime.ctx.mode !== "tui") return;
	if (!runtime.widgetRegistered) {
		runtime.ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				runtime.widgetTui = tui;
				return createWatchdogWidget(theme, () => statusState(runtime));
			},
			{ placement: "belowEditor" },
		);
		runtime.widgetRegistered = true;
		runtime.ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	runtime.widgetTui?.requestRender();
}

function clearWidget(runtime: Runtime): void {
	const ctx = runtime.ctx;
	if (ctx !== null && runtime.widgetRegistered && ctx.mode === "tui") {
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// Stale session cleanup may reject UI mutation.
		}
	}
	runtime.widgetRegistered = false;
	runtime.widgetTui = null;
	ctx?.ui.setStatus(STATUS_KEY, undefined);
}

function scheduleRefresh(runtime: Runtime, services: RuntimeServices): void {
	if (runtime.ticker !== undefined) services.clearTimeout(runtime.ticker);
	runtime.ticker = undefined;
	if (
		!owns(runtime) ||
		runtime.ctx === null ||
		!currentCounters(runtime)?.anyBusy
	)
		return;
	const role: TimerRole =
		runtime.ctx.mode === "tui" ? "tui-refresh" : "rpc-status";
	const delay = role === "tui-refresh" ? ACTIVE_TICK_MS : RPC_STATUS_TICK_MS;
	runtime.ticker = scheduleTimer(
		services,
		role,
		() => {
			runtime.ticker = undefined;
			refreshWidget(runtime);
			scheduleRefresh(runtime, services);
		},
		delay,
	);
	runtime.ticker.unref?.();
}

function safeToDispatch(runtime: Runtime): boolean {
	if (
		!owns(runtime) ||
		runtime.ctx === null ||
		runtime.activeReflection !== undefined
	)
		return false;
	const piState = probePiAgentState(runtime.ctx);
	const counters = currentCounters(runtime);
	const localCountsAsBusy =
		runtime.localBusy && runtime.internalRun.kind === "none";
	const sameProcessOthersBusy = Math.max(
		0,
		runtime.hub.snapshot.busyCount - (localCountsAsBusy ? 1 : 0),
	);
	const crossProcessOthersBusy = counters?.otherBusy === true;
	return (
		!piState.pendingMessages &&
		sameProcessOthersBusy === 0 &&
		!crossProcessOthersBusy &&
		counters?.certain === true &&
		(piState.idle || localCountsAsBusy)
	);
}

function sendActiveReflection(runtime: Runtime, prompt: string): void {
	const active = runtime.activeReflection;
	if (active === undefined || !owns(runtime)) return;
	active.handle = active.inquiry.attempt(active.attempt);
	if (!active.handle.markSent()) return;
	active.inquiry.send(runtime.pi, prompt, active.attempt);
}

function beginReflection(runtime: Runtime, pending: PendingReflection): void {
	const inquiry = createInquiryRuntime(REFLECTION_INQUIRY_NAMESPACE, {
		inquiryId: `reflection-${pending.id}`,
	});
	runtime.activeReflection = {
		...pending,
		attempt: 1,
		toolCalls: 0,
		inquiry,
		handle: inquiry.attempt(1),
	};
	runtime.internalRun = { kind: "provisional", attempt: 1 };
	sendActiveReflection(
		runtime,
		buildReflectionPrompt({
			semanticPrefix: runtime.config.reflectionPrompt,
			timestamp: pending.timestamp,
			reasons: pending.reasons,
			thresholds: pending.thresholds,
			userSupplement: pending.userSupplement,
		}),
	);
}

function maybeDispatch(runtime: Runtime): void {
	if (!safeToDispatch(runtime)) return;
	const manual = runtime.manualQueue.shift();
	if (manual !== undefined) {
		beginReflection(runtime, manual);
		return;
	}
	const automatic = runtime.pendingAutomatic;
	if (automatic === undefined) return;
	runtime.pendingAutomatic = undefined;
	runtime.latched.clear();
	void runtime.processDomain.resetReminderCycle().catch(() => {});
	beginReflection(runtime, automatic);
}

function queueManualReflection(runtime: Runtime, supplement?: string): void {
	if (!owns(runtime)) return;
	runtime.reflectionSequence += 1;
	runtime.manualQueue.push({
		id: runtime.reflectionSequence,
		reasons: ["USER_REQUEST"],
		thresholds: thresholdSnapshot(runtime),
		userSupplement: supplement,
		timestamp: localTimestamp(),
	});
	maybeDispatch(runtime);
}

function finishReflection(
	runtime: Runtime,
	decision?: ReflectionDecision,
): void {
	const active = runtime.activeReflection;
	if (active === undefined) return;
	runtime.activeReflection = undefined;
	runtime.internalRun = { kind: "none" };
	if (runtime.ctx !== null) observe(runtime, runtime.ctx);
	if (decision?.type === "ROUTE_CORRECTION") {
		runtime.pi.sendMessage(
			{
				customType: `${REFLECTION_MESSAGE_TYPE}:correction`,
				content: [
					`Reflect watchdog correction: ${decision.reason}`,
					`Done: ${decision.done}`,
					`Current step: ${decision.currentStep}`,
					`Next step: ${decision.nextStep}`,
				].join("\n"),
				display: true,
				details: { timestamp: active.timestamp, decision },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	} else if (decision !== undefined && runtime.ctx?.mode === "tui") {
		runtime.ctx.ui.notify(`Reflect watchdog: ${decision.reason}`, "info");
	}
	maybeDispatch(runtime);
}

function observe(runtime: Runtime, ctx: ExtensionContext): void {
	if (runtime.stopped || runtime.attachment === null) return;
	const internal = runtime.internalRun.kind !== "none";
	runtime.localBusy = probePiAgentState(ctx).busy;
	const ordinaryBusy = runtime.localBusy && !internal;
	if (ordinaryBusy) runtime.hub.markBusy(runtime.attachment);
	else runtime.hub.markIdle(runtime.attachment);
	void runtime.processDomain
		.setBusy(runtime.attachmentInstance, ordinaryBusy)
		.catch(() => {});
	refreshWidget(runtime);
}

function commandIsCurrent(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): boolean {
	return (
		owns(runtime) &&
		runtime.ctx !== null &&
		runtime.ctx.sessionManager === ctx.sessionManager
	);
}

function isSuccessfulTurn(event: TurnEndEvent): boolean {
	return (
		event.message.role === "assistant" &&
		(event.message.stopReason === "stop" ||
			event.message.stopReason === "toolUse")
	);
}

function syncOwnership(runtime: Runtime, services: RuntimeServices): void {
	if (runtime.stopped || runtime.attachment === null) return;
	if (runtime.hub.snapshot.main === null)
		runtime.hub.reclaimMain(runtime.attachment);
	const nextClaim = runtime.hub.mainClaimFor(runtime.attachment);
	if (runtime.claim !== null && !runtime.hub.isCurrentMain(runtime.claim)) {
		clearWidget(runtime);
		runtime.activeReflection = undefined;
		runtime.internalRun = { kind: "none" };
	}
	runtime.claim = nextClaim;
	if (!owns(runtime)) return;
	latchAutomaticReflection(runtime);
	refreshWidget(runtime);
	scheduleRefresh(runtime, services);
	maybeDispatch(runtime);
}

function shutdownRuntime(runtime: Runtime, services: RuntimeServices): void {
	if (runtime.stopped) return;
	runtime.stopped = true;
	if (runtime.ticker !== undefined) services.clearTimeout(runtime.ticker);
	runtime.ticker = undefined;
	clearWidget(runtime);
	runtime.unsubscribeHub?.();
	runtime.unsubscribeDomain?.();
	const attachment = runtime.attachment;
	if (attachment !== null) runtime.hub.detach(attachment);
	runtime.attachment = null;
	runtime.claim = null;
	runtime.ctx = null;
	runtime.activeReflection = undefined;
	runtime.manualQueue = [];
	runtime.pendingAutomatic = undefined;
	if (runtime.domainAttached) {
		runtime.domainAttached = false;
		void runtime.processDomain
			.detach(runtime.attachmentInstance)
			.catch(() => {});
	}
}

export interface WatchdogExtensionOptions {
	readonly hub?: ObservableAgentHub;
	readonly processDomain?: ReflectDomainCoordinator;
	readonly services?: Partial<RuntimeServices>;
}

export function createWatchdogExtension(
	overrides: Partial<RuntimeServices> | WatchdogExtensionOptions = {},
): (pi: ExtensionAPI) => void {
	const structured =
		"services" in overrides ||
		"hub" in overrides ||
		"processDomain" in overrides;
	const serviceOverrides = structured
		? (overrides as WatchdogExtensionOptions).services
		: (overrides as Partial<RuntimeServices>);
	const services: RuntimeServices = {
		...defaultServices,
		...serviceOverrides,
		processDomain:
			(structured
				? (overrides as WatchdogExtensionOptions).processDomain
				: undefined) ??
			serviceOverrides?.processDomain ??
			defaultServices.processDomain,
	};
	const hub =
		(structured ? (overrides as WatchdogExtensionOptions).hub : undefined) ??
		getProcessObservableAgentHub();

	return (pi) => {
		const runtime: Runtime = {
			pi,
			hub,
			processDomain: services.processDomain,
			attachmentInstance: createHubAttachmentInstance(),
			attachment: null,
			claim: null,
			ctx: null,
			config: { ...BUILT_IN_CONFIG },
			configReady: false,
			stopped: false,
			domainAttached: false,
			domainFatal: false,
			localBusy: false,
			latched: new Set(),
			manualQueue: [],
			internalRun: { kind: "none" },
			reflectionSequence: 0,
			widgetTui: null,
			widgetRegistered: false,
		};

		pi.on("context", (event) => ({
			messages: foldInquiryContext(
				event.messages,
				REFLECTION_INQUIRY_NAMESPACE,
			),
		}));

		pi.registerCommand(REFLECT_COMMAND, {
			description:
				"Queue an immediate reflection with optional user supplement",
			handler: async (args, ctx) => {
				if (!commandIsCurrent(runtime, ctx)) return;
				queueManualReflection(runtime, args.trim() || undefined);
				ctx.ui.notify("Reflection queued.", "info");
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			if (runtime.ctx !== null || runtime.stopped) return;
			runtime.ctx = ctx;
			runtime.localBusy = probePiAgentState(ctx).busy;
			try {
				await runtime.processDomain.attach(runtime.attachmentInstance, {
					getBusy: () => {
						if (runtime.ctx === null) return false;
						return (
							probePiAgentState(runtime.ctx).busy &&
							runtime.internalRun.kind === "none"
						);
					},
					onFatal: (error) => {
						if (!isReflectDomainFatalError(error)) return;
						runtime.domainFatal = true;
						services.fatalExit.fail(error, ctx);
					},
				});
				runtime.domainAttached = true;
			} catch (error) {
				runtime.domainFatal = true;
				services.fatalExit.fail(
					error instanceof Error ? error : new Error("process domain failed"),
					ctx,
				);
				return;
			}
			const bound = hub.bind({
				instance: runtime.attachmentInstance,
				sessionId: ctx.sessionManager.getSessionId(),
				hasUI: ctx.hasUI,
				initialBusy: runtime.localBusy,
			});
			runtime.attachment = bound.attachment;
			runtime.claim = hub.mainClaimFor(bound.attachment);
			runtime.unsubscribeHub = hub.subscribe(() =>
				syncOwnership(runtime, services),
			);
			runtime.unsubscribeDomain = runtime.processDomain.subscribe(
				(counters) => {
					runtime.latestCounters = counters;
					latchAutomaticReflection(runtime);
					refreshWidget(runtime);
					scheduleRefresh(runtime, services);
					maybeDispatch(runtime);
				},
			);
			const loaded = await services.loadConfig(ctx.cwd, ctx.isProjectTrusted());
			if (runtime.stopped || runtime.ctx !== ctx) return;
			runtime.config = loaded.config;
			runtime.processDomain.setIdleResetGapSeconds(
				runtime.config.idleResetGapSeconds,
			);
			runtime.configReady = true;
			for (const diagnostic of loaded.diagnostics.slice(0, 3))
				ctx.ui.notify(
					`pi-reflect-watchdog ${diagnostic.source}: ${diagnostic.message}`,
					"warning",
				);
			syncOwnership(runtime, services);
		});

		pi.on("agent_start", (_event, ctx) => {
			const active = runtime.activeReflection;
			if (active !== undefined && runtime.internalRun.kind !== "confirmed") {
				runtime.internalRun = {
					kind: "provisional",
					attempt: active.attempt,
				};
			}
			observe(runtime, ctx);
		});

		pi.on("message_start", (event, ctx) => {
			const active = runtime.activeReflection;
			if (active?.handle.matchesPrompt(event.message)) {
				runtime.internalRun = { kind: "confirmed", attempt: active.attempt };
				observe(runtime, ctx);
			}
		});

		pi.on("tool_call", () => {
			const active = runtime.activeReflection;
			if (active === undefined || runtime.internalRun.kind !== "confirmed")
				return;
			if (active.toolCalls >= MAX_REFLECTION_TOOL_CALLS)
				return {
					block: true,
					reason: "Reflection tool-call budget exhausted.",
				};
			active.toolCalls += 1;
		});

		const handleMessageEnd = (event: MessageEndEvent) => {
			const active = runtime.activeReflection;
			if (active === undefined) return;
			// Only a run whose inquiry prompt was confirmed via message_start may
			// capture an assistant. A provisional internal run shares the turn
			// with ordinary work and must never claim its assistant replies.
			if (
				runtime.internalRun.kind !== "confirmed" ||
				runtime.internalRun.attempt !== active.attempt
			)
				return;
			const text = active.handle.capture(event.message);
			if (text === null) return;
			const validation = parseReflectionXml(text);
			active.planned = validation.valid
				? validation.decision
				: { error: validation.error };
			// Keep the provider's original stopReason. Synthesizing "aborted"
			// here would leak this plugin's internal lifecycle into the global
			// abort semantics other extensions legitimately observe.
			return {
				message: active.handle.neutralize(event.message),
			};
		};
		(pi as ExtensionAPI & Partial<UninterruptibleMessageEndAPI>).on(
			"message_end",
			handleMessageEnd,
			{ uninterruptible: true },
		);

		pi.on("turn_end", async (event) => {
			if (!isSuccessfulTurn(event) || runtime.internalRun.kind !== "none")
				return;
			if (owns(runtime)) await runtime.processDomain.recordRootLoop();
			else await runtime.processDomain.recordAllLoop();
			latchAutomaticReflection(runtime);
			refreshWidget(runtime);
		});

		pi.on("agent_end", () => {});
		pi.on("agent_settled", (_event, ctx) => {
			observe(runtime, ctx);
			const active = runtime.activeReflection;
			if (active !== undefined && runtime.internalRun.kind !== "none") {
				const planned = active.planned;
				runtime.internalRun = { kind: "none" };
				if (planned !== undefined && "error" in planned) {
					if (active.attempt < MAX_REFLECTION_REASKS) {
						const fold = active.handle.complete();
						if (fold !== null)
							pi.sendMessage(fold, {
								deliverAs: "steer",
								triggerTurn: false,
							});
						active.attempt += 1;
						active.planned = undefined;
						sendActiveReflection(
							runtime,
							buildReflectionReaskPrompt(planned.error),
						);
						return;
					}
					const fold = active.handle.complete();
					if (fold !== null)
						pi.sendMessage(fold, {
							deliverAs: "steer",
							triggerTurn: false,
						});
					runtime.ctx?.ui.notify(
						`Reflection failed: ${planned.error}`,
						"warning",
					);
					finishReflection(runtime);
					return;
				}
				if (planned !== undefined) {
					const fold = active.handle.complete();
					if (fold !== null)
						pi.sendMessage(fold, {
							deliverAs: "steer",
							triggerTurn: false,
						});
					finishReflection(runtime, planned);
					return;
				}
				const fold = active.handle.cancel();
				if (fold !== null)
					pi.sendMessage(fold, {
						deliverAs: "steer",
						triggerTurn: false,
					});
				finishReflection(runtime);
				return;
			}
			latchAutomaticReflection(runtime);
			maybeDispatch(runtime);
		});

		pi.on("session_shutdown", () => {
			shutdownRuntime(runtime, services);
			services.fatalExit.completeShutdown();
		});
	};
}

export default function registerWatchdogExtension(pi: ExtensionAPI): void {
	createWatchdogExtension()(pi);
}
