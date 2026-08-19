import { isProcessDomainOpenError, openProcessDomain, } from "pi-extension-utils/process-domain";
export const FATAL_EXIT_CODE = 78;
const ACTIVITY_CHANNEL = "pi-reflect-watchdog.activity.v2";
const LOOP_CHANNEL = "pi-reflect-watchdog.loop.v2";
const COUNTERS_CHANNEL = "pi-reflect-watchdog.counters.v2";
const LEAVE_CHANNEL = "pi-reflect-watchdog.leave.v2";
const ACTIVE_TICK_MS = 1_000;
const IDLE_RESET_GAP_MS = 60_000;
export class ReflectDomainFatalError extends Error {
    code;
    isReflectDomainFatalError = true;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "ReflectDomainFatalError";
    }
}
export function isReflectDomainFatalError(value) {
    return (value instanceof Error &&
        value.isReflectDomainFatalError === true);
}
function counter(value = 0n, paused = false) {
    return { value, paused };
}
function zeroCounters(paused = false, state = {}) {
    const domainEpoch = state.domainEpoch ?? "pending";
    const generation = state.generation ?? 0n;
    return {
        domainEpoch,
        revision: state.revision ?? 0n,
        generation,
        certain: state.certain ?? false,
        anyBusy: state.anyBusy ?? false,
        endLoopTimeMs: null,
        fence: { domainEpoch, generation },
        activeMs: counter(0n, paused),
        activeLoops: counter(0n, paused),
        taskMs: counter(0n, paused),
        rootLoops: counter(0n, paused),
        allLoops: counter(0n, paused),
    };
}
function sameCounters(left, right) {
    return (left.domainEpoch === right.domainEpoch &&
        left.revision === right.revision &&
        left.generation === right.generation &&
        left.certain === right.certain &&
        left.anyBusy === right.anyBusy &&
        left.endLoopTimeMs === right.endLoopTimeMs &&
        left.activeMs.value === right.activeMs.value &&
        left.activeMs.paused === right.activeMs.paused &&
        left.activeLoops.value === right.activeLoops.value &&
        left.activeLoops.paused === right.activeLoops.paused &&
        left.taskMs.value === right.taskMs.value &&
        left.taskMs.paused === right.taskMs.paused &&
        left.rootLoops.value === right.rootLoops.value &&
        left.rootLoops.paused === right.rootLoops.paused &&
        left.allLoops.value === right.allLoops.value &&
        left.allLoops.paused === right.allLoops.paused);
}
function validId(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}
function validRevision(value) {
    return typeof value === "string" && /^[1-9]\d*$/.test(value);
}
function validCounterValue(value) {
    return typeof value === "string" && /^\d+$/.test(value);
}
function parseRevisionMap(value) {
    if (!Array.isArray(value))
        return null;
    const parsed = new Map();
    for (const entry of value) {
        if (typeof entry !== "object" ||
            entry === null ||
            !validId(entry.nodeId) ||
            !validRevision(entry.revision) ||
            parsed.has(entry.nodeId)) {
            return null;
        }
        parsed.set(entry.nodeId, BigInt(entry.revision));
    }
    return parsed;
}
function parseActivity(value) {
    if (typeof value !== "object" || value === null)
        return null;
    const wire = value;
    if (typeof wire.busy !== "boolean" || !validRevision(wire.revision))
        return null;
    return { busy: wire.busy, revision: BigInt(wire.revision) };
}
function parseLoop(value) {
    if (typeof value !== "object" || value === null)
        return null;
    const wire = value;
    if (!validRevision(wire.revision) ||
        !validCounterValue(wire.rootLoops) ||
        !validCounterValue(wire.allLoops))
        return null;
    const revision = BigInt(wire.revision);
    const rootLoops = BigInt(wire.rootLoops);
    const allLoops = BigInt(wire.allLoops);
    if (allLoops !== revision || rootLoops > allLoops)
        return null;
    return { revision, rootLoops, allLoops };
}
function parseCounters(value, nodeId) {
    if (typeof value !== "object" || value === null)
        return null;
    const wire = value;
    const activityRevisions = parseRevisionMap(wire.activityRevisions);
    const loopRevisions = parseRevisionMap(wire.loopRevisions);
    if (!validRevision(wire.revision) ||
        !validRevision(wire.generation) ||
        !validId(wire.domainEpoch) ||
        typeof wire.certain !== "boolean" ||
        typeof wire.paused !== "boolean" ||
        typeof wire.anyBusy !== "boolean" ||
        (wire.endLoopTimeMs !== null && !validCounterValue(wire.endLoopTimeMs)) ||
        !validCounterValue(wire.activeMs) ||
        !validCounterValue(wire.activeLoops) ||
        !validCounterValue(wire.taskMs) ||
        !validCounterValue(wire.rootLoops) ||
        !validCounterValue(wire.allLoops) ||
        activityRevisions === null ||
        loopRevisions === null) {
        return null;
    }
    const generation = BigInt(wire.generation);
    return {
        counters: {
            domainEpoch: wire.domainEpoch,
            revision: BigInt(wire.revision),
            generation,
            certain: wire.certain,
            anyBusy: wire.anyBusy,
            endLoopTimeMs: wire.endLoopTimeMs === null ? null : BigInt(wire.endLoopTimeMs),
            fence: { domainEpoch: wire.domainEpoch, generation },
            activeMs: counter(BigInt(wire.activeMs), wire.paused),
            activeLoops: counter(BigInt(wire.activeLoops), wire.paused),
            taskMs: counter(BigInt(wire.taskMs), wire.paused),
            rootLoops: counter(BigInt(wire.rootLoops), wire.paused),
            allLoops: counter(BigInt(wire.allLoops), wire.paused),
        },
        activityRevision: activityRevisions.get(nodeId) ?? 0n,
        loopRevision: loopRevisions.get(nodeId) ?? 0n,
    };
}
function revisionMap(value) {
    return Array.from(value)
        .filter(([, revision]) => revision > 0n)
        .map(([nodeId, revision]) => ({
        nodeId,
        revision: revision.toString(),
    }));
}
export function createReflectDomainCoordinator(options = {}) {
    const open = options.open ?? openProcessDomain;
    const env = options.env ?? process.env;
    const clock = options.clock ?? {
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (handle) => clearTimeout(handle),
    };
    const activeTickMs = options.activeTickMs ?? ACTIVE_TICK_MS;
    const now = options.now ?? Date.now;
    let idleResetGapMs = options.idleResetGapMs ?? IDLE_RESET_GAP_MS;
    const attachments = new Map();
    const listeners = new Set();
    const peers = new Map();
    const uncertainPeers = new Set();
    let node;
    let rootProcess = false;
    let opening;
    let countersValue;
    let hostState;
    let hostStateRevision = 0n;
    let acceptedHostRevision = 0n;
    let acceptedHostEpoch;
    let paused = false;
    let transportHealthy = true;
    let tick;
    let unsubscribeEvents;
    let unsubscribeActivity;
    let unsubscribeLoops;
    let unsubscribeCounters;
    let unsubscribeLeave;
    let writeTail = Promise.resolve();
    let lifecycleTail = Promise.resolve();
    let snapshotRevision = 0n;
    let snapshotGeneration = 0n;
    let localActivityRevision = 0n;
    let localLoopRevision = 0n;
    let localRootLoops = 0n;
    let localAllLoops = 0n;
    let requiredActivityRevision = 0n;
    let requiredLoopRevision = 0n;
    const desiredActivity = () => Array.from(attachments.values()).some((attachment) => attachment.busy);
    const notify = (next) => {
        if (countersValue !== undefined && sameCounters(countersValue, next))
            return;
        countersValue = next;
        for (const listener of Array.from(listeners)) {
            try {
                listener(next);
            }
            catch {
                // Observers cannot corrupt coordinator state or the writer queue.
            }
        }
    };
    const markClientUncertain = () => {
        countersValue = undefined;
    };
    const queueLifecycle = (operation) => {
        const result = lifecycleTail.catch(() => { }).then(operation);
        lifecycleTail = result.then(() => { }, () => { });
        return result;
    };
    const queueTransport = (operation) => {
        const result = writeTail.catch(() => { }).then(operation);
        writeTail = result.then(() => { }, () => { });
        return result;
    };
    const markTransportUncertain = (forceTransport = false) => {
        if (node === undefined)
            return;
        if (!rootProcess) {
            markClientUncertain();
            return;
        }
        let changed = false;
        if (forceTransport && transportHealthy) {
            transportHealthy = false;
            changed = true;
        }
        for (const peer of node.peers()) {
            if (peer.status === "offline" &&
                peers.has(peer.nodeId) &&
                !uncertainPeers.has(peer.nodeId)) {
                uncertainPeers.add(peer.nodeId);
                changed = true;
            }
        }
        if (!changed)
            return;
        hostStateRevision += 1n;
        const current = countersValue ?? hostCounters();
        if (!current.certain)
            return;
        snapshotRevision += 1n;
        snapshotGeneration += 1n;
        const domainEpoch = node.declaration.domainId;
        notify({
            ...current,
            domainEpoch,
            revision: snapshotRevision,
            generation: snapshotGeneration,
            certain: false,
            fence: { domainEpoch, generation: snapshotGeneration },
        });
    };
    const reportFatal = (error, forceTransport = false) => {
        markTransportUncertain(forceTransport);
        for (const attachment of attachments.values()) {
            try {
                attachment.onFatal(error);
            }
            catch {
                // Fatal ownership remains with the host adapter.
            }
        }
    };
    const hostCounters = () => {
        const current = hostState ?? zeroCounters(paused);
        return {
            ...current,
            activeMs: counter(current.activeMs.value, paused),
            activeLoops: counter(current.activeLoops.value, paused),
            taskMs: counter(current.taskMs.value, paused),
            rootLoops: counter(current.rootLoops.value, paused),
            allLoops: counter(current.allLoops.value, paused),
        };
    };
    const hostBusy = () => {
        if (desiredActivity())
            return true;
        for (const peer of peers.values())
            if (peer.busy)
                return true;
        return false;
    };
    const hostCertain = () => transportHealthy && uncertainPeers.size === 0;
    const publishHostNow = async () => {
        if (!rootProcess || node === undefined)
            return;
        const currentNode = node;
        const current = hostCounters();
        const publishedStateRevision = hostStateRevision;
        snapshotRevision += 1n;
        snapshotGeneration += 1n;
        const domainEpoch = currentNode.declaration.domainId;
        const counters = {
            ...current,
            domainEpoch,
            revision: snapshotRevision,
            generation: snapshotGeneration,
            certain: uncertainPeers.size === 0,
            anyBusy: hostBusy(),
            fence: { domainEpoch, generation: snapshotGeneration },
        };
        const activityRevisions = new Map();
        const loopRevisions = new Map();
        for (const [nodeId, peer] of peers) {
            activityRevisions.set(nodeId, peer.activityRevision);
            loopRevisions.set(nodeId, peer.loopRevision);
        }
        const message = {
            revision: snapshotRevision.toString(),
            generation: snapshotGeneration.toString(),
            domainEpoch,
            certain: counters.certain,
            paused,
            anyBusy: counters.anyBusy,
            endLoopTimeMs: counters.endLoopTimeMs?.toString() ?? null,
            activeMs: counters.activeMs.value.toString(),
            activeLoops: counters.activeLoops.value.toString(),
            taskMs: counters.taskMs.value.toString(),
            rootLoops: counters.rootLoops.value.toString(),
            allLoops: counters.allLoops.value.toString(),
            activityRevisions: revisionMap(activityRevisions),
            loopRevisions: revisionMap(loopRevisions),
        };
        const targets = [...peers.keys()].filter((nodeId) => currentNode
            .peers()
            .some((peer) => peer.nodeId === nodeId && peer.status === "online"));
        await Promise.all(targets.map((nodeId) => currentNode.send(nodeId, COUNTERS_CHANNEL, message)));
        transportHealthy = true;
        if (publishedStateRevision === hostStateRevision)
            notify(counters);
    };
    const publishHost = () => queueTransport(async () => {
        try {
            await publishHostNow();
        }
        catch (error) {
            reportFatal(error instanceof Error
                ? error
                : new Error("reflection transport write failed"), true);
            throw error;
        }
    });
    const applyHostActivity = (message) => {
        if (!rootProcess || node === undefined)
            return;
        const peer = node
            .peers()
            .find((candidate) => candidate.nodeId === message.senderId);
        if (peer?.status !== "online")
            return;
        const activity = parseActivity(message.value);
        const current = peers.get(message.senderId);
        if (activity === null ||
            current === undefined ||
            activity.revision <= current.activityRevision)
            return;
        const wasBusy = hostBusy();
        current.busy = activity.busy;
        current.activityRevision = activity.revision;
        hostStateRevision += 1n;
        uncertainPeers.delete(message.senderId);
        applyAggregateBusyTransition(wasBusy, hostBusy());
        void publishHost()
            .then(updateHostTimers)
            .catch(() => { });
    };
    const applyHostLoop = (message) => {
        if (!rootProcess || node === undefined)
            return;
        const peer = node
            .peers()
            .find((candidate) => candidate.nodeId === message.senderId);
        if (peer?.status !== "online")
            return;
        const loop = parseLoop(message.value);
        const current = peers.get(message.senderId);
        if (loop === null ||
            current === undefined ||
            loop.revision <= current.loopRevision ||
            loop.rootLoops < current.rootLoops ||
            loop.allLoops < current.allLoops)
            return;
        const rootDelta = loop.rootLoops - current.rootLoops;
        const allDelta = loop.allLoops - current.allLoops;
        current.loopRevision = loop.revision;
        current.rootLoops = loop.rootLoops;
        current.allLoops = loop.allLoops;
        hostStateRevision += 1n;
        if (!paused) {
            const currentCounters = hostCounters();
            hostState = {
                ...currentCounters,
                activeLoops: counter(currentCounters.activeLoops.value + allDelta, paused),
                rootLoops: counter(currentCounters.rootLoops.value + rootDelta, paused),
                allLoops: counter(currentCounters.allLoops.value + allDelta, paused),
            };
        }
        void publishHost().catch(() => { });
    };
    const clearEveryCounter = (current) => ({
        ...current,
        endLoopTimeMs: null,
        activeMs: counter(0n, paused),
        activeLoops: counter(0n, paused),
        taskMs: counter(0n, paused),
        rootLoops: counter(0n, paused),
        allLoops: counter(0n, paused),
    });
    const clearReminderCounters = (current) => ({
        ...current,
        taskMs: counter(0n, paused),
        rootLoops: counter(0n, paused),
        allLoops: counter(0n, paused),
    });
    const applyAggregateBusyTransition = (wasBusy, isBusy) => {
        if (!rootProcess || paused || wasBusy === isBusy)
            return;
        const current = hostCounters();
        if (!isBusy) {
            hostState = { ...current, anyBusy: false, endLoopTimeMs: BigInt(now()) };
            return;
        }
        const gapExceeded = current.endLoopTimeMs !== null &&
            BigInt(now()) > current.endLoopTimeMs + BigInt(idleResetGapMs);
        const resumed = gapExceeded ? clearEveryCounter(current) : current;
        hostState = { ...resumed, anyBusy: true, endLoopTimeMs: null };
    };
    const scheduleTick = () => {
        if (!rootProcess || node === undefined || tick !== undefined || paused)
            return;
        tick = clock.setTimeout(() => {
            tick = undefined;
            if (!rootProcess || paused || !hostCertain())
                return;
            if (!hostBusy())
                return;
            const current = hostCounters();
            hostStateRevision += 1n;
            hostState = {
                ...current,
                activeMs: counter(current.activeMs.value + BigInt(activeTickMs), paused),
                taskMs: counter(current.taskMs.value + BigInt(activeTickMs), paused),
            };
            void publishHost().catch(() => { });
            scheduleTick();
            return;
        }, activeTickMs);
        tick.unref?.();
    };
    const updateHostTimers = () => {
        if (!rootProcess || paused || !hostCertain())
            return;
        if (hostBusy()) {
            scheduleTick();
            return;
        }
        if (tick !== undefined) {
            clock.clearTimeout(tick);
            tick = undefined;
        }
    };
    const handleTransportEvent = (event) => {
        if (event.type !== "peer" || node === undefined)
            return;
        if (!rootProcess) {
            if (event.peer.nodeId !== node.declaration.hostNodeId)
                return;
            if (event.peer.status === "offline")
                markClientUncertain();
            else {
                markClientUncertain();
                void (async () => {
                    await queueWrite("activity");
                    await queueLoopSnapshot();
                })().catch(() => { });
            }
            return;
        }
        const wasBusy = hostBusy();
        if (event.peer.status === "online") {
            if (peers.has(event.peer.nodeId))
                return;
            peers.set(event.peer.nodeId, {
                busy: event.peer.metadata.activity === "busy",
                activityRevision: 0n,
                loopRevision: 0n,
                rootLoops: 0n,
                allLoops: 0n,
            });
            uncertainPeers.add(event.peer.nodeId);
        }
        else {
            if (!peers.has(event.peer.nodeId))
                return;
            uncertainPeers.add(event.peer.nodeId);
        }
        hostStateRevision += 1n;
        applyAggregateBusyTransition(wasBusy, hostBusy());
        void publishHost().catch(() => { });
        updateHostTimers();
    };
    const queueWrite = (kind) => {
        const clientWrite = node !== undefined && !rootProcess
            ? kind === "activity"
                ? {
                    kind,
                    revision: ++localActivityRevision,
                    busy: desiredActivity(),
                }
                : {
                    kind,
                    revision: ++localLoopRevision,
                    rootLoops: kind === "root-loop" ? ++localRootLoops : localRootLoops,
                    allLoops: ++localAllLoops,
                }
            : undefined;
        if (clientWrite?.kind === "activity") {
            requiredActivityRevision = clientWrite.revision;
            markClientUncertain();
        }
        else if (clientWrite !== undefined) {
            requiredLoopRevision = clientWrite.revision;
            markClientUncertain();
        }
        return queueTransport(async () => {
            if (node === undefined || rootProcess || clientWrite === undefined)
                return;
            try {
                if (clientWrite.kind === "activity") {
                    await node.send(node.declaration.hostNodeId, ACTIVITY_CHANNEL, {
                        revision: clientWrite.revision.toString(),
                        busy: clientWrite.busy,
                    });
                    return;
                }
                await node.send(node.declaration.hostNodeId, LOOP_CHANNEL, {
                    revision: clientWrite.revision.toString(),
                    rootLoops: clientWrite.rootLoops.toString(),
                    allLoops: clientWrite.allLoops.toString(),
                });
            }
            catch (error) {
                reportFatal(error instanceof Error
                    ? error
                    : new Error("reflection transport write failed"));
                throw error;
            }
        });
    };
    const queueLoopSnapshot = () => {
        if (node === undefined || rootProcess || localLoopRevision === 0n)
            return Promise.resolve();
        const target = node.declaration.hostNodeId;
        const revision = localLoopRevision;
        const rootLoops = localRootLoops;
        const allLoops = localAllLoops;
        requiredLoopRevision = revision;
        markClientUncertain();
        return queueTransport(async () => {
            if (node === undefined || rootProcess)
                return;
            try {
                await node.send(target, LOOP_CHANNEL, {
                    revision: revision.toString(),
                    rootLoops: rootLoops.toString(),
                    allLoops: allLoops.toString(),
                });
            }
            catch (error) {
                reportFatal(error instanceof Error
                    ? error
                    : new Error("reflection transport write failed"));
                throw error;
            }
        });
    };
    const ensureOpen = () => {
        if (opening)
            return opening;
        opening = (async () => {
            let opened;
            try {
                opened = await open({
                    env,
                    metadata: {
                        role: "pi-reflect-watchdog",
                        pid: String(process.pid),
                        activity: desiredActivity() ? "busy" : "idle",
                    },
                    onError: (error) => reportFatal(error, rootProcess && peers.size > 0),
                });
            }
            catch (error) {
                throw new ReflectDomainFatalError(isProcessDomainOpenError(error) ? error.code : "DOMAIN_UNRECOVERABLE", "failed to initialize reflect-watchdog process transport", { cause: error });
            }
            node = opened;
            rootProcess = opened.role === "host";
            if (rootProcess) {
                hostState = zeroCounters(false, {
                    domainEpoch: opened.declaration.domainId,
                    certain: true,
                });
                countersValue = hostState;
                paused = false;
                transportHealthy = true;
                snapshotRevision = 0n;
                snapshotGeneration = 0n;
                unsubscribeEvents = opened.subscribeEvents(handleTransportEvent);
                unsubscribeActivity = opened.subscribe(ACTIVITY_CHANNEL, applyHostActivity);
                unsubscribeLoops = opened.subscribe(LOOP_CHANNEL, applyHostLoop);
                unsubscribeLeave = opened.subscribe(LEAVE_CHANNEL, (message) => {
                    const wasBusy = hostBusy();
                    if (!peers.delete(message.senderId))
                        return;
                    uncertainPeers.delete(message.senderId);
                    hostStateRevision += 1n;
                    applyAggregateBusyTransition(wasBusy, hostBusy());
                    void publishHost()
                        .then(updateHostTimers)
                        .catch(() => { });
                });
                await publishHost();
                return;
            }
            unsubscribeEvents = opened.subscribeEvents(handleTransportEvent);
            unsubscribeCounters = opened.subscribe(COUNTERS_CHANNEL, (message) => {
                if (message.senderId !== opened.declaration.hostNodeId)
                    return;
                const host = opened
                    .peers()
                    .find((peer) => peer.nodeId === opened.declaration.hostNodeId);
                if (host?.status !== "online")
                    return;
                const parsed = parseCounters(message.value, opened.nodeId);
                if (parsed === null ||
                    parsed.counters.domainEpoch !== opened.declaration.domainId ||
                    (acceptedHostEpoch !== undefined &&
                        parsed.counters.domainEpoch !== acceptedHostEpoch) ||
                    parsed.counters.revision <= acceptedHostRevision ||
                    parsed.activityRevision < requiredActivityRevision ||
                    parsed.loopRevision < requiredLoopRevision)
                    return;
                acceptedHostEpoch = parsed.counters.domainEpoch;
                acceptedHostRevision = parsed.counters.revision;
                countersValue = parsed.counters;
                for (const listener of Array.from(listeners)) {
                    try {
                        listener(parsed.counters);
                    }
                    catch {
                        // Listener failures are isolated from coordinator state.
                    }
                }
            });
            await queueWrite("activity");
        })().catch(async (error) => {
            const fatal = isReflectDomainFatalError(error)
                ? error
                : new ReflectDomainFatalError("CONNECTION_UNAVAILABLE", "failed to publish initial reflect-watchdog state", { cause: error });
            reportFatal(fatal);
            unsubscribeEvents?.();
            unsubscribeActivity?.();
            unsubscribeLoops?.();
            unsubscribeCounters?.();
            unsubscribeLeave?.();
            unsubscribeEvents = undefined;
            unsubscribeActivity = undefined;
            unsubscribeLoops = undefined;
            unsubscribeCounters = undefined;
            unsubscribeLeave = undefined;
            const failedNode = node;
            node = undefined;
            rootProcess = false;
            opening = undefined;
            await failedNode?.close().catch(() => { });
            throw fatal;
        });
        return opening;
    };
    return {
        get rootProcess() {
            return rootProcess;
        },
        attach(instance, onFatal) {
            return queueLifecycle(async () => {
                if (attachments.has(instance))
                    return;
                attachments.set(instance, { busy: false, onFatal });
                const alreadyOpen = node !== undefined;
                try {
                    await ensureOpen();
                    if (alreadyOpen)
                        await queueWrite("activity");
                }
                catch (error) {
                    attachments.delete(instance);
                    throw error;
                }
            });
        },
        detach(instance) {
            return queueLifecycle(async () => {
                if (!attachments.delete(instance))
                    return;
                if (attachments.size !== 0) {
                    await queueWrite("activity");
                    return;
                }
                if (node !== undefined && !rootProcess) {
                    await queueTransport(() => node === undefined
                        ? Promise.resolve()
                        : node.send(node.declaration.hostNodeId, LEAVE_CHANNEL, {
                            version: 1,
                        })).catch(() => { });
                }
                await writeTail.catch(() => { });
                unsubscribeEvents?.();
                unsubscribeActivity?.();
                unsubscribeLoops?.();
                unsubscribeCounters?.();
                unsubscribeLeave?.();
                unsubscribeEvents = undefined;
                unsubscribeActivity = undefined;
                unsubscribeLoops = undefined;
                unsubscribeCounters = undefined;
                unsubscribeLeave = undefined;
                if (tick !== undefined)
                    clock.clearTimeout(tick);
                tick = undefined;
                const closing = node;
                node = undefined;
                rootProcess = false;
                opening = undefined;
                countersValue = undefined;
                hostState = undefined;
                hostStateRevision = 0n;
                acceptedHostRevision = 0n;
                acceptedHostEpoch = undefined;
                paused = false;
                transportHealthy = true;
                peers.clear();
                uncertainPeers.clear();
                snapshotRevision = 0n;
                snapshotGeneration = 0n;
                localActivityRevision = 0n;
                localLoopRevision = 0n;
                localRootLoops = 0n;
                localAllLoops = 0n;
                requiredActivityRevision = 0n;
                requiredLoopRevision = 0n;
                await closing?.close();
            });
        },
        async setBusy(instance, busy) {
            const attachment = attachments.get(instance);
            if (attachment === undefined || attachment.busy === busy)
                return;
            const wasBusy = rootProcess && hostBusy();
            attachment.busy = busy;
            if (rootProcess) {
                hostStateRevision += 1n;
                applyAggregateBusyTransition(wasBusy, hostBusy());
            }
            await queueWrite("activity");
            if (rootProcess) {
                await publishHost();
                updateHostTimers();
            }
        },
        async recordRootLoop() {
            if (!rootProcess || paused) {
                if (!rootProcess)
                    await queueWrite("root-loop");
                return countersValue ?? zeroCounters(paused);
            }
            const current = hostCounters();
            hostStateRevision += 1n;
            hostState = {
                ...current,
                activeLoops: counter(current.activeLoops.value + 1n, false),
                rootLoops: counter(current.rootLoops.value + 1n, false),
                allLoops: counter(current.allLoops.value + 1n, false),
            };
            await publishHost();
            updateHostTimers();
            return countersValue ?? hostCounters();
        },
        async recordAllLoop() {
            if (!rootProcess) {
                await queueWrite("all-loop");
                return countersValue ?? zeroCounters(true);
            }
            if (paused)
                return hostCounters();
            const current = hostCounters();
            hostStateRevision += 1n;
            hostState = {
                ...current,
                activeLoops: counter(current.activeLoops.value + 1n, false),
                allLoops: counter(current.allLoops.value + 1n, false),
            };
            await publishHost();
            return countersValue ?? hostCounters();
        },
        counters() {
            return countersValue;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setIdleResetGapSeconds(seconds) {
            if (Number.isSafeInteger(seconds) && seconds > 0)
                idleResetGapMs = seconds * 1_000;
        },
        async resetReminderCycle() {
            if (!rootProcess || countersValue === undefined)
                return countersValue;
            hostStateRevision += 1n;
            hostState = clearReminderCounters(hostCounters());
            await publishHost();
            return countersValue;
        },
        async pauseForReflection(resetReminderCycle) {
            if (!rootProcess || countersValue === undefined)
                return countersValue;
            paused = true;
            if (tick !== undefined)
                clock.clearTimeout(tick);
            tick = undefined;
            hostStateRevision += 1n;
            const current = hostCounters();
            const reset = resetReminderCycle
                ? clearReminderCounters(current)
                : current;
            hostState = {
                ...reset,
                activeMs: counter(current.activeMs.value, true),
                activeLoops: counter(current.activeLoops.value, true),
                taskMs: counter(reset.taskMs.value, true),
                rootLoops: counter(reset.rootLoops.value, true),
                allLoops: counter(reset.allLoops.value, true),
            };
            await publishHost();
            return countersValue;
        },
        async resume() {
            if (!rootProcess || countersValue === undefined)
                return;
            paused = false;
            hostStateRevision += 1n;
            const current = hostCounters();
            hostState = {
                ...current,
                endLoopTimeMs: hostBusy() ? null : BigInt(now()),
                activeMs: counter(current.activeMs.value, false),
                activeLoops: counter(current.activeLoops.value, false),
                taskMs: counter(current.taskMs.value, false),
                rootLoops: counter(current.rootLoops.value, false),
                allLoops: counter(current.allLoops.value, false),
            };
            await publishHost();
            updateHostTimers();
        },
    };
}
const SHARED = Symbol.for("pi-reflect-watchdog:process-domain:v2");
export function getReflectDomainCoordinator() {
    const host = globalThis;
    host[SHARED] ??= createReflectDomainCoordinator();
    return host[SHARED];
}
