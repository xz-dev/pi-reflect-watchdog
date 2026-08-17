import type { WarningKind } from "./controller.js";
export declare const REFLECTION_ROOT_TAG = "reflection";
export declare const MAX_REFLECTION_TEXT_CHARACTERS = 16384;
export declare const MAX_REFLECTION_TOOL_CALLS = 10;
/** Maximum total invalid XML attempts, matching the continue-watchdog contract. */
export declare const MAX_REFLECTION_REASKS = 3;
export type ReflectionType = "NO_ISSUE" | "ROUTE_CORRECTION";
export type ReflectionTriggerReason = WarningKind | "USER_REQUEST";
export interface ReflectionDecision {
    readonly type: ReflectionType;
    readonly reason: string;
    readonly done: string;
    readonly currentStep: string;
    readonly nextStep: string;
}
export interface ReflectionThresholdSnapshot {
    readonly rootLoops: number;
    readonly rootLoopLimit: number;
    readonly domainLoops: number;
    readonly domainLoopLimit: number;
    readonly continuousDomainActiveMs: number;
    readonly continuousDomainActiveMinutes: number;
}
export interface ReflectionPromptContext {
    readonly semanticPrefix: string;
    readonly timestamp: string;
    readonly reasons: readonly ReflectionTriggerReason[];
    readonly thresholds: ReflectionThresholdSnapshot;
    readonly userSupplement?: string;
    readonly previousReflection?: {
        readonly timestamp: string;
        readonly report: string;
    };
}
export type ReflectionValidation = {
    readonly valid: true;
    readonly decision: ReflectionDecision;
} | {
    readonly valid: false;
    readonly error: string;
};
/** Extract one unique bare trailing reflection XML document, case-insensitively. */
export declare function extractTrailingReflectionXml(text: string): string | null;
/** Parse required case-insensitive tags while rejecting duplicate required fields. */
export declare function parseReflectionXml(text: string): ReflectionValidation;
/** Append all non-customizable facts and parser constraints to the semantic prefix. */
export declare function buildReflectionPrompt(context: ReflectionPromptContext): string;
export declare function buildReflectionReaskPrompt(error: string): string;
