import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Box, Key, type KeyId, matchesKey, Text } from "@earendil-works/pi-tui";
import { probePiAgentState } from "pi-extension-utils/pi-agent-state";
import {
	foldInquiryContext,
	type InquiryAttemptHandle,
} from "pi-extension-utils/pi-inquiry";
import {
	captureAnchor,
	type PrivateChildSession,
	type PrivateInquiryResult,
	type PrivateRuntime,
	runPrivateInquiry,
} from "pi-extension-utils/private-inquiry";
import { publishSemanticHook } from "pi-extension-utils/semantic-hook";
import {
	ACCOUNTING_BOUNDARY_ENTRY,
	deriveBranchAccounting,
	isAgentLoopMessage,
	REFLECTION_COMPLETED_ENTRY,
	REFLECTION_INQUIRY_NAMESPACE,
	REFLECTION_RESULT_ENTRY,
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

const REFLECTION_COMPLETED_HOOK = "reflection-completed";
const REFLECTION_CONTINUATION = "pi-reflect-watchdog:continuation";
const REFLECTION_CONTINUATION_CONTENT = "[assistant]\ncontinue";
const SEMANTIC_HOOK_TEXT_LIMIT = 4096;
const REFLECT_COOLDOWN_MIN_LOOPS = 10;
const REFLECT_COOLDOWN_MAX_LOOPS = 30;
const ACTIVE_TICK_MS = 1_000;

type Timer = ReturnType<typeof setTimeout>;
type TimerRole = "tui-refresh" | "rpc-status";

export interface RuntimeServices {
	/** Monotonic private-operation display clock; accounting owns its own clock. */
	now(): number;
	setTimeout(callback: () => void, delay: number): Timer;
	clearTimeout(timer: Timer): void;
	loadConfig(cwd: string, trusted: boolean): Promise<LoadedConfig>;
	processDomain: ReflectBranchDomainCoordinator;
	fatalExit: FatalExitAdapter;
	scheduleTimer?(role: TimerRole, callback: () => void, delay: number): Timer;
}

const defaultServices: RuntimeServices = {
	now: () => performance.now(),
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
	/**
	 * Admission-time identity binding. A queued request is fulfilled only
	 * while session, branch owner (attachmentId+generation — the hub mints
	 * a fresh claim object per sync so compare structurally), scope
	 * generation AND takeover generation still match — a stale or
	 * mismatched entry is silently dropped, never launched. Deliberately
	 * NOT leaf-based: ordinary same-ancestry progress keeps it current.
	 */
	readonly admission: {
		readonly sessionId: string | null;
		readonly claim: {
			readonly attachmentId: number;
			readonly generation: number;
		} | null;
		readonly scopeRevision: number;
		readonly takeoverGeneration: number;
	};
}

/**
 * One in-flight private reflection: its frozen source, abort controller and
 * settled outcome. Result/correction authority is revoked synchronously on
 * invalidation; `drained` resolves when the shared executor's cleanup ends.
 */
interface ActiveReflection extends PendingReflection {
	readonly abort: AbortController;
	readonly anchorId: string;
	readonly model: string;
	readonly correlation: InquiryAttemptHandle["correlation"];
	/** Revocation retires authority immediately; the slot stays occupied
	 * until the exact run settles so no overlap/relaunch can interleave. */
	revoked: boolean;
	/** Official working state of the exact child, projected from its own
	 * session events (agent_start/turn_start/auto_retry_start on,
	 * agent_end/agent_settled off). Never the whole op window, never
	 * ordinary-loop charges. */
	childWorking: boolean;
	/** Mirrors the pinned child's compaction-retry latch: agent_settled is
	 * not idle while a compaction retry is still pending. */
	/** Mirrors the pinned child's compaction-retry latch: agent_settled is
	 * not idle while a compaction retry is still pending. */
	compactionRetryActive: boolean;
	/** Presentation only: independent of official child-working/accounting. */
	progress?: {
		startedAt: number;
		stage: NonNullable<WidgetState["progress"]>["stage"];
		attempt?: number;
		activeHelpers: Map<string, string>;
		/** Content-free stream of the current private response: latest
		 * delta kind + total streamed chars. Never holds delta text. */
		streamKind?: "thinking" | "writing" | "tool call";
		streamCount?: number;
	};
	unsubscribeChild?: () => void;
	/** Sanitized terminal-assistant metadata of the exact accepted private
	 * child, captured before disposal; only valid entries reach a marker. */
	privateSource?: PrivateSourceMetadata;
	drained: Promise<void>;
}

/** Injection seam for unit tests; production loads the shared executor. */
interface PrivateInquiryServices {
	createRuntime(): Promise<PrivateRuntime>;
	run(
		options: Parameters<typeof runPrivateInquiry<ReflectionDecision>>[0],
	): Promise<PrivateInquiryResult<ReflectionDecision>>;
}

const defaultPrivateInquiry: PrivateInquiryServices = {
	// Import the prepared TypeScript runtime from this source graph so Pi's
	// extension loader transpiles it; utils' own native import cannot.
	createRuntime: async () =>
		(
			await import("private-inquiry-subagents-runtime/watchdog-runtime")
		).createWatchdogRuntime(),
	run: (options) => runPrivateInquiry(options),
};

interface ReflectionResult {
	readonly version: 1;
	readonly timestamp: string;
	readonly reasons: readonly ReflectionTriggerReason[];
	readonly thresholds: ReflectionThresholdSnapshot;
	readonly userSupplement?: string;
	readonly decision: ReflectionDecision;
	readonly report: string;
	/** Private results bind the completion marker (cooldown pairing). */
	readonly correlation?: InquiryAttemptHandle["correlation"];
}

interface ReflectionContinuationDetails {
	readonly version: 1;
	readonly origin: "automatic" | "manual";
	readonly report: string;
	readonly correlation: InquiryAttemptHandle["correlation"];
	/**
	 * Private-handoff source: sanitized terminal-assistant metadata captured
	 * from the exact accepted child before disposal (allowlist only: identity
	 * and accounting fields — never content, thinking, tool calls or paths).
	 * Present but invalid fails closed; legacy records never carry it.
	 */
	readonly private?: PrivateSourceMetadata;
}

interface PrivateSourceMetadata {
	readonly sessionId: string;
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	readonly responseId?: string;
	/** Correlation binding captured at the accepted own-source moment:
	 * the marker's correlation must equal this exactly or the record is
	 * rejected (tampered marker or source fails closed). */
	readonly inquiryId: string;
	readonly attempt: number;
	readonly timestamp: number;
	readonly stopReason: "stop" | "toolUse";
	readonly usage: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly totalTokens: number;
		readonly cost: {
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
			readonly total: number;
		};
	};
}

interface Runtime {
	readonly services: RuntimeServices;
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
	privateRuntime?: PrivateRuntime;
	privateRuntimePromise?: Promise<PrivateRuntime>;
	privateInquiry: PrivateInquiryServices;
	abortBoundaryLeafId?: string | null;
	abortSettlementPending: boolean;
	reflectionSequence: number;
	ticker?: Timer;
	widgetTui: { requestRender(): void } | null;
	widgetRegistered: boolean;
	unsubscribeHub?: () => void;
	unsubscribeDomain?: () => void;
	unsubscribeCompletions?: () => void;
	unsubscribeTerminalInput?: () => void;
	/** Post-abort eligibility hold: only new explicit user input (interactive or
	 * user-client rpc) or a fresh user-invoked /reflect may release it. */
	abortedHold: boolean;
	/** Monotonic event clock for explicit user input; fences a late settlement
	 * from re-holding a cycle the user already re-entered. */
	explicitInputClock: number;
	/** Explicit-input clock at run start; later input survives old cancellation. */
	boundaryInputClock: number;
	/** Monotonic takeover generation: incremented synchronously at every
	 * full-cycle user-takeover reset, BEFORE the boundary append/reset
	 * callback, so reentrancy cannot interleave a stale admission. A queued
	 * manual request bound to an older generation never fulfills. */
	takeoverGeneration: number;
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

function nonnegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The child's own reply for the LAST forwarded prompt: the newest
 * assistant-role message at or after `promptStart`. Earlier assistants
 * are inherited context or a rejected previous attempt — never the
 * accepted source.
 */
function lastAssistantAtOrAfter(
	messages: readonly unknown[],
	promptStart: number,
): Record<string, unknown> | null {
	let found: Record<string, unknown> | null = null;
	for (let index = promptStart; index < messages.length; index += 1) {
		const message = messages[index];
		if (isRecord(message) && message.role === "assistant") found = message;
	}
	return found;
}

/** Allowlist-validated terminal-assistant metadata for the private handoff
 * source. Identity and accounting fields only — never content/thinking.
 */
function privateSourceMetadata(value: unknown): PrivateSourceMetadata | null {
	if (!isRecord(value)) return null;
	const usage = isRecord(value.usage) ? value.usage : null;
	const cost = usage !== null && isRecord(usage.cost) ? usage.cost : null;
	if (
		typeof value.sessionId !== "string" ||
		value.sessionId.length === 0 ||
		typeof value.api !== "string" ||
		value.api.length === 0 ||
		typeof value.provider !== "string" ||
		value.provider.length === 0 ||
		typeof value.model !== "string" ||
		value.model.length === 0 ||
		(value.responseId !== undefined && typeof value.responseId !== "string") ||
		typeof value.inquiryId !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(value.inquiryId) ||
		typeof value.attempt !== "number" ||
		!Number.isSafeInteger(value.attempt) ||
		value.attempt <= 0 ||
		!nonnegativeNumber(value.timestamp) ||
		(value.stopReason !== "stop" && value.stopReason !== "toolUse") ||
		usage === null ||
		cost === null ||
		!nonnegativeNumber(usage.input) ||
		!nonnegativeNumber(usage.output) ||
		!nonnegativeNumber(usage.cacheRead) ||
		!nonnegativeNumber(usage.cacheWrite) ||
		!nonnegativeNumber(usage.totalTokens) ||
		!nonnegativeNumber(cost.input) ||
		!nonnegativeNumber(cost.output) ||
		!nonnegativeNumber(cost.cacheRead) ||
		!nonnegativeNumber(cost.cacheWrite) ||
		!nonnegativeNumber(cost.total)
	)
		return null;
	return {
		sessionId: value.sessionId,
		api: value.api,
		provider: value.provider,
		model: value.model,
		responseId:
			typeof value.responseId === "string" ? value.responseId : undefined,
		inquiryId: value.inquiryId,
		attempt: value.attempt,
		timestamp: value.timestamp,
		stopReason: value.stopReason,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			cost: {
				input: cost.input,
				output: cost.output,
				cacheRead: cost.cacheRead,
				cacheWrite: cost.cacheWrite,
				total: cost.total,
			},
		},
	};
}

/** Parse a legacy or private continuation marker. A `private` key that is
 * present but invalid rejects the whole record (fail closed — never fall
 * through to legacy acceptance or guess a source). */
function continuationDetails(
	value: unknown,
): ReflectionContinuationDetails | null {
	if (!isRecord(value)) return null;
	const correlation = inquiryCorrelation(value.correlation);
	if (
		value.version !== 1 ||
		(value.origin !== "automatic" && value.origin !== "manual") ||
		typeof value.report !== "string" ||
		value.report.trim().length === 0 ||
		correlation === null
	)
		return null;
	let privateSource: PrivateSourceMetadata | undefined;
	if ("private" in value) {
		privateSource = privateSourceMetadata(value.private) ?? undefined;
		// Correlation binding is authoritative: the embedded source binding
		// must equal the marker correlation exactly — tampering either side
		// fails closed rather than guessing an identity.
		if (
			privateSource === undefined ||
			privateSource.inquiryId !== correlation.inquiryId ||
			privateSource.attempt !== correlation.attempt
		)
			return null;
	}
	return {
		version: 1,
		origin: value.origin,
		report: value.report,
		correlation,
		private: privateSource,
	};
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
		if (source === undefined || !started) {
			// Private reflections never wrote a main-session inquiry chain;
			// their continuation markers carry a validated `private` source
			// object bound to the exact accepted child's terminal assistant.
			// Only that explicit new-format source may project without a
			// correlated legacy chain — legacy or malformed records never
			// guess a source.
			if (!isRecord(marker) || details.private === undefined) continue;
			const report =
				details.origin === "automatic"
					? {
							role: "assistant",
							api: details.private.api,
							provider: details.private.provider,
							model: details.private.model,
							responseId: details.private.responseId,
							usage: details.private.usage,
							content: [{ type: "text", text: details.report }],
							stopReason: "stop",
							timestamp: details.private.timestamp,
						}
					: {
							role: "user",
							content: [{ type: "text", text: details.report }],
							timestamp: details.private.timestamp,
						};
			projections.set(markerIndex, report as T);
			continue;
		}

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

function reflectionContext<T extends object>(messages: T[]): T[] {
	return foldInquiryContext(
		continuationProjection(messages),
		REFLECTION_INQUIRY_NAMESPACE,
	);
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
	if (!skip && runtime.ctx !== null) {
		try {
			reserveReflection(
				runtime,
				{
					id: ++runtime.reflectionSequence,
					reasons,
					thresholds,
					timestamp: localTimestamp(),
					admission: {
						sessionId: runtime.sessionId,
						claim: runtime.claim
							? {
									attachmentId: runtime.claim.attachmentId,
									generation: runtime.claim.generation,
								}
							: null,
						scopeRevision: runtime.scopeRevision,
						takeoverGeneration: runtime.takeoverGeneration,
					},
				},
				runtime.ctx,
			);
		} catch {
			// A trigger without a replayable/model source is a typed setup
			// failure: record the reminder reset below and launch nothing.
		}
	}
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
	if (runtime.activeReflection !== undefined && runtime.ctx !== null)
		submitReflection(runtime, runtime.ctx);
}

function visibleReflection(
	runtime: Runtime,
	active: ActiveReflection,
): boolean {
	const claim = runtime.claim;
	const admitted = active.admission.claim;
	return (
		runtime.activeReflection === active &&
		owns(runtime) &&
		active.admission.sessionId === runtime.sessionId &&
		active.admission.scopeRevision === runtime.scopeRevision &&
		claim !== null &&
		admitted !== null &&
		claim.attachmentId === admitted.attachmentId &&
		claim.generation === admitted.generation
	);
}

function reflectionProgress(runtime: Runtime): WidgetState["progress"] {
	try {
		const active = runtime.activeReflection;
		if (active === undefined || !visibleReflection(runtime, active)) return;
		const progress = active.progress;
		if (progress === undefined) return;
		return {
			stage: progress.stage,
			elapsedMs: Math.max(0, runtime.services.now() - progress.startedAt),
			attempt: progress.attempt,
			attemptLimit: MAX_REFLECTION_REASKS,
			tools: [...new Set(progress.activeHelpers.values())],
			stream:
				progress.streamKind === undefined
					? undefined
					: { kind: progress.streamKind, count: progress.streamCount ?? 0 },
		};
	} catch {
		return undefined;
	}
}

function updateReflectionProgress(
	runtime: Runtime,
	active: ActiveReflection,
	stage: NonNullable<WidgetState["progress"]>["stage"],
	attempt?: number,
): void {
	try {
		if (
			!visibleReflection(runtime, active) ||
			active.revoked ||
			active.progress === undefined
		)
			return;
		active.progress.stage = stage;
		if (attempt !== undefined) active.progress.attempt = attempt;
		refreshWidget(runtime);
		scheduleRefresh(runtime, runtime.services);
	} catch {
		// Progress cannot change execution or result authority.
	}
}

function observeReflectionProgress(
	runtime: Runtime,
	active: ActiveReflection,
	event: unknown,
): void {
	try {
		if (
			!visibleReflection(runtime, active) ||
			active.revoked ||
			active.progress === undefined ||
			!isRecord(event)
		)
			return;
		const progress = active.progress;
		if (event.type === "tool_execution_start") {
			// The pinned evidence profile admits whole helper-only batches before execution.
			if (
				typeof event.toolCallId !== "string" ||
				typeof event.toolName !== "string" ||
				!["read", "ls", "grep", "find"].includes(event.toolName)
			)
				return;
			progress.activeHelpers.set(event.toolCallId, event.toolName);
			updateReflectionProgress(runtime, active, "tools");
		} else if (event.type === "tool_execution_end") {
			if (
				typeof event.toolCallId !== "string" ||
				!progress.activeHelpers.delete(event.toolCallId)
			)
				return;
			updateReflectionProgress(
				runtime,
				active,
				progress.activeHelpers.size > 0 ? "tools" : "waiting for model",
			);
		} else if (
			event.type === "agent_start" ||
			event.type === "turn_start" ||
			event.type === "auto_retry_start"
		) {
			updateReflectionProgress(
				runtime,
				active,
				progress.activeHelpers.size > 0
					? "tools"
					: progress.stage === "correcting"
						? "correcting"
						: "waiting for model",
			);
		} else if (event.type === "message_start") {
			// A new assistant response resets the stream; nothing painted yet.
			const message = event.message;
			if (!isRecord(message) || message.role !== "assistant") return;
			progress.streamKind = undefined;
			progress.streamCount = undefined;
		} else if (event.type === "message_update") {
			const message = event.message;
			const delta = event.assistantMessageEvent;
			if (
				!isRecord(message) ||
				message.role !== "assistant" ||
				!isRecord(delta)
			)
				return;
			const kind =
				delta.type === "thinking_delta"
					? "thinking"
					: delta.type === "text_delta"
						? "writing"
						: delta.type === "toolcall_delta"
							? "tool call"
							: undefined;
			if (kind === undefined) return;
			const length = typeof delta.delta === "string" ? delta.delta.length : 0;
			const nextCount = (progress.streamCount ?? 0) + length;
			// Repaint only when the visible kind or braille frame changes;
			// the 1s elapsed tick already refreshes the count otherwise.
			const visibleChange =
				progress.streamKind !== kind ||
				Math.floor((progress.streamCount ?? 0) / 24) !==
					Math.floor(nextCount / 24);
			progress.streamKind = kind;
			progress.streamCount = nextCount;
			if (visibleChange && progress.activeHelpers.size === 0)
				updateReflectionProgress(
					runtime,
					active,
					progress.stage === "correcting" ? "correcting" : "waiting for model",
				);
		} else if (event.type === "message_end") {
			const message = event.message;
			if (!isRecord(message) || message.role !== "assistant") return;
			const hadStream = progress.streamKind !== undefined;
			progress.streamKind = undefined;
			progress.streamCount = undefined;
			if (hadStream && progress.activeHelpers.size === 0)
				updateReflectionProgress(
					runtime,
					active,
					progress.stage === "correcting" ? "correcting" : "waiting for model",
				);
		}
	} catch {
		// Child observations are presentation only.
	}
}

function statusState(runtime: Runtime): WidgetState {
	const counters = currentCounters(runtime);
	return {
		progress: reflectionProgress(runtime),
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
	try {
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
	} catch {
		// A stale UI or renderer must not affect private execution or accounting.
	}
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
	try {
		ctx?.ui.setStatus(STATUS_KEY, undefined);
	} catch {}
}

function scheduleRefresh(runtime: Runtime, services: RuntimeServices): void {
	try {
		if (
			!owns(runtime) ||
			runtime.ctx === null ||
			(runtime.ctx.mode !== "tui" && runtime.ctx.mode !== "rpc") ||
			(!currentCounters(runtime)?.anyBusy &&
				reflectionProgress(runtime) === undefined)
		) {
			if (runtime.ticker !== undefined) services.clearTimeout(runtime.ticker);
			runtime.ticker = undefined;
			return;
		}
		if (runtime.ticker !== undefined) return;
		const revision = runtime.scopeRevision;
		const timer = scheduleTimer(
			services,
			runtime.ctx.mode === "tui" ? "tui-refresh" : "rpc-status",
			() => {
				if (runtime.ticker !== timer) return;
				runtime.ticker = undefined;
				if (runtime.stopped || runtime.scopeRevision !== revision) return;
				// Display-only waits never feed time or activity into accounting.
				if (currentCounters(runtime)?.anyBusy)
					void runtime.processDomain
						.refreshBranch(runtime.attachmentInstance)
						.catch(() => {});
				refreshWidget(runtime);
				scheduleRefresh(runtime, services);
			},
			ACTIVE_TICK_MS,
		);
		runtime.ticker = timer;
		timer.unref?.();
	} catch {
		// A display scheduler failure must not change execution.
	}
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
	revokeActiveReflection(runtime);
	runtime.manualQueue = [];
	resetCycleForUserTakeover(runtime);
	if (runtime.explicitInputClock > runtime.boundaryInputClock)
		runtime.abortedHold = false;
	refreshWidget(runtime);
	return true;
}

/**
 * Synchronously retire result/correction authority and request exact-child
 * cancellation. The admission slot stays occupied until the exact run's
 * settlement releases it, so no overlap or stale-trigger replacement can
 * interleave while the old child drains.
 */
function revokeActiveReflection(runtime: Runtime): void {
	const active = runtime.activeReflection;
	if (active === undefined || active.revoked) return;
	active.revoked = true;
	if (active.progress !== undefined) active.progress.stage = "cancelling";
	active.abort.abort();
	refreshWidget(runtime);
	scheduleRefresh(runtime, runtime.services);
}

/**
 * Backstop currentness: the operation is still admitted, this watchdog still
 * owns main, and the captured anchor remains on the active ancestry. Ordinary
 * same-ancestry appends/compaction keep it current; leaf equality is never
 * compared.
 */
function anchorInActiveAncestry(runtime: Runtime, anchorId: string): boolean {
	return (
		runtime.ctx?.sessionManager
			.getBranch()
			.some((entry) => entry.id === anchorId) === true
	);
}

function reflectionIsCurrent(
	runtime: Runtime,
	active: ActiveReflection,
): boolean {
	return (
		runtime.activeReflection === active &&
		!active.revoked &&
		!runtime.stopped &&
		!runtime.abortedHold &&
		owns(runtime) &&
		!active.abort.signal.aborted &&
		anchorInActiveAncestry(runtime, active.anchorId)
	);
}

/**
 * One extension-lifetime private runtime. The in-flight creation is memoized
 * so concurrent launches share it and shutdown can dispose a late result
 * instead of leaking a runtime created after unload.
 */
function acquirePrivateRuntime(runtime: Runtime): Promise<PrivateRuntime> {
	if (runtime.privateRuntime !== undefined)
		return Promise.resolve(runtime.privateRuntime);
	runtime.privateRuntimePromise ??= runtime.privateInquiry
		.createRuntime()
		.then((created) => {
			if (runtime.stopped) {
				created.dispose();
				throw new Error("extension unloaded during private runtime setup");
			}
			runtime.privateRuntime = created;
			return created;
		})
		.finally(() => {
			runtime.privateRuntimePromise = undefined;
		});
	return runtime.privateRuntimePromise;
}

/**
 * Project the exact child's official working state from its session events.
 * Official SDK truth: `_isAgentRunActive` clears only in `_emitAgentSettled`
 * (agent-session.js ~685), and pinned `projectChildLifecycle` returns
 * cancel-drain for EVERY `agent_end` — `agent_end` only clears the
 * compaction latch, it never starts the drain. So working persists through
 * `agent_end` (including finalization) until `agent_settled` or disposal.
 * `agent_start`/`turn_start`/`auto_retry_start` mark work and clear the
 * latch; `compaction_end` records the latch; `agent_settled` is not idle
 * while a compaction retry is latched; `auto_retry_end` (success or
 * cancelled) implies nothing about the run and is ignored.
 */
function observeChildEvent(
	active: ActiveReflection,
	event: { type?: string; willRetry?: unknown },
): void {
	switch (event.type) {
		case "agent_start":
		case "turn_start":
		case "auto_retry_start":
			active.compactionRetryActive = false;
			active.childWorking = true;
			return;
		case "compaction_end":
			active.compactionRetryActive = event.willRetry === true;
			return;
		case "agent_end":
			// Working continues through finalization; only the latch resets.
			if (event.willRetry !== true) active.compactionRetryActive = false;
			return;
		case "agent_settled":
			if (!active.compactionRetryActive) active.childWorking = false;
			return;
		default:
			return;
	}
}

/**
 * Fork the exact child under observation: subscribe before the proxy
 * reaches the executor, forward live getters and bound prompt/abort/
 * subscribe unchanged, and guarantee `off()` runs exactly once on cleanup
 * even when child.dispose throws. Stale events after cleanup cannot touch
 * this op or a successor.
 */
async function forkObservedChild(
	runtime: Runtime,
	inner: PrivateRuntime,
	active: ActiveReflection,
	input: Parameters<PrivateRuntime["fork"]>[0],
): Promise<PrivateChildSession> {
	const child = await inner.fork(input);
	if (runtime.activeReflection !== active) {
		// The operation was revoked and its slot already handed over while the
		// fork awaited: dispose the orphan and fail instead of leaking a child
		// or letting its events reach a successor's working flag.
		await child.dispose().catch(() => {});
		throw new Error("private reflection slot released during fork");
	}
	let subscribed = true;
	// Own-response boundary: assistants appended before the latest forwarded
	// prompt are inherited context or an earlier (already rejected) reply —
	// never the accepted source. Recorded before each prompt because the
	// child mutates `messages` asynchronously.
	let promptStart = child.messages.length;
	const off = child.subscribe((event) => {
		if (!subscribed || runtime.activeReflection !== active) return;
		observeChildEvent(active, event);
		observeReflectionProgress(runtime, active, event);
		if (runtime.ctx !== null) observe(runtime, runtime.ctx);
	});
	const cleanup = () => {
		if (!subscribed) return;
		subscribed = false;
		try {
			off();
		} catch {}
		active.progress?.activeHelpers.clear();
		if (runtime.activeReflection === active && active.childWorking) {
			active.childWorking = false;
			if (runtime.ctx !== null) observe(runtime, runtime.ctx);
		}
	};
	active.unsubscribeChild = cleanup;
	const observed: PrivateChildSession = {
		prompt: async (text) => {
			// A new prompt invalidates any earlier captured source; only an
			// assistant appended at/after this point may supply one.
			promptStart = child.messages.length;
			active.privateSource = undefined;
			const attempt = (active.progress?.attempt ?? 0) + 1;
			updateReflectionProgress(
				runtime,
				active,
				attempt > 1 ? "correcting" : "waiting for model",
				attempt,
			);
			return child.prompt(text);
		},
		abort: () => child.abort(),
		subscribe: (listener) => child.subscribe(listener),
		dispose: async () => {
			// Capture the accepted child's own terminal assistant metadata
			// before disposal may clear live state; only an assistant appended
			// at/after the LAST forwarded prompt counts as the accepted reply —
			// inherited context and earlier rejected replies never qualify.
			const ownAssistant = lastAssistantAtOrAfter(child.messages, promptStart);
			if (ownAssistant !== null)
				active.privateSource =
					privateSourceMetadata({
						sessionId: child.sessionId,
						api: ownAssistant.api,
						provider: ownAssistant.provider,
						model: ownAssistant.model,
						responseId: ownAssistant.responseId,
						timestamp: ownAssistant.timestamp,
						stopReason: ownAssistant.stopReason,
						usage: ownAssistant.usage,
						inquiryId: active.correlation.inquiryId,
						attempt: active.correlation.attempt,
					}) ?? undefined;
			cleanup();
			await child.dispose();
		},
		get messages() {
			return child.messages;
		},
		get sessionFile() {
			return child.sessionFile;
		},
		get sessionId() {
			return child.sessionId;
		},
		get modelId() {
			return child.modelId;
		},
		get inheritedProvider() {
			return child.inheritedProvider;
		},
		get attemptError() {
			return child.attemptError;
		},
		get helperCalls() {
			return child.helperCalls;
		},
	};
	return observed;
}

function reserveReflection(
	runtime: Runtime,
	pending: PendingReflection,
	ctx: ExtensionContext,
): ActiveReflection {
	// Freeze the qualified source before any await: replayable anchor, model
	// and thinking level are captured synchronously at admission.
	const anchorId = captureAnchor(ctx.sessionManager);
	const model = ctx.model;
	if (model === undefined)
		throw new Error("The main session has no selected model.");
	const active: ActiveReflection = {
		...pending,
		abort: new AbortController(),
		anchorId,
		model: `${model.provider}/${model.id}:${runtime.pi.getThinkingLevel()}`,
		correlation: {
			version: 1,
			namespace: REFLECTION_INQUIRY_NAMESPACE,
			inquiryId: `reflection-${pending.id}`,
			attempt: 1,
		},
		revoked: false,
		childWorking: false,
		compactionRetryActive: false,
		drained: Promise.resolve(),
	};
	runtime.activeReflection = active;
	try {
		active.progress = {
			startedAt: runtime.services.now(),
			stage: "preparing",
			activeHelpers: new Map(),
		};
		refreshWidget(runtime);
		scheduleRefresh(runtime, runtime.services);
	} catch {
		// Missing presentation never changes admission.
	}
	return active;
}

/**
 * Release the admission slot after the exact run settles — success, failure,
 * cancellation or throw. Settlement itself never reevaluates thresholds,
 * resets counters or launches a replacement; a queued manual reflection
 * dispatches only from its own trigger paths.
 */
function releaseReflectionSlot(
	runtime: Runtime,
	active: ActiveReflection,
): void {
	if (runtime.activeReflection !== active) return;
	active.unsubscribeChild?.();
	active.unsubscribeChild = undefined;
	active.childWorking = false;
	runtime.activeReflection = undefined;
	if (runtime.ctx !== null) observe(runtime, runtime.ctx);
	refreshWidget(runtime);
	scheduleRefresh(runtime, runtime.services);
	// The drained slot is the dispatch point for an already-pending explicit
	// manual request — e.g. a /reflect queued during abort settlement. This
	// is caller-owned queue fulfillment, not threshold reevaluation: an empty
	// queue or a still-held/suspended cycle dispatches nothing.
	maybeDispatch(runtime);
}

async function runPrivateReflection(
	runtime: Runtime,
	active: ActiveReflection,
	ctx: ExtensionContext,
): Promise<void> {
	const isCurrent = () => reflectionIsCurrent(runtime, active);
	// Every source field is frozen before the first await: session
	// manager/model registry/cwd identities, captured anchor, parent
	// session file locator and the historical report.
	const parent = ctx.sessionManager;
	const parentProviderRegistry = ctx.modelRegistry;
	const cwd = ctx.cwd;
	const sessionFile = parent.getSessionFile();
	const previous = latestReflection(runtime);
	const prompt = buildReflectionPrompt({
		semanticPrefix: runtime.config.reflectionPrompt,
		historyLocator: {
			sessionFile,
			branchLeafId: active.anchorId,
		},
		previousReflection:
			previous === undefined
				? undefined
				: { timestamp: previous.timestamp, report: previous.report },
		timestamp: active.timestamp,
		reasons: active.reasons,
		thresholds: active.thresholds,
		userSupplement: active.userSupplement,
	});
	try {
		const sharedRuntime = await acquirePrivateRuntime(runtime);
		// Per-operation façade: the shared core still owns prompt/abort/file
		// mechanics; the fork return is wrapped so this exact child's official
		// working events feed the domain busy flag. The façade's dispose is a
		// no-op for the extension-lifetime runtime — ownership stays here.
		const observedRuntime: PrivateRuntime = {
			fork: (input) => forkObservedChild(runtime, sharedRuntime, active, input),
			dispose: () => sharedRuntime.dispose(),
		};
		const result = await runtime.privateInquiry.run({
			runtime: observedRuntime,
			fork: {
				parent,
				parentProviderRegistry,
				cwd,
				model: active.model,
				retryPolicy: "native",
				anchorId: active.anchorId,
				profile: {
					kind: "read-only-evidence",
					maxHelperCalls: MAX_REFLECTION_TOOL_CALLS,
				},
			},
			signal: active.abort.signal,
			isCurrent,
			invalidAttemptLimit: MAX_REFLECTION_REASKS,
			validate: (payload) => {
				updateReflectionProgress(runtime, active, "validating");
				const validation = parseReflectionArguments(
					prepareReflectionArguments(payload),
				);
				if (validation.valid)
					return { valid: true, value: validation.decision };
				return { valid: false, error: validation.error };
			},
			prompt: () => prompt,
			correction: (error) => buildReflectionReaskPrompt(error),
			// Existing bounded per-attempt warning before each same-child retry.
			onResponse: (observation) => {
				updateReflectionProgress(runtime, active, "validating");
				if (
					observation.outcome.kind !== "invalid" ||
					observation.attempt >= MAX_REFLECTION_REASKS ||
					!isCurrent() ||
					runtime.ctx === null
				)
					return;
				runtime.ctx.ui.notify(
					`Reflection attempt ${observation.attempt}/${MAX_REFLECTION_REASKS} invalid: ${observation.outcome.error.replace(/\.$/, "")}; retrying.`,
					"warning",
				);
			},
		});
		// Recheck currentness before durable publication; a revoked or stale
		// operation never writes entries, hooks or continuation traffic.
		// The continuation's private source must be the validated metadata of
		// the exact accepted child's terminal assistant, captured before its
		// disposal and bound to the accepted result's session — missing,
		// invalid or mismatched source fails closed with no report, hook or
		// continuation.
		if (
			result.kind === "decision" &&
			isCurrent() &&
			active.privateSource !== undefined &&
			active.privateSource.sessionId === result.sessionId
		) {
			updateReflectionProgress(runtime, active, "publishing");
			const outcome = {
				...reflectionResult(active, result.decision),
				correlation: active.correlation,
			};
			runtime.pi.appendEntry(REFLECTION_RESULT_ENTRY, outcome);
			runtime.pi.appendEntry(REFLECTION_COMPLETED_ENTRY, active.correlation);
			if (!isCurrent()) return;
			publishReflectionCompleted(runtime, result.decision);
			if (!isCurrent()) return;
			// finishReflection releases the slot and publishes the
			// continuation: native steering behind earlier messages while
			// busy, or exactly one triggered ordinary request while idle.
			finishReflection(runtime, result.decision, outcome.report);
			refreshWidget(runtime);
			return;
		}
		if (
			result.kind === "decision-failed" &&
			isCurrent() &&
			runtime.ctx !== null
		)
			runtime.ctx.ui.notify(`Reflection failed: ${result.error}`, "warning");
	} catch (error) {
		if (isCurrent() && runtime.ctx !== null)
			runtime.ctx.ui.notify(
				`Reflection failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
	} finally {
		// Every outcome — success, failure, cancellation, late stale result
		// or a throwing executor — releases the slot exactly once. Only the
		// successful path published above; the rest insert no parent traffic.
		releaseReflectionSlot(runtime, active);
	}
}

function submitReflection(runtime: Runtime, ctx: ExtensionContext): void {
	const active = runtime.activeReflection;
	if (active === undefined || !owns(runtime) || runtime.abortedHold) return;
	active.drained = runPrivateReflection(runtime, active, ctx).catch(() => {});
}

/** A queued manual request is current only while the admission-time
 * session, branch owner and scope generation all still match. Stale or
 * mismatched entries drop silently — ordinary same-ancestry progress
 * (leaf movement) never disqualifies them. */
function queuedIsCurrent(
	runtime: Runtime,
	pending: PendingReflection,
): boolean {
	const claim = runtime.claim;
	const admitted = pending.admission.claim;
	return (
		pending.admission.sessionId === runtime.sessionId &&
		pending.admission.scopeRevision === runtime.scopeRevision &&
		pending.admission.takeoverGeneration === runtime.takeoverGeneration &&
		(claim === null
			? admitted === null
			: admitted !== null &&
				claim.attachmentId === admitted.attachmentId &&
				claim.generation === admitted.generation)
	);
}

function maybeDispatch(runtime: Runtime): void {
	// Stale or mismatched queued entries are dropped silently whenever the
	// queue is inspected — never a warning, result or launch. The drop is
	// bookkeeping, not dispatch, so it runs even while the slot or the
	// abort hold blocks actual launch.
	while (runtime.manualQueue.length > 0) {
		const head = runtime.manualQueue[0];
		if (head === undefined || queuedIsCurrent(runtime, head)) break;
		runtime.manualQueue.shift();
	}
	if (!safeToDispatch(runtime) || runtime.ctx === null) return;
	if (runtime.manualQueue.length === 0) return;
	const manual = runtime.manualQueue.shift();
	if (manual === undefined) return;
	try {
		reserveReflection(runtime, manual, runtime.ctx);
	} catch (error) {
		runtime.ctx.ui.notify(
			`Reflection unavailable: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		refreshWidget(runtime);
		return;
	}
	submitReflection(runtime, runtime.ctx);
	refreshWidget(runtime);
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
		admission: {
			sessionId: runtime.sessionId,
			claim: runtime.claim
				? {
						attachmentId: runtime.claim.attachmentId,
						generation: runtime.claim.generation,
					}
				: null,
			scopeRevision: runtime.scopeRevision,
			takeoverGeneration: runtime.takeoverGeneration,
		},
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
					correlation: active.correlation,
					private: active.privateSource,
				} satisfies ReflectionContinuationDetails,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}
	// Releasing through releaseReflectionSlot keeps the queued explicit
	// manual fulfillment rule in one place — and here it runs only after
	// the continuation publish so the entries → hook → continuation order
	// always precedes the next admitted run.
	releaseReflectionSlot(runtime, active);
	if (decision?.type === "NO_ISSUE" && runtime.ctx?.mode === "tui") {
		runtime.ctx.ui.notify(`Reflect watchdog: ${decision.reason}`, "info");
	}
}

function observe(runtime: Runtime, ctx: ExtensionContext): void {
	if (runtime.stopped || runtime.attachment === null) return;
	// Parent busy OR exact-child official working counts toward domain active
	// time. Slot presence alone (waiting for events or draining after revoke)
	// never charges; ordinary loops are never inflated.
	runtime.localBusy =
		probePiAgentState(ctx).busy ||
		runtime.activeReflection?.childWorking === true;
	if (probePiAgentState(ctx).busy) runtime.hub.markBusy(runtime.attachment);
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
	// Generation bumps BEFORE any external write/reset callback: an explicit
	// takeover retires every previously admitted queued request, and the
	// reentrant window cannot fulfill one under the old identity.
	runtime.takeoverGeneration += 1;
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
		revokeActiveReflection(runtime);
		runtime.manualQueue = [];
	}
	runtime.claim = nextClaim;
	scheduleRefresh(runtime, services);
	if (!owns(runtime)) return;
	refreshWidget(runtime);
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
	runtime.unsubscribeTerminalInput?.();
	runtime.unsubscribeTerminalInput = undefined;
	const attachment = runtime.attachment;
	if (attachment !== null) runtime.hub.detach(attachment);
	runtime.attachment = null;
	runtime.claim = null;
	runtime.ctx = null;
	revokeActiveReflection(runtime);
	runtime.privateRuntime?.dispose();
	runtime.privateRuntime = undefined;
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
	readonly privateInquiry?: PrivateInquiryServices;
}

export function createWatchdogExtension(
	overrides: Partial<RuntimeServices> | WatchdogExtensionOptions = {},
): (pi: ExtensionAPI) => void {
	const structured =
		"services" in overrides ||
		"hub" in overrides ||
		"processDomain" in overrides ||
		"privateInquiry" in overrides;
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
	const privateInquiry =
		(structured
			? (overrides as WatchdogExtensionOptions).privateInquiry
			: undefined) ?? defaultPrivateInquiry;

	return (pi) => {
		const runtime: Runtime = {
			services,
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
			privateInquiry,
			reflectionSequence: 0,
			abortSettlementPending: false,
			widgetTui: null,
			widgetRegistered: false,
			abortedHold: false,
			explicitInputClock: 0,
			boundaryInputClock: 0,
			takeoverGeneration: 0,
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
		// Main Escape cannot see an idle-session private child; consume it only
		// for owned unfinished work, as an exact-child user takeover.
		const listenForEscape = (ctx: ExtensionContext): void => {
			runtime.unsubscribeTerminalInput?.();
			runtime.unsubscribeTerminalInput = undefined;
			if (ctx.mode !== "tui") return;
			// Pi builds a fresh context per event, so scope is bounded by this
			// listener's replace/shutdown lifetime, not by context identity.
			runtime.unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
				const active = runtime.activeReflection;
				if (
					!matchesKey(data, Key.escape) ||
					runtime.stopped ||
					!owns(runtime) ||
					active === undefined ||
					active.revoked ||
					!probePiAgentState(ctx).idle
				)
					return undefined;
				revokeActiveReflection(runtime);
				runtime.manualQueue = [];
				resetCycleForUserTakeover(runtime);
				refreshWidget(runtime);
				ctx.ui.notify("Reflection cancelled.", "info");
				return { consume: true };
			});
		};
		const replaceScope = async (ctx: ExtensionContext): Promise<void> => {
			runtime.configReady = false;
			runtime.scopeRevision += 1;
			if (runtime.ticker !== undefined) services.clearTimeout(runtime.ticker);
			runtime.ticker = undefined;
			revokeActiveReflection(runtime);
			runtime.manualQueue = [];
			runtime.abortBoundaryLeafId = undefined;
			runtime.abortSettlementPending = false;
			runtime.ctx = ctx;
			listenForEscape(ctx);
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

		// Branch navigation or session replacement revokes the captured source
		// synchronously: retire authority and signal the exact child at once.
		// A later-cancelled navigation never revives the private operation.
		pi.on("session_before_switch", () => {
			revokeActiveReflection(runtime);
		});
		pi.on("session_before_fork", () => {
			revokeActiveReflection(runtime);
		});
		pi.on("session_before_tree", () => {
			revokeActiveReflection(runtime);
		});

		pi.on("context", (event) => ({
			messages: reflectionContext(event.messages),
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
			listenForEscape(ctx);
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
			// Fresh user input revokes a captured-source reflection immediately;
			// its authority dies here, not when the private child settles.
			revokeActiveReflection(runtime);
			if (ctx.isIdle() && cancelAbortedRun(runtime))
				runtime.abortSettlementPending = true;
			resetCycleForUserTakeover(runtime);
			runtime.abortedHold = false;
		});

		// Input accepted before capture surfaces as a non-owned user
		// message_start; a user-triggered before_agent_start is the fallback.
		pi.on("message_start", (event, ctx) => {
			if (!scopeIsCurrent(ctx)) return;
			if (
				event.message.role === "user" &&
				runtime.activeReflection !== undefined
			) {
				revokeActiveReflection(runtime);
				observe(runtime, ctx);
			}
		});

		pi.on("before_agent_start", (event, ctx) => {
			if (!scopeIsCurrent(ctx)) return;
			if (
				event.messageType === "user" &&
				runtime.activeReflection !== undefined
			)
				revokeActiveReflection(runtime);
		});

		pi.on("message_end", (event, ctx) => {
			if (!scopeIsCurrent(ctx)) return;
			// An authoritative aborted ordinary outcome settles the abort hold;
			// provider errors stay inside Pi's native retry cycle.
			if (
				event.message.role === "assistant" &&
				event.message.stopReason === "aborted"
			) {
				if (cancelAbortedRun(runtime, runtime.abortBoundaryLeafId, true))
					runtime.abortSettlementPending = true;
			}
		});

		pi.on("turn_end", async (event, ctx) => {
			if (!scopeIsCurrent(ctx) || !isSuccessfulTurn(event)) return;
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
			const abortBoundaryLeafId = runtime.abortBoundaryLeafId;
			runtime.abortBoundaryLeafId = undefined;
			if (cancelAbortedRun(runtime, abortBoundaryLeafId)) {
				observe(runtime, ctx);
				return;
			}
			observe(runtime, ctx);
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
