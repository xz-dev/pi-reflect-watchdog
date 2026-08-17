import { openDomain, } from "pi-process-domain";
const ROOT_COUNTER = "pi-reflect-watchdog.root-loops";
const DOMAIN_COUNTER = "pi-reflect-watchdog.domain-loops";
const ACTIVE_COUNTER = "pi-reflect-watchdog.active-ms";
const ACTIVE_TICK_MS = 1_000;
const IDLE_GRACE_MS = 10_000;
function counterNames() {
    return {
        rootLoops: ROOT_COUNTER,
        domainLoops: DOMAIN_COUNTER,
        activeMs: ACTIVE_COUNTER,
    };
}
export function createReflectDomainCoordinator(options = {}) {
    const open = options.open ?? openDomain;
    const clock = options.clock ?? {
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (handle) => clearTimeout(handle),
    };
    const activeTickMs = options.activeTickMs ?? ACTIVE_TICK_MS;
    const idleGraceMs = options.idleGraceMs ?? IDLE_GRACE_MS;
    const attachments = new Map();
    const listeners = new Set();
    const reclaiming = new Set();
    let domain;
    let rootProcess = false;
    let opening;
    let countersValue;
    let paused = false;
    let tick;
    let idleGrace;
    let unsubscribeDomain;
    let unsubscribeCounters = [];
    let writeTail = Promise.resolve();
    const notify = (next) => {
        countersValue = next;
        for (const listener of Array.from(listeners)) {
            try {
                listener(next);
            }
            catch {
                // Observers cannot corrupt broker state or the writer queue.
            }
        }
    };
    const readCounters = async () => {
        if (!domain)
            throw new Error("reflection process domain is not attached");
        const names = counterNames();
        const [rootLoops, domainLoops, activeMs] = await Promise.all([
            domain.getCycleCounter(names.rootLoops),
            domain.getCycleCounter(names.domainLoops),
            domain.getCycleCounter(names.activeMs),
        ]);
        const next = { rootLoops, domainLoops, activeMs };
        notify(next);
        return next;
    };
    const generation = (name) => {
        const current = countersValue?.[name];
        if (!current || current.generation === 0n)
            throw new Error(`reflection counter ${name} is not claimed`);
        return current.generation;
    };
    const increment = (name, delta) => {
        const operation = writeTail
            .catch(() => { })
            .then(async () => {
            if (!domain)
                throw new Error("reflection process domain is not attached");
            const counter = await domain.incrementCycleCounter(counterNames()[name], delta, generation(name));
            const current = countersValue ?? (await readCounters());
            const next = { ...current, [name]: counter };
            // Broker broadcasts are the only listener notification path. Updating the
            // local cache here only makes sequential writes use the committed value.
            countersValue = next;
            return next;
        });
        writeTail = operation.then(() => { }, () => { });
        return operation;
    };
    const anyBusy = () => Array.from(attachments.values()).some((attachment) => attachment.busy);
    const resetContinuousActive = async () => {
        if (!rootProcess || !domain || !countersValue || paused)
            return;
        const activeMs = await domain.resetCycleCounter(counterNames().activeMs, countersValue.activeMs.generation);
        countersValue = { ...countersValue, activeMs };
    };
    const scheduleTick = () => {
        if (!rootProcess || !domain || tick !== undefined || paused)
            return;
        tick = clock.setTimeout(async () => {
            tick = undefined;
            if (!domain || paused)
                return;
            if (domain.snapshot().busyParticipants > 0) {
                try {
                    await increment("activeMs", BigInt(activeTickMs));
                }
                catch {
                    // Runtime reconnect makes the snapshot uncertain; the next tick retries.
                }
            }
            if (anyBusy() || domain.snapshot().busyParticipants > 0) {
                scheduleTick();
                return;
            }
            startIdleGrace();
        }, activeTickMs);
        tick.unref?.();
    };
    const startIdleGrace = () => {
        if (!rootProcess || !domain || paused || idleGrace !== undefined)
            return;
        idleGrace = clock.setTimeout(() => {
            idleGrace = undefined;
            if (!domain || paused)
                return;
            if (anyBusy() || domain.snapshot().busyParticipants > 0) {
                scheduleTick();
                return;
            }
            void resetContinuousActive().catch(() => { });
        }, idleGraceMs);
        idleGrace.unref?.();
    };
    const installCounterSubscriptions = (opened) => {
        const names = counterNames();
        const keyByName = new Map(Object.entries(names).map(([key, name]) => [name, key]));
        for (const name of Object.values(names)) {
            unsubscribeCounters.push(opened.subscribeCycleCounter(name, (counter) => {
                const key = keyByName.get(counter.name);
                if (!key || !countersValue)
                    return;
                if (rootProcess &&
                    counter.ownerParticipantId === null &&
                    !reclaiming.has(counter.name)) {
                    reclaiming.add(counter.name);
                    void opened
                        .claimCycleCounter(counter.name)
                        .then((claimed) => {
                        if (!countersValue)
                            return;
                        const current = countersValue[key];
                        if (current.value === claimed.value &&
                            current.paused === claimed.paused &&
                            current.generation === claimed.generation &&
                            current.ownerParticipantId === claimed.ownerParticipantId)
                            return;
                        const next = {
                            ...countersValue,
                            [key]: claimed,
                        };
                        if (key === "rootLoops")
                            countersValue = next;
                        else
                            notify(next);
                    })
                        .catch(() => { })
                        .finally(() => reclaiming.delete(counter.name));
                    return;
                }
                const current = countersValue[key];
                if (current.value === counter.value &&
                    current.paused === counter.paused &&
                    current.generation === counter.generation &&
                    current.ownerParticipantId === counter.ownerParticipantId)
                    return;
                const next = {
                    ...countersValue,
                    [key]: counter,
                };
                if (key === "rootLoops")
                    countersValue = next;
                else
                    notify(next);
            }));
        }
    };
    const ensureOpen = () => {
        if (opening)
            return opening;
        opening = (async () => {
            const result = await open({
                initialActivity: anyBusy() ? "busy" : "idle",
                metadata: { role: "pi-reflect-watchdog", pid: String(process.pid) },
            });
            domain = result.domain;
            rootProcess = result.hosted;
            if (rootProcess) {
                const names = counterNames();
                const rootLoops = await domain.claimCycleCounter(names.rootLoops);
                const domainLoops = await domain.claimCycleCounter(names.domainLoops);
                const activeMs = await domain.claimCycleCounter(names.activeMs);
                notify({ rootLoops, domainLoops, activeMs });
            }
            else
                await readCounters();
            installCounterSubscriptions(domain);
            unsubscribeDomain = domain.subscribe((snapshot) => {
                if (!rootProcess || paused)
                    return;
                if (snapshot.busyParticipants > 0) {
                    if (idleGrace)
                        clock.clearTimeout(idleGrace);
                    idleGrace = undefined;
                    scheduleTick();
                }
                else if (tick === undefined)
                    startIdleGrace();
            });
        })().catch((error) => {
            for (const attachment of attachments.values()) {
                try {
                    attachment.onFatal(error instanceof Error ? error : new Error(String(error)));
                }
                catch {
                    // Fatal ownership remains with the host adapter.
                }
            }
            opening = undefined;
            throw error;
        });
        return opening;
    };
    return {
        get rootProcess() {
            return rootProcess;
        },
        attach(instance, onFatal) {
            if (!attachments.has(instance))
                attachments.set(instance, { busy: false, onFatal });
            return ensureOpen();
        },
        async detach(instance) {
            attachments.delete(instance);
            if (attachments.size !== 0 || !domain)
                return;
            if (tick)
                clock.clearTimeout(tick);
            if (idleGrace)
                clock.clearTimeout(idleGrace);
            unsubscribeDomain?.();
            for (const unsubscribe of unsubscribeCounters)
                unsubscribe();
            unsubscribeCounters = [];
            reclaiming.clear();
            tick = undefined;
            idleGrace = undefined;
            unsubscribeDomain = undefined;
            const closing = domain;
            domain = undefined;
            opening = undefined;
            countersValue = undefined;
            rootProcess = false;
            await closing.close();
        },
        async setBusy(instance, busy) {
            const attachment = attachments.get(instance);
            if (!attachment || !domain)
                return;
            attachment.busy = busy;
            await domain.setActivity(anyBusy() ? "busy" : "idle");
            if (busy) {
                if (idleGrace)
                    clock.clearTimeout(idleGrace);
                idleGrace = undefined;
                scheduleTick();
            }
        },
        async recordRootLoop() {
            if (!rootProcess)
                return increment("domainLoops", 1n);
            await increment("rootLoops", 1n);
            return increment("domainLoops", 1n);
        },
        recordDomainLoop() {
            return increment("domainLoops", 1n);
        },
        counters() {
            return countersValue;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async pauseAndReset() {
            if (!domain || !rootProcess || !countersValue)
                return countersValue;
            paused = true;
            if (tick)
                clock.clearTimeout(tick);
            tick = undefined;
            const names = counterNames();
            for (const name of Object.keys(names)) {
                const counter = countersValue[name];
                await domain.setCycleCounterPaused(names[name], true, counter.generation);
            }
            const before = await readCounters();
            for (const name of Object.keys(names)) {
                const counter = before[name];
                await domain.resetCycleCounter(names[name], counter.generation);
            }
            return readCounters();
        },
        async resume() {
            if (!domain || !rootProcess || !countersValue)
                return;
            const names = counterNames();
            for (const name of Object.keys(names)) {
                const counter = countersValue[name];
                await domain.setCycleCounterPaused(names[name], false, counter.generation);
            }
            paused = false;
            if (anyBusy() || domain.snapshot().busyParticipants > 0)
                scheduleTick();
            await readCounters();
        },
    };
}
const SHARED = Symbol.for("pi-reflect-watchdog:process-domain:v1");
export function getReflectDomainCoordinator() {
    const host = globalThis;
    host[SHARED] ??= createReflectDomainCoordinator();
    return host[SHARED];
}
