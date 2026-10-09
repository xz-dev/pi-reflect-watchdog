import type { Static } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	SessionEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Box, type KeyId, Text } from "@earendil-works/pi-tui";
import { probePiAgentState } from "pi-extension-utils/pi-agent-state";
import {
	createInquiryRuntime,
	foldInquiryContext,
	type InquiryAttemptHandle,
	type InquiryRuntime,
} from "pi-extension-utils/pi-inquiry";
import { publishSemanticHook } from "pi-extension-utils/semantic-hook";
import {
	ACCOUNTING_BOUNDARY_ENTRY,
	deriveBranchAccounting,
	isAgentLoopMessage,
	REFLECTION_COMPLETED_ENTRY,
	REFLECTION_INQUIRY_NAMESPACE,
	reflectCooldownState,
} from "./branch-accounting.js";
import { BUILT_IN_CONFIG, type WatchdogConfig } from "./config.js";
import { type LoadedConfig, loadRuntimeConfig } from "./config-loader.js";
import { formatDuration } from "./duration.js";
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
	type ReflectBranchDomainCoordinator,
	type ReflectDomainCounters,
} from "./process-domain.js";
import {
	buildReflectionPrompt,
	buildReflectionReaskPrompt,
	MAX_REFLECTION_REASKS,
	MAX_REFLECTION_TOOL_CALLS,
	parseReflectionArguments,
	prepareReflectionArguments,
	REFLECTION_PARAMETERS,
	REFLECTION_TOOL_NAME,
	type ReflectionDecision,
	type ReflectionThresholdSnapshot,
	type ReflectionTriggerReason,
} from "./reflection-protocol.js";
import {
	createWatchdogWidget,
	formatWidgetText,
	WIDGET_KEY,
	type WidgetState,
} from "./widget.js";

export {
	isAgentLoopMessage,
	reflectCooldownState,
} from "./branch-accounting.js";

const STATUS_KEY = "pi-reflect-watchdog";
const REFLECT_COMMAND = "reflect";
const CANCEL_REFLECT_COMMAND = "cancel-reflect";
const REFLECTION_RESULT_ENTRY = "pi-reflect-watchdog:reflection";
const REFLECTION_COMPLETED_HOOK = "reflection-completed";
const REFLECTION_CONTINUATION = "pi-reflect-watchdog:continuation";
const REFLECTION_CONTINUATION_CONTENT = "[assistant]\ncontinue";
const SEMANTIC_HOOK_TEXT_LIMIT = 4096;
const REFLECT_COOLDOWN_MIN_LOOPS = 10;
const REFLECT_COOLDOWN_MAX_LOOPS = 30;
const ACTIVE_TICK_MS = 1_000;

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
	processDomain: ReflectBranchDomainCoordinator;
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
	readonly toolCallIds: Set<string>;
	readonly inquiry: InquiryRuntime;
	handle: InquiryAttemptHandle;
	responseObserved: boolean;
	planned?: ReflectionDecision | { readonly error: string };
}

interface ReflectionResult {
	readonly version: 1;
	readonly timestamp: string;
	readonly reasons: readonly ReflectionTriggerReason[];
	readonly thresholds: ReflectionThresholdSnapshot;
	readonly userSupplement?: string;
	readonly decision: ReflectionDecision;
	readonly report: string;
}

interface ReflectionContinuationDetails {
	readonly version: 1;
	readonly origin: "automatic" | "manual";
	readonly report: string;
	readonly correlation: InquiryAttemptHandle["correlation"];
}

interface Runtime {
	readonly pi: ExtensionAPI;
	readonly hub: ObservableAgentHub;
	readonly processDomain: ReflectBranchDomainCoordinator;
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
	sessionId: string | null;
	scopeRevision: number;
	manualQueue: PendingReflection[];
	activeReflection?: ActiveReflection;
	internalRun: InternalRun;
	abortBoundaryLeafId?: string | null;
	abortSettlementPending: boolean;
	reflectionSequence: number;
	ticker?: Timer;
	widgetTui: { requestRender(): void } | null;
	widgetRegistered: boolean;
	unsubscribeHub?: () => void;
	unsubscribeDomain?: () => void;
	unsubscribeCompletions?: () => void;
	/** Inquiry ids cancelled by a confirmed abort; exactly-correlated plugin
	 * controls (inquiry prompts and folds) are withheld from model-visible
	 * context. Physical native-queue removal is not claimed. */
	abortedInquiryIds: Set<string>;
	abortedToolCallIds: Set<string>;
	/** Post-abort eligibility hold: only new explicit user input (interactive or
	 * user-client rpc) or a fresh user-invoked /reflect may release it. */
	abortedHold: boolean;
	/** Monotonic event clock for explicit user input; fences a late settlement
	 * from re-holding a cycle the user already re-entered. */
	explicitInputClock: number;
	/** Explicit-input clock at run start; later input survives old cancellation. */
	boundaryInputClock: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameCorrelation(
	left: InquiryAttemptHandle["correlation"],
	right: InquiryAttemptHandle["correlation"],
): boolean {
	return (
		left.version === right.version &&
		left.namespace === right.namespace &&
		left.inquiryId === right.inquiryId &&
		left.attempt === right.attempt
	);
}

function inquiryCorrelation(
	value: unknown,
): InquiryAttemptHandle["correlation"] | null {
	if (!isRecord(value)) return null;
	return value.version === 1 &&
		value.namespace === REFLECTION_INQUIRY_NAMESPACE &&
		typeof value.inquiryId === "string" &&
		/^[A-Za-z0-9_-]{1,128}$/.test(value.inquiryId) &&
		typeof value.attempt === "number" &&
		Number.isSafeInteger(value.attempt) &&
		value.attempt > 0
		? {
				version: 1,
				namespace: REFLECTION_INQUIRY_NAMESPACE,
				inquiryId: value.inquiryId,
				attempt: value.attempt,
			}
		: null;
}

function continuationDetails(
	value: unknown,
): ReflectionContinuationDetails | null {
	if (!isRecord(value)) return null;
	const correlation = inquiryCorrelation(value.correlation);
	return value.version === 1 &&
		(value.origin === "automatic" || value.origin === "manual") &&
		typeof value.report === "string" &&
		value.report.trim().length > 0 &&
		correlation !== null
		? {
				version: 1,
				origin: value.origin,
				report: value.report,
				correlation,
			}
		: null;
}

function messageText(message: Record<string, unknown>): string | null {
	if (typeof message.content === "string") return message.content;
	if (
		Array.isArray(message.content) &&
		message.content.length === 1 &&
		isRecord(message.content[0]) &&
		message.content[0].type === "text" &&
		typeof message.content[0].text === "string"
	)
		return message.content[0].text;
	return null;
}

function continuationProjection<T extends object>(messages: T[]): T[] {
	const projections = new Map<number, T>();
	for (let markerIndex = 0; markerIndex < messages.length; markerIndex += 1) {
		const marker = messages[markerIndex];
		if (!isRecord(marker)) continue;
		const details =
			marker.role === "custom" &&
			marker.customType === REFLECTION_CONTINUATION &&
			messageText(marker) === REFLECTION_CONTINUATION_CONTENT
				? continuationDetails(marker.details)
				: null;
		if (details === null) continue;

		let source: Record<string, unknown> | undefined;
		let completed = false;
		let started = false;
		for (let index = markerIndex - 1; index >= 0; index -= 1) {
			const candidate = messages[index];
			if (!isRecord(candidate)) continue;
			// A previous handoff bounds this segment even when ids are reused.
			if (
				candidate.role === "custom" &&
				candidate.customType === REFLECTION_CONTINUATION
			)
				break;
			if (
				candidate.role === "custom" &&
				candidate.customType ===
					`${REFLECTION_INQUIRY_NAMESPACE}:inquiry-fold` &&
				messageText(candidate) === "" &&
				isRecord(candidate.details) &&
				candidate.details.outcome === "remove"
			) {
				const correlation = inquiryCorrelation(candidate.details);
				if (
					correlation !== null &&
					sameCorrelation(correlation, details.correlation)
				) {
					if (completed) break;
					completed = true;
				}
			}
			if (
				candidate.role === "custom" &&
				candidate.customType === `${REFLECTION_INQUIRY_NAMESPACE}:inquiry`
			) {
				const correlation = inquiryCorrelation(candidate.details);
				if (
					correlation !== null &&
					sameCorrelation(correlation, details.correlation)
				) {
					started =
						source !== undefined &&
						(messageText(candidate)?.trim().length ?? 0) > 0;
					break;
				}
			}
			if (
				candidate.role !== "assistant" ||
				!Array.isArray(candidate.content) ||
				!candidate.content.every(
					(block) =>
						isRecord(block) &&
						(block.type === "toolCall" || block.type === "thinking"),
				) ||
				!isRecord(candidate.details)
			)
				continue;
			const correlation = inquiryCorrelation(candidate.details.piInquiry);
			if (
				completed &&
				source === undefined &&
				correlation !== null &&
				sameCorrelation(correlation, details.correlation)
			) {
				source = candidate;
			}
		}
		if (source === undefined || !started) continue;

		const timestamp = source.timestamp;
		const report =
			details.origin === "automatic"
				? {
						...source,
						content: [{ type: "text", text: details.report }],
						stopReason:
							source.stopReason === "toolUse" ? "stop" : source.stopReason,
						details: Object.fromEntries(
							Object.entries(source.details as Record<string, unknown>).filter(
								([key]) => key !== "piInquiry",
							),
						),
					}
				: {
						role: "user",
						content: [{ type: "text", text: details.report }],
						timestamp,
					};
		projections.set(markerIndex, report as T);
	}
	return projections.size === 0
		? messages
		: messages.flatMap((message, index) => {
				const report = projections.get(index);
				return report === undefined ? [message] : [report, message];
			});
}

function reflectionContext<T extends object>(
	messages: T[],
	abortedInquiryIds: ReadonlySet<string> = new Set(),
): T[] {
	const folded = foldInquiryContext(
		continuationProjection(messages),
		REFLECTION_INQUIRY_NAMESPACE,
	);
	if (abortedInquiryIds.size === 0) return folded;
	const cancelledToolIds = new Set<string>();
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant") continue;
		const correlation = inquiryCorrelation(record(message.details)?.piInquiry);
		if (
			correlation === null ||
			!abortedInquiryIds.has(correlation.inquiryId) ||
			!Array.isArray(message.content)
		)
			continue;
		for (const block of message.content)
			if (
				isRecord(block) &&
				block.type === "toolCall" &&
				typeof block.id === "string"
			)
				cancelledToolIds.add(block.id);
	}
	const retained = folded.filter((message) => {
		if (
			isRecord(message) &&
			message.role === "toolResult" &&
			typeof message.toolCallId === "string" &&
			cancelledToolIds.has(message.toolCallId)
		)
			return false;
		if (isRecord(message) && message.role === "assistant") {
			const correlation = inquiryCorrelation(
				record(message.details)?.piInquiry,
			);
			if (correlation !== null && abortedInquiryIds.has(correlation.inquiryId))
				return false;
		}
		// Withhold only this plugin's exact owned control messages: the inquiry
		// prompt and fold custom types with a matching namespace correlation.
		// Unrelated custom messages sharing no plugin customType stay visible.
		if (!isRecord(message) || message.role !== "custom") return true;
		if (
			message.customType !== `${REFLECTION_INQUIRY_NAMESPACE}:inquiry` &&
			message.customType !== `${REFLECTION_INQUIRY_NAMESPACE}:inquiry-fold`
		)
			return true;
		const correlation = inquiryCorrelation(message.details);
		return (
			correlation === null || !abortedInquiryIds.has(correlation.inquiryId)
		);
	});
	return retained.length === folded.length ? folded : retained;
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

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseReflectionResult(value: unknown): ReflectionResult | undefined {
	const result = record(value);
	const decision = record(result?.decision);
	const thresholds = record(result?.thresholds);
	if (
		result?.version !== 1 ||
		typeof result.timestamp !== "string" ||
		Number.isNaN(Date.parse(result.timestamp)) ||
		!Array.isArray(result.reasons) ||
		result.reasons.length === 0 ||
		!result.reasons.every(
			(reason) =>
				reason === "ROOT_LOOP_LIMIT" ||
				reason === "ALL_LOOP_LIMIT" ||
				reason === "TASK_TIME_LIMIT" ||
				reason === "USER_REQUEST",
		) ||
		thresholds === undefined ||
		![
			"activeMs",
			"activeLoops",
			"taskMs",
			"taskMinutes",
			"rootLoops",
			"rootLoopLimit",
			"allLoops",
			"allLoopLimit",
		].every(
			(key) =>
				typeof thresholds[key] === "number" &&
				Number.isSafeInteger(thresholds[key]) &&
				Number(thresholds[key]) >= 0,
		) ||
		decision === undefined ||
		(decision.type !== "NO_ISSUE" && decision.type !== "ROUTE_CORRECTION") ||
		!["reason", "done", "currentStep", "nextStep"].every(
			(key) =>
				typeof decision[key] === "string" &&
				String(decision[key]).trim().length > 0,
		) ||
		typeof result.report !== "string" ||
		result.report.trim().length === 0 ||
		(result.userSupplement !== undefined &&
			typeof result.userSupplement !== "string")
	)
		return undefined;
	return result as unknown as ReflectionResult;
}

function latestReflection(runtime: Runtime): ReflectionResult | undefined {
	const branch = runtime.ctx?.sessionManager.getBranch() ?? [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (
			entry?.type !== "custom" ||
			entry.customType !== REFLECTION_RESULT_ENTRY
		)
			continue;
		const result = parseReflectionResult(entry.data);
		if (result !== undefined) return result;
	}
	return undefined;
}

function formatReflectionReport(
	active: PendingReflection,
	decision: ReflectionDecision,
): string {
	const supplement = active.userSupplement?.trim();
	return [
		`Reflection · ${decision.type}`,
		`Time: ${active.timestamp}`,
		`Trigger: ${active.reasons.join(", ")}`,
		`Thresholds: active=${formatDuration(active.thresholds.activeMs)}/${active.thresholds.activeLoops} loops; task=${formatDuration(active.thresholds.taskMs)}/${active.thresholds.taskMinutes}m; root=${active.thresholds.rootLoops}/${active.thresholds.rootLoopLimit}; all=${active.thresholds.allLoops}/${active.thresholds.allLoopLimit}`,
		`User supplement: ${supplement ? supplement : "(none)"}`,
		`Reason: ${decision.reason}`,
		`Done: ${decision.done}`,
		`Current step: ${decision.currentStep}`,
		`Next step: ${decision.nextStep}`,
	].join("\n");
}

function reflectionResult(
	active: PendingReflection,
	decision: ReflectionDecision,
): ReflectionResult {
	return {
		version: 1,
		timestamp: active.timestamp,
		reasons: active.reasons,
		thresholds: active.thresholds,
		userSupplement: active.userSupplement,
		decision,
		report: formatReflectionReport(active, decision),
	};
}

function clipSemanticHookText(value: string): string {
	if (value.length <= SEMANTIC_HOOK_TEXT_LIMIT) return value;
	let prefix = "";
	for (const codePoint of value) {
		if (prefix.length + codePoint.length >= SEMANTIC_HOOK_TEXT_LIMIT) break;
		prefix += codePoint;
	}
	return `${prefix}…`;
}

function publishReflectionCompleted(
	runtime: Runtime,
	decision: ReflectionDecision,
): void {
	try {
		publishSemanticHook(runtime.pi.events, {
			name: REFLECTION_COMPLETED_HOOK,
			values: {
				REFLECTION_TYPE: decision.type,
				REASON: clipSemanticHookText(decision.reason),
				NEXT_STEP: clipSemanticHookText(decision.nextStep),
			},
		});
	} catch {}
}

export function reflectCooldownLoops(rootLoopLimit: number): number {
	if (!Number.isFinite(rootLoopLimit)) return REFLECT_COOLDOWN_MAX_LOOPS;
	return Math.min(
		REFLECT_COOLDOWN_MAX_LOOPS,
		Math.max(REFLECT_COOLDOWN_MIN_LOOPS, Math.floor(rootLoopLimit / 3)),
	);
}

function currentCooldown(runtime: Runtime) {
	return reflectCooldownState(
		runtime.ctx?.sessionManager.getBranch() ?? [],
		reflectCooldownLoops(runtime.config.rootLoopLimit),
	);
}

function thresholdSnapshot(
	runtime: Runtime,
	counters = currentCounters(runtime),
): ReflectionThresholdSnapshot {
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

function considerFreshCompletion(
	runtime: Runtime,
	counters: ReflectDomainCounters,
): void {
	if (!owns(runtime) || !runtime.configReady || !safeToDispatch(runtime))
		return;
	const thresholds = thresholdSnapshot(runtime, counters);
	const reasons: Exclude<ReflectionTriggerReason, "USER_REQUEST">[] = [];
	if (thresholds.rootLoops >= runtime.config.rootLoopLimit)
		reasons.push("ROOT_LOOP_LIMIT");
	if (thresholds.allLoops >= runtime.config.allLoopLimit)
		reasons.push("ALL_LOOP_LIMIT");
	if (thresholds.taskMs >= runtime.config.taskMinutes * 60_000)
		reasons.push("TASK_TIME_LIMIT");
	if (reasons.length === 0) return;
	const skip = currentCooldown(runtime).skipAutomatic;
	if (!skip)
		reserveReflection(runtime, {
			id: ++runtime.reflectionSequence,
			reasons,
			thresholds,
			timestamp: localTimestamp(),
		});
	// Reserve first: append/reset can synchronously notify another completion.
	runtime.pi.appendEntry(ACCOUNTING_BOUNDARY_ENTRY, {
		version: 1,
		window: "reminder",
	});
	void runtime.processDomain.resetReminderCycle().catch(() => {});
	if (skip) {
		if (runtime.ctx?.mode === "tui")
			runtime.ctx.ui.notify("Reflect skipped during cooldown.", "info");
		return;
	}
	submitReflection(runtime);
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
		cooldownRemainingLoops: currentCooldown(runtime).remainingLoops,
		queuedCancelLabel:
			runtime.manualQueue.length > 0 ? cancelLabel(runtime) : undefined,
	};
}

function statusText(runtime: Runtime): string {
	return formatWidgetText(statusState(runtime));
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
	if (
		!owns(runtime) ||
		runtime.ctx === null ||
		!currentCounters(runtime)?.anyBusy
	) {
		if (runtime.ticker !== undefined) services.clearTimeout(runtime.ticker);
		runtime.ticker = undefined;
		return;
	}
	if (runtime.ticker !== undefined) return;
	const revision = runtime.scopeRevision;
	runtime.ticker = scheduleTimer(
		services,
		runtime.ctx.mode === "tui" ? "tui-refresh" : "rpc-status",
		() => {
			runtime.ticker = undefined;
			if (runtime.stopped || runtime.scopeRevision !== revision) return;
			void runtime.processDomain
				.refreshBranch(runtime.attachmentInstance)
				.catch(() => {});
			refreshWidget(runtime);
			scheduleRefresh(runtime, services);
		},
		ACTIVE_TICK_MS,
	);
	runtime.ticker.unref?.();
}

function safeToDispatch(runtime: Runtime): boolean {
	return (
		owns(runtime) &&
		runtime.ctx !== null &&
		!runtime.abortedHold &&
		runtime.activeReflection === undefined
	);
}

/** Keep dispatch inhibited throughout cancellation and counter publication. */
function establishAbortedHold(runtime: Runtime): void {
	runtime.abortedHold = true;
}

function cancelAbortedRun(
	runtime: Runtime,
	boundary = runtime.abortBoundaryLeafId,
	confirmedOutcome = false,
): boolean {
	if (
		!owns(runtime) ||
		boundary === undefined ||
		runtime.ctx === null ||
		(!confirmedOutcome &&
			!isAbortedTerminalTakeover(
				runtime.ctx.sessionManager.getBranch(),
				boundary,
			))
	)
		return false;
	runtime.abortBoundaryLeafId = undefined;
	establishAbortedHold(runtime);
	const active = runtime.activeReflection;
	runtime.activeReflection = undefined;
	runtime.internalRun = { kind: "none" };
	runtime.manualQueue = [];
	if (active !== undefined) {
		for (const id of active.toolCallIds) runtime.abortedToolCallIds.add(id);
		runtime.abortedInquiryIds.add(active.handle.correlation.inquiryId);
		const fold = active.handle.cancel();
		if (fold !== null)
			runtime.pi.sendMessage(fold, { deliverAs: "steer", triggerTurn: false });
	}
	resetCycleForUserTakeover(runtime);
	if (runtime.explicitInputClock > runtime.boundaryInputClock)
		runtime.abortedHold = false;
	refreshWidget(runtime);
	return true;
}

function sendActiveReflection(runtime: Runtime, prompt: string): void {
	const active = runtime.activeReflection;
	if (active === undefined || !owns(runtime) || runtime.abortedHold) return;
	active.handle = active.inquiry.attempt(active.attempt);
	if (!active.handle.markSent()) return;
	active.inquiry.send(runtime.pi, prompt, active.attempt);
}

function reserveReflection(runtime: Runtime, pending: PendingReflection): void {
	const inquiry = createInquiryRuntime(REFLECTION_INQUIRY_NAMESPACE, {
		inquiryId: `reflection-${pending.id}`,
	});
	runtime.activeReflection = {
		...pending,
		attempt: 1,
		toolCalls: 0,
		toolCallIds: new Set(),
		responseObserved: false,
		inquiry,
		handle: inquiry.attempt(1),
	};
	runtime.internalRun = { kind: "provisional", attempt: 1 };
}

function submitReflection(runtime: Runtime): void {
	const pending = runtime.activeReflection;
	if (pending === undefined || !owns(runtime) || runtime.abortedHold) return;
	const previous = latestReflection(runtime);
	sendActiveReflection(
		runtime,
		buildReflectionPrompt({
			semanticPrefix: runtime.config.reflectionPrompt,
			historyLocator: {
				sessionFile: runtime.ctx?.sessionManager.getSessionFile(),
				branchLeafId: runtime.ctx?.sessionManager.getLeafId() ?? null,
			},
			previousReflection:
				previous === undefined
					? undefined
					: { timestamp: previous.timestamp, report: previous.report },
			timestamp: pending.timestamp,
			reasons: pending.reasons,
			thresholds: pending.thresholds,
			userSupplement: pending.userSupplement,
		}),
	);
}

function maybeDispatch(runtime: Runtime): void {
	if (!safeToDispatch(runtime)) return;
	const manual = runtime.manualQueue[0];
	if (manual !== undefined) {
		// Manual and automatic reflections share the native steering queue: a
		// busy ordinary run (or a settle -> new run race) cannot delay the
		// request, so it never re-enters a plugin-side waiting state here.
		runtime.manualQueue.shift();
		reserveReflection(runtime, manual);
		submitReflection(runtime);
		refreshWidget(runtime);
		return;
	}
}

type ManualQueueOutcome = "ignored" | "coalesced" | "queued" | "dispatched";

function queueManualReflection(
	runtime: Runtime,
	supplement?: string,
): ManualQueueOutcome {
	if (!owns(runtime)) return "ignored";
	// Commands can run once the aborted host run is idle but before our settlement.
	if (runtime.ctx?.isIdle() && cancelAbortedRun(runtime))
		runtime.abortSettlementPending = true;
	// A fresh user-invoked /reflect is explicit re-entry: release any abort
	// hold and reset the cycle before dispatch under the existing manual rules.
	if (runtime.abortedHold) {
		resetCycleForUserTakeover(runtime);
		runtime.abortedHold = false;
	}
	if (runtime.manualQueue.length > 0) return "coalesced";
	runtime.reflectionSequence += 1;
	const pending: PendingReflection = {
		id: runtime.reflectionSequence,
		reasons: ["USER_REQUEST"],
		thresholds: thresholdSnapshot(runtime),
		userSupplement: supplement,
		timestamp: localTimestamp(),
	};
	runtime.manualQueue.push(pending);
	maybeDispatch(runtime);
	refreshWidget(runtime);
	return runtime.manualQueue.includes(pending) ? "queued" : "dispatched";
}

function cancelLabel(runtime: Runtime): string {
	return runtime.config.cancelShortcut === false
		? `/${CANCEL_REFLECT_COMMAND}`
		: runtime.config.cancelShortcut;
}

function cancelQueuedReflection(runtime: Runtime): void {
	const ui = runtime.ctx?.ui;
	if (runtime.manualQueue.length === 0) {
		ui?.notify("No queued reflection to cancel.", "info");
		return;
	}
	runtime.manualQueue = [];
	refreshWidget(runtime);
	ui?.notify("Queued reflection cancelled.", "info");
}

// Queue dispatch is deliberately caller-owned so completed evidence can be
// appended before a waiting manual reflection is submitted.
function finishReflection(
	runtime: Runtime,
	decision?: ReflectionDecision,
	report?: string,
): void {
	const active = runtime.activeReflection;
	if (active === undefined) return;
	runtime.activeReflection = undefined;
	runtime.internalRun = { kind: "none" };
	if (decision !== undefined && report !== undefined) {
		runtime.pi.sendMessage(
			{
				customType: REFLECTION_CONTINUATION,
				content: REFLECTION_CONTINUATION_CONTENT,
				display: true,
				details: {
					version: 1,
					origin: active.reasons.includes("USER_REQUEST")
						? "manual"
						: "automatic",
					report,
					correlation: active.handle.correlation,
				} satisfies ReflectionContinuationDetails,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}
	if (runtime.ctx !== null) observe(runtime, runtime.ctx);
	if (decision?.type === "NO_ISSUE" && runtime.ctx?.mode === "tui") {
		runtime.ctx.ui.notify(`Reflect watchdog: ${decision.reason}`, "info");
	}
}

function observe(runtime: Runtime, ctx: ExtensionContext): void {
	if (runtime.stopped || runtime.attachment === null) return;
	const internal = runtime.internalRun.kind !== "none";
	runtime.localBusy = probePiAgentState(ctx).busy;
	const ordinaryBusy = runtime.localBusy && !internal;
	if (ordinaryBusy) runtime.hub.markBusy(runtime.attachment);
	else runtime.hub.markIdle(runtime.attachment);
	void runtime.processDomain
		.setBusy(runtime.attachmentInstance, runtime.localBusy)
		.catch(() => {});
	void runtime.processDomain
		.refreshBranch(runtime.attachmentInstance)
		.catch(() => {});
	refreshWidget(runtime);
}

function commandIsCurrent(runtime: Runtime, ctx: ExtensionContext): boolean {
	return (
		owns(runtime) &&
		runtime.ctx !== null &&
		runtime.ctx.sessionManager === ctx.sessionManager &&
		runtime.sessionId === ctx.sessionManager.getSessionId()
	);
}

/**
 * Allowlist for one agent loop: a completed assistant reply that the agent
 * itself produced (non-empty text or a tool call). Provider/gateway failures,
 * plugin-rewritten replies (errorMessage), any plugin inquiry reply
 * (details.piInquiry), and empty/thinking-only replies never count.
 */
function isSuccessfulTurn(event: TurnEndEvent): boolean {
	return isAgentLoopMessage(event.message);
}

function resetCycleForUserTakeover(runtime: Runtime): void {
	if (!owns(runtime)) return;
	runtime.pi.appendEntry(ACCOUNTING_BOUNDARY_ENTRY, {
		version: 1,
		window: "full",
	});
	void runtime.processDomain.resetCycleOnUserTakeover().catch(() => {});
}

function isAbortedTerminalTakeover(
	branch: readonly SessionEntry[],
	boundaryLeafId: string | null,
): boolean {
	let startIndex = 0;
	if (boundaryLeafId !== null) {
		const boundaryIndex = branch.findIndex(
			(entry) => entry.id === boundaryLeafId,
		);
		if (boundaryIndex === -1) return false;
		startIndex = boundaryIndex + 1;
	}
	let terminalStopReason: string | undefined;
	for (let index = startIndex; index < branch.length; index++) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "assistant")
			terminalStopReason = entry.message.stopReason;
	}
	return terminalStopReason === "aborted";
}

function syncOwnership(runtime: Runtime, services: RuntimeServices): void {
	if (runtime.stopped || runtime.attachment === null) return;
	if (runtime.hub.snapshot.main === null)
		runtime.hub.reclaimMain(runtime.attachment);
	const nextClaim = runtime.hub.mainClaimFor(runtime.attachment);
	if (runtime.claim !== null && !runtime.hub.isCurrentMain(runtime.claim)) {
		clearWidget(runtime);
		const active = runtime.activeReflection;
		if (active !== undefined) {
			runtime.abortedInquiryIds.add(active.handle.correlation.inquiryId);
			for (const id of active.toolCallIds) runtime.abortedToolCallIds.add(id);
			active.handle.cancel();
		}
		runtime.manualQueue = [];
		runtime.activeReflection = undefined;
		runtime.internalRun = { kind: "none" };
	}
	runtime.claim = nextClaim;
	if (!owns(runtime)) return;
	refreshWidget(runtime);
	scheduleRefresh(runtime, services);
}

function shutdownRuntime(runtime: Runtime, services: RuntimeServices): void {
	if (runtime.stopped) return;
	runtime.stopped = true;
	if (runtime.ticker !== undefined) services.clearTimeout(runtime.ticker);
	runtime.ticker = undefined;
	clearWidget(runtime);
	runtime.unsubscribeHub?.();
	runtime.unsubscribeDomain?.();
	runtime.unsubscribeCompletions?.();
	const attachment = runtime.attachment;
	if (attachment !== null) runtime.hub.detach(attachment);
	runtime.attachment = null;
	runtime.claim = null;
	runtime.ctx = null;
	runtime.activeReflection = undefined;
	runtime.abortBoundaryLeafId = undefined;
	runtime.manualQueue = [];
	if (runtime.domainAttached) {
		runtime.domainAttached = false;
		void runtime.processDomain
			.detach(runtime.attachmentInstance)
			.catch(() => {});
	}
}

export interface WatchdogExtensionOptions {
	readonly hub?: ObservableAgentHub;
	readonly processDomain?: ReflectBranchDomainCoordinator;
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
			sessionId: null,
			scopeRevision: 0,
			manualQueue: [],
			internalRun: { kind: "none" },
			reflectionSequence: 0,
			abortSettlementPending: false,
			widgetTui: null,
			widgetRegistered: false,
			abortedInquiryIds: new Set(),
			abortedToolCallIds: new Set(),
			abortedHold: false,
			explicitInputClock: 0,
			boundaryInputClock: 0,
		};

		const scopeIsCurrent = (ctx: ExtensionContext): boolean =>
			!runtime.stopped &&
			runtime.ctx !== null &&
			runtime.sessionId === ctx.sessionManager.getSessionId() &&
			runtime.ctx.sessionManager === ctx.sessionManager;
		const rebaseSelectedHistory = (history: readonly SessionEntry[]) => {
			if (!owns(runtime))
				return runtime.processDomain.rebaseBranch(runtime.attachmentInstance);
			// Historical fallback is deliberate at adoption, never during live scans.
			const historical = deriveBranchAccounting(history, {
				boundaryPolicy: "legacy",
				cooldownLoops: reflectCooldownLoops(runtime.config.rootLoopLimit),
			});
			return runtime.processDomain.rebaseBranch(runtime.attachmentInstance, {
				adoptHistory: true,
				fullAfterEntryId: historical.full.afterEntryId,
				reminderAfterEntryId: historical.reminder.afterEntryId,
			});
		};
		const replaceScope = async (ctx: ExtensionContext): Promise<void> => {
			runtime.configReady = false;
			runtime.scopeRevision += 1;
			if (runtime.ticker !== undefined) services.clearTimeout(runtime.ticker);
			runtime.ticker = undefined;
			const active = runtime.activeReflection;
			runtime.activeReflection = undefined;
			if (active !== undefined) {
				runtime.abortedInquiryIds.add(active.handle.correlation.inquiryId);
				for (const id of active.toolCallIds) runtime.abortedToolCallIds.add(id);
				active.handle.cancel();
			}
			runtime.internalRun = { kind: "none" };
			runtime.manualQueue = [];
			runtime.abortBoundaryLeafId = undefined;
			runtime.abortSettlementPending = false;
			runtime.ctx = ctx;
			runtime.sessionId = ctx.sessionManager.getSessionId();
			const revision = runtime.scopeRevision;
			if (owns(runtime)) await runtime.processDomain.resetCycleOnUserTakeover();
			if (runtime.stopped || revision !== runtime.scopeRevision) return;
			await rebaseSelectedHistory(ctx.sessionManager.getBranch());
			if (runtime.stopped || revision !== runtime.scopeRevision) return;
			runtime.configReady = true;
			observe(runtime, ctx);
			scheduleRefresh(runtime, services);
		};
		pi.on("session_tree", async (event, ctx) => {
			if (!scopeIsCurrent(ctx) || event.newLeafId === event.oldLeafId) return;
			await replaceScope(ctx);
		});
		pi.on("session_before_compact", (_event, ctx) => {
			if (scopeIsCurrent(ctx)) observe(runtime, ctx);
		});
		pi.on("session_compact_failed", (_event, ctx) => {
			if (scopeIsCurrent(ctx)) observe(runtime, ctx);
		});
		pi.on("session_compact", (_event, ctx) => {
			if (scopeIsCurrent(ctx)) observe(runtime, ctx);
		});

		pi.registerTool({
			name: REFLECTION_TOOL_NAME,
			label: REFLECTION_TOOL_NAME,
			description: "don't use unless ask",
			parameters: REFLECTION_PARAMETERS,
			prepareArguments: (args) =>
				prepareReflectionArguments(args) as Static<
					typeof REFLECTION_PARAMETERS
				>,
			async execute(toolCallId, params) {
				const active = runtime.activeReflection;
				if (
					!owns(runtime) ||
					runtime.abortedToolCallIds.has(toolCallId) ||
					active === undefined ||
					runtime.internalRun.kind !== "confirmed" ||
					runtime.internalRun.attempt !== active.attempt
				)
					throw new Error(
						"This function is reserved for the plugin. Please try another function.",
					);
				if (active.planned !== undefined)
					throw new Error("Reflection result already submitted.");
				const validation = parseReflectionArguments(params);
				active.planned = validation.valid
					? validation.decision
					: { error: validation.error };
				return {
					content: [
						{
							type: "text",
							text: validation.valid
								? "Reflection received."
								: validation.error,
						},
					],
					details: undefined,
					...(validation.valid ? {} : { isError: true }),
					terminate: true,
				};
			},
		});

		pi.on("context", (event) => ({
			messages: reflectionContext(event.messages, runtime.abortedInquiryIds),
		}));

		pi.registerMessageRenderer<ReflectionContinuationDetails>(
			REFLECTION_CONTINUATION,
			(message, { outputPad }, theme) => {
				const details = continuationDetails(message.details);
				if (details === null) return undefined;
				const box = new Box(outputPad, 1, (text) =>
					theme.bg("customMessageBg", text),
				);
				box.addChild(new Text(details.report, 0, 0));
				return box;
			},
		);

		pi.registerCommand(REFLECT_COMMAND, {
			description:
				"Queue an immediate reflection with optional user supplement",
			handler: async (args, ctx) => {
				if (!commandIsCurrent(runtime, ctx)) return;
				const outcome = queueManualReflection(
					runtime,
					args.trim() || undefined,
				);
				if (outcome === "ignored") return;
				if (outcome === "coalesced")
					ctx.ui.notify("A reflection is already queued.", "info");
				else if (outcome === "queued")
					ctx.ui.notify(
						`Reflection queued · ${cancelLabel(runtime)} to cancel`,
						"info",
					);
				else ctx.ui.notify("Reflection queued.", "info");
			},
		});

		pi.registerCommand(CANCEL_REFLECT_COMMAND, {
			description: "Cancel a queued manual reflection before it starts",
			handler: async (_args, ctx) => {
				if (!commandIsCurrent(runtime, ctx)) return;
				cancelQueuedReflection(runtime);
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			if (runtime.stopped) return;
			if (runtime.ctx !== null) {
				await replaceScope(ctx);
				return;
			}
			runtime.ctx = ctx;
			runtime.sessionId = ctx.sessionManager.getSessionId();
			const initialHistory = [...ctx.sessionManager.getBranch()];
			runtime.localBusy = probePiAgentState(ctx).busy;
			try {
				await runtime.processDomain.attach(runtime.attachmentInstance, {
					getBusy: () => {
						if (runtime.ctx === null) return false;
						return probePiAgentState(runtime.ctx).busy;
					},
					source: {
						getBranch: () => runtime.ctx?.sessionManager.getBranch() ?? [],
						getLeafId: () => runtime.ctx?.sessionManager.getLeafId() ?? null,
						isMain: () => owns(runtime),
						boundaryPolicy: "recorded",
						recordFullBoundary: () =>
							pi.appendEntry(ACCOUNTING_BOUNDARY_ENTRY, {
								version: 1,
								window: "full",
							}),
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
					refreshWidget(runtime);
					scheduleRefresh(runtime, services);
				},
			);
			const loaded = await services.loadConfig(ctx.cwd, ctx.isProjectTrusted());
			if (runtime.stopped || runtime.ctx !== ctx) return;
			runtime.config = loaded.config;
			runtime.unsubscribeCompletions =
				runtime.processDomain.subscribeCompletions((completion) => {
					considerFreshCompletion(runtime, completion.counters);
				});
			await rebaseSelectedHistory(initialHistory);
			runtime.processDomain.setIdleResetGapSeconds(
				runtime.config.idleResetGapSeconds,
			);
			runtime.configReady = true;
			if (runtime.config.cancelShortcut !== false)
				pi.registerShortcut(runtime.config.cancelShortcut as KeyId, {
					description: "Cancel queued reflection (pi-reflect-watchdog)",
					handler: (shortcutCtx) => {
						if (commandIsCurrent(runtime, shortcutCtx))
							cancelQueuedReflection(runtime);
					},
				});
			for (const diagnostic of loaded.diagnostics.slice(0, 3))
				ctx.ui.notify(
					`pi-reflect-watchdog ${diagnostic.source}: ${diagnostic.message}`,
					"warning",
				);
			syncOwnership(runtime, services);
		});

		pi.on("agent_start", (_event, ctx) => {
			if (!scopeIsCurrent(ctx)) return;
			runtime.ctx = ctx;
			runtime.abortBoundaryLeafId = owns(runtime)
				? ctx.sessionManager.getLeafId()
				: undefined;
			runtime.boundaryInputClock = runtime.explicitInputClock;
			const active = runtime.activeReflection;
			if (active !== undefined && runtime.internalRun.kind !== "confirmed") {
				runtime.internalRun = {
					kind: "provisional",
					attempt: active.attempt,
				};
			}
			observe(runtime, ctx);
		});

		pi.on("input", (event, ctx) => {
			// Only newly submitted explicit user input releases the abort hold:
			// source "extension" (plugin/other-extension sendUserMessage) and
			// role-only user messages never qualify. Normal delivery is not
			// altered; the hold only gates this plugin's own dispatch.
			if (!scopeIsCurrent(ctx) || !owns(runtime)) return;
			if (event.source !== "interactive" && event.source !== "rpc") return;
			runtime.explicitInputClock += 1;
			if (ctx.isIdle() && cancelAbortedRun(runtime))
				runtime.abortSettlementPending = true;
			resetCycleForUserTakeover(runtime);
			runtime.abortedHold = false;
		});

		pi.on("message_start", (event, ctx) => {
			if (!scopeIsCurrent(ctx)) return;
			const active = runtime.activeReflection;
			if (active?.handle.matchesPrompt(event.message)) {
				runtime.internalRun = { kind: "confirmed", attempt: active.attempt };
				observe(runtime, ctx);
				return;
			}
		});

		pi.on("tool_call", (event) => {
			if (runtime.abortedToolCallIds.has(event.toolCallId))
				return { block: true, reason: "Reflection inquiry cancelled." };
			const active = runtime.activeReflection;
			if (active === undefined || runtime.internalRun.kind !== "confirmed")
				return;
			active.toolCallIds.add(event.toolCallId);
			if (event.toolName === REFLECTION_TOOL_NAME) return;
			if (active.toolCalls >= MAX_REFLECTION_TOOL_CALLS)
				return {
					block: true,
					reason: `Reflection tool-call budget exhausted. If reflection is complete, call ${REFLECTION_TOOL_NAME} alone to submit your result and end reflection.`,
				};
			active.toolCalls += 1;
		});

		const handleMessageEnd = (
			event: MessageEndEvent,
			ctx: ExtensionContext,
		) => {
			if (!scopeIsCurrent(ctx)) return;
			const correlation = inquiryCorrelation(
				record(record(event.message)?.details)?.piInquiry,
			);
			if (
				correlation !== null &&
				runtime.abortedInquiryIds.has(correlation.inquiryId)
			) {
				if (event.message.role === "assistant")
					for (const block of event.message.content)
						if (block.type === "toolCall")
							runtime.abortedToolCallIds.add(block.id);
				return;
			}
			const active = runtime.activeReflection;
			if (
				event.message.role === "assistant" &&
				event.message.stopReason === "aborted" &&
				correlation === null &&
				runtime.internalRun.kind !== "confirmed"
			) {
				if (cancelAbortedRun(runtime, runtime.abortBoundaryLeafId, true))
					runtime.abortSettlementPending = true;
				return;
			}
			if (
				active === undefined ||
				(correlation !== null &&
					!sameCorrelation(correlation, active.handle.correlation))
			)
				return;
			// Only a run whose inquiry prompt was confirmed via message_start may
			// capture an assistant. A provisional internal run shares the turn
			// with ordinary work and must never claim its assistant replies.
			if (
				runtime.internalRun.kind !== "confirmed" ||
				runtime.internalRun.attempt !== active.attempt
			)
				return;
			if (event.message.role === "assistant") active.responseObserved = true;
			// Provider failures belong to Pi's retry cycle, not result validation.
			if (
				event.message.role === "assistant" &&
				event.message.stopReason === "error"
			)
				return;
			if (
				active.handle.capture(event.message) === null ||
				event.message.role !== "assistant"
			)
				return;
			const toolCalls = event.message.content.filter(
				(block) => block.type === "toolCall",
			);
			for (const call of toolCalls) active.toolCallIds.add(call.id);
			// An aborted owned response keeps its authoritative aborted outcome:
			// neither invalid-response staging (which would reask) nor the
			// stop-rewrite below may convert a user abort into more work.
			if (event.message.stopReason === "aborted") {
				if (cancelAbortedRun(runtime, runtime.abortBoundaryLeafId, true))
					runtime.abortSettlementPending = true;
				return {
					message: {
						...active.handle.neutralize(event.message, {
							stopReason: "aborted",
						}),
						content: [],
					},
				};
			}
			if (toolCalls.length === 0 && active.planned === undefined)
				active.planned = {
					error: `reflection must be submitted with ${REFLECTION_TOOL_NAME}`,
				};
			// An invalid result call must not reach native schema validation: that
			// path would request an unbudgeted follow-up and settle as a cancel.
			// Judge raw arguments with the plugin parser and stop the response here.
			const invalidResult = toolCalls
				.filter((call) => call.name === REFLECTION_TOOL_NAME)
				.map((call) => parseReflectionArguments(call.arguments))
				.find((validation) => !validation.valid);
			if (invalidResult !== undefined && !invalidResult.valid) {
				active.planned ??= { error: invalidResult.error };
				return {
					message: {
						...active.handle.neutralize(event.message),
						stopReason: "stop" as const,
						content: [],
					},
				};
			}
			// Preserve executable calls until Pi runs them; the completed inquiry
			// folds calls and results together out of subsequent context.
			return {
				message: {
					...active.handle.neutralize(event.message),
					content:
						toolCalls.length === 0
							? []
							: event.message.content.filter(
									(block) =>
										block.type === "toolCall" || block.type === "thinking",
								),
				},
			};
		};
		(pi as ExtensionAPI & Partial<UninterruptibleMessageEndAPI>).on(
			"message_end",
			handleMessageEnd,
			{ uninterruptible: true },
		);

		pi.on("turn_end", async (event, ctx) => {
			if (
				!scopeIsCurrent(ctx) ||
				!isSuccessfulTurn(event) ||
				runtime.internalRun.kind === "confirmed"
			)
				return;
			const branch = ctx.sessionManager.getBranch();
			if (
				typeof event.messageEntryId !== "string" ||
				!Array.isArray(event.toolResultEntryIds) ||
				!event.toolResultEntryIds.every((id) =>
					branch.some(
						(entry) =>
							entry.id === id &&
							entry.type === "message" &&
							entry.message.role === "toolResult",
					),
				)
			)
				return;
			await runtime.processDomain.completeTurn(
				runtime.attachmentInstance,
				event.messageEntryId,
			);
			refreshWidget(runtime);
		});

		pi.on("agent_end", () => {});
		pi.on("agent_settled", (_event, ctx) => {
			if (!scopeIsCurrent(ctx) || !ctx.isIdle()) return;
			if (runtime.abortSettlementPending) {
				runtime.abortSettlementPending = false;
				observe(runtime, ctx);
				return;
			}
			// Reentrant observation cannot finalize a newborn or unconsumed inquiry.
			const activeAtEntry = runtime.activeReflection;
			const abortBoundaryLeafId = runtime.abortBoundaryLeafId;
			runtime.abortBoundaryLeafId = undefined;
			if (cancelAbortedRun(runtime, abortBoundaryLeafId)) {
				observe(runtime, ctx);
				return;
			}
			observe(runtime, ctx);
			const active = runtime.activeReflection;
			if (
				active !== undefined &&
				active === activeAtEntry &&
				((runtime.internalRun.kind === "confirmed" &&
					active.responseObserved) ||
					active.planned !== undefined)
			) {
				const planned = active.planned;
				runtime.internalRun = { kind: "none" };
				if (planned !== undefined && "error" in planned) {
					if (active.attempt < MAX_REFLECTION_REASKS) {
						runtime.ctx?.ui.notify(
							`Reflection attempt ${active.attempt}/${MAX_REFLECTION_REASKS} invalid: ${planned.error}; retrying.`,
							"warning",
						);
						if (
							runtime.activeReflection !== active ||
							runtime.abortedHold ||
							!owns(runtime)
						)
							return;
						active.responseObserved = false;
						active.attempt += 1;
						active.planned = undefined;
						runtime.internalRun = {
							kind: "provisional",
							attempt: active.attempt,
						};
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
					if (
						runtime.activeReflection !== active ||
						runtime.abortedHold ||
						!owns(runtime)
					)
						return;
					runtime.ctx?.ui.notify(
						`Reflection failed: ${planned.error}`,
						"warning",
					);
					if (
						runtime.activeReflection !== active ||
						runtime.abortedHold ||
						!owns(runtime)
					)
						return;
					finishReflection(runtime);
					maybeDispatch(runtime);
					return;
				}
				if (planned !== undefined) {
					const result = reflectionResult(active, planned);
					const fold = active.handle.complete();
					if (fold !== null)
						pi.sendMessage(fold, {
							deliverAs: "steer",
							triggerTurn: false,
						});
					if (
						runtime.activeReflection !== active ||
						!owns(runtime) ||
						runtime.abortedHold
					)
						return;
					try {
						pi.appendEntry(REFLECTION_RESULT_ENTRY, result);
					} catch (error) {
						finishReflection(runtime);
						throw error;
					}
					if (
						runtime.activeReflection !== active ||
						!owns(runtime) ||
						runtime.abortedHold
					)
						return;
					try {
						pi.appendEntry(
							REFLECTION_COMPLETED_ENTRY,
							active.handle.correlation,
						);
					} catch (error) {
						finishReflection(runtime);
						throw error;
					}
					if (
						runtime.activeReflection !== active ||
						!owns(runtime) ||
						runtime.abortedHold
					)
						return;
					publishReflectionCompleted(runtime, planned);
					if (
						runtime.activeReflection !== active ||
						!owns(runtime) ||
						runtime.abortedHold
					)
						return;
					finishReflection(runtime, planned, result.report);
					maybeDispatch(runtime);
					return;
				}
				const fold = active.handle.cancel();
				if (fold !== null)
					pi.sendMessage(fold, {
						deliverAs: "steer",
						triggerTurn: false,
					});
				if (
					runtime.activeReflection !== active ||
					runtime.abortedHold ||
					!owns(runtime)
				)
					return;
				finishReflection(runtime);
				maybeDispatch(runtime);
				return;
			}
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
