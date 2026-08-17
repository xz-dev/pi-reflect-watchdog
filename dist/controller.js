import { BUILT_IN_CONFIG } from "./config.js";
const COVERAGE = "Observable total includes the root and watchdog-enabled child sessions in this process; isolated, disabled, remote, and out-of-process sessions may be absent.";
function transition(warnings = [], triggerStatus) {
    return { warnings, triggerStatus };
}
function positiveSafeInteger(value, fallback) {
    return value !== undefined && Number.isSafeInteger(value) && value > 0
        ? value
        : fallback;
}
export class TaskController {
    configuredLimits;
    limits;
    epoch = 0;
    mainLoops = 0;
    activeLoops = 0;
    observedChildLoops = 0;
    observerEpochs = new Map();
    runningObserverEpochs = new Map();
    latched = new Set();
    /** Root agent run may begin before Pi delivers the first root user message. */
    rootRunActive = false;
    /** A root user task awaits its first root or observable-child participant. */
    pendingRootTask = false;
    /** Current epoch's active-window start; undefined when no participant runs. */
    activeSince;
    /** Root-only timer start; it freezes as soon as the root settles. */
    rootActiveSince;
    settledElapsedMs = 0;
    constructor(options = {}) {
        this.configuredLimits = {
            mainLoopLimit: positiveSafeInteger(options.mainLoopLimit, BUILT_IN_CONFIG.mainLoopLimit),
            observedTotalLoopLimit: positiveSafeInteger(options.observedTotalLoopLimit, BUILT_IN_CONFIG.observedTotalLoopLimit),
            wallClockMinutes: positiveSafeInteger(options.wallClockMinutes, BUILT_IN_CONFIG.wallClockMinutes),
        };
        this.limits = { ...this.configuredLimits };
    }
    startRootTask(now, rootRunning = false) {
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
    bindObserver(observerId) {
        if (this.epoch === 0)
            return 0;
        this.observerEpochs.set(observerId, this.epoch);
        return this.epoch;
    }
    startObserverRun(observerId, now) {
        if (this.observerEpochs.get(observerId) !== this.epoch)
            return;
        this.runningObserverEpochs.set(observerId, this.epoch);
        if (this.activeSince === undefined) {
            this.activeSince = now;
            this.pendingRootTask = false;
        }
    }
    settleObserverRun(observerId, epoch, now) {
        if (epoch !== this.epoch ||
            this.runningObserverEpochs.get(observerId) !== epoch)
            return undefined;
        this.runningObserverEpochs.delete(observerId);
        return this.closeActivityIfIdle(now);
    }
    unbindObserver(observerId, now, epoch) {
        const boundEpoch = this.observerEpochs.get(observerId);
        if (boundEpoch === undefined ||
            (epoch !== undefined && boundEpoch !== epoch))
            return undefined;
        this.observerEpochs.delete(observerId);
        this.runningObserverEpochs.delete(observerId);
        return this.closeActivityIfIdle(now);
    }
    completeRootTurn(now) {
        if (this.epoch === 0)
            return transition();
        this.mainLoops += 1;
        if (this.activeSince !== undefined)
            this.activeLoops += 1;
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
        if (this.rootActiveSince !== undefined)
            this.rootActiveSince = now;
    }
    resetWarningCycle(now) {
        if (this.epoch === 0)
            return;
        this.resetRuntime(now);
        this.limits = { ...this.configuredLimits };
    }
    setLimits(limits, now, resetWarningCycle = false) {
        if (limits.mainLoopLimit !== undefined)
            this.limits.mainLoopLimit = positiveSafeInteger(limits.mainLoopLimit, this.limits.mainLoopLimit);
        if (limits.observedTotalLoopLimit !== undefined)
            this.limits.observedTotalLoopLimit = positiveSafeInteger(limits.observedTotalLoopLimit, this.limits.observedTotalLoopLimit);
        if (limits.wallClockMinutes !== undefined)
            this.limits.wallClockMinutes = positiveSafeInteger(limits.wallClockMinutes, this.limits.wallClockMinutes);
        this.rearmBelowLimits(now);
        return this.evaluate(now, true, resetWarningCycle);
    }
    restoreConfiguredDefaults(now, resetWarningCycle = false) {
        this.limits = { ...this.configuredLimits };
        this.rearmBelowLimits(now);
        return this.evaluate(now, true, resetWarningCycle);
    }
    startRootActiveSegment(now) {
        if (this.rootRunActive)
            return;
        this.rootRunActive = true;
        // A root start joins an already-active task (for example, while a bound
        // child holds it open). A start after full quiescence is admission only;
        // the following root user message establishes the next task.
        if (this.activeSince !== undefined) {
            this.rootActiveSince = now;
            return;
        }
        if (!this.pendingRootTask)
            return;
        this.pendingRootTask = false;
        this.rootActiveSince = now;
        this.activeSince = now;
        this.settledElapsedMs = 0;
    }
    settleRootActiveSegment(now) {
        if (!this.rootRunActive)
            return undefined;
        this.rootRunActive = false;
        if (this.rootActiveSince !== undefined) {
            this.settledElapsedMs += Math.max(0, now - this.rootActiveSince);
            this.rootActiveSince = undefined;
        }
        return this.closeActivityIfIdle(now);
    }
    finalize() {
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
    evaluateWallClock(now) {
        if (this.epoch === 0 || this.rootActiveSince === undefined)
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
    closeActivityIfIdle(now) {
        if (this.rootActiveSince !== undefined ||
            this.runningObserverEpochs.size > 0)
            return undefined;
        return this.closeActivity(now);
    }
    closeActivity(now) {
        if (this.activeSince === undefined)
            return undefined;
        const snapshot = {
            elapsedMs: this.activityElapsed(now),
            loops: this.activeLoops,
        };
        this.activeSince = undefined;
        this.activeLoops = 0;
        this.pendingRootTask = false;
        return snapshot;
    }
    rearmBelowLimits(now) {
        if (this.mainLoops < this.limits.mainLoopLimit)
            this.latched.delete("ROOT_LOOP_LIMIT");
        if (this.mainLoops + this.observedChildLoops <
            this.limits.observedTotalLoopLimit)
            this.latched.delete("DOMAIN_LOOP_LIMIT");
        if (this.elapsed(now) < this.wallClockLimitMs())
            this.latched.delete("CONTINUOUS_DOMAIN_ACTIVE_TIME");
    }
    evaluate(now, includeLoops = true, resetWarningCycle = true) {
        const warnings = [];
        const total = this.mainLoops + this.observedChildLoops;
        if (includeLoops && this.mainLoops >= this.limits.mainLoopLimit)
            this.latch("ROOT_LOOP_LIMIT", warnings);
        if (includeLoops && total >= this.limits.observedTotalLoopLimit)
            this.latch("DOMAIN_LOOP_LIMIT", warnings);
        if (this.rootActiveSince !== undefined &&
            this.elapsed(now) >= this.wallClockLimitMs())
            this.latch("CONTINUOUS_DOMAIN_ACTIVE_TIME", warnings);
        if (warnings.length === 0)
            return transition();
        const triggerStatus = this.status(now);
        if (resetWarningCycle)
            this.resetWarningCycle(now);
        return transition(warnings, triggerStatus);
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
        return (this.settledElapsedMs +
            (this.rootActiveSince === undefined
                ? 0
                : Math.max(0, now - this.rootActiveSince)));
    }
    activityElapsed(now) {
        return this.activeSince === undefined
            ? 0
            : Math.max(0, now - this.activeSince);
    }
}
export function controllerOptionsFromConfig(config) {
    return {
        mainLoopLimit: config.mainLoopLimit,
        observedTotalLoopLimit: config.observedTotalLoopLimit,
        wallClockMinutes: config.wallClockMinutes,
    };
}
