import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReflectionDecision, ReflectionThresholdSnapshot, ReflectionTriggerReason } from "./reflection-protocol.js";
export declare const REFLECTION_HISTORY_ENTRY_TYPE = "pi-reflect-watchdog:reflection";
export declare const REFLECTION_HISTORY_VERSION = 1;
export declare const MAX_HISTORY_RESULT_ITEMS = 100;
export interface ReflectionHistoryEntry {
    readonly version: 1;
    readonly timestamp: string;
    readonly reasons: readonly ReflectionTriggerReason[];
    readonly thresholds: ReflectionThresholdSnapshot;
    readonly userSupplement?: string;
    readonly decision: ReflectionDecision;
    readonly report: string;
}
export type ReflectionHistoryQuery = {
    readonly latest: true;
} | {
    readonly index: number;
} | {
    readonly range: {
        readonly start: number;
        readonly end: number;
    };
};
export declare function parseReflectionHistoryData(value: unknown): ReflectionHistoryEntry | null;
export declare function reflectionHistory(sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">): ReflectionHistoryEntry[];
export declare function queryReflectionHistory(history: readonly ReflectionHistoryEntry[], query: ReflectionHistoryQuery): ReflectionHistoryEntry[];
export declare function formatReflectionReport(entry: Omit<ReflectionHistoryEntry, "version" | "report">): string;
export declare function formatHistoryResult(entries: readonly ReflectionHistoryEntry[], firstOrdinal?: number): string;
