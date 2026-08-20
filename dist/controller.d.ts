import type { ActivitySnapshot, ActivityStatus } from "./activity.js";
import { type WatchdogConfig } from "./config.js";
export type WarningKind = "ROOT_LOOP_LIMIT" | "ALL_LOOP_LIMIT" | "TASK_TIME_LIMIT";
export interface RuntimeLimits {
    rootLoopLimit: number;
    allLoopLimit: number;
    taskMinutes: number;
    idleResetGapSeconds: number;
}
export interface ControllerTransition {
    warnings: WarningKind[];
    /** Immutable status captured immediately before a warning resets its cycle. */
    triggerStatus?: TaskStatus;
}
export interface TaskStatus {
    epoch: number;
    rootLoops: number;
    otherAgentLoops: number;
    allLoops: number;
    observableAgentSessions: number;
    limits: RuntimeLimits;
    configuredLimits: RuntimeLimits;
    latchedWarnings: WarningKind[];
    /** True while any observable agent is running ordinary work. */
    rootActive: boolean;
    /** Frozen or live active-cycle aggregate, including all observable agents. */
    activity: ActivityStatus;
    taskElapsedMs: number;
    coverage: string;
}
export interface TaskControllerOptions extends Partial<RuntimeLimits> {
}
export declare class TaskController {
    private readonly configuredLimits;
    private limits;
    private epoch;
    private rootLoops;
    private otherAgentLoops;
    private activeLoops;
    private activeElapsedMs;
    private taskElapsedMs;
    private taskCycleSince;
    private observerEpochs;
    private runningObserverEpochs;
    private latched;
    private rootRunActive;
    /** Start of the current aggregate-busy segment. */
    private activeSince;
    /** Exact all-idle timestamp used by the strict greater-than gap guard. */
    private endLoopTime;
    /** Start of the current global pause, used to exclude paused wall time. */
    private pausedAt;
    constructor(options?: TaskControllerOptions);
    startRootTask(now: number, rootRunning?: boolean): ActivitySnapshot | undefined;
    bindObserver(observerId: string): number;
    startObserverRun(observerId: string, now: number): void;
    settleObserverRun(observerId: string, epoch: number, now: number): ActivitySnapshot | undefined;
    unbindObserver(observerId: string, now: number, epoch?: number): ActivitySnapshot | undefined;
    completeRootTurn(now: number): ControllerTransition;
    completeObserverTurn(observerId: string, epoch: number, now: number): ControllerTransition;
    /** Reset the task/root/all reminder cycle while preserving the active cycle. */
    resetReminderCycle(_now: number): void;
    private resetWarningCycle;
    private resetEveryCounter;
    setLimits(limits: Partial<RuntimeLimits>, now: number, resetWarningCycle?: boolean): ControllerTransition;
    restoreConfiguredDefaults(now: number, resetWarningCycle?: boolean): ControllerTransition;
    startRootActiveSegment(now: number): void;
    settleRootActiveSegment(now: number): ActivitySnapshot | undefined;
    pauseActivity(now: number): ActivitySnapshot | undefined;
    resumeActivity(now: number, aggregateBusy: boolean): void;
    finalize(): void;
    evaluateTaskTime(now: number): ControllerTransition;
    status(now: number): TaskStatus;
    private beginActivity;
    private closeActivityIfIdle;
    private closeActivity;
    private rearmBelowLimits;
    private evaluate;
    private latch;
    private taskLimitMs;
    private taskElapsed;
    private activeElapsed;
}
export declare function controllerOptionsFromConfig(config: WatchdogConfig): TaskControllerOptions;
