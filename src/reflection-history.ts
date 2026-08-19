import type {
	CustomEntry,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	ReflectionDecision,
	ReflectionThresholdSnapshot,
	ReflectionTriggerReason,
} from "./reflection-protocol.js";

export const REFLECTION_HISTORY_ENTRY_TYPE = "pi-reflect-watchdog:reflection";
export const REFLECTION_HISTORY_VERSION = 1;
export const MAX_HISTORY_RESULT_ITEMS = 100;

export interface ReflectionHistoryEntry {
	readonly version: 1;
	readonly timestamp: string;
	readonly reasons: readonly ReflectionTriggerReason[];
	readonly thresholds: ReflectionThresholdSnapshot;
	readonly userSupplement?: string;
	readonly decision: ReflectionDecision;
	readonly report: string;
}

export type ReflectionHistoryQuery =
	| { readonly latest: true }
	| { readonly index: number }
	| { readonly range: { readonly start: number; readonly end: number } };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecision(value: unknown): value is ReflectionDecision {
	if (!isObject(value)) return false;
	return (
		(value.type === "NO_ISSUE" || value.type === "ROUTE_CORRECTION") &&
		["reason", "done", "currentStep", "nextStep"].every(
			(key) => typeof value[key] === "string" && value[key].trim().length > 0,
		)
	);
}

function isThresholds(value: unknown): value is ReflectionThresholdSnapshot {
	if (!isObject(value)) return false;
	return [
		"activeMs",
		"activeLoops",
		"taskMs",
		"taskMinutes",
		"rootLoops",
		"rootLoopLimit",
		"allLoops",
		"allLoopLimit",
	].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
}

export function parseReflectionHistoryData(
	value: unknown,
): ReflectionHistoryEntry | null {
	if (!isObject(value)) return null;
	if (
		value.version !== REFLECTION_HISTORY_VERSION ||
		typeof value.timestamp !== "string" ||
		Number.isNaN(Date.parse(value.timestamp)) ||
		!Array.isArray(value.reasons) ||
		value.reasons.length === 0 ||
		!value.reasons.every(
			(reason) =>
				reason === "ROOT_LOOP_LIMIT" ||
				reason === "ALL_LOOP_LIMIT" ||
				reason === "TASK_TIME_LIMIT" ||
				reason === "USER_REQUEST",
		) ||
		!isThresholds(value.thresholds) ||
		!isDecision(value.decision) ||
		typeof value.report !== "string" ||
		value.report.trim().length === 0 ||
		(value.userSupplement !== undefined &&
			typeof value.userSupplement !== "string")
	)
		return null;
	return value as unknown as ReflectionHistoryEntry;
}

export function reflectionHistory(
	sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">,
): ReflectionHistoryEntry[] {
	const history: ReflectionHistoryEntry[] = [];
	for (const entry of sessionManager.getBranch()) {
		if (
			entry.type !== "custom" ||
			entry.customType !== REFLECTION_HISTORY_ENTRY_TYPE
		)
			continue;
		const parsed = parseReflectionHistoryData(
			(entry as CustomEntry<unknown>).data,
		);
		if (parsed !== null) history.push(parsed);
	}
	return history;
}

export function queryReflectionHistory(
	history: readonly ReflectionHistoryEntry[],
	query: ReflectionHistoryQuery,
): ReflectionHistoryEntry[] {
	if ("latest" in query) {
		const latest = history.at(-1);
		return latest === undefined ? [] : [latest];
	}
	if ("index" in query) {
		if (!Number.isSafeInteger(query.index) || query.index < 1)
			throw new Error("index must be a positive 1-based ordinal");
		const entry = history[query.index - 1];
		return entry === undefined ? [] : [entry];
	}
	const { start, end } = query.range;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 1 ||
		end < start
	)
		throw new Error("range must use positive 1-based start <= end ordinals");
	if (end - start + 1 > MAX_HISTORY_RESULT_ITEMS)
		throw new Error(
			`range may include at most ${MAX_HISTORY_RESULT_ITEMS} entries`,
		);
	return history.slice(start - 1, end);
}

export function formatReflectionReport(
	entry: Omit<ReflectionHistoryEntry, "version" | "report">,
): string {
	const supplement = entry.userSupplement?.trim();
	return [
		`Reflection · ${entry.decision.type}`,
		`Time: ${entry.timestamp}`,
		`Trigger: ${entry.reasons.join(", ")}`,
		`Thresholds: active=${entry.thresholds.activeMs}ms/${entry.thresholds.activeLoops} loops; task=${entry.thresholds.taskMs}ms/${entry.thresholds.taskMinutes}m; root=${entry.thresholds.rootLoops}/${entry.thresholds.rootLoopLimit}; all=${entry.thresholds.allLoops}/${entry.thresholds.allLoopLimit}`,
		`User supplement: ${supplement ? supplement : "(none)"}`,
		`Reason: ${entry.decision.reason}`,
		`Done: ${entry.decision.done}`,
		`Current step: ${entry.decision.currentStep}`,
		`Next step: ${entry.decision.nextStep}`,
	].join("\n");
}

export function formatHistoryResult(
	entries: readonly ReflectionHistoryEntry[],
	firstOrdinal = 1,
): string {
	if (entries.length === 0)
		return "No completed reflections on the current branch.";
	return entries
		.map((entry, index) => `#${firstOrdinal + index}\n${entry.report}`)
		.join("\n\n");
}
