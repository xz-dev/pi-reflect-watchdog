import type { ActivitySnapshot, ActivityStatus } from "./activity.js";
import { type WatchdogConfig } from "./config.js";
export type WarningKind = "ROOT_LOOP_LIMIT" | "DOMAIN_LOOP_LIMIT" | "CONTINUOUS_DOMAIN_ACTIVE_TIME";
export interface RuntimeLimits {
    mainLoopLimit: number;
    observedTotalLoopLimit: number;
    wallClockMinutes: number;
}
export interface ControllerTransition {
    warnings: WarningKind[];
    /** Immutable status captured immediately before a warning resets its cycle. */
    triggerStatus?: TaskStatus;
}
export interface TaskStatus {
    epoch: number;
    mainLoops: number;
    observedChildLoops: number;
    observedTotalLoops: number;
    observedChildSessions: number;
    limits: RuntimeLimits;
    configuredLimits: RuntimeLimits;
    latchedWarnings: WarningKind[];
    /** True only while the root agent is running; drives root-only wall-clock warnings. */
    rootActive: boolean;
    /** Root and bound-running child activity for the current root epoch. */
    activity: ActivityStatus;
    wallClockElapsedMs: number;
    coverage: string;
}
export interface TaskControllerOptions extends Partial<Omit<RuntimeLimits, "wallClockMinutes">> {
    wallClockMinutes?: number;
}
export declare class TaskController {
    private readonly configuredLimits;
    private limits;
    private epoch;
    private mainLoops;
    private activeLoops;
    private observedChildLoops;
    private observerEpochs;
    private runningObserverEpochs;
    private latched;
    /** Root agent run may begin before Pi delivers the first root user message. */
    private rootRunActive;
    /** A root user task awaits its first root or observable-child participant. */
    private pendingRootTask;
    /** Current epoch's active-window start; undefined when no participant runs. */
    private activeSince;
    /** Root-only timer start; it freezes as soon as the root settles. */
    private rootActiveSince;
    private settledElapsedMs;
    constructor(options?: TaskControllerOptions);
    startRootTask(now: number, rootRunning?: boolean): ActivitySnapshot | undefined;
    bindObserver(observerId: string): number;
    startObserverRun(observerId: string, now: number): void;
    settleObserverRun(observerId: string, epoch: number, now: number): ActivitySnapshot | undefined;
    unbindObserver(observerId: string, now: number, epoch?: number): ActivitySnapshot | undefined;
    completeRootTurn(now: number): ControllerTransition;
    completeObserverTurn(observerId: string, epoch: number, now: number): ControllerTransition;
    resetRuntime(now: number): void;
    private resetWarningCycle;
    setLimits(limits: Partial<RuntimeLimits>, now: number, resetWarningCycle?: boolean): ControllerTransition;
    restoreConfiguredDefaults(now: number, resetWarningCycle?: boolean): ControllerTransition;
    startRootActiveSegment(now: number): void;
    settleRootActiveSegment(now: number): ActivitySnapshot | undefined;
    finalize(): void;
    evaluateWallClock(now: number): ControllerTransition;
    status(now: number): TaskStatus;
    private closeActivityIfIdle;
    private closeActivity;
    private rearmBelowLimits;
    private evaluate;
    private latch;
    private wallClockLimitMs;
    private elapsed;
    private activityElapsed;
}
export declare function controllerOptionsFromConfig(config: WatchdogConfig): TaskControllerOptions;
