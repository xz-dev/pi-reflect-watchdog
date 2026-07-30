/**
 * Root activity tracker: pairs root-only active time with completed root
 * turns inside the current automatic activity window.
 *
 * The window is deliberately separate from the watchdog's manual-reset cycle
 * counters. It resets only on automatic boundaries: the root agent settling,
 * or an interjecting/new root user message replacing a currently active
 * window. Threshold crossings and runtime controls never touch it.
 *
 * A root user message while idle arms the window so the next agent run
 * accrues from its agent_start; a root user message inside an active run
 * continues accruing (Pi emits no agent_start between a steering/interjected
 * message and the run that consumes it).
 *
 * All state is instance-scoped and every clock value comes from the caller,
 * so behavior is deterministic in tests.
 */
export interface ActivityStatus {
    /** True while the current window is accruing active time. */
    active: boolean;
    /** Root-only active milliseconds in the current window, excluding idle. */
    elapsedMs: number;
    /** Completed root turns in the current window. */
    loops: number;
}
export interface ActivitySnapshot {
    elapsedMs: number;
    loops: number;
}
export declare class RootActivityTracker {
    /** A root agent run is in flight (seen agent_start without a later settle). */
    private rootRunActive;
    /** A root user message arrived while idle; the next run starts the window. */
    private pendingTask;
    /** Start time of the current segment; undefined while no window is begun. */
    private activeSince;
    private activeLoops;
    /**
     * Record the start of a root agent run. A window armed by a root user
     * message while idle begins accruing here; a run without a task (Pi emits
     * agent_start before the first user message) begins nothing by itself.
     */
    beginRun(now: number): void;
    /**
     * A root user message starts (or interrupts) a task. When a begun window
     * exists, it is reset and its snapshot returned; an interjection during an
     * idle gap arms the next run and returns undefined.
     */
    startRootTask(now: number): ActivitySnapshot | undefined;
    /** Count one completed root turn in the current window. */
    completeRootTurn(): void;
    /**
     * The root agent settled. A begun window is reset and its snapshot
     * returned; a settle without a begun window returns undefined.
     */
    settle(now: number): ActivitySnapshot | undefined;
    /** Drop all state without emitting anything (demotion/shutdown). */
    finalize(): void;
    status(now: number): ActivityStatus;
    private snapshot;
}
