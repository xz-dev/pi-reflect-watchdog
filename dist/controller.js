import { BUILT_IN_CONFIG } from "./config.js";
const COVERAGE = "All counters include the root and watchdog-enabled agent sessions in this process domain; isolated, disabled, remote, and out-of-process sessions may be absent.";
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
    rootLoops = 0;
    otherAgentLoops = 0;
    activeLoops = 0;
    activeElapsedMs = 0;
    taskElapsedMs = 0;
    taskCycleSince;
    observerEpochs = new Map();
    runningObserverEpochs = new Map();
    latched = new Set();
    rootRunActive = false;
    /** Start of the current aggregate-busy segment. */
    activeSince;
    /** Exact all-idle timestamp used by the strict greater-than gap guard. */
    endLoopTime;
    constructor(options = {}) {
        this.configuredLimits = {
            rootLoopLimit: positiveSafeInteger(options.rootLoopLimit, BUILT_IN_CONFIG.rootLoopLimit),
            allLoopLimit: positiveSafeInteger(options.allLoopLimit, BUILT_IN_CONFIG.allLoopLimit),
            taskMinutes: positiveSafeInteger(options.taskMinutes, BUILT_IN_CONFIG.taskMinutes),
            idleResetGapSeconds: positiveSafeInteger(options.idleResetGapSeconds, BUILT_IN_CONFIG.idleResetGapSeconds),
        };
        this.limits = { ...this.configuredLimits };
    }
    startRootTask(now, rootRunning = false) {
        this.epoch += 1;
        this.observerEpochs.clear();
        this.runningObserverEpochs.clear();
        if (rootRunning || this.rootRunActive)
            this.beginActivity(now);
        return undefined;
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
        this.beginActivity(now);
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
        this.rootLoops += 1;
        this.activeLoops += 1;
        if (this.activeSince === undefined)
            this.beginActivity(now);
        return this.evaluate(now);
    }
    completeObserverTurn(observerId, epoch, now) {
        if (this.epoch === 0 ||
            this.observerEpochs.get(observerId) !== epoch ||
            epoch !== this.epoch)
            return transition();
        this.otherAgentLoops += 1;
        this.activeLoops += 1;
        return this.evaluate(now);
    }
    /** Reset the task/root/all reminder cycle while preserving the active cycle. */
    resetReminderCycle(_now) {
        if (this.epoch === 0)
            return;
        this.rootLoops = 0;
        this.otherAgentLoops = 0;
        this.taskElapsedMs = 0;
        if (this.activeSince !== undefined)
            this.taskCycleSince = _now;
        this.latched.clear();
    }
    resetWarningCycle(now) {
        if (this.epoch === 0)
            return;
        this.resetReminderCycle(now);
        this.limits = { ...this.configuredLimits };
    }
    resetEveryCounter() {
        this.rootLoops = 0;
        this.otherAgentLoops = 0;
        this.activeLoops = 0;
        this.activeElapsedMs = 0;
        this.taskElapsedMs = 0;
        this.latched.clear();
    }
    setLimits(limits, now, resetWarningCycle = false) {
        if (limits.rootLoopLimit !== undefined)
            this.limits.rootLoopLimit = positiveSafeInteger(limits.rootLoopLimit, this.limits.rootLoopLimit);
        if (limits.allLoopLimit !== undefined)
            this.limits.allLoopLimit = positiveSafeInteger(limits.allLoopLimit, this.limits.allLoopLimit);
        if (limits.taskMinutes !== undefined)
            this.limits.taskMinutes = positiveSafeInteger(limits.taskMinutes, this.limits.taskMinutes);
        if (limits.idleResetGapSeconds !== undefined)
            this.limits.idleResetGapSeconds = positiveSafeInteger(limits.idleResetGapSeconds, this.limits.idleResetGapSeconds);
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
        this.beginActivity(now);
    }
    settleRootActiveSegment(now) {
        if (!this.rootRunActive)
            return undefined;
        this.rootRunActive = false;
        return this.closeActivityIfIdle(now);
    }
    finalize() {
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
        this.taskCycleSince = undefined;
    }
    evaluateTaskTime(now) {
        if (this.epoch === 0 || this.activeSince === undefined)
            return transition();
        return this.evaluate(now, false);
    }
    status(now) {
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
    beginActivity(now) {
        if (this.activeSince !== undefined)
            return;
        if (this.endLoopTime !== undefined &&
            now > this.endLoopTime + this.limits.idleResetGapSeconds * 1_000)
            this.resetEveryCounter();
        this.endLoopTime = undefined;
        this.activeSince = now;
        this.taskCycleSince = now;
    }
    closeActivityIfIdle(now) {
        if (this.rootRunActive || this.runningObserverEpochs.size > 0)
            return undefined;
        return this.closeActivity(now);
    }
    closeActivity(now) {
        if (this.activeSince === undefined)
            return undefined;
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
    rearmBelowLimits(now) {
        if (this.rootLoops < this.limits.rootLoopLimit)
            this.latched.delete("ROOT_LOOP_LIMIT");
        if (this.rootLoops + this.otherAgentLoops < this.limits.allLoopLimit)
            this.latched.delete("ALL_LOOP_LIMIT");
        if (this.taskElapsed(now) < this.taskLimitMs())
            this.latched.delete("TASK_TIME_LIMIT");
    }
    evaluate(now, includeLoops = true, resetWarningCycle = true) {
        const warnings = [];
        const total = this.rootLoops + this.otherAgentLoops;
        if (includeLoops && this.rootLoops >= this.limits.rootLoopLimit)
            this.latch("ROOT_LOOP_LIMIT", warnings);
        if (includeLoops && total >= this.limits.allLoopLimit)
            this.latch("ALL_LOOP_LIMIT", warnings);
        if (this.activeSince !== undefined &&
            this.taskElapsed(now) >= this.taskLimitMs())
            this.latch("TASK_TIME_LIMIT", warnings);
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
    taskLimitMs() {
        return this.limits.taskMinutes * 60 * 1000;
    }
    taskElapsed(now) {
        return (this.taskElapsedMs +
            (this.taskCycleSince === undefined
                ? 0
                : Math.max(0, now - this.taskCycleSince)));
    }
    activeElapsed(now) {
        return (this.activeElapsedMs +
            (this.activeSince === undefined ? 0 : Math.max(0, now - this.activeSince)));
    }
}
export function controllerOptionsFromConfig(config) {
    return {
        rootLoopLimit: config.rootLoopLimit,
        allLoopLimit: config.allLoopLimit,
        taskMinutes: config.taskMinutes,
        idleResetGapSeconds: config.idleResetGapSeconds,
    };
}
