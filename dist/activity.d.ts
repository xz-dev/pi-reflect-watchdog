/** Aggregate active-cycle projection used by the local status fallback. */
export interface ActivityStatus {
    /** True while the active cycle is currently accruing ordinary work. */
    active: boolean;
    /** Aggregate active milliseconds, frozen at the all-idle edge. */
    elapsedMs: number;
    /** Ordinary turns completed by every observable agent in the active cycle. */
    loops: number;
}
export interface ActivitySnapshot {
    elapsedMs: number;
    loops: number;
}
export declare class RootActivityTracker {
    private readonly idleResetGapSeconds;
    /** A root agent run is in flight (seen agent_start without a later settle). */
    private rootRunActive;
    /** A root user message arrived while idle; the next run resumes the cycle. */
    private pendingTask;
    private activeSince;
    private endLoopTime;
    private elapsedMs;
    private loops;
    constructor(idleResetGapSeconds?: number);
    /**
     * A user-armed run resumes the active cycle. Exactly the configured idle
     * gap resumes; only a strictly longer gap starts a fresh active cycle.
     */
    beginRun(now: number): void;
    /** A root user message arms work without resetting reminder counters. */
    startRootTask(now: number): ActivitySnapshot | undefined;
    completeRootTurn(): void;
    /** Freeze the active cycle immediately at the all-idle edge. */
    settle(now: number): ActivitySnapshot | undefined;
    finalize(): void;
    status(now: number): ActivityStatus;
}
