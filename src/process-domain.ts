import {
	isProcessDomainOpenError,
	openProcessDomain,
	type ProcessDomainDataMessage,
	type ProcessDomainEvent,
	type ProcessDomainNode,
	type ProcessDomainOpenErrorCode,
} from "pi-extension-utils/process-domain";

export const FATAL_EXIT_CODE = 78;

const ACTIVITY_CHANNEL = "pi-reflect-watchdog.activity.v2";
const LOOP_CHANNEL = "pi-reflect-watchdog.loop.v2";
const COUNTERS_CHANNEL = "pi-reflect-watchdog.counters.v2";
const LEAVE_CHANNEL = "pi-reflect-watchdog.leave.v2";
const ACTIVE_TICK_MS = 1_000;
const IDLE_RESET_GAP_MS = 60_000;

export type ReflectDomainFatalCode =
	| ProcessDomainOpenErrorCode
	| "DOMAIN_UNRECOVERABLE";

export class ReflectDomainFatalError extends Error {
	readonly isReflectDomainFatalError = true as const;

	constructor(
		readonly code: ReflectDomainFatalCode,
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options);
		this.name = "ReflectDomainFatalError";
	}
}

export function isReflectDomainFatalError(
	value: unknown,
): value is ReflectDomainFatalError {
	return (
		value instanceof Error &&
		(value as ReflectDomainFatalError).isReflectDomainFatalError === true
	);
}

const TRANSIENT_TRANSPORT_MESSAGES = [
	"process-domain host is offline",
	"process-domain host disconnected",
	"process-domain peer disconnected",
	"process-domain acknowledgement timed out",
	"process-domain connection timed out",
	"process-domain connection closed",
	"process-domain send timed out",
] as const;

function isTransientTransportError(error: unknown): boolean {
	if (error instanceof TypeError) return false;
	const message = error instanceof Error ? error.message : "";
	return TRANSIENT_TRANSPORT_MESSAGES.some((candidate) =>
		message.includes(candidate),
	);
}

export interface ReflectCounterValue {
	readonly value: bigint;
}

export interface ReflectDomainFence {
	readonly domainEpoch: string;
	readonly generation: bigint;
}

export interface ReflectDomainCounters {
	readonly domainEpoch: string;
	readonly revision: bigint;
	readonly generation: bigint;
	readonly certain: boolean;
	readonly anyBusy: boolean;
	readonly localBusy: boolean;
	readonly otherBusy: boolean;
	readonly endLoopTimeMs: bigint | null;
	readonly fence: ReflectDomainFence;
	readonly activeMs: ReflectCounterValue;
	readonly activeLoops: ReflectCounterValue;
	readonly taskMs: ReflectCounterValue;
	readonly rootLoops: ReflectCounterValue;
	readonly allLoops: ReflectCounterValue;
}

interface ActivityWire {
	readonly revision: string;
	readonly busy: boolean;
}

interface LoopWire {
	readonly revision: string;
	readonly rootLoops: string;
	readonly allLoops: string;
}

interface RevisionWire {
	readonly nodeId: string;
	readonly revision: string;
}

interface CountersWire {
	readonly revision: string;
	readonly generation: string;
	readonly domainEpoch: string;
	readonly certain: boolean;
	readonly anyBusy: boolean;
	readonly localBusy: boolean;
	readonly otherBusy: boolean;
	readonly endLoopTimeMs: string | null;
	readonly activeMs: string;
	readonly activeLoops: string;
	readonly taskMs: string;
	readonly rootLoops: string;
	readonly allLoops: string;
	readonly activityRevisions: readonly RevisionWire[];
	readonly loopRevisions: readonly RevisionWire[];
}

interface PeerActivity {
	busy: boolean;
	activityRevision: bigint;
	loopRevision: bigint;
	rootLoops: bigint;
	allLoops: bigint;
}

interface Attachment {
	busy: boolean;
	readonly getBusy: () => boolean;
	readonly onFatal: (error: Error) => void;
}

interface ParsedCounterMessage {
	readonly counters: ReflectDomainCounters;
	readonly activityRevision: bigint;
	readonly loopRevision: bigint;
}

export interface ReflectDomainCoordinator {
	readonly rootProcess: boolean;
	attach(
		instance: object,
		options: {
			/** Queried at attach and after every client reconnect. */
			readonly getBusy: () => boolean;
			readonly onFatal: (error: Error) => void;
		},
	): Promise<void>;
	detach(instance: object): Promise<void>;
	setBusy(instance: object, busy: boolean): Promise<void>;
	recordRootLoop(): Promise<ReflectDomainCounters>;
	recordAllLoop(): Promise<ReflectDomainCounters>;
	counters(): ReflectDomainCounters | undefined;
	subscribe(listener: (counters: ReflectDomainCounters) => void): () => void;
	setIdleResetGapSeconds(seconds: number): void;
	resetReminderCycle(): Promise<ReflectDomainCounters | undefined>;
}

export interface ReflectDomainClock {
	setTimeout(
		callback: () => void,
		delayMs: number,
	): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface ReflectDomainOptions {
	readonly open?: typeof openProcessDomain;
	readonly env?: NodeJS.ProcessEnv;
	readonly clock?: ReflectDomainClock;
	readonly activeTickMs?: number;
	readonly idleResetGapMs?: number;
	readonly now?: () => number;
}

function counter(value = 0n): ReflectCounterValue {
	return { value };
}

function zeroCounters(
	state: {
		readonly domainEpoch?: string;
		readonly revision?: bigint;
		readonly generation?: bigint;
		readonly certain?: boolean;
		readonly anyBusy?: boolean;
		readonly localBusy?: boolean;
		readonly otherBusy?: boolean;
	} = {},
): ReflectDomainCounters {
	const domainEpoch = state.domainEpoch ?? "pending";
	const generation = state.generation ?? 0n;
	return {
		domainEpoch,
		revision: state.revision ?? 0n,
		generation,
		certain: state.certain ?? false,
		anyBusy: state.anyBusy ?? false,
		localBusy: state.localBusy ?? false,
		otherBusy: state.otherBusy ?? false,
		endLoopTimeMs: null,
		fence: { domainEpoch, generation },
		activeMs: counter(),
		activeLoops: counter(),
		taskMs: counter(),
		rootLoops: counter(),
		allLoops: counter(),
	};
}

function sameCounters(
	left: ReflectDomainCounters,
	right: ReflectDomainCounters,
): boolean {
	return (
		left.domainEpoch === right.domainEpoch &&
		left.revision === right.revision &&
		left.generation === right.generation &&
		left.certain === right.certain &&
		left.anyBusy === right.anyBusy &&
		left.localBusy === right.localBusy &&
		left.otherBusy === right.otherBusy &&
		left.endLoopTimeMs === right.endLoopTimeMs &&
		left.activeMs.value === right.activeMs.value &&
		left.activeLoops.value === right.activeLoops.value &&
		left.taskMs.value === right.taskMs.value &&
		left.rootLoops.value === right.rootLoops.value &&
		left.allLoops.value === right.allLoops.value
	);
}

function validId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

function validRevision(value: unknown): value is string {
	return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function validCounterValue(value: unknown): value is string {
	return typeof value === "string" && /^\d+$/.test(value);
}

function parseRevisionMap(value: unknown): Map<string, bigint> | null {
	if (!Array.isArray(value)) return null;
	const parsed = new Map<string, bigint>();
	for (const entry of value) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!validId((entry as Partial<RevisionWire>).nodeId) ||
			!validRevision((entry as Partial<RevisionWire>).revision) ||
			parsed.has((entry as RevisionWire).nodeId)
		) {
			return null;
		}
		parsed.set(
			(entry as RevisionWire).nodeId,
			BigInt((entry as RevisionWire).revision),
		);
	}
	return parsed;
}

function parseActivity(
	value: unknown,
): { busy: boolean; revision: bigint } | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as Partial<ActivityWire>;
	if (typeof wire.busy !== "boolean" || !validRevision(wire.revision))
		return null;
	return { busy: wire.busy, revision: BigInt(wire.revision) };
}

function parseLoop(value: unknown): {
	revision: bigint;
	rootLoops: bigint;
	allLoops: bigint;
} | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as Partial<LoopWire>;
	if (
		!validRevision(wire.revision) ||
		!validCounterValue(wire.rootLoops) ||
		!validCounterValue(wire.allLoops)
	)
		return null;
	const revision = BigInt(wire.revision);
	const rootLoops = BigInt(wire.rootLoops);
	const allLoops = BigInt(wire.allLoops);
	if (allLoops !== revision || rootLoops > allLoops) return null;
	return { revision, rootLoops, allLoops };
}

function parseCounters(
	value: unknown,
	nodeId: string,
): ParsedCounterMessage | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as Partial<CountersWire>;
	const activityRevisions = parseRevisionMap(wire.activityRevisions);
	const loopRevisions = parseRevisionMap(wire.loopRevisions);
	if (
		!validRevision(wire.revision) ||
		!validRevision(wire.generation) ||
		!validId(wire.domainEpoch) ||
		typeof wire.certain !== "boolean" ||
		typeof wire.anyBusy !== "boolean" ||
		typeof wire.localBusy !== "boolean" ||
		typeof wire.otherBusy !== "boolean" ||
		(wire.endLoopTimeMs !== null && !validCounterValue(wire.endLoopTimeMs)) ||
		!validCounterValue(wire.activeMs) ||
		!validCounterValue(wire.activeLoops) ||
		!validCounterValue(wire.taskMs) ||
		!validCounterValue(wire.rootLoops) ||
		!validCounterValue(wire.allLoops) ||
		activityRevisions === null ||
		loopRevisions === null
	) {
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
			localBusy: wire.localBusy,
			otherBusy: wire.otherBusy,
			endLoopTimeMs:
				wire.endLoopTimeMs === null ? null : BigInt(wire.endLoopTimeMs),
			fence: { domainEpoch: wire.domainEpoch, generation },
			activeMs: counter(BigInt(wire.activeMs)),
			activeLoops: counter(BigInt(wire.activeLoops)),
			taskMs: counter(BigInt(wire.taskMs)),
			rootLoops: counter(BigInt(wire.rootLoops)),
			allLoops: counter(BigInt(wire.allLoops)),
		},
		activityRevision: activityRevisions.get(nodeId) ?? 0n,
		loopRevision: loopRevisions.get(nodeId) ?? 0n,
	};
}

function revisionMap(
	value: ReadonlyMap<string, bigint>,
): readonly RevisionWire[] {
	return Array.from(value)
		.filter(([, revision]) => revision > 0n)
		.map(([nodeId, revision]) => ({
			nodeId,
			revision: revision.toString(),
		}));
}

export function createReflectDomainCoordinator(
	options: ReflectDomainOptions = {},
): ReflectDomainCoordinator {
	const open = options.open ?? openProcessDomain;
	const env = options.env ?? process.env;
	const clock = options.clock ?? {
		setTimeout: (callback: () => void, delayMs: number) =>
			setTimeout(callback, delayMs),
		clearTimeout: (handle: ReturnType<typeof setTimeout>) =>
			clearTimeout(handle),
	};
	const activeTickMs = options.activeTickMs ?? ACTIVE_TICK_MS;
	const now = options.now ?? Date.now;
	let idleResetGapMs = options.idleResetGapMs ?? IDLE_RESET_GAP_MS;
	const attachments = new Map<object, Attachment>();
	const listeners = new Set<(counters: ReflectDomainCounters) => void>();
	const peers = new Map<string, PeerActivity>();
	const uncertainPeers = new Set<string>();
	let node: ProcessDomainNode | undefined;
	let rootProcess = false;
	let opening: Promise<void> | undefined;
	let countersValue: ReflectDomainCounters | undefined;
	let hostState: ReflectDomainCounters | undefined;
	let hostStateRevision = 0n;
	let acceptedHostRevision = 0n;
	let acceptedHostEpoch: string | undefined;
	let transportHealthy = true;
	let tick: ReturnType<typeof setTimeout> | undefined;
	let unsubscribeEvents: (() => void) | undefined;
	let unsubscribeActivity: (() => void) | undefined;
	let unsubscribeLoops: (() => void) | undefined;
	let unsubscribeCounters: (() => void) | undefined;
	let unsubscribeLeave: (() => void) | undefined;
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

	const desiredActivity = (): boolean =>
		Array.from(attachments.values()).some((attachment) => attachment.busy);

	const notify = (next: ReflectDomainCounters): void => {
		if (countersValue !== undefined && sameCounters(countersValue, next))
			return;
		countersValue = next;
		for (const listener of Array.from(listeners)) {
			try {
				listener(next);
			} catch {
				// Observers cannot corrupt coordinator state or the writer queue.
			}
		}
	};

	const markClientUncertain = (): void => {
		countersValue = undefined;
	};

	const queueLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = lifecycleTail.catch(() => {}).then(operation);
		lifecycleTail = result.then(
			() => {},
			() => {},
		);
		return result;
	};

	const queueTransport = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = writeTail.catch(() => {}).then(operation);
		writeTail = result.then(
			() => {},
			() => {},
		);
		return result;
	};

	const markTransportUncertain = (forceTransport = false): void => {
		if (node === undefined) return;
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
			if (
				peer.status === "offline" &&
				peers.has(peer.nodeId) &&
				!uncertainPeers.has(peer.nodeId)
			) {
				uncertainPeers.add(peer.nodeId);
				changed = true;
			}
		}
		if (!changed) return;
		hostStateRevision += 1n;
		const current = countersValue ?? hostCounters();
		if (!current.certain) return;
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

	const reportFatal = (error: Error, forceTransport = false): void => {
		markTransportUncertain(forceTransport);
		for (const attachment of attachments.values()) {
			try {
				attachment.onFatal(error);
			} catch {
				// Fatal ownership remains with the host adapter.
			}
		}
	};

	const hostCounters = (): ReflectDomainCounters => hostState ?? zeroCounters();

	const hostBusy = (): boolean => {
		if (desiredActivity()) return true;
		for (const peer of peers.values()) if (peer.busy) return true;
		return false;
	};

	const hostCertain = (): boolean =>
		transportHealthy && uncertainPeers.size === 0;

	const publishHostNow = async (): Promise<void> => {
		if (!rootProcess || node === undefined) return;
		const currentNode = node;
		const current = hostCounters();
		const publishedStateRevision = hostStateRevision;
		snapshotRevision += 1n;
		snapshotGeneration += 1n;
		const domainEpoch = currentNode.declaration.domainId;
		const counters: ReflectDomainCounters = {
			...current,
			domainEpoch,
			revision: snapshotRevision,
			generation: snapshotGeneration,
			certain: uncertainPeers.size === 0,
			anyBusy: hostBusy(),
			localBusy: desiredActivity(),
			otherBusy: [...peers.values()].some((peer) => peer.busy),
			fence: { domainEpoch, generation: snapshotGeneration },
		};
		const activityRevisions = new Map<string, bigint>();
		const loopRevisions = new Map<string, bigint>();
		for (const [nodeId, peer] of peers) {
			activityRevisions.set(nodeId, peer.activityRevision);
			loopRevisions.set(nodeId, peer.loopRevision);
		}
		const message: CountersWire = {
			revision: snapshotRevision.toString(),
			generation: snapshotGeneration.toString(),
			domainEpoch,
			certain: counters.certain,
			anyBusy: counters.anyBusy,
			localBusy: counters.localBusy,
			otherBusy: counters.otherBusy,
			endLoopTimeMs: counters.endLoopTimeMs?.toString() ?? null,
			activeMs: counters.activeMs.value.toString(),
			activeLoops: counters.activeLoops.value.toString(),
			taskMs: counters.taskMs.value.toString(),
			rootLoops: counters.rootLoops.value.toString(),
			allLoops: counters.allLoops.value.toString(),
			activityRevisions: revisionMap(activityRevisions),
			loopRevisions: revisionMap(loopRevisions),
		};
		const targets = [...peers.keys()].filter((nodeId) =>
			currentNode
				.peers()
				.some((peer) => peer.nodeId === nodeId && peer.status === "online"),
		);
		await Promise.all(
			targets.map((nodeId) =>
				currentNode.send(nodeId, COUNTERS_CHANNEL, message),
			),
		);
		transportHealthy = true;
		if (publishedStateRevision === hostStateRevision) notify(counters);
	};

	const publishHost = (): Promise<void> =>
		queueTransport(async () => {
			try {
				await publishHostNow();
			} catch (error) {
				reportFatal(
					error instanceof Error
						? error
						: new Error("reflection transport write failed"),
					true,
				);
				throw error;
			}
		});

	const applyHostActivity = (message: ProcessDomainDataMessage): void => {
		if (!rootProcess || node === undefined) return;
		const peer = node
			.peers()
			.find((candidate) => candidate.nodeId === message.senderId);
		if (peer?.status !== "online") return;
		const activity = parseActivity(message.value);
		const current = peers.get(message.senderId);
		if (
			activity === null ||
			current === undefined ||
			activity.revision <= current.activityRevision
		)
			return;
		const wasBusy = hostBusy();
		current.busy = activity.busy;
		current.activityRevision = activity.revision;
		hostStateRevision += 1n;
		uncertainPeers.delete(message.senderId);
		applyAggregateBusyTransition(wasBusy, hostBusy());
		void publishHost()
			.then(updateHostTimers)
			.catch(() => {});
	};

	const applyHostLoop = (message: ProcessDomainDataMessage): void => {
		if (!rootProcess || node === undefined) return;
		const peer = node
			.peers()
			.find((candidate) => candidate.nodeId === message.senderId);
		if (peer?.status !== "online") return;
		const loop = parseLoop(message.value);
		const current = peers.get(message.senderId);
		if (
			loop === null ||
			current === undefined ||
			loop.revision <= current.loopRevision ||
			loop.rootLoops < current.rootLoops ||
			loop.allLoops < current.allLoops
		)
			return;
		const rootDelta = loop.rootLoops - current.rootLoops;
		const allDelta = loop.allLoops - current.allLoops;
		current.loopRevision = loop.revision;
		current.rootLoops = loop.rootLoops;
		current.allLoops = loop.allLoops;
		hostStateRevision += 1n;
		const currentCounters = hostCounters();
		hostState = {
			...currentCounters,
			activeLoops: counter(currentCounters.activeLoops.value + allDelta),
			rootLoops: counter(currentCounters.rootLoops.value + rootDelta),
			allLoops: counter(currentCounters.allLoops.value + allDelta),
		};
		void publishHost().catch(() => {});
	};

	const clearEveryCounter = (current: ReflectDomainCounters) => ({
		...current,
		endLoopTimeMs: null,
		activeMs: counter(),
		activeLoops: counter(),
		taskMs: counter(),
		rootLoops: counter(),
		allLoops: counter(),
	});

	const clearReminderCounters = (current: ReflectDomainCounters) => ({
		...current,
		taskMs: counter(),
		rootLoops: counter(),
		allLoops: counter(),
	});

	const applyAggregateBusyTransition = (
		wasBusy: boolean,
		isBusy: boolean,
	): void => {
		if (!rootProcess || wasBusy === isBusy) return;
		const current = hostCounters();
		if (!isBusy) {
			hostState = {
				...current,
				anyBusy: false,
				localBusy: false,
				otherBusy: false,
				endLoopTimeMs: BigInt(now()),
			};
			return;
		}
		const gapExceeded =
			current.endLoopTimeMs !== null &&
			BigInt(now()) > current.endLoopTimeMs + BigInt(idleResetGapMs);
		const resumed = gapExceeded ? clearEveryCounter(current) : current;
		hostState = {
			...resumed,
			anyBusy: true,
			localBusy: desiredActivity(),
			otherBusy: [...peers.values()].some((peer) => peer.busy),
			endLoopTimeMs: null,
		};
	};

	const scheduleTick = (): void => {
		if (!rootProcess || node === undefined || tick !== undefined) return;
		tick = clock.setTimeout(() => {
			tick = undefined;
			if (!rootProcess || !hostCertain()) return;
			if (!hostBusy()) return;
			const current = hostCounters();
			hostStateRevision += 1n;
			hostState = {
				...current,
				activeMs: counter(current.activeMs.value + BigInt(activeTickMs)),
				taskMs: counter(current.taskMs.value + BigInt(activeTickMs)),
			};
			void publishHost().catch(() => {});
			scheduleTick();
			return;
		}, activeTickMs);
		tick.unref?.();
	};

	const updateHostTimers = (): void => {
		if (!rootProcess || !hostCertain()) return;
		if (hostBusy()) {
			scheduleTick();
			return;
		}
		if (tick !== undefined) {
			clock.clearTimeout(tick);
			tick = undefined;
		}
	};

	const handleTransportEvent = (event: ProcessDomainEvent): void => {
		if (event.type !== "peer" || node === undefined) return;
		if (!rootProcess) {
			if (event.peer.nodeId !== node.declaration.hostNodeId) return;
			if (event.peer.status === "offline") markClientUncertain();
			else {
				markClientUncertain();
				for (const attachment of attachments.values())
					attachment.busy = attachment.getBusy();
				void (async () => {
					await queueWrite("activity");
					await queueLoopSnapshot();
				})().catch(() => {});
			}
			return;
		}
		const wasBusy = hostBusy();
		if (event.peer.status === "online") {
			if (peers.has(event.peer.nodeId)) return;
			peers.set(event.peer.nodeId, {
				busy: event.peer.metadata.activity === "busy",
				activityRevision: 0n,
				loopRevision: 0n,
				rootLoops: 0n,
				allLoops: 0n,
			});
			uncertainPeers.add(event.peer.nodeId);
		} else {
			if (!peers.has(event.peer.nodeId)) return;
			uncertainPeers.add(event.peer.nodeId);
		}
		hostStateRevision += 1n;
		applyAggregateBusyTransition(wasBusy, hostBusy());
		void publishHost().catch(() => {});
		updateHostTimers();
	};

	const queueWrite = (
		kind: "activity" | "root-loop" | "all-loop",
	): Promise<void> => {
		const clientWrite =
			node !== undefined && !rootProcess
				? kind === "activity"
					? {
							kind,
							revision: ++localActivityRevision,
							busy: desiredActivity(),
						}
					: {
							kind,
							revision: ++localLoopRevision,
							rootLoops:
								kind === "root-loop" ? ++localRootLoops : localRootLoops,
							allLoops: ++localAllLoops,
						}
				: undefined;
		if (clientWrite?.kind === "activity") {
			requiredActivityRevision = clientWrite.revision;
			markClientUncertain();
		} else if (clientWrite !== undefined) {
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
					} satisfies ActivityWire);
					return;
				}
				await node.send(node.declaration.hostNodeId, LOOP_CHANNEL, {
					revision: clientWrite.revision.toString(),
					rootLoops: clientWrite.rootLoops.toString(),
					allLoops: clientWrite.allLoops.toString(),
				} satisfies LoopWire);
			} catch (error) {
				if (!rootProcess && isTransientTransportError(error)) {
					// Reconnect replays activity and the cumulative loop snapshot.
					markClientUncertain();
					return;
				}
				reportFatal(
					error instanceof Error
						? error
						: new Error("reflection transport write failed"),
				);
				throw error;
			}
		});
	};

	const queueLoopSnapshot = (): Promise<void> => {
		if (node === undefined || rootProcess || localLoopRevision === 0n)
			return Promise.resolve();
		const target = node.declaration.hostNodeId;
		const revision = localLoopRevision;
		const rootLoops = localRootLoops;
		const allLoops = localAllLoops;
		requiredLoopRevision = revision;
		markClientUncertain();
		return queueTransport(async () => {
			if (node === undefined || rootProcess) return;
			try {
				await node.send(target, LOOP_CHANNEL, {
					revision: revision.toString(),
					rootLoops: rootLoops.toString(),
					allLoops: allLoops.toString(),
				} satisfies LoopWire);
			} catch (error) {
				if (!rootProcess && isTransientTransportError(error)) {
					markClientUncertain();
					return;
				}
				reportFatal(
					error instanceof Error
						? error
						: new Error("reflection transport write failed"),
				);
				throw error;
			}
		});
	};

	const ensureOpen = (): Promise<void> => {
		if (opening) return opening;
		opening = (async () => {
			let opened: ProcessDomainNode;
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
			} catch (error) {
				throw new ReflectDomainFatalError(
					isProcessDomainOpenError(error) ? error.code : "DOMAIN_UNRECOVERABLE",
					"failed to initialize reflect-watchdog process transport",
					{ cause: error },
				);
			}
			node = opened;
			rootProcess = opened.role === "host";
			if (rootProcess) {
				hostState = zeroCounters({
					domainEpoch: opened.declaration.domainId,
					certain: true,
				});
				countersValue = hostState;
				transportHealthy = true;

				snapshotRevision = 0n;
				snapshotGeneration = 0n;
				unsubscribeEvents = opened.subscribeEvents(handleTransportEvent);
				unsubscribeActivity = opened.subscribe(
					ACTIVITY_CHANNEL,
					applyHostActivity,
				);
				unsubscribeLoops = opened.subscribe(LOOP_CHANNEL, applyHostLoop);
				unsubscribeLeave = opened.subscribe(LEAVE_CHANNEL, (message) => {
					const wasBusy = hostBusy();
					if (!peers.delete(message.senderId)) return;
					uncertainPeers.delete(message.senderId);
					hostStateRevision += 1n;
					applyAggregateBusyTransition(wasBusy, hostBusy());
					void publishHost()
						.then(updateHostTimers)
						.catch(() => {});
				});
				await publishHost();
				return;
			}
			unsubscribeEvents = opened.subscribeEvents(handleTransportEvent);
			unsubscribeCounters = opened.subscribe(COUNTERS_CHANNEL, (message) => {
				if (message.senderId !== opened.declaration.hostNodeId) return;
				const host = opened
					.peers()
					.find((peer) => peer.nodeId === opened.declaration.hostNodeId);
				if (host?.status !== "online") return;
				const parsed = parseCounters(message.value, opened.nodeId);
				if (
					parsed === null ||
					parsed.counters.domainEpoch !== opened.declaration.domainId ||
					(acceptedHostEpoch !== undefined &&
						parsed.counters.domainEpoch !== acceptedHostEpoch) ||
					parsed.counters.revision <= acceptedHostRevision ||
					parsed.activityRevision < requiredActivityRevision ||
					parsed.loopRevision < requiredLoopRevision
				)
					return;
				acceptedHostEpoch = parsed.counters.domainEpoch;
				acceptedHostRevision = parsed.counters.revision;
				countersValue = parsed.counters;
				for (const listener of Array.from(listeners)) {
					try {
						listener(parsed.counters);
					} catch {
						// Listener failures are isolated from coordinator state.
					}
				}
			});
			await queueWrite("activity");
		})().catch(async (error) => {
			const fatal = isReflectDomainFatalError(error)
				? error
				: new ReflectDomainFatalError(
						"CONNECTION_UNAVAILABLE",
						"failed to publish initial reflect-watchdog state",
						{ cause: error },
					);
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
			await failedNode?.close().catch(() => {});
			throw fatal;
		});
		return opening;
	};

	return {
		get rootProcess() {
			return rootProcess;
		},
		attach(instance, attachOptions) {
			return queueLifecycle(async () => {
				if (attachments.has(instance)) return;
				attachments.set(instance, {
					busy: attachOptions.getBusy(),
					getBusy: attachOptions.getBusy,
					onFatal: attachOptions.onFatal,
				});
				const alreadyOpen = node !== undefined;
				try {
					await ensureOpen();
					if (alreadyOpen) await queueWrite("activity");
				} catch (error) {
					attachments.delete(instance);
					throw error;
				}
			});
		},
		detach(instance) {
			return queueLifecycle(async () => {
				if (!attachments.delete(instance)) return;
				if (attachments.size !== 0) {
					await queueWrite("activity");
					return;
				}
				if (node !== undefined && !rootProcess) {
					await queueTransport(() =>
						node === undefined
							? Promise.resolve()
							: node.send(node.declaration.hostNodeId, LEAVE_CHANNEL, {
									version: 1,
								}),
					).catch(() => {});
				}
				await writeTail.catch(() => {});
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
				if (tick !== undefined) clock.clearTimeout(tick);
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
			if (attachment === undefined || attachment.busy === busy) return;
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
			if (!rootProcess) {
				await queueWrite("root-loop");
				return countersValue ?? zeroCounters();
			}
			const current = hostCounters();
			hostStateRevision += 1n;
			hostState = {
				...current,
				activeLoops: counter(current.activeLoops.value + 1n),
				rootLoops: counter(current.rootLoops.value + 1n),
				allLoops: counter(current.allLoops.value + 1n),
			};
			await publishHost();
			updateHostTimers();
			return countersValue ?? hostCounters();
		},
		async recordAllLoop() {
			if (!rootProcess) {
				await queueWrite("all-loop");
				return countersValue ?? zeroCounters();
			}
			const current = hostCounters();
			hostStateRevision += 1n;
			hostState = {
				...current,
				activeLoops: counter(current.activeLoops.value + 1n),
				allLoops: counter(current.allLoops.value + 1n),
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
			if (!rootProcess || countersValue === undefined) return countersValue;
			hostStateRevision += 1n;
			hostState = clearReminderCounters(hostCounters());
			await publishHost();
			return countersValue;
		},
	};
}

const SHARED = Symbol.for("pi-reflect-watchdog:process-domain:v2");
type SharedHost = typeof globalThis & { [SHARED]?: ReflectDomainCoordinator };

export function getReflectDomainCoordinator(): ReflectDomainCoordinator {
	const host = globalThis as SharedHost;
	host[SHARED] ??= createReflectDomainCoordinator();
	return host[SHARED];
}
