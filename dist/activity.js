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
const ZERO = { active: false, elapsedMs: 0, loops: 0 };
export class RootActivityTracker {
    /** A root agent run is in flight (seen agent_start without a later settle). */
    rootRunActive = false;
    /** A root user message arrived while idle; the next run starts the window. */
    pendingTask = false;
    /** Start time of the current segment; undefined while no window is begun. */
    activeSince;
    activeLoops = 0;
    /**
     * Record the start of a root agent run. A window armed by a root user
     * message while idle begins accruing here; a run without a task (Pi emits
     * agent_start before the first user message) begins nothing by itself.
     */
    beginRun(now) {
        this.rootRunActive = true;
        if (this.pendingTask && this.activeSince === undefined) {
            this.activeSince = now;
            this.activeLoops = 0;
        }
        this.pendingTask = false;
    }
    /**
     * A root user message starts (or interrupts) a task. When a begun window
     * exists, it is reset and its snapshot returned; an interjection during an
     * idle gap arms the next run and returns undefined.
     */
    startRootTask(now) {
        const snapshot = this.activeSince === undefined ? undefined : this.snapshot(now);
        this.activeLoops = 0;
        if (this.rootRunActive) {
            this.activeSince = now;
            this.pendingTask = false;
        }
        else {
            this.activeSince = undefined;
            this.pendingTask = true;
        }
        return snapshot;
    }
    /** Count one completed root turn in the current window. */
    completeRootTurn() {
        if (this.activeSince !== undefined)
            this.activeLoops += 1;
    }
    /**
     * The root agent settled. A begun window is reset and its snapshot
     * returned; a settle without a begun window returns undefined.
     */
    settle(now) {
        this.rootRunActive = false;
        const snapshot = this.activeSince === undefined ? undefined : this.snapshot(now);
        this.activeSince = undefined;
        this.activeLoops = 0;
        return snapshot;
    }
    /** Drop all state without emitting anything (demotion/shutdown). */
    finalize() {
        this.rootRunActive = false;
        this.pendingTask = false;
        this.activeSince = undefined;
        this.activeLoops = 0;
    }
    status(now) {
        if (this.activeSince === undefined)
            return { ...ZERO };
        return {
            active: true,
            elapsedMs: Math.max(0, now - this.activeSince),
            loops: this.activeLoops,
        };
    }
    snapshot(now) {
        return {
            elapsedMs: Math.max(0, now - (this.activeSince ?? now)),
            loops: this.activeLoops,
        };
    }
}
