import type { ActivitySnapshot, ActivityStatus } from "./activity.js";
import { BUILT_IN_CONFIG, type WatchdogConfig } from "./config.js";
export type WarningKind =
	| "ROOT_LOOP_LIMIT"
	| "DOMAIN_LOOP_LIMIT"
	| "CONTINUOUS_DOMAIN_ACTIVE_TIME";

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

export interface TaskControllerOptions
	extends Partial<Omit<RuntimeLimits, "wallClockMinutes">> {
	wallClockMinutes?: number;
}

const COVERAGE =
	"Observable total includes the root and watchdog-enabled child sessions in this process; isolated, disabled, remote, and out-of-process sessions may be absent.";

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
	private mainLoops = 0;
	private activeLoops = 0;
	private observedChildLoops = 0;
	private observerEpochs = new Map<string, number>();
	private runningObserverEpochs = new Map<string, number>();
	private latched = new Set<WarningKind>();
	/** Root agent run may begin before Pi delivers the first root user message. */
	private rootRunActive = false;
	/** A root user task awaits its first root or observable-child participant. */
	private pendingRootTask = false;
	/** Current epoch's active-window start; undefined when no participant runs. */
	private activeSince: number | undefined;
	/** Root-only timer start; it freezes as soon as the root settles. */
	private rootActiveSince: number | undefined;
	private settledElapsedMs = 0;

	constructor(options: TaskControllerOptions = {}) {
		this.configuredLimits = {
			mainLoopLimit: positiveSafeInteger(
				options.mainLoopLimit,
				BUILT_IN_CONFIG.mainLoopLimit,
			),
			observedTotalLoopLimit: positiveSafeInteger(
				options.observedTotalLoopLimit,
				BUILT_IN_CONFIG.observedTotalLoopLimit,
			),
			wallClockMinutes: positiveSafeInteger(
				options.wallClockMinutes,
				BUILT_IN_CONFIG.wallClockMinutes,
			),
		};
		this.limits = { ...this.configuredLimits };
	}

	startRootTask(
		now: number,
		rootRunning = false,
	): ActivitySnapshot | undefined {
		const snapshot = this.closeActivity(now);
		this.epoch += 1;
		this.mainLoops = 0;
		this.activeLoops = 0;
		this.observedChildLoops = 0;
		this.observerEpochs.clear();
		this.runningObserverEpochs.clear();
		this.latched.clear();
		this.limits = { ...this.configuredLimits };
		this.settledElapsedMs = 0;
		const rootActive = rootRunning || this.rootRunActive;
		this.pendingRootTask = !rootActive;
		this.rootActiveSince = rootActive ? now : undefined;
		this.activeSince = rootActive ? now : undefined;
		return snapshot;
	}

	bindObserver(observerId: string): number {
		if (this.epoch === 0) return 0;
		this.observerEpochs.set(observerId, this.epoch);
		return this.epoch;
	}

	startObserverRun(observerId: string, now: number): void {
		if (this.observerEpochs.get(observerId) !== this.epoch) return;
		this.runningObserverEpochs.set(observerId, this.epoch);
		if (this.activeSince === undefined) {
			this.activeSince = now;
			this.pendingRootTask = false;
		}
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
		this.mainLoops += 1;
		if (this.activeSince !== undefined) this.activeLoops += 1;
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
		this.observedChildLoops += 1;
		return this.evaluate(now);
	}

	resetRuntime(now: number): void {
		if (this.epoch === 0) return;
		this.mainLoops = 0;
		this.observedChildLoops = 0;
		this.latched.clear();
		this.settledElapsedMs = 0;
		if (this.rootActiveSince !== undefined) this.rootActiveSince = now;
	}

	private resetWarningCycle(now: number): void {
		if (this.epoch === 0) return;
		this.resetRuntime(now);
		this.limits = { ...this.configuredLimits };
	}

	setLimits(
		limits: Partial<RuntimeLimits>,
		now: number,
		resetWarningCycle = false,
	): ControllerTransition {
		if (limits.mainLoopLimit !== undefined)
			this.limits.mainLoopLimit = positiveSafeInteger(
				limits.mainLoopLimit,
				this.limits.mainLoopLimit,
			);
		if (limits.observedTotalLoopLimit !== undefined)
			this.limits.observedTotalLoopLimit = positiveSafeInteger(
				limits.observedTotalLoopLimit,
				this.limits.observedTotalLoopLimit,
			);
		if (limits.wallClockMinutes !== undefined)
			this.limits.wallClockMinutes = positiveSafeInteger(
				limits.wallClockMinutes,
				this.limits.wallClockMinutes,
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
		// A root start joins an already-active task (for example, while a bound
		// child holds it open). A start after full quiescence is admission only;
		// the following root user message establishes the next task.
		if (this.activeSince !== undefined) {
			this.rootActiveSince = now;
			return;
		}
		if (!this.pendingRootTask) return;
		this.pendingRootTask = false;
		this.rootActiveSince = now;
		this.activeSince = now;
		this.settledElapsedMs = 0;
	}

	settleRootActiveSegment(now: number): ActivitySnapshot | undefined {
		if (!this.rootRunActive) return undefined;
		this.rootRunActive = false;
		if (this.rootActiveSince !== undefined) {
			this.settledElapsedMs += Math.max(0, now - this.rootActiveSince);
			this.rootActiveSince = undefined;
		}
		return this.closeActivityIfIdle(now);
	}

	finalize(): void {
		this.epoch = 0;
		this.mainLoops = 0;
		this.activeLoops = 0;
		this.observedChildLoops = 0;
		this.observerEpochs.clear();
		this.runningObserverEpochs.clear();
		this.latched.clear();
		this.rootRunActive = false;
		this.pendingRootTask = false;
		this.activeSince = undefined;
		this.rootActiveSince = undefined;
		this.settledElapsedMs = 0;
	}

	evaluateWallClock(now: number): ControllerTransition {
		if (this.epoch === 0 || this.rootActiveSince === undefined)
			return transition();
		return this.evaluate(now, false);
	}

	status(now: number): TaskStatus {
		return {
			epoch: this.epoch,
			mainLoops: this.mainLoops,
			observedChildLoops: this.observedChildLoops,
			observedTotalLoops: this.mainLoops + this.observedChildLoops,
			observedChildSessions: this.observerEpochs.size,
			limits: { ...this.limits },
			configuredLimits: { ...this.configuredLimits },
			latchedWarnings: [...this.latched],
			rootActive: this.rootActiveSince !== undefined,
			activity: {
				active: this.activeSince !== undefined,
				elapsedMs: this.activityElapsed(now),
				loops: this.activeSince === undefined ? 0 : this.activeLoops,
			},
			wallClockElapsedMs: this.elapsed(now),
			coverage: COVERAGE,
		};
	}

	private closeActivityIfIdle(now: number): ActivitySnapshot | undefined {
		if (
			this.rootActiveSince !== undefined ||
			this.runningObserverEpochs.size > 0
		)
			return undefined;
		return this.closeActivity(now);
	}

	private closeActivity(now: number): ActivitySnapshot | undefined {
		if (this.activeSince === undefined) return undefined;
		const snapshot = {
			elapsedMs: this.activityElapsed(now),
			loops: this.activeLoops,
		};
		this.activeSince = undefined;
		this.activeLoops = 0;
		this.pendingRootTask = false;
		return snapshot;
	}

	private rearmBelowLimits(now: number): void {
		if (this.mainLoops < this.limits.mainLoopLimit)
			this.latched.delete("ROOT_LOOP_LIMIT");
		if (
			this.mainLoops + this.observedChildLoops <
			this.limits.observedTotalLoopLimit
		)
			this.latched.delete("DOMAIN_LOOP_LIMIT");
		if (this.elapsed(now) < this.wallClockLimitMs())
			this.latched.delete("CONTINUOUS_DOMAIN_ACTIVE_TIME");
	}

	private evaluate(
		now: number,
		includeLoops = true,
		resetWarningCycle = true,
	): ControllerTransition {
		const warnings: WarningKind[] = [];
		const total = this.mainLoops + this.observedChildLoops;
		if (includeLoops && this.mainLoops >= this.limits.mainLoopLimit)
			this.latch("ROOT_LOOP_LIMIT", warnings);
		if (includeLoops && total >= this.limits.observedTotalLoopLimit)
			this.latch("DOMAIN_LOOP_LIMIT", warnings);
		if (
			this.rootActiveSince !== undefined &&
			this.elapsed(now) >= this.wallClockLimitMs()
		)
			this.latch("CONTINUOUS_DOMAIN_ACTIVE_TIME", warnings);
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

	private wallClockLimitMs(): number {
		return this.limits.wallClockMinutes * 60 * 1000;
	}

	private elapsed(now: number): number {
		return (
			this.settledElapsedMs +
			(this.rootActiveSince === undefined
				? 0
				: Math.max(0, now - this.rootActiveSince))
		);
	}

	private activityElapsed(now: number): number {
		return this.activeSince === undefined
			? 0
			: Math.max(0, now - this.activeSince);
	}
}

export function controllerOptionsFromConfig(
	config: WatchdogConfig,
): TaskControllerOptions {
	return {
		mainLoopLimit: config.mainLoopLimit,
		observedTotalLoopLimit: config.observedTotalLoopLimit,
		wallClockMinutes: config.wallClockMinutes,
	};
}
