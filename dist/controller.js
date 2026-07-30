import { BUILT_IN_CONFIG } from "./config.js";
const COVERAGE = "Observable total includes the root and watchdog-enabled child sessions in this process; isolated, disabled, remote, and out-of-process sessions may be absent.";
function transition(warnings = []) {
    return { warnings };
}
function positiveSafeInteger(value, fallback) {
    return value !== undefined && Number.isSafeInteger(value) && value > 0
        ? value
        : fallback;
}
export class TaskController {
    configuredLimits;
    configuredPrompts;
    limits;
    promptOverrides = {};
    epoch = 0;
    mainLoops = 0;
    observedChildLoops = 0;
    observerEpochs = new Map();
    latched = new Set();
    activeSince;
    rootRunActive = false;
    settledElapsedMs = 0;
    constructor(options = {}) {
        this.configuredLimits = {
            mainLoopLimit: positiveSafeInteger(options.mainLoopLimit, BUILT_IN_CONFIG.mainLoopLimit),
            observedTotalLoopLimit: positiveSafeInteger(options.observedTotalLoopLimit, BUILT_IN_CONFIG.observedTotalLoopLimit),
            wallClockMinutes: positiveSafeInteger(options.wallClockMinutes, BUILT_IN_CONFIG.wallClockMinutes),
        };
        this.configuredPrompts = { ...BUILT_IN_CONFIG.prompts, ...options.prompts };
        this.limits = { ...this.configuredLimits };
    }
    startRootTask(now, active = false) {
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
    bindObserver(observerId) {
        if (this.epoch === 0)
            return 0;
        this.observerEpochs.set(observerId, this.epoch);
        return this.epoch;
    }
    unbindObserver(observerId, epoch) {
        const boundEpoch = this.observerEpochs.get(observerId);
        if (boundEpoch === undefined ||
            (epoch !== undefined && boundEpoch !== epoch))
            return false;
        this.observerEpochs.delete(observerId);
        return true;
    }
    completeRootTurn(now) {
        if (this.epoch === 0)
            return transition();
        this.mainLoops += 1;
        return this.evaluate(now);
    }
    completeObserverTurn(observerId, epoch, now) {
        if (this.epoch === 0 ||
            this.observerEpochs.get(observerId) !== epoch ||
            epoch !== this.epoch)
            return transition();
        this.observedChildLoops += 1;
        return this.evaluate(now);
    }
    resetRuntime(now) {
        if (this.epoch === 0)
            return;
        this.mainLoops = 0;
        this.observedChildLoops = 0;
        this.latched.clear();
        this.settledElapsedMs = 0;
        this.activeSince = this.activeSince === undefined ? undefined : now;
    }
    setLimits(limits, now) {
        if (limits.mainLoopLimit !== undefined)
            this.limits.mainLoopLimit = positiveSafeInteger(limits.mainLoopLimit, this.limits.mainLoopLimit);
        if (limits.observedTotalLoopLimit !== undefined)
            this.limits.observedTotalLoopLimit = positiveSafeInteger(limits.observedTotalLoopLimit, this.limits.observedTotalLoopLimit);
        if (limits.wallClockMinutes !== undefined)
            this.limits.wallClockMinutes = positiveSafeInteger(limits.wallClockMinutes, this.limits.wallClockMinutes);
        this.rearmBelowLimits(now);
        return this.evaluate(now);
    }
    restoreConfiguredDefaults(now) {
        this.limits = { ...this.configuredLimits };
        this.rearmBelowLimits(now);
        return this.evaluate(now);
    }
    setPromptOverride(kind, template) {
        this.promptOverrides[kind] = template;
    }
    resetPromptOverride(kind) {
        if (kind === undefined)
            this.promptOverrides = {};
        else
            delete this.promptOverrides[kind];
    }
    startRootActiveSegment(now) {
        this.rootRunActive = true;
        if (this.epoch !== 0 && this.activeSince === undefined) {
            this.activeSince = now;
            this.settledElapsedMs = 0;
        }
    }
    settleRootActiveSegment(now) {
        this.rootRunActive = false;
        if (this.activeSince === undefined)
            return;
        this.settledElapsedMs = Math.max(0, now - this.activeSince);
        this.activeSince = undefined;
    }
    evaluateWallClock(now) {
        if (this.epoch === 0 || this.activeSince === undefined)
            return transition();
        return this.evaluate(now, false);
    }
    status(now) {
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
    rearmBelowLimits(now) {
        if (this.mainLoops < this.limits.mainLoopLimit)
            this.latched.delete("mainLoopLimitReached");
        if (this.mainLoops + this.observedChildLoops <
            this.limits.observedTotalLoopLimit)
            this.latched.delete("observedTotalLoopLimitReached");
        if (this.elapsed(now) < this.wallClockLimitMs())
            this.latched.delete("wallClockLimitReached");
    }
    evaluate(now, includeLoops = true) {
        const warnings = [];
        const total = this.mainLoops + this.observedChildLoops;
        if (includeLoops && this.mainLoops >= this.limits.mainLoopLimit)
            this.latch("mainLoopLimitReached", warnings);
        if (includeLoops && total >= this.limits.observedTotalLoopLimit)
            this.latch("observedTotalLoopLimitReached", warnings);
        if (this.activeSince !== undefined &&
            this.elapsed(now) >= this.wallClockLimitMs())
            this.latch("wallClockLimitReached", warnings);
        return transition(warnings);
    }
    latch(kind, warnings) {
        if (!this.latched.has(kind)) {
            this.latched.add(kind);
            warnings.push(kind);
        }
    }
    wallClockLimitMs() {
        return this.limits.wallClockMinutes * 60 * 1000;
    }
    elapsed(now) {
        return this.activeSince === undefined
            ? this.settledElapsedMs
            : Math.max(0, now - this.activeSince);
    }
}
export function controllerOptionsFromConfig(config) {
    return {
        mainLoopLimit: config.mainLoopLimit,
        observedTotalLoopLimit: config.observedTotalLoopLimit,
        wallClockMinutes: config.wallClockMinutes,
        prompts: { ...config.prompts },
    };
}
