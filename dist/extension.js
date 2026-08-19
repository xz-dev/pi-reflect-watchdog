import { StringEnum, Type } from "@earendil-works/pi-ai";
import { createInquiryRuntime, foldInquiryContext, } from "pi-extension-utils/pi-inquiry";
import { loadRuntimeConfig } from "./config-loader.js";
import { controllerOptionsFromConfig, TaskController, } from "./controller.js";
import { parseReflectWatchdogCommand, REFLECT_COMMAND, REFLECT_TIMELINE_COMMAND, REFLECT_WATCHDOG_COMMAND, } from "./controls.js";
import { createFatalExitAdapter } from "./fatal-exit.js";
import { allocateAttachmentToken, claimRoot, getHub, isCurrentRoot, releaseRoot, } from "./hub.js";
import { getReflectDomainCoordinator, isReflectDomainFatalError, } from "./process-domain.js";
import { formatHistoryResult, formatReflectionReport, queryReflectionHistory, REFLECTION_HISTORY_ENTRY_TYPE, reflectionHistory, } from "./reflection-history.js";
import { buildReflectionPrompt, buildReflectionReaskPrompt, MAX_REFLECTION_REASKS, MAX_REFLECTION_TOOL_CALLS, parseReflectionXml, } from "./reflection-protocol.js";
import { createReflectionEntryRenderer, showReflectionTimeline, } from "./reflection-timeline.js";
import { createWatchdogWidget, formatDuration, WIDGET_KEY, } from "./widget.js";
const STATUS_KEY = "pi-reflect-watchdog";
const TOOL_NAME = "reflect_watchdog_control";
const HISTORY_COUNT_TOOL_NAME = "reflect_history_count";
const HISTORY_GET_TOOL_NAME = "reflect_history_get";
const CONTROL_TOOL_NAMES = new Set([
    TOOL_NAME,
    HISTORY_COUNT_TOOL_NAME,
    HISTORY_GET_TOOL_NAME,
]);
const REFLECTION_INQUIRY_NAMESPACE = "pi-reflect-watchdog";
const REFLECTION_MESSAGE_TYPE = `${REFLECTION_INQUIRY_NAMESPACE}:inquiry`;
const REFLECTION_ENTRY_TYPE = REFLECTION_HISTORY_ENTRY_TYPE;
// Node clamps any setTimeout delay above 2^31-1 ms to 1 ms, which would fire
// the task threshold far too early. Large valid limits are instead
// scheduled as capped chunks that recompute the exact remaining delay.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// The dedicated TUI widget shows seconds, so it refreshes at about one
// second while the root is active and stops entirely while idle. The wall-
// clock threshold timer is a separate role and keeps its exact semantics.
const WIDGET_TICK_MS = 1_000;
const RPC_STATUS_TICK_MS = 30_000;
const defaultServices = {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
    loadConfig: loadRuntimeConfig,
    processDomain: getReflectDomainCoordinator(),
    fatalExit: createFatalExitAdapter(),
};
function positiveSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function elapsed(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return `${seconds} second${seconds === 1 ? "" : "s"}`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
function priority(ctx) {
    return ctx.hasUI ? 2 : 1;
}
function rootIsCurrent(runtime) {
    return (runtime.state === "root" &&
        runtime.root !== undefined &&
        runtime.controller !== undefined &&
        runtime.ctx !== undefined &&
        isCurrentRoot(getHub(), runtime.token, runtime.root.generation));
}
function scheduleTimer(services, role, callback, delay) {
    return (services.scheduleTimer?.(role, callback, delay) ??
        services.setTimeout(callback, delay));
}
function clearTimers(runtime, services) {
    if (runtime.timer)
        services.clearTimeout(runtime.timer);
    if (runtime.ticker)
        services.clearTimeout(runtime.ticker);
    runtime.timer = undefined;
    runtime.ticker = undefined;
    // Invalidate callbacks that a host may still deliver after clearTimeout;
    // staleness is scoped to the root generation and task epoch.
    runtime.timerLifecycle = undefined;
}
function removeControlTool(runtime) {
    if (!runtime.toolRegistered)
        return;
    // Dynamic tool state is public API. Remove only our name so unrelated tools stay active.
    runtime.pi.setActiveTools(runtime.pi.getActiveTools().filter((name) => !CONTROL_TOOL_NAMES.has(name)));
}
function deactivate(runtime, services) {
    clearTimers(runtime, services);
    runtime.domainCounterUnsubscribe?.();
    runtime.domainCounterUnsubscribe = undefined;
    if (runtime.domainAttached) {
        runtime.domainAttached = false;
        const detach = () => {
            void services.processDomain.detach(runtime).catch(() => { });
        };
        if (runtime.pausedForReflection)
            void services.processDomain
                .resume()
                .catch(() => { })
                .finally(detach);
        else
            detach();
    }
    runtime.domainCounters = undefined;
    runtime.runActivity = "pending";
    clearWidget(runtime);
    if (runtime.ctx)
        runtime.ctx.ui.setStatus(STATUS_KEY, undefined);
    removeControlTool(runtime);
    runtime.observerBinding = undefined;
    runtime.root = undefined;
    runtime.controller?.finalize();
    runtime.controller = undefined;
    runtime.ctx = undefined;
    runtime.sessionManager = undefined;
    runtime.config = undefined;
    runtime.reflectionQueue = [];
    runtime.activeReflection = undefined;
    runtime.pausedForReflection = false;
    runtime.resumeAfterReflectionTurn = false;
    runtime.suppressNextRootTurn = false;
    if (runtime.state !== "shutdown")
        runtime.state = "observer";
}
function safeCounterNumber(value) {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return Number(value > max ? max : value);
}
function statusLine(status, counters) {
    return `WD active ${safeCounterNumber(counters?.activeLoops.value ?? BigInt(status.activity.loops))} loops · task ${elapsed(safeCounterNumber(counters?.taskMs.value ?? BigInt(status.taskElapsedMs)))}/${status.limits.taskMinutes}m · root ${safeCounterNumber(counters?.rootLoops.value ?? BigInt(status.rootLoops))}/${status.limits.rootLoopLimit} · all ${safeCounterNumber(counters?.allLoops.value ?? BigInt(status.allLoops))}/${status.limits.allLoopLimit}`;
}
function widgetState(runtime, now) {
    const status = runtime.controller.status(now);
    const counters = runtime.domainCounters;
    return {
        activity: {
            active: counters?.anyBusy ?? status.activity.active,
            elapsedMs: safeCounterNumber(counters?.activeMs.value ?? BigInt(status.activity.elapsedMs)),
            loops: safeCounterNumber(counters?.activeLoops.value ?? BigInt(status.activity.loops)),
        },
        taskElapsedMs: safeCounterNumber(counters?.taskMs.value ?? BigInt(status.taskElapsedMs)),
        taskMinutes: status.limits.taskMinutes,
        rootLoops: safeCounterNumber(counters?.rootLoops.value ?? BigInt(status.rootLoops)),
        rootLoopLimit: status.limits.rootLoopLimit,
        allLoops: safeCounterNumber(counters?.allLoops.value ?? BigInt(status.allLoops)),
        allLoopLimit: status.limits.allLoopLimit,
    };
}
// The TUI widget owns its status line. RPC retains the footer status because
// it is the only non-TUI mode where that status is meaningful.
function updateStatus(runtime, services) {
    if (!rootIsCurrent(runtime) || runtime.ctx.mode !== "rpc")
        return;
    runtime.ctx.ui.setStatus(STATUS_KEY, statusLine(runtime.controller.status(services.now()), runtime.domainCounters));
}
function installWidget(runtime, services) {
    if (!rootIsCurrent(runtime) || runtime.ctx.mode !== "tui")
        return;
    const ctx = runtime.ctx;
    const owner = {};
    runtime.widgetOwner = owner;
    runtime.widgetRequestRender = undefined;
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        // A factory can be invoked after its widget has been replaced. Only the
        // current root/context/widget instance may retain this TUI callback.
        if (rootIsCurrent(runtime) &&
            runtime.ctx === ctx &&
            runtime.widgetOwner === owner)
            runtime.widgetRequestRender = () => tui.requestRender();
        return createWatchdogWidget(theme, () => widgetState(runtime, services.now()));
    }, { placement: "belowEditor" });
    ctx.ui.setStatus(STATUS_KEY, undefined);
}
function clearWidget(runtime) {
    // Clear first: queued timers and late factory calls must never redraw a
    // removed, demoted, shut-down, or replaced context.
    runtime.widgetRequestRender = undefined;
    runtime.widgetOwner = undefined;
    if (runtime.ctx?.mode === "tui")
        runtime.ctx.ui.setWidget(WIDGET_KEY, undefined);
}
// The freeze notification is user-only TUI output. Pi exposes no reliable
// public user-abort provenance at agent_settled, so the wording stays
// neutral and the line never enters the model context or triggers a turn.
function emitActiveCycleFrozenNotification(runtime, snapshot) {
    if (snapshot === undefined || !rootIsCurrent(runtime))
        return;
    if (runtime.ctx.mode !== "tui")
        return;
    runtime.ctx.ui.notify(`Watchdog active frozen | active ${formatDuration(snapshot.elapsedMs)}/${snapshot.loops} loops`, "info");
}
function scheduleTimers(runtime, services) {
    clearTimers(runtime, services);
    if (!rootIsCurrent(runtime) ||
        runtime.activeReflection !== undefined ||
        runtime.reflectionQueue.length > 0)
        return;
    const generation = runtime.root.generation;
    const epoch = runtime.controller.status(services.now()).epoch;
    const lifecycle = { generation, epoch };
    runtime.timerLifecycle = lifecycle;
    // Each scheduled callback fires exactly once; a host that delivers a
    // callback again (or after clearTimeout) hits the consumed flag and the
    // superseded lifecycle token, never the live state.
    const stale = (fired) => {
        if (fired.consumed)
            return true;
        fired.consumed = true;
        return (!rootIsCurrent(runtime) ||
            runtime.timerLifecycle !== lifecycle ||
            runtime.controller.status(services.now()).epoch !== epoch);
    };
    // scheduleWallClock runs at most once per timer callback; early delivery
    // rearms the remaining delay in place instead of stacking timers.
    const scheduleWallClock = () => {
        const status = runtime.controller.status(services.now());
        if (!status.rootActive)
            return;
        const remaining = status.limits.taskMinutes * 60_000 - status.taskElapsedMs;
        if (remaining <= 0) {
            // Already at or beyond the boundary (a rearmed limit can land there):
            // evaluate exactly once instead of scheduling a zero-delay timer.
            deliverWarnings(runtime, runtime.controller.evaluateTaskTime(services.now()), services);
            return;
        }
        const fired = { consumed: false };
        runtime.timer = scheduleTimer(services, "threshold", () => {
            if (stale(fired))
                return;
            runtime.timer = undefined;
            const delivered = deliverWarnings(runtime, runtime.controller.evaluateTaskTime(services.now()), services);
            // A warning reset creates a fresh timer lifecycle. Only an early or
            // capped callback without a warning may rearm this lifecycle in place.
            if (!delivered)
                scheduleWallClock();
            updateStatus(runtime, services);
        }, Math.min(remaining, MAX_TIMER_DELAY_MS));
        runtime.timer.unref?.();
    };
    // Once attached, the watchdog-owned activeMs state is the sole
    // cross-process wall-threshold authority. A parallel local timer can race
    // one snapshot broadcast ahead and enqueue a reflection with a stale
    // snapshot (for example 59000ms at the 60000ms boundary).
    if (!runtime.domainAttached)
        scheduleWallClock();
    const scheduleRefreshTick = (role, delay, refresh) => {
        const fired = { consumed: false };
        runtime.ticker = scheduleTimer(services, role, () => {
            if (stale(fired))
                return;
            runtime.ticker = undefined;
            refresh();
            scheduleRefreshTick(role, delay, refresh);
        }, delay);
        runtime.ticker.unref?.();
    };
    // Refresh roles are deliberately mode-specific. The widget needs a
    // second-level redraw while any current-epoch participant runs; RPC keeps
    // its established bounded footer refresh; print/json/headless have no
    // changing UI surface to refresh.
    if (!runtime.controller.status(services.now()).activity.active)
        return;
    if (runtime.ctx.mode === "tui")
        scheduleRefreshTick("tui-refresh", WIDGET_TICK_MS, () => {
            runtime.widgetRequestRender?.();
        });
    else if (runtime.ctx.mode === "rpc")
        scheduleRefreshTick("rpc-status", RPC_STATUS_TICK_MS, () => updateStatus(runtime, services));
}
function thresholdSnapshot(status, counters) {
    return {
        activeMs: Number(counters?.activeMs.value ?? BigInt(status.activity.elapsedMs)),
        activeLoops: Number(counters?.activeLoops.value ?? BigInt(status.activity.loops)),
        taskMs: Number(counters?.taskMs.value ?? BigInt(status.taskElapsedMs)),
        taskMinutes: status.limits.taskMinutes,
        rootLoops: Number(counters?.rootLoops.value ?? BigInt(status.rootLoops)),
        rootLoopLimit: status.limits.rootLoopLimit,
        allLoops: Number(counters?.allLoops.value ?? BigInt(status.allLoops)),
        allLoopLimit: status.limits.allLoopLimit,
    };
}
function domainThresholdReasons(runtime, counters) {
    if (!counters.certain ||
        counters.taskMs.paused ||
        counters.rootLoops.paused ||
        counters.allLoops.paused ||
        counters.activeMs.paused ||
        counters.activeLoops.paused)
        return [];
    const status = runtime.controller.status(Date.now());
    const reasons = [];
    if (counters.rootLoops.value >= BigInt(status.limits.rootLoopLimit))
        reasons.push("ROOT_LOOP_LIMIT");
    if (counters.allLoops.value >= BigInt(status.limits.allLoopLimit))
        reasons.push("ALL_LOOP_LIMIT");
    if (counters.taskMs.value >= BigInt(status.limits.taskMinutes) * 60000n)
        reasons.push("TASK_TIME_LIMIT");
    return reasons;
}
function localTimestamp() {
    const date = new Date();
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const pad = (value) => String(Math.abs(value)).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}
function lastReflection(runtime) {
    return runtime.sessionManager === undefined
        ? undefined
        : reflectionHistory(runtime.sessionManager).at(-1);
}
function sendActiveReflection(runtime) {
    if (!rootIsCurrent(runtime) ||
        runtime.activeReflection === undefined ||
        runtime.config === undefined)
        return;
    const active = runtime.activeReflection;
    const previous = lastReflection(runtime);
    const content = buildReflectionPrompt({
        semanticPrefix: runtime.config.reflectionPrompt,
        timestamp: active.timestamp,
        reasons: active.reasons,
        thresholds: active.thresholds,
        userSupplement: active.userSupplement,
        previousReflection: previous === undefined
            ? undefined
            : { timestamp: previous.timestamp, report: previous.report },
    });
    active.submittedAttempt = undefined;
    active.inquiry.send(runtime.pi, content, active.reasks + 1);
}
function failReflectionBeforeSend(runtime, services, message) {
    runtime.activeReflection = undefined;
    runtime.reflectionQueue = [];
    runtime.pausedForReflection = false;
    runtime.resumeAfterReflectionTurn = false;
    void services.processDomain.resume().catch(() => { });
    if (rootIsCurrent(runtime)) {
        runtime.ctx.ui.notify(message, "warning");
        scheduleTimers(runtime, services);
        updateStatus(runtime, services);
    }
}
function beginNextReflection(runtime, services) {
    if (!rootIsCurrent(runtime) || runtime.activeReflection !== undefined)
        return;
    const pending = runtime.reflectionQueue.shift();
    if (pending === undefined)
        return;
    runtime.activeReflection = {
        ...pending,
        reasks: 0,
        toolCalls: 0,
        inquiry: createInquiryRuntime(REFLECTION_INQUIRY_NAMESPACE, {
            inquiryId: `reflection-${pending.id}`,
        }),
    };
    clearTimers(runtime, services);
    runtime.pausedForReflection = true;
    runtime.resumeAfterReflectionTurn = false;
    const resetReminderCycle = !pending.reasons.includes("USER_REQUEST");
    if (resetReminderCycle)
        runtime.controller.resetReminderCycle(services.now());
    void services.processDomain.pauseForReflection(resetReminderCycle).then((counters) => {
        if (counters !== undefined)
            runtime.domainCounters = counters;
        sendActiveReflection(runtime);
    }, () => failReflectionBeforeSend(runtime, services, "Reflection failed: process-domain counter pause/reset failed."));
}
function enqueueReflection(runtime, services, reasons, thresholds, userSupplement) {
    if (!rootIsCurrent(runtime))
        return;
    const normalizedReasons = [...new Set(reasons)];
    const tail = runtime.reflectionQueue.at(-1);
    if (!normalizedReasons.includes("USER_REQUEST") &&
        userSupplement === undefined &&
        tail !== undefined &&
        !tail.reasons.includes("USER_REQUEST") &&
        tail.userSupplement === undefined) {
        for (const reason of normalizedReasons)
            if (!tail.reasons.includes(reason))
                tail.reasons.push(reason);
        return;
    }
    runtime.reflectionSequence += 1;
    runtime.reflectionQueue.push({
        id: runtime.reflectionSequence,
        reasons: normalizedReasons,
        thresholds,
        userSupplement,
        timestamp: localTimestamp(),
    });
    beginNextReflection(runtime, services);
}
function finalizeReflection(runtime, services, report, decision) {
    const active = runtime.activeReflection;
    if (!active || !runtime.sessionManager)
        return;
    if (decision === undefined) {
        runtime.ctx?.ui.notify(report, "warning");
    }
    else {
        const entryBase = {
            version: 1,
            timestamp: active.timestamp,
            reasons: active.reasons,
            thresholds: active.thresholds,
            userSupplement: active.userSupplement,
            decision,
        };
        const historyEntry = {
            ...entryBase,
            report: formatReflectionReport(entryBase),
        };
        if ("appendEntry" in runtime.pi)
            runtime.pi.appendEntry(REFLECTION_ENTRY_TYPE, historyEntry);
        if (runtime.ctx?.mode === "tui")
            runtime.ctx.ui.notify(historyEntry.report, "info");
        if (decision.type === "ROUTE_CORRECTION") {
            runtime.pi.sendMessage({
                customType: `${REFLECTION_MESSAGE_TYPE}:correction`,
                content: historyEntry.report,
                display: true,
                details: historyEntry,
            }, 
            // message_end runs while the reflection agent loop is still active.
            // Steer the readable correction into that loop so continuation does
            // not wait for another user prompt.
            { deliverAs: "steer", triggerTurn: true });
        }
    }
    runtime.activeReflection = undefined;
    runtime.suppressNextRootTurn = false;
    if (runtime.reflectionQueue.length > 0) {
        beginNextReflection(runtime, services);
        return;
    }
    // message_end precedes this reflection response's turn_end. Resume only
    // after that exact turn is swallowed so reflection work cannot count itself.
    runtime.resumeAfterReflectionTurn = true;
}
function deliverWarnings(runtime, transition, services) {
    if (transition.warnings.length === 0 || !rootIsCurrent(runtime))
        return false;
    const status = transition.triggerStatus;
    if (status === undefined)
        throw new Error("warning transition must include its pre-reset status");
    enqueueReflection(runtime, services, transition.warnings, thresholdSnapshot(status, runtime.domainCounters));
    clearTimers(runtime, services);
    updateStatus(runtime, services);
    return true;
}
export function createWatchdogExtension(overrides = {}) {
    const services = { ...defaultServices, ...overrides };
    return (pi) => {
        pi.on("context", (event) => ({
            messages: foldInquiryContext(event.messages, REFLECTION_INQUIRY_NAMESPACE),
        }));
        const runtime = {
            pi,
            token: "",
            sessionId: "",
            state: "new",
            toolRegistered: false,
            commandRegistered: false,
            reflectionSequence: 0,
            reflectionQueue: [],
            pausedForReflection: false,
            resumeAfterReflectionTurn: false,
            runActivity: "pending",
            suppressNextRootTurn: false,
            domainAttached: false,
        };
        const classifyWork = () => {
            if (runtime.runActivity === "work")
                return;
            runtime.runActivity = "work";
            if (runtime.domainAttached)
                void services.processDomain.setBusy(runtime, true).catch(() => { });
            if (rootIsCurrent(runtime)) {
                runtime.controller.startRootActiveSegment(services.now());
                scheduleTimers(runtime, services);
                updateStatus(runtime, services);
                return;
            }
            const root = getHub().root?.value;
            const binding = runtime.observerBinding;
            if (!root ||
                !rootIsCurrent(root) ||
                !binding ||
                binding.observerAttachmentToken !== runtime.token ||
                binding.rootGeneration !== root.root.generation)
                return;
            root.controller.startObserverRun(runtime.token, services.now());
            scheduleTimers(root, services);
            updateStatus(root, services);
        };
        const classifyMessage = (message) => {
            if (message.role === "user") {
                classifyWork();
                return;
            }
            if (runtime.runActivity === "pending")
                classifyWork();
        };
        pi.on("session_start", async (_event, ctx) => {
            const hub = getHub();
            if (runtime.state !== "new")
                return;
            // Pi command contexts are distinct wrappers, but retain this exact
            // session-owned manager plus its stable ID from session_start.
            runtime.sessionManager = ctx.sessionManager;
            runtime.sessionId = ctx.sessionManager.getSessionId();
            runtime.token = allocateAttachmentToken(hub, runtime.sessionId);
            runtime.state = "loading";
            // Claim ownership before awaiting configuration. This atomic priority
            // decision lets a UI claim replace a fallback while preventing delayed
            // equal/lower-priority callbacks from stealing it afterward.
            const claim = claimRoot(hub, runtime.token, priority(ctx), runtime);
            if (!claim) {
                runtime.state = "observer";
                return;
            }
            runtime.root = { generation: claim.root.generation };
            if (claim.replaced)
                deactivate(claim.replaced.value, services);
            const loaded = await services.loadConfig(ctx.cwd, ctx.isProjectTrusted());
            // A shutdown/replacement has no cancellation hook; all post-await work is inert.
            if (runtime.state !== "loading" ||
                !isCurrentRoot(hub, runtime.token, claim.root.generation))
                return;
            runtime.ctx = ctx;
            runtime.controller = new TaskController(controllerOptionsFromConfig(loaded.config));
            runtime.config = loaded.config;
            runtime.state = "root";
            for (const diagnostic of loaded.diagnostics.slice(0, 3))
                ctx.ui.notify(`pi-reflect-watchdog ${diagnostic.source}: ${diagnostic.message}`, "warning");
            let initialAttachComplete = false;
            let initialExitRequested = false;
            const exitForInitialDomainFailure = (error) => {
                if (initialAttachComplete ||
                    initialExitRequested ||
                    !isReflectDomainFatalError(error))
                    return false;
                initialExitRequested = true;
                services.fatalExit.fail(error, ctx);
                return true;
            };
            try {
                await services.processDomain.attach(runtime, (error) => {
                    if (exitForInitialDomainFailure(error))
                        return;
                    runtime.domainCounters = undefined;
                    ctx.ui.notify("pi-reflect-watchdog process monitoring is uncertain; cross-process reflection thresholds are paused.", "warning");
                });
                if (runtime.state !== "root" ||
                    !isCurrentRoot(hub, runtime.token, claim.root.generation)) {
                    await services.processDomain.detach(runtime).catch(() => { });
                    return;
                }
                initialAttachComplete = true;
                runtime.domainAttached = true;
                services.processDomain.setIdleResetGapSeconds(loaded.config.idleResetGapSeconds);
                runtime.domainCounters = services.processDomain.counters();
                if (services.processDomain.rootProcess) {
                    runtime.domainCounterUnsubscribe = services.processDomain.subscribe((counters) => {
                        runtime.domainCounters = counters;
                        if (!rootIsCurrent(runtime) ||
                            runtime.activeReflection !== undefined)
                            return;
                        const reasons = domainThresholdReasons(runtime, counters);
                        if (reasons.length === 0)
                            return;
                        enqueueReflection(runtime, services, reasons, thresholdSnapshot(runtime.controller.status(services.now()), counters));
                    });
                }
            }
            catch (error) {
                const attachError = error instanceof Error ? error : new Error("process domain failed");
                deactivate(runtime, services);
                exitForInitialDomainFailure(attachError);
                return;
            }
            registerControlTool(pi, runtime, services);
            registerHistoryTools(pi, runtime);
            pi.registerEntryRenderer?.(REFLECTION_ENTRY_TYPE, createReflectionEntryRenderer());
            registerWatchdogCommand(pi, runtime, services);
            // Recreate the dedicated widget for every fresh root context; TUI
            // mode uses it as the status UI and never gets a footer status.
            installWidget(runtime, services);
            updateStatus(runtime, services);
        });
        pi.on("message_start", (event) => {
            if (event.message.role === "custom") {
                const active = runtime.activeReflection;
                const message = event.message;
                const attempt = active === undefined ? 0 : active.reasks + 1;
                const correlation = active?.inquiry.correlation(attempt || 1);
                if (active !== undefined &&
                    correlation !== undefined &&
                    message.customType === REFLECTION_MESSAGE_TYPE &&
                    message.details?.version === correlation.version &&
                    message.details?.namespace === correlation.namespace &&
                    message.details?.inquiryId === correlation.inquiryId &&
                    message.details?.attempt === correlation.attempt) {
                    active.submittedAttempt = attempt;
                    return;
                }
            }
            classifyMessage(event.message);
            if (event.message.role !== "user")
                return;
            if (rootIsCurrent(runtime)) {
                // An interjecting/new root user message replaces a begun activity
                // window; the finished window is announced exactly once.
                const snapshot = runtime.controller.startRootTask(services.now(), runtime.controller.status(services.now()).rootActive);
                emitActiveCycleFrozenNotification(runtime, snapshot);
                scheduleTimers(runtime, services);
                updateStatus(runtime, services);
                return;
            }
            const root = getHub().root?.value;
            if (!root || !rootIsCurrent(root))
                return;
            const epoch = root.controller.bindObserver(runtime.token);
            if (epoch === 0)
                return;
            runtime.observerBinding = {
                observerAttachmentToken: runtime.token,
                rootGeneration: root.root.generation,
                taskEpoch: epoch,
            };
        });
        pi.on("agent_start", () => {
            if (!runtime.pausedForReflection && runtime.runActivity === "pending")
                classifyWork();
        });
        pi.on("agent_settled", () => {
            const completedActivity = runtime.runActivity;
            runtime.runActivity = "pending";
            if (runtime.pausedForReflection) {
                if (runtime.domainAttached)
                    void services.processDomain.setBusy(runtime, false).catch(() => { });
                if (rootIsCurrent(runtime)) {
                    const snapshot = runtime.controller.settleRootActiveSegment(services.now());
                    emitActiveCycleFrozenNotification(runtime, snapshot);
                }
                if (runtime.activeReflection !== undefined &&
                    !runtime.resumeAfterReflectionTurn) {
                    runtime.activeReflection = undefined;
                    runtime.reflectionQueue = [];
                    runtime.ctx?.ui.notify("Reflection aborted before a valid response; watchdog counters resumed.", "warning");
                    void services.processDomain.resume().finally(() => {
                        runtime.pausedForReflection = false;
                        scheduleTimers(runtime, services);
                    });
                    return;
                }
                if (runtime.resumeAfterReflectionTurn) {
                    runtime.resumeAfterReflectionTurn = false;
                    void services.processDomain.resume().finally(() => {
                        runtime.pausedForReflection = false;
                        scheduleTimers(runtime, services);
                    });
                }
                return;
            }
            if (runtime.domainAttached)
                void services.processDomain.setBusy(runtime, false).catch(() => { });
            if (completedActivity !== "work")
                return;
            if (rootIsCurrent(runtime)) {
                const snapshot = runtime.controller.settleRootActiveSegment(services.now());
                emitActiveCycleFrozenNotification(runtime, snapshot);
                scheduleTimers(runtime, services);
                updateStatus(runtime, services);
                return;
            }
            const root = getHub().root?.value;
            const binding = runtime.observerBinding;
            if (!root ||
                !rootIsCurrent(root) ||
                !binding ||
                binding.observerAttachmentToken !== runtime.token ||
                binding.rootGeneration !== root.root.generation)
                return;
            const snapshot = root.controller.settleObserverRun(runtime.token, binding.taskEpoch, services.now());
            emitActiveCycleFrozenNotification(root, snapshot);
            scheduleTimers(root, services);
            updateStatus(root, services);
        });
        pi.on("tool_call", () => {
            const active = runtime.activeReflection;
            if (active === undefined)
                return;
            if (active.toolCalls >= MAX_REFLECTION_TOOL_CALLS)
                return {
                    block: true,
                    reason: "Reflection tool-call budget exhausted.",
                };
            active.toolCalls += 1;
        });
        pi.on("message_end", (event) => {
            const active = runtime.activeReflection;
            const attempt = active?.submittedAttempt;
            if (active === undefined || attempt === undefined)
                return;
            const text = active.inquiry.capture(event.message);
            if (text === null)
                return;
            active.submittedAttempt = undefined;
            const replacement = {
                message: active.inquiry.neutralize(event.message, attempt),
            };
            const validation = parseReflectionXml(text);
            if (!validation.valid) {
                active.reasks += 1;
                if (active.reasks < MAX_REFLECTION_REASKS) {
                    active.inquiry.send(runtime.pi, buildReflectionReaskPrompt(validation.error), active.reasks + 1);
                    return replacement;
                }
                runtime.pi.sendMessage(active.inquiry.fold(attempt), {
                    deliverAs: "steer",
                    triggerTurn: false,
                });
                finalizeReflection(runtime, services, `Reflection failed: ${validation.error}`);
                return replacement;
            }
            runtime.pi.sendMessage(active.inquiry.fold(attempt), {
                deliverAs: "steer",
                triggerTurn: false,
            });
            finalizeReflection(runtime, services, text, validation.decision);
            return replacement;
        });
        pi.on("turn_end", () => {
            if (runtime.pausedForReflection)
                return;
            if (runtime.runActivity === "pending")
                classifyWork();
            if (rootIsCurrent(runtime)) {
                if (runtime.suppressNextRootTurn) {
                    runtime.suppressNextRootTurn = false;
                    return;
                }
                const local = runtime.controller.completeRootTurn(services.now());
                if (runtime.domainAttached) {
                    void services.processDomain.recordRootLoop().then((counters) => {
                        runtime.domainCounters = counters;
                    }, () => { });
                }
                else
                    deliverWarnings(runtime, local, services);
                updateStatus(runtime, services);
                return;
            }
            if (runtime.domainAttached)
                void services.processDomain.recordAllLoop().catch(() => { });
            const root = getHub().root?.value;
            const binding = runtime.observerBinding;
            if (!root ||
                !rootIsCurrent(root) ||
                !binding ||
                binding.observerAttachmentToken !== runtime.token ||
                binding.rootGeneration !== root.root.generation)
                return;
            deliverWarnings(root, root.controller.completeObserverTurn(runtime.token, binding.taskEpoch, services.now()), services);
        });
        pi.on("session_shutdown", () => {
            services.fatalExit.completeShutdown();
            if (runtime.state === "shutdown")
                return;
            runtime.state = "shutdown";
            const hub = getHub();
            // Release the exact hub claim, including a pending one whose
            // configuration never resolved, so an equal-priority replacement can
            // become root while the stale resolution stays inert.
            const generation = runtime.root?.generation;
            if (generation !== undefined &&
                releaseRoot(hub, runtime.token, generation))
                deactivate(runtime, services);
            else {
                const root = hub.root?.value;
                const binding = runtime.observerBinding;
                if (root &&
                    rootIsCurrent(root) &&
                    binding &&
                    binding.rootGeneration === root.root.generation) {
                    const snapshot = root.controller.unbindObserver(runtime.token, services.now(), binding.taskEpoch);
                    emitActiveCycleFrozenNotification(root, snapshot);
                    scheduleTimers(root, services);
                    updateStatus(root, services);
                }
                clearTimers(runtime, services);
                clearWidget(runtime);
                runtime.observerBinding = undefined;
            }
        });
    };
}
export default createWatchdogExtension();
function commandIsCurrent(runtime, ctx) {
    // Pi wraps event and command contexts separately. The
    // session manager is the stable session-owned object shared by those
    // wrappers; pair it with the session ID and current hub token/generation.
    return (rootIsCurrent(runtime) &&
        runtime.sessionManager !== undefined &&
        ctx.sessionManager === runtime.sessionManager &&
        ctx.sessionManager.getSessionId() === runtime.sessionId);
}
function userStatusText(runtime, services) {
    const status = runtime.controller?.status(services.now());
    if (!status)
        return "Watchdog is not active for this session.";
    return [
        "Watchdog status",
        `root loops: ${status.rootLoops}`,
        `other agent loops: ${status.otherAgentLoops}`,
        `observable agent sessions: ${status.observableAgentSessions}`,
        `all loops: ${status.allLoops}`,
        `active window: ${formatDuration(status.activity.elapsedMs)}/${status.activity.loops} loops`,
        `task time: ${elapsed(status.taskElapsedMs)}`,
        `limits: root=${status.limits.rootLoopLimit}; all=${status.limits.allLoopLimit}; task=${status.limits.taskMinutes}m; idle-reset-gap=${status.limits.idleResetGapSeconds}s`,
        `configured defaults: root=${status.configuredLimits.rootLoopLimit}; all=${status.configuredLimits.allLoopLimit}; task=${status.configuredLimits.taskMinutes}m; idle-reset-gap=${status.configuredLimits.idleResetGapSeconds}s`,
        `latched warnings: ${status.latchedWarnings.join(", ") || "none"}`,
        `coverage: ${status.coverage}`,
    ].join("\n");
}
function notifyCommand(ctx, message, kind = "info") {
    ctx.ui.notify(message, kind);
}
function notifyCommandWarnings(ctx, warnings) {
    if (warnings.length !== 0)
        notifyCommand(ctx, `Reflection queued: ${warnings.join(", ")}`, "warning");
}
function registerWatchdogCommand(pi, runtime, services) {
    if (runtime.commandRegistered)
        return;
    runtime.commandRegistered = true;
    // Pi has no public command unregistration. Registration occurs only after
    // this attachment wins root ownership; a stale handler validates generation
    // and context before reading or changing any current root state.
    pi.registerCommand(REFLECT_WATCHDOG_COMMAND, {
        description: "Inspect and control the current reflection watchdog cycle",
        async handler(args, ctx) {
            // Never read the stale wrapper's UI before proving stable session identity.
            if (!commandIsCurrent(runtime, ctx))
                return;
            const parsed = parseReflectWatchdogCommand(args);
            if ("error" in parsed) {
                notifyCommand(ctx, parsed.error, "error");
                return;
            }
            const current = services.now();
            switch (parsed.command.action) {
                case "status":
                    notifyCommand(ctx, userStatusText(runtime, services));
                    return;
                case "reset":
                    runtime.controller.resetReminderCycle(current);
                    await services.processDomain
                        .resetReminderCycle()
                        .catch(() => undefined);
                    runtime.domainCounters = services.processDomain.counters();
                    scheduleTimers(runtime, services);
                    updateStatus(runtime, services);
                    notifyCommand(ctx, "Watchdog task cycle reset. Active window is unchanged.");
                    return;
                case "limits-show":
                    notifyCommand(ctx, userStatusText(runtime, services));
                    return;
                case "limits-set": {
                    const transition = runtime.controller.setLimits(parsed.command, current);
                    services.processDomain.setIdleResetGapSeconds(parsed.command.idleResetGapSeconds);
                    scheduleTimers(runtime, services);
                    notifyCommandWarnings(ctx, transition.warnings);
                    updateStatus(runtime, services);
                    notifyCommand(ctx, "Watchdog current-task limits updated.");
                    return;
                }
                case "limits-reset": {
                    const transition = runtime.controller.restoreConfiguredDefaults(current);
                    const configured = runtime.controller.status(current).configuredLimits;
                    services.processDomain.setIdleResetGapSeconds(configured.idleResetGapSeconds);
                    scheduleTimers(runtime, services);
                    notifyCommandWarnings(ctx, transition.warnings);
                    updateStatus(runtime, services);
                    notifyCommand(ctx, "Watchdog configured limits restored for this task.");
                    return;
                }
            }
        },
    });
    pi.registerCommand(REFLECT_COMMAND, {
        description: "Queue an immediate reflection with optional user supplement",
        handler: async (args, ctx) => {
            if (!commandIsCurrent(runtime, ctx))
                return;
            const status = runtime.controller.status(services.now());
            enqueueReflection(runtime, services, ["USER_REQUEST"], thresholdSnapshot(status, runtime.domainCounters), args.trim() || undefined);
            notifyCommand(ctx, "Reflection queued.");
        },
    });
    pi.registerCommand(REFLECT_TIMELINE_COMMAND, {
        description: "Show completed reflections on the current session branch",
        handler: async (_args, ctx) => {
            if (!commandIsCurrent(runtime, ctx))
                return;
            await showReflectionTimeline(ctx, reflectionHistory(ctx.sessionManager));
        },
    });
}
function registerHistoryTools(pi, runtime) {
    pi.registerTool({
        name: HISTORY_COUNT_TOOL_NAME,
        label: "Reflection History Count",
        description: "Return the number of completed valid reflections on the current session branch.",
        parameters: Type.Object({}),
        async execute() {
            if (!rootIsCurrent(runtime) || runtime.sessionManager === undefined)
                throw new Error("reflect_history_count is available only to the current root session");
            const count = reflectionHistory(runtime.sessionManager).length;
            return {
                content: [{ type: "text", text: String(count) }],
                details: { count },
            };
        },
    });
    pi.registerTool({
        name: HISTORY_GET_TOOL_NAME,
        label: "Reflection History Get",
        description: "Get completed reflections by exactly one 1-based selector: latest, index, or range.",
        parameters: Type.Object({
            latest: Type.Optional(Type.Boolean()),
            index: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
            range: Type.Optional(Type.Object({
                start: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
                end: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            })),
        }),
        async execute(_id, params) {
            if (!rootIsCurrent(runtime) || runtime.sessionManager === undefined)
                throw new Error("reflect_history_get is available only to the current root session");
            const selectors = [
                params.latest === true,
                params.index !== undefined,
                params.range !== undefined,
            ].filter(Boolean).length;
            if (selectors !== 1)
                throw new Error("provide exactly one of latest, index, or range");
            const history = reflectionHistory(runtime.sessionManager);
            let firstOrdinal = 1;
            let entries;
            if (params.latest === true) {
                entries = queryReflectionHistory(history, { latest: true });
            }
            else if (params.index !== undefined) {
                firstOrdinal = params.index;
                entries = queryReflectionHistory(history, { index: params.index });
            }
            else {
                if (params.range === undefined)
                    throw new Error("range is required");
                firstOrdinal = params.range.start;
                entries = queryReflectionHistory(history, { range: params.range });
            }
            return {
                content: [
                    { type: "text", text: formatHistoryResult(entries, firstOrdinal) },
                ],
                details: { entries, firstOrdinal, total: history.length },
            };
        },
    });
    pi.setActiveTools([
        ...new Set([
            ...pi.getActiveTools(),
            HISTORY_COUNT_TOOL_NAME,
            HISTORY_GET_TOOL_NAME,
        ]),
    ]);
}
function registerControlTool(pi, runtime, services) {
    runtime.toolRegistered = true;
    pi.registerTool({
        name: TOOL_NAME,
        label: "Reflect Watchdog Control",
        description: "Inspect or adjust current-task reflection watchdog counters and limits. Use after a genuine reassessment, not merely to silence a warning.",
        promptSnippet: "Inspect or adjust current reflection watchdog limits after reassessing work",
        promptGuidelines: [
            "Use reflect_watchdog_control to inspect or deliberately adjust the current task's reflection watchdog; do not reset it mechanically just to silence a warning.",
        ],
        parameters: Type.Object({
            action: StringEnum(["status", "reset", "set_limits", "restore_defaults"]),
            rootLoopLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
            allLoopLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
            taskMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
            idleResetGapSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
        }),
        async execute(_id, params) {
            if (!rootIsCurrent(runtime))
                throw new Error("reflect_watchdog_control is available only to the current root session");
            const current = services.now();
            let transition = { warnings: [] };
            if (params.action === "reset") {
                runtime.controller.resetReminderCycle(current);
                await services.processDomain
                    .resetReminderCycle()
                    .catch(() => undefined);
                runtime.domainCounters = services.processDomain.counters();
            }
            else if (params.action === "set_limits") {
                const limits = {
                    rootLoopLimit: params.rootLoopLimit,
                    allLoopLimit: params.allLoopLimit,
                    taskMinutes: params.taskMinutes,
                    idleResetGapSeconds: params.idleResetGapSeconds,
                };
                const values = Object.values(limits).filter((value) => value !== undefined);
                if (values.length === 0)
                    throw new Error("set_limits requires at least one positive safe integer");
                if (!values.every(positiveSafeInteger))
                    throw new Error("set_limits accepts only positive safe integer limits");
                transition = runtime.controller.setLimits(limits, current, true);
                if (limits.idleResetGapSeconds !== undefined)
                    services.processDomain.setIdleResetGapSeconds(limits.idleResetGapSeconds);
            }
            else if (params.action === "restore_defaults") {
                transition = runtime.controller.restoreConfiguredDefaults(current, true);
                services.processDomain.setIdleResetGapSeconds(runtime.controller.status(current).configuredLimits
                    .idleResetGapSeconds);
            }
            if (!deliverWarnings(runtime, transition, services))
                scheduleTimers(runtime, services);
            updateStatus(runtime, services);
            const status = runtime.controller.status(current);
            return {
                content: [
                    {
                        type: "text",
                        text: `reflect_watchdog ${params.action}\nroot loops: ${status.rootLoops}\nother agent loops: ${status.otherAgentLoops}\nobservable agent sessions: ${status.observableAgentSessions}\nall loops: ${status.allLoops}\nlimits: root=${status.limits.rootLoopLimit}; all=${status.limits.allLoopLimit}; task=${status.limits.taskMinutes}m; idle-reset-gap=${status.limits.idleResetGapSeconds}s\ntask elapsed: ${elapsed(status.taskElapsedMs)}\nroot active: ${status.rootActive}\nlatched warnings: ${status.latchedWarnings.join(", ") || "none"}\ncoverage: ${status.coverage}`,
                    },
                ],
                details: status,
            };
        },
    });
    pi.setActiveTools([...new Set([...pi.getActiveTools(), TOOL_NAME])]);
}
