import {
	type CycleCounterSnapshot,
	openDomain,
	type ProcessDomain,
} from "pi-process-domain";

const ROOT_COUNTER = "pi-reflect-watchdog.root-loops";
const DOMAIN_COUNTER = "pi-reflect-watchdog.domain-loops";
const ACTIVE_COUNTER = "pi-reflect-watchdog.active-ms";
const ACTIVE_TICK_MS = 1_000;
const IDLE_GRACE_MS = 10_000;

type CounterName = "rootLoops" | "domainLoops" | "activeMs";
export interface ReflectDomainCounters {
	readonly rootLoops: CycleCounterSnapshot;
	readonly domainLoops: CycleCounterSnapshot;
	readonly activeMs: CycleCounterSnapshot;
}

export interface ReflectDomainCoordinator {
	readonly rootProcess: boolean;
	attach(instance: object, onFatal: (error: Error) => void): Promise<void>;
	detach(instance: object): Promise<void>;
	setBusy(instance: object, busy: boolean): Promise<void>;
	recordRootLoop(): Promise<ReflectDomainCounters>;
	recordDomainLoop(): Promise<ReflectDomainCounters>;
	counters(): ReflectDomainCounters | undefined;
	subscribe(listener: (counters: ReflectDomainCounters) => void): () => void;
	pauseAndReset(): Promise<ReflectDomainCounters | undefined>;
	resume(): Promise<void>;
}

interface Attachment {
	busy: boolean;
	onFatal: (error: Error) => void;
}

function counterNames(): Record<CounterName, string> {
	return {
		rootLoops: ROOT_COUNTER,
		domainLoops: DOMAIN_COUNTER,
		activeMs: ACTIVE_COUNTER,
	};
}

export interface ReflectDomainClock {
	setTimeout(
		callback: () => void,
		delayMs: number,
	): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface ReflectDomainOptions {
	readonly open?: typeof openDomain;
	readonly clock?: ReflectDomainClock;
	readonly activeTickMs?: number;
	readonly idleGraceMs?: number;
}

export function createReflectDomainCoordinator(
	options: ReflectDomainOptions = {},
): ReflectDomainCoordinator {
	const open = options.open ?? openDomain;
	const clock = options.clock ?? {
		setTimeout: (callback: () => void, delayMs: number) =>
			setTimeout(callback, delayMs),
		clearTimeout: (handle: ReturnType<typeof setTimeout>) =>
			clearTimeout(handle),
	};
	const activeTickMs = options.activeTickMs ?? ACTIVE_TICK_MS;
	const idleGraceMs = options.idleGraceMs ?? IDLE_GRACE_MS;
	const attachments = new Map<object, Attachment>();
	const listeners = new Set<(counters: ReflectDomainCounters) => void>();
	const reclaiming = new Set<string>();
	let domain: ProcessDomain | undefined;
	let rootProcess = false;
	let opening: Promise<void> | undefined;
	let countersValue: ReflectDomainCounters | undefined;
	let paused = false;
	let tick: ReturnType<typeof setTimeout> | undefined;
	let idleGrace: ReturnType<typeof setTimeout> | undefined;
	let unsubscribeDomain: (() => void) | undefined;
	let unsubscribeCounters: Array<() => void> = [];
	let writeTail = Promise.resolve();

	const notify = (next: ReflectDomainCounters): void => {
		countersValue = next;
		for (const listener of Array.from(listeners)) {
			try {
				listener(next);
			} catch {
				// Observers cannot corrupt broker state or the writer queue.
			}
		}
	};

	const readCounters = async (): Promise<ReflectDomainCounters> => {
		if (!domain) throw new Error("reflection process domain is not attached");
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

	const generation = (name: CounterName): bigint => {
		const current = countersValue?.[name];
		if (!current || current.generation === 0n)
			throw new Error(`reflection counter ${name} is not claimed`);
		return current.generation;
	};

	const increment = (
		name: CounterName,
		delta: bigint,
	): Promise<ReflectDomainCounters> => {
		const operation = writeTail
			.catch(() => {})
			.then(async () => {
				if (!domain)
					throw new Error("reflection process domain is not attached");
				const counter = await domain.incrementCycleCounter(
					counterNames()[name],
					delta,
					generation(name),
				);
				const current = countersValue ?? (await readCounters());
				const next = { ...current, [name]: counter } as ReflectDomainCounters;
				// Broker broadcasts are the only listener notification path. Updating the
				// local cache here only makes sequential writes use the committed value.
				countersValue = next;
				return next;
			});
		writeTail = operation.then(
			() => {},
			() => {},
		);
		return operation;
	};

	const anyBusy = (): boolean =>
		Array.from(attachments.values()).some((attachment) => attachment.busy);

	const resetContinuousActive = async (): Promise<void> => {
		if (!rootProcess || !domain || !countersValue || paused) return;
		const activeMs = await domain.resetCycleCounter(
			counterNames().activeMs,
			countersValue.activeMs.generation,
		);
		countersValue = { ...countersValue, activeMs };
	};

	const scheduleTick = (): void => {
		if (!rootProcess || !domain || tick !== undefined || paused) return;
		tick = clock.setTimeout(async () => {
			tick = undefined;
			if (!domain || paused) return;
			if (domain.snapshot().busyParticipants > 0) {
				try {
					await increment("activeMs", BigInt(activeTickMs));
				} catch {
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

	const startIdleGrace = (): void => {
		if (!rootProcess || !domain || paused || idleGrace !== undefined) return;
		idleGrace = clock.setTimeout(() => {
			idleGrace = undefined;
			if (!domain || paused) return;
			if (anyBusy() || domain.snapshot().busyParticipants > 0) {
				scheduleTick();
				return;
			}
			void resetContinuousActive().catch(() => {});
		}, idleGraceMs);
		idleGrace.unref?.();
	};

	const installCounterSubscriptions = (opened: ProcessDomain): void => {
		const names = counterNames();
		const keyByName = new Map(
			(Object.entries(names) as Array<[CounterName, string]>).map(
				([key, name]) => [name, key] as const,
			),
		);
		for (const name of Object.values(names)) {
			unsubscribeCounters.push(
				opened.subscribeCycleCounter(name, (counter) => {
					const key = keyByName.get(counter.name);
					if (!key || !countersValue) return;
					if (
						rootProcess &&
						counter.ownerParticipantId === null &&
						!reclaiming.has(counter.name)
					) {
						reclaiming.add(counter.name);
						void opened
							.claimCycleCounter(counter.name)
							.then((claimed) => {
								if (!countersValue) return;
								const current = countersValue[key];
								if (
									current.value === claimed.value &&
									current.paused === claimed.paused &&
									current.generation === claimed.generation &&
									current.ownerParticipantId === claimed.ownerParticipantId
								)
									return;
								const next = {
									...countersValue,
									[key]: claimed,
								} as ReflectDomainCounters;
								if (key === "rootLoops") countersValue = next;
								else notify(next);
							})
							.catch(() => {})
							.finally(() => reclaiming.delete(counter.name));
						return;
					}
					const current = countersValue[key];
					if (
						current.value === counter.value &&
						current.paused === counter.paused &&
						current.generation === counter.generation &&
						current.ownerParticipantId === counter.ownerParticipantId
					)
						return;
					const next = {
						...countersValue,
						[key]: counter,
					} as ReflectDomainCounters;
					if (key === "rootLoops") countersValue = next;
					else notify(next);
				}),
			);
		}
	};

	const ensureOpen = (): Promise<void> => {
		if (opening) return opening;
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
			} else await readCounters();
			installCounterSubscriptions(domain);
			unsubscribeDomain = domain.subscribe((snapshot) => {
				if (!rootProcess || paused) return;
				if (snapshot.busyParticipants > 0) {
					if (idleGrace) clock.clearTimeout(idleGrace);
					idleGrace = undefined;
					scheduleTick();
				} else if (tick === undefined) startIdleGrace();
			});
		})().catch((error) => {
			for (const attachment of attachments.values()) {
				try {
					attachment.onFatal(
						error instanceof Error ? error : new Error(String(error)),
					);
				} catch {
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
			if (attachments.size !== 0 || !domain) return;
			if (tick) clock.clearTimeout(tick);
			if (idleGrace) clock.clearTimeout(idleGrace);
			unsubscribeDomain?.();
			for (const unsubscribe of unsubscribeCounters) unsubscribe();
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
			if (!attachment || !domain) return;
			attachment.busy = busy;
			await domain.setActivity(anyBusy() ? "busy" : "idle");
			if (busy) {
				if (idleGrace) clock.clearTimeout(idleGrace);
				idleGrace = undefined;
				scheduleTick();
			}
		},
		async recordRootLoop() {
			if (!rootProcess) return increment("domainLoops", 1n);
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
			if (!domain || !rootProcess || !countersValue) return countersValue;
			paused = true;
			if (tick) clock.clearTimeout(tick);
			tick = undefined;
			const names = counterNames();
			for (const name of Object.keys(names) as CounterName[]) {
				const counter = countersValue[name];
				await domain.setCycleCounterPaused(
					names[name],
					true,
					counter.generation,
				);
			}
			const before = await readCounters();
			for (const name of Object.keys(names) as CounterName[]) {
				const counter = before[name];
				await domain.resetCycleCounter(names[name], counter.generation);
			}
			return readCounters();
		},
		async resume() {
			if (!domain || !rootProcess || !countersValue) return;
			const names = counterNames();
			for (const name of Object.keys(names) as CounterName[]) {
				const counter = countersValue[name];
				await domain.setCycleCounterPaused(
					names[name],
					false,
					counter.generation,
				);
			}
			paused = false;
			if (anyBusy() || domain.snapshot().busyParticipants > 0) scheduleTick();
			await readCounters();
		},
	};
}

const SHARED = Symbol.for("pi-reflect-watchdog:process-domain:v1");
type SharedHost = typeof globalThis & { [SHARED]?: ReflectDomainCoordinator };

export function getReflectDomainCoordinator(): ReflectDomainCoordinator {
	const host = globalThis as SharedHost;
	host[SHARED] ??= createReflectDomainCoordinator();
	return host[SHARED];
}
