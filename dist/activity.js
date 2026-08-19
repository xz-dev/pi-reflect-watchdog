/** Aggregate active-cycle projection used by the local status fallback. */
const ZERO = { active: false, elapsedMs: 0, loops: 0 };
export class RootActivityTracker {
    idleResetGapSeconds;
    /** A root agent run is in flight (seen agent_start without a later settle). */
    rootRunActive = false;
    /** A root user message arrived while idle; the next run resumes the cycle. */
    pendingTask = false;
    activeSince;
    endLoopTime;
    elapsedMs = 0;
    loops = 0;
    constructor(idleResetGapSeconds = 60) {
        this.idleResetGapSeconds = idleResetGapSeconds;
    }
    /**
     * A user-armed run resumes the active cycle. Exactly the configured idle
     * gap resumes; only a strictly longer gap starts a fresh active cycle.
     */
    beginRun(now) {
        this.rootRunActive = true;
        if (this.pendingTask && this.activeSince === undefined) {
            if (this.endLoopTime !== undefined &&
                now > this.endLoopTime + this.idleResetGapSeconds * 1_000) {
                this.elapsedMs = 0;
                this.loops = 0;
            }
            this.endLoopTime = undefined;
            this.activeSince = now;
        }
        this.pendingTask = false;
    }
    /** A root user message arms work without resetting reminder counters. */
    startRootTask(now) {
        if (this.rootRunActive) {
            this.pendingTask = false;
            if (this.activeSince === undefined)
                this.activeSince = now;
            this.endLoopTime = undefined;
        }
        else {
            this.pendingTask = true;
        }
        return undefined;
    }
    completeRootTurn() {
        if (this.activeSince !== undefined)
            this.loops += 1;
    }
    /** Freeze the active cycle immediately at the all-idle edge. */
    settle(now) {
        this.rootRunActive = false;
        if (this.activeSince === undefined)
            return undefined;
        this.elapsedMs += Math.max(0, now - this.activeSince);
        this.activeSince = undefined;
        this.endLoopTime = now;
        return { elapsedMs: this.elapsedMs, loops: this.loops };
    }
    finalize() {
        this.rootRunActive = false;
        this.pendingTask = false;
        this.activeSince = undefined;
        this.endLoopTime = undefined;
        this.elapsedMs = 0;
        this.loops = 0;
    }
    status(now) {
        if (this.activeSince === undefined)
            return { active: false, elapsedMs: this.elapsedMs, loops: this.loops };
        if (this.elapsedMs === 0 &&
            this.loops === 0 &&
            this.endLoopTime === undefined)
            return {
                ...ZERO,
                active: true,
                elapsedMs: Math.max(0, now - this.activeSince),
            };
        return {
            active: true,
            elapsedMs: this.elapsedMs + Math.max(0, now - this.activeSince),
            loops: this.loops,
        };
    }
}
