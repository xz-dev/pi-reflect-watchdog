import { type WatchdogConfig } from "./config.js";
import type { PromptKind, PromptTemplateOverrides, PromptTemplates } from "./prompts.js";
export type WarningKind = PromptKind;
export interface RuntimeLimits {
    mainLoopLimit: number;
    observedTotalLoopLimit: number;
    wallClockMinutes: number;
}
export interface ControllerTransition {
    warnings: WarningKind[];
}
export interface TaskStatus {
    epoch: number;
    mainLoops: number;
    observedChildLoops: number;
    observedTotalLoops: number;
    observedChildSessions: number;
    limits: RuntimeLimits;
    configuredLimits: RuntimeLimits;
    prompts: PromptTemplates;
    latchedWarnings: WarningKind[];
    rootActive: boolean;
    wallClockElapsedMs: number;
    coverage: string;
}
export interface TaskControllerOptions extends Partial<Omit<RuntimeLimits, "wallClockMinutes">> {
    wallClockMinutes?: number;
    prompts?: PromptTemplateOverrides;
}
export declare class TaskController {
    private readonly configuredLimits;
    private readonly configuredPrompts;
    private limits;
    private promptOverrides;
    private epoch;
    private mainLoops;
    private observedChildLoops;
    private observerEpochs;
    private latched;
    private activeSince;
    private rootRunActive;
    private settledElapsedMs;
    constructor(options?: TaskControllerOptions);
    startRootTask(now: number, active?: boolean): void;
    bindObserver(observerId: string): number;
    unbindObserver(observerId: string, epoch?: number): boolean;
    completeRootTurn(now: number): ControllerTransition;
    completeObserverTurn(observerId: string, epoch: number, now: number): ControllerTransition;
    resetRuntime(now: number): void;
    setLimits(limits: Partial<RuntimeLimits>, now: number): ControllerTransition;
    restoreConfiguredDefaults(now: number): ControllerTransition;
    setPromptOverride(kind: PromptKind, template: string): void;
    resetPromptOverride(kind?: PromptKind): void;
    startRootActiveSegment(now: number): void;
    settleRootActiveSegment(now: number): void;
    evaluateWallClock(now: number): ControllerTransition;
    status(now: number): TaskStatus;
    private rearmBelowLimits;
    private evaluate;
    private latch;
    private wallClockLimitMs;
    private elapsed;
}
export declare function controllerOptionsFromConfig(config: WatchdogConfig): TaskControllerOptions;
