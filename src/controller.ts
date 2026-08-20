import type { ActivitySnapshot, ActivityStatus } from "./activity.js";
import { BUILT_IN_CONFIG, type WatchdogConfig } from "./config.js";

export type WarningKind =
	| "ROOT_LOOP_LIMIT"
	| "ALL_LOOP_LIMIT"
	| "TASK_TIME_LIMIT";

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

export interface TaskControllerOptions extends Partial<RuntimeLimits> {}

const COVERAGE =
	"All counters include the root and watchdog-enabled agent sessions in this process domain; isolated, disabled, remote, and out-of-process sessions may be absent.";

function transition(
	warnings: WarningKind[] = [],
	triggerStatus?: TaskStatus,
): ControllerTransition {
	return { warnings, triggerStatus };
}

function positiveSafeInteger(
	value: number | undefined,
	fallback: number,
): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0
		? value
		: fallback;
}

export class TaskController {
	private readonly configuredLimits: RuntimeLimits;
	private limits: RuntimeLimits;
	private epoch = 0;
	private rootLoops = 0;
	private otherAgentLoops = 0;
	private activeLoops = 0;
	private activeElapsedMs = 0;
	private taskElapsedMs = 0;
	private taskCycleSince: number | undefined;
	private observerEpochs = new Map<string, number>();
	private runningObserverEpochs = new Map<string, number>();
	private latched = new Set<WarningKind>();
	private rootRunActive = false;
	/** Start of the current aggregate-busy segment. */
	private activeSince: number | undefined;
	/** Exact all-idle timestamp used by the strict greater-than gap guard. */
	private endLoopTime: number | undefined;
	/** Start of the current global pause, used to exclude paused wall time. */
	private pausedAt: number | undefined;

	constructor(options: TaskControllerOptions = {}) {
		this.configuredLimits = {
			rootLoopLimit: positiveSafeInteger(
				options.rootLoopLimit,
				BUILT_IN_CONFIG.rootLoopLimit,
			),
			allLoopLimit: positiveSafeInteger(
				options.allLoopLimit,
				BUILT_IN_CONFIG.allLoopLimit,
			),
			taskMinutes: positiveSafeInteger(
				options.taskMinutes,
				BUILT_IN_CONFIG.taskMinutes,
			),
			idleResetGapSeconds: positiveSafeInteger(
				options.idleResetGapSeconds,
				BUILT_IN_CONFIG.idleResetGapSeconds,
			),
		};
		this.limits = { ...this.configuredLimits };
	}

	startRootTask(
		now: number,
		rootRunning = false,
	): ActivitySnapshot | undefined {
		this.epoch += 1;
		this.observerEpochs.clear();
		this.runningObserverEpochs.clear();
		if (rootRunning || this.rootRunActive) this.beginActivity(now);
		return undefined;
	}

	bindObserver(observerId: string): number {
		if (this.epoch === 0) return 0;
		this.observerEpochs.set(observerId, this.epoch);
		return this.epoch;
	}

	startObserverRun(observerId: string, now: number): void {
		if (this.observerEpochs.get(observerId) !== this.epoch) return;
		this.runningObserverEpochs.set(observerId, this.epoch);
		this.beginActivity(now);
	}

	settleObserverRun(
		observerId: string,
		epoch: number,
		now: number,
	): ActivitySnapshot | undefined {
		if (
			epoch !== this.epoch ||
			this.runningObserverEpochs.get(observerId) !== epoch
		)
			return undefined;
		this.runningObserverEpochs.delete(observerId);
		return this.closeActivityIfIdle(now);
	}

	unbindObserver(
		observerId: string,
		now: number,
		epoch?: number,
	): ActivitySnapshot | undefined {
		const boundEpoch = this.observerEpochs.get(observerId);
		if (
			boundEpoch === undefined ||
			(epoch !== undefined && boundEpoch !== epoch)
		)
			return undefined;
		this.observerEpochs.delete(observerId);
		this.runningObserverEpochs.delete(observerId);
		return this.closeActivityIfIdle(now);
	}

	completeRootTurn(now: number): ControllerTransition {
		if (this.epoch === 0) return transition();
		this.rootLoops += 1;
		this.activeLoops += 1;
		if (this.activeSince === undefined) this.beginActivity(now);
		return this.evaluate(now);
	}

	completeObserverTurn(
		observerId: string,
		epoch: number,
		now: number,
	): ControllerTransition {
		if (
			this.epoch === 0 ||
			this.observerEpochs.get(observerId) !== epoch ||
			epoch !== this.epoch
		)
			return transition();
		this.otherAgentLoops += 1;
		this.activeLoops += 1;
		return this.evaluate(now);
	}

	/** Reset the task/root/all reminder cycle while preserving the active cycle. */
	resetReminderCycle(_now: number): void {
		if (this.epoch === 0) return;
		this.rootLoops = 0;
		this.otherAgentLoops = 0;
		this.taskElapsedMs = 0;
		if (this.activeSince !== undefined) this.taskCycleSince = _now;
		this.latched.clear();
	}

	private resetWarningCycle(now: number): void {
		if (this.epoch === 0) return;
		this.resetReminderCycle(now);
		this.limits = { ...this.configuredLimits };
	}

	private resetEveryCounter(): void {
		this.rootLoops = 0;
		this.otherAgentLoops = 0;
		this.activeLoops = 0;
		this.activeElapsedMs = 0;
		this.taskElapsedMs = 0;
		this.latched.clear();
	}

	setLimits(
		limits: Partial<RuntimeLimits>,
		now: number,
		resetWarningCycle = false,
	): ControllerTransition {
		if (limits.rootLoopLimit !== undefined)
			this.limits.rootLoopLimit = positiveSafeInteger(
				limits.rootLoopLimit,
				this.limits.rootLoopLimit,
			);
		if (limits.allLoopLimit !== undefined)
			this.limits.allLoopLimit = positiveSafeInteger(
				limits.allLoopLimit,
				this.limits.allLoopLimit,
			);
		if (limits.taskMinutes !== undefined)
			this.limits.taskMinutes = positiveSafeInteger(
				limits.taskMinutes,
				this.limits.taskMinutes,
			);
		if (limits.idleResetGapSeconds !== undefined)
			this.limits.idleResetGapSeconds = positiveSafeInteger(
				limits.idleResetGapSeconds,
				this.limits.idleResetGapSeconds,
			);
		this.rearmBelowLimits(now);
		return this.evaluate(now, true, resetWarningCycle);
	}

	restoreConfiguredDefaults(
		now: number,
		resetWarningCycle = false,
	): ControllerTransition {
		this.limits = { ...this.configuredLimits };
		this.rearmBelowLimits(now);
		return this.evaluate(now, true, resetWarningCycle);
	}

	startRootActiveSegment(now: number): void {
		if (this.rootRunActive) return;
		this.rootRunActive = true;
		this.beginActivity(now);
	}

	settleRootActiveSegment(now: number): ActivitySnapshot | undefined {
		if (!this.rootRunActive) return undefined;
		this.rootRunActive = false;
		return this.closeActivityIfIdle(now);
	}

	pauseActivity(now: number): ActivitySnapshot | undefined {
		if (this.pausedAt !== undefined) return undefined;
		this.pausedAt = now;
		return this.closeActivity(now);
	}

	resumeActivity(now: number, aggregateBusy: boolean): void {
		if (this.pausedAt === undefined) return;
		const pausedDuration = Math.max(0, now - this.pausedAt);
		this.pausedAt = undefined;
		if (this.endLoopTime !== undefined) this.endLoopTime += pausedDuration;
		if (aggregateBusy) {
			this.beginActivity(now);
			return;
		}
		this.rootRunActive = false;
		this.runningObserverEpochs.clear();
		this.endLoopTime ??= now;
	}

	finalize(): void {
		this.epoch = 0;
		this.rootLoops = 0;
		this.otherAgentLoops = 0;
		this.activeLoops = 0;
		this.activeElapsedMs = 0;
		this.taskElapsedMs = 0;
		this.observerEpochs.clear();
		this.runningObserverEpochs.clear();
		this.latched.clear();
		this.rootRunActive = false;
		this.activeSince = undefined;
		this.endLoopTime = undefined;
		this.pausedAt = undefined;
		this.taskCycleSince = undefined;
	}

	evaluateTaskTime(now: number): ControllerTransition {
		if (this.epoch === 0 || this.activeSince === undefined) return transition();
		return this.evaluate(now, false);
	}

	status(now: number): TaskStatus {
		return {
			epoch: this.epoch,
			rootLoops: this.rootLoops,
			otherAgentLoops: this.otherAgentLoops,
			allLoops: this.rootLoops + this.otherAgentLoops,
			observableAgentSessions: this.observerEpochs.size,
			limits: { ...this.limits },
			configuredLimits: { ...this.configuredLimits },
			latchedWarnings: [...this.latched],
			rootActive: this.activeSince !== undefined,
			activity: {
				active: this.activeSince !== undefined,
				elapsedMs: this.activeElapsed(now),
				loops: this.activeLoops,
			},
			taskElapsedMs: this.taskElapsed(now),
			coverage: COVERAGE,
		};
	}

	private beginActivity(now: number): void {
		if (this.activeSince !== undefined) return;
		if (
			this.endLoopTime !== undefined &&
			now > this.endLoopTime + this.limits.idleResetGapSeconds * 1_000
		)
			this.resetEveryCounter();
		this.endLoopTime = undefined;
		this.activeSince = now;
		this.taskCycleSince = now;
	}

	private closeActivityIfIdle(now: number): ActivitySnapshot | undefined {
		if (this.rootRunActive || this.runningObserverEpochs.size > 0)
			return undefined;
		return this.closeActivity(now);
	}

	private closeActivity(now: number): ActivitySnapshot | undefined {
		if (this.activeSince === undefined) return undefined;
		const delta = Math.max(0, now - this.activeSince);
		this.activeElapsedMs += delta;
		this.taskElapsedMs += delta;
		this.taskCycleSince = undefined;
		this.activeSince = undefined;
		this.endLoopTime = now;
		return {
			elapsedMs: this.activeElapsedMs,
			loops: this.activeLoops,
		};
	}

	private rearmBelowLimits(now: number): void {
		if (this.rootLoops < this.limits.rootLoopLimit)
			this.latched.delete("ROOT_LOOP_LIMIT");
		if (this.rootLoops + this.otherAgentLoops < this.limits.allLoopLimit)
			this.latched.delete("ALL_LOOP_LIMIT");
		if (this.taskElapsed(now) < this.taskLimitMs())
			this.latched.delete("TASK_TIME_LIMIT");
	}

	private evaluate(
		now: number,
		includeLoops = true,
		resetWarningCycle = true,
	): ControllerTransition {
		const warnings: WarningKind[] = [];
		const total = this.rootLoops + this.otherAgentLoops;
		if (includeLoops && this.rootLoops >= this.limits.rootLoopLimit)
			this.latch("ROOT_LOOP_LIMIT", warnings);
		if (includeLoops && total >= this.limits.allLoopLimit)
			this.latch("ALL_LOOP_LIMIT", warnings);
		if (
			this.activeSince !== undefined &&
			this.taskElapsed(now) >= this.taskLimitMs()
		)
			this.latch("TASK_TIME_LIMIT", warnings);
		if (warnings.length === 0) return transition();
		const triggerStatus = this.status(now);
		if (resetWarningCycle) this.resetWarningCycle(now);
		return transition(warnings, triggerStatus);
	}

	private latch(kind: WarningKind, warnings: WarningKind[]): void {
		if (!this.latched.has(kind)) {
			this.latched.add(kind);
			warnings.push(kind);
		}
	}

	private taskLimitMs(): number {
		return this.limits.taskMinutes * 60 * 1000;
	}

	private taskElapsed(now: number): number {
		return (
			this.taskElapsedMs +
			(this.taskCycleSince === undefined
				? 0
				: Math.max(0, now - this.taskCycleSince))
		);
	}

	private activeElapsed(now: number): number {
		return (
			this.activeElapsedMs +
			(this.activeSince === undefined ? 0 : Math.max(0, now - this.activeSince))
		);
	}
}

export function controllerOptionsFromConfig(
	config: WatchdogConfig,
): TaskControllerOptions {
	return {
		rootLoopLimit: config.rootLoopLimit,
		allLoopLimit: config.allLoopLimit,
		taskMinutes: config.taskMinutes,
		idleResetGapSeconds: config.idleResetGapSeconds,
	};
}
