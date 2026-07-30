import { BUILT_IN_CONFIG, type WatchdogConfig } from "./config.js";
import type {
	PromptKind,
	PromptTemplateOverrides,
	PromptTemplates,
} from "./prompts.js";

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

export interface TaskControllerOptions
	extends Partial<Omit<RuntimeLimits, "wallClockMinutes">> {
	wallClockMinutes?: number;
	prompts?: PromptTemplateOverrides;
}

const COVERAGE =
	"Observable total includes the root and watchdog-enabled child sessions in this process; isolated, disabled, remote, and out-of-process sessions may be absent.";

function transition(warnings: WarningKind[] = []): ControllerTransition {
	return { warnings };
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
	private readonly configuredPrompts: PromptTemplates;
	private limits: RuntimeLimits;
	private promptOverrides: PromptTemplateOverrides = {};
	private epoch = 0;
	private mainLoops = 0;
	private observedChildLoops = 0;
	private observerEpochs = new Map<string, number>();
	private latched = new Set<WarningKind>();
	private activeSince: number | undefined;
	private rootRunActive = false;
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
		this.configuredPrompts = { ...BUILT_IN_CONFIG.prompts, ...options.prompts };
		this.limits = { ...this.configuredLimits };
	}

	startRootTask(now: number, active = false): void {
		this.epoch += 1;
		this.mainLoops = 0;
		this.observedChildLoops = 0;
		this.observerEpochs.clear();
		this.latched.clear();
		this.limits = { ...this.configuredLimits };
		this.promptOverrides = {};
		this.activeSince = active || this.rootRunActive ? now : undefined;
		this.settledElapsedMs = 0;
	}

	bindObserver(observerId: string): number {
		if (this.epoch === 0) return 0;
		this.observerEpochs.set(observerId, this.epoch);
		return this.epoch;
	}

	unbindObserver(observerId: string, epoch?: number): boolean {
		const boundEpoch = this.observerEpochs.get(observerId);
		if (
			boundEpoch === undefined ||
			(epoch !== undefined && boundEpoch !== epoch)
		)
			return false;
		this.observerEpochs.delete(observerId);
		return true;
	}

	completeRootTurn(now: number): ControllerTransition {
		if (this.epoch === 0) return transition();
		this.mainLoops += 1;
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
		this.activeSince = this.activeSince === undefined ? undefined : now;
	}

	setLimits(limits: Partial<RuntimeLimits>, now: number): ControllerTransition {
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
		return this.evaluate(now);
	}

	restoreConfiguredDefaults(now: number): ControllerTransition {
		this.limits = { ...this.configuredLimits };
		this.rearmBelowLimits(now);
		return this.evaluate(now);
	}

	setPromptOverride(kind: PromptKind, template: string): void {
		this.promptOverrides[kind] = template;
	}

	resetPromptOverride(kind?: PromptKind): void {
		if (kind === undefined) this.promptOverrides = {};
		else delete this.promptOverrides[kind];
	}

	startRootActiveSegment(now: number): void {
		this.rootRunActive = true;
		if (this.epoch !== 0 && this.activeSince === undefined) {
			this.activeSince = now;
			this.settledElapsedMs = 0;
		}
	}

	settleRootActiveSegment(now: number): void {
		this.rootRunActive = false;
		if (this.activeSince === undefined) return;
		this.settledElapsedMs = Math.max(0, now - this.activeSince);
		this.activeSince = undefined;
	}

	evaluateWallClock(now: number): ControllerTransition {
		if (this.epoch === 0 || this.activeSince === undefined) return transition();
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
			prompts: { ...this.configuredPrompts, ...this.promptOverrides },
			latchedWarnings: [...this.latched],
			rootActive: this.activeSince !== undefined,
			wallClockElapsedMs: this.elapsed(now),
			coverage: COVERAGE,
		};
	}

	private rearmBelowLimits(now: number): void {
		if (this.mainLoops < this.limits.mainLoopLimit)
			this.latched.delete("mainLoopLimitReached");
		if (
			this.mainLoops + this.observedChildLoops <
			this.limits.observedTotalLoopLimit
		)
			this.latched.delete("observedTotalLoopLimitReached");
		if (this.elapsed(now) < this.wallClockLimitMs())
			this.latched.delete("wallClockLimitReached");
	}

	private evaluate(now: number, includeLoops = true): ControllerTransition {
		const warnings: WarningKind[] = [];
		const total = this.mainLoops + this.observedChildLoops;
		if (includeLoops && this.mainLoops >= this.limits.mainLoopLimit)
			this.latch("mainLoopLimitReached", warnings);
		if (includeLoops && total >= this.limits.observedTotalLoopLimit)
			this.latch("observedTotalLoopLimitReached", warnings);
		if (
			this.activeSince !== undefined &&
			this.elapsed(now) >= this.wallClockLimitMs()
		)
			this.latch("wallClockLimitReached", warnings);
		return transition(warnings);
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
		return this.activeSince === undefined
			? this.settledElapsedMs
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
		prompts: { ...config.prompts },
	};
}
