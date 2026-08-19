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

const ZERO: ActivityStatus = { active: false, elapsedMs: 0, loops: 0 };

export class RootActivityTracker {
	/** A root agent run is in flight (seen agent_start without a later settle). */
	private rootRunActive = false;
	/** A root user message arrived while idle; the next run resumes the cycle. */
	private pendingTask = false;
	private activeSince: number | undefined;
	private endLoopTime: number | undefined;
	private elapsedMs = 0;
	private loops = 0;

	constructor(private readonly idleResetGapSeconds = 60) {}

	/**
	 * A user-armed run resumes the active cycle. Exactly the configured idle
	 * gap resumes; only a strictly longer gap starts a fresh active cycle.
	 */
	beginRun(now: number): void {
		this.rootRunActive = true;
		if (this.pendingTask && this.activeSince === undefined) {
			if (
				this.endLoopTime !== undefined &&
				now > this.endLoopTime + this.idleResetGapSeconds * 1_000
			) {
				this.elapsedMs = 0;
				this.loops = 0;
			}
			this.endLoopTime = undefined;
			this.activeSince = now;
		}
		this.pendingTask = false;
	}

	/** A root user message arms work without resetting reminder counters. */
	startRootTask(now: number): ActivitySnapshot | undefined {
		if (this.rootRunActive) {
			this.pendingTask = false;
			if (this.activeSince === undefined) this.activeSince = now;
			this.endLoopTime = undefined;
		} else {
			this.pendingTask = true;
		}
		return undefined;
	}

	completeRootTurn(): void {
		if (this.activeSince !== undefined) this.loops += 1;
	}

	/** Freeze the active cycle immediately at the all-idle edge. */
	settle(now: number): ActivitySnapshot | undefined {
		this.rootRunActive = false;
		if (this.activeSince === undefined) return undefined;
		this.elapsedMs += Math.max(0, now - this.activeSince);
		this.activeSince = undefined;
		this.endLoopTime = now;
		return { elapsedMs: this.elapsedMs, loops: this.loops };
	}

	finalize(): void {
		this.rootRunActive = false;
		this.pendingTask = false;
		this.activeSince = undefined;
		this.endLoopTime = undefined;
		this.elapsedMs = 0;
		this.loops = 0;
	}

	status(now: number): ActivityStatus {
		if (this.activeSince === undefined)
			return { active: false, elapsedMs: this.elapsedMs, loops: this.loops };
		if (
			this.elapsedMs === 0 &&
			this.loops === 0 &&
			this.endLoopTime === undefined
		)
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
