import { createHmac, randomBytes } from "node:crypto";
import {
	isProcessDomainOpenError,
	type openProcessDomain,
	openSharedProcessDomain,
	type ProcessDomainDataMessage,
	type ProcessDomainEvent,
	type ProcessDomainNode,
	type ProcessDomainOpenErrorCode,
} from "pi-extension-utils/process-domain";
import {
	type AcceptedLoopDelta,
	type CheckpointLedgerEntry,
	type CollectionState,
	checkpointLoopDelta,
	createCollectionState,
	type PeerCheckpoint,
	reduceCollectionState,
	snapshotCollectionState,
} from "./collection-state.js";

export const FATAL_EXIT_CODE = 78;

const CHECKPOINT_CHANNEL = "pi-reflect-watchdog.checkpoint.v3";
const COUNTERS_CHANNEL = "pi-reflect-watchdog.counters.v3";
const LEAVE_CHANNEL = "pi-reflect-watchdog.leave.v3";
const PRIVATE_PROTOCOL_VERSION = 3;
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
	"process-domain peer replaced",
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
	readonly paused: boolean;
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

interface CheckpointWire {
	readonly version: typeof PRIVATE_PROTOCOL_VERSION;
	readonly incarnation: string;
	readonly contributorId: string;
	readonly accountingGeneration: string;
	readonly seq: string;
	readonly busy: boolean;
	readonly rootLoops: string;
	readonly allLoops: string;
	readonly resumeReceipt: string | null;
}

interface CheckpointAckWire {
	readonly nodeId: string;
	readonly incarnation: string;
	readonly contributorId: string;
	readonly accountingGeneration: string;
	readonly seq: string;
	readonly resumeReceipt: string;
}

interface CountersWire {
	readonly version: typeof PRIVATE_PROTOCOL_VERSION;
	readonly revision: string;
	readonly generation: string;
	readonly accountingGeneration: string;
	readonly domainEpoch: string;
	readonly paused: boolean;
	readonly anyBusy: boolean;
	readonly localBusy: boolean;
	readonly otherBusy: boolean;
	readonly endLoopTimeMs: string | null;
	readonly activeMs: string;
	readonly activeLoops: string;
	readonly taskMs: string;
	readonly rootLoops: string;
	readonly allLoops: string;
	readonly checkpointAcks: readonly CheckpointAckWire[];
}

interface LeaveWire {
	readonly version: typeof PRIVATE_PROTOCOL_VERSION;
	readonly incarnation: string;
	readonly contributorId: string;
}

interface Attachment {
	readonly contributorId: string;
	busy: boolean;
	readonly getBusy: () => boolean;
	readonly onFatal: (error: Error) => void;
}

interface PeerSession {
	readonly nodeId: string;
	readonly incarnation: string;
	readonly contributorId: string;
	readonly replayKey: string;
	readonly accountingGeneration: bigint;
	readonly seq: bigint;
	readonly resumeReceipt: string;
}

interface ReplayRegistryEntry {
	readonly replayKey: string;
	readonly ack: CheckpointAckWire;
}

interface HostPublication {
	readonly wire: CountersWire;
	readonly targets: readonly string[];
}

interface ParsedCounterMessage {
	readonly counters: ReflectDomainCounters;
	readonly accountingGeneration: bigint;
	readonly checkpointAck: CheckpointAckWire | undefined;
}

export interface ReflectDomainCoordinator {
	readonly rootProcess: boolean;
	readonly paused: boolean;
	attach(
		instance: object,
		options: {
			/** Queried at attach, after every client reconnect, and when pause ends. */
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

type ReflectDomainPauseControl = (
	paused: boolean,
) => Promise<ReflectDomainCounters | undefined>;

type ReflectDomainPauseBridge = ReflectDomainCoordinator & {
	setPaused: ReflectDomainPauseControl;
};

const PAUSE_CONTROLS = new WeakMap<
	ReflectDomainCoordinator,
	ReflectDomainPauseControl
>();

/** @internal Watchdog-owned control; intentionally absent from the package root API. */
export function setReflectDomainPausedForWatchdog(
	coordinator: ReflectDomainCoordinator,
	paused: boolean,
): Promise<ReflectDomainCounters | undefined> {
	const control = PAUSE_CONTROLS.get(coordinator);
	if (control !== undefined) return control(paused);
	const injected = coordinator as Partial<ReflectDomainPauseBridge>;
	return typeof injected.setPaused === "function"
		? injected.setPaused(paused)
		: Promise.resolve(undefined);
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

function id(): string {
	return randomBytes(16).toString("base64url");
}

function counter(value = 0n): ReflectCounterValue {
	return { value };
}

function zeroCounters(domainEpoch = "pending"): ReflectDomainCounters {
	return {
		domainEpoch,
		revision: 0n,
		generation: 0n,
		paused: false,
		anyBusy: false,
		localBusy: false,
		otherBusy: false,
		endLoopTimeMs: null,
		fence: { domainEpoch, generation: 0n },
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
		left.paused === right.paused &&
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

function validPositive(value: unknown): value is string {
	return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function validCounterValue(value: unknown): value is string {
	return typeof value === "string" && /^\d+$/.test(value);
}

function parseCheckpoint(value: unknown): CheckpointWire | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as Partial<CheckpointWire>;
	if (
		wire.version !== PRIVATE_PROTOCOL_VERSION ||
		!validId(wire.incarnation) ||
		!validId(wire.contributorId) ||
		!validCounterValue(wire.accountingGeneration) ||
		!validPositive(wire.seq) ||
		typeof wire.busy !== "boolean" ||
		!validCounterValue(wire.rootLoops) ||
		!validCounterValue(wire.allLoops) ||
		(wire.resumeReceipt !== null && !validId(wire.resumeReceipt))
	)
		return null;
	if (BigInt(wire.rootLoops) > BigInt(wire.allLoops)) return null;
	return wire as CheckpointWire;
}

function parseLeave(value: unknown): LeaveWire | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as Partial<LeaveWire>;
	return wire.version === PRIVATE_PROTOCOL_VERSION &&
		validId(wire.incarnation) &&
		validId(wire.contributorId)
		? (wire as LeaveWire)
		: null;
}

function parseCheckpointAcks(
	value: unknown,
): readonly CheckpointAckWire[] | null {
	if (!Array.isArray(value)) return null;
	const parsed: CheckpointAckWire[] = [];
	const nodes = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) return null;
		const ack = entry as Partial<CheckpointAckWire>;
		if (
			!validId(ack.nodeId) ||
			!validId(ack.incarnation) ||
			!validId(ack.contributorId) ||
			!validCounterValue(ack.accountingGeneration) ||
			!validPositive(ack.seq) ||
			!validId(ack.resumeReceipt) ||
			nodes.has(ack.nodeId)
		)
			return null;
		nodes.add(ack.nodeId);
		parsed.push(ack as CheckpointAckWire);
	}
	return parsed;
}

function parseCounters(
	value: unknown,
	nodeId: string,
): ParsedCounterMessage | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as Partial<CountersWire>;
	const checkpointAcks = parseCheckpointAcks(wire.checkpointAcks);
	if (
		wire.version !== PRIVATE_PROTOCOL_VERSION ||
		!validPositive(wire.revision) ||
		!validPositive(wire.generation) ||
		!validCounterValue(wire.accountingGeneration) ||
		!validId(wire.domainEpoch) ||
		typeof wire.paused !== "boolean" ||
		typeof wire.anyBusy !== "boolean" ||
		typeof wire.localBusy !== "boolean" ||
		typeof wire.otherBusy !== "boolean" ||
		(wire.endLoopTimeMs !== null && !validCounterValue(wire.endLoopTimeMs)) ||
		!validCounterValue(wire.activeMs) ||
		!validCounterValue(wire.activeLoops) ||
		!validCounterValue(wire.taskMs) ||
		!validCounterValue(wire.rootLoops) ||
		!validCounterValue(wire.allLoops) ||
		checkpointAcks === null
	)
		return null;
	const snapshotGeneration = BigInt(wire.generation);
	return {
		counters: {
			domainEpoch: wire.domainEpoch,
			revision: BigInt(wire.revision),
			generation: snapshotGeneration,
			paused: wire.paused,
			anyBusy: wire.anyBusy,
			localBusy: wire.localBusy,
			otherBusy: wire.otherBusy,
			endLoopTimeMs:
				wire.endLoopTimeMs === null ? null : BigInt(wire.endLoopTimeMs),
			fence: {
				domainEpoch: wire.domainEpoch,
				generation: snapshotGeneration,
			},
			activeMs: counter(BigInt(wire.activeMs)),
			activeLoops: counter(BigInt(wire.activeLoops)),
			taskMs: counter(BigInt(wire.taskMs)),
			rootLoops: counter(BigInt(wire.rootLoops)),
			allLoops: counter(BigInt(wire.allLoops)),
		},
		accountingGeneration: BigInt(wire.accountingGeneration),
		checkpointAck: checkpointAcks.find((ack) => ack.nodeId === nodeId),
	};
}

export function createReflectDomainCoordinator(
	options: ReflectDomainOptions = {},
): ReflectDomainCoordinator {
	const open = options.open ?? openSharedProcessDomain;
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
	const processIncarnation = id();
	const receiptSecret = randomBytes(32);
	const attachments = new Map<object, Attachment>();
	const listeners = new Set<(counters: ReflectDomainCounters) => void>();
	const peerSessions = new Map<string, PeerSession>();
	const controlPeers = new Set<string>();
	const replayRegistry = new Map<string, ReplayRegistryEntry>();
	let nextAttachmentId = 0;
	let node: ProcessDomainNode | undefined;
	let rootProcess = false;
	let opening: Promise<void> | undefined;
	let countersValue: ReflectDomainCounters | undefined;
	let collectionState: CollectionState | undefined;
	let snapshotRevision = 0n;
	let snapshotGeneration = 0n;
	let acceptedHostRevision = 0n;
	let acceptedHostEpoch: string | undefined;
	let clientPaused = false;
	let clientAccountingGeneration = 0n;
	let clientContributorId = id();
	let clientResumeReceipt: string | null = null;
	let localCheckpointSeq = 0n;
	let requiredCheckpointSeq = 0n;
	let localRootLoops = 0n;
	let localAllLoops = 0n;
	let tick: ReturnType<typeof setTimeout> | undefined;
	let unsubscribeEvents: (() => void) | undefined;
	let unsubscribeCheckpoint: (() => void) | undefined;
	let unsubscribeCounters: (() => void) | undefined;
	let unsubscribeLeave: (() => void) | undefined;
	let writeTail = Promise.resolve();
	let lifecycleTail = Promise.resolve();

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

	const clearClientCounters = (): void => {
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

	const reportError = (error: Error): void => {
		for (const attachment of attachments.values()) {
			try {
				attachment.onFatal(error);
			} catch {
				// Error reporting cannot corrupt coordinator state.
			}
		}
	};

	const receiptFor = (replayKey: string): string =>
		createHmac("sha256", receiptSecret)
			.update(node?.declaration.domainId ?? "pending")
			.update("\0")
			.update(replayKey)
			.digest("base64url");

	const replayKeyFor = (nodeId: string, incarnation: string): string =>
		`${nodeId}:${incarnation}`;

	const retainedLedger = (
		replayKey: string,
		atMs: number,
	): CheckpointLedgerEntry | undefined => {
		const entry = collectionState?.ledger.get(replayKey);
		return entry !== undefined &&
			(entry.replayUntilMs === null || atMs <= entry.replayUntilMs)
			? entry
			: undefined;
	};

	const reduce = (event: Parameters<typeof reduceCollectionState>[1]): void => {
		if (collectionState !== undefined)
			collectionState = reduceCollectionState(collectionState, event);
	};

	const localAndOtherBusy = (): {
		readonly localBusy: boolean;
		readonly otherBusy: boolean;
	} => {
		let localBusy = false;
		let otherBusy = false;
		for (const contributor of collectionState?.live.values() ?? []) {
			if (!contributor.busy) continue;
			if (contributor.kind === "local") localBusy = true;
			else otherBusy = true;
		}
		return { localBusy, otherBusy };
	};

	const projectHostCounters = (): ReflectDomainCounters => {
		if (node === undefined || collectionState === undefined)
			return zeroCounters();
		const snapshot = snapshotCollectionState(collectionState, now());
		const busy = localAndOtherBusy();
		const domainEpoch = node.declaration.domainId;
		return {
			domainEpoch,
			revision: snapshotRevision,
			generation: snapshotGeneration,
			paused: snapshot.paused,
			anyBusy: snapshot.anyBusy,
			localBusy: busy.localBusy,
			otherBusy: busy.otherBusy,
			endLoopTimeMs:
				!snapshot.paused &&
				!snapshot.anyBusy &&
				collectionState.accounting.idleSinceMs !== null
					? BigInt(collectionState.accounting.idleSinceMs)
					: null,
			fence: { domainEpoch, generation: snapshotGeneration },
			activeMs: counter(snapshot.activeMs),
			activeLoops: counter(snapshot.activeLoops),
			taskMs: counter(snapshot.taskMs),
			rootLoops: counter(snapshot.rootLoops),
			allLoops: counter(snapshot.allLoops),
		};
	};

	const checkpointAcks = (): readonly CheckpointAckWire[] => {
		if (node === undefined) return Object.freeze([]);
		const acks: CheckpointAckWire[] = [];
		for (const nodeId of controlPeers) {
			const peer = node
				.peers()
				.find((candidate) => candidate.nodeId === nodeId);
			if (
				peer?.status !== "online" ||
				peer.metadata.protocol !== String(PRIVATE_PROTOCOL_VERSION) ||
				!validId(peer.metadata.incarnation)
			)
				continue;
			const entry = replayRegistry.get(
				replayKeyFor(nodeId, peer.metadata.incarnation),
			);
			if (entry !== undefined) acks.push(entry.ack);
		}
		return Object.freeze(acks);
	};

	const removePeerSession = (nodeId: string, atMs = now()): boolean => {
		const session = peerSessions.get(nodeId);
		if (session === undefined) return false;
		reduce({
			type: "peer-offline",
			contributorId: session.contributorId,
			atMs,
		});
		peerSessions.delete(nodeId);
		return true;
	};

	const captureHostPublication = (): HostPublication | undefined => {
		if (!rootProcess || node === undefined || collectionState === undefined)
			return undefined;
		snapshotRevision += 1n;
		snapshotGeneration += 1n;
		const counters = projectHostCounters();
		notify(counters);
		const wire: CountersWire = Object.freeze({
			version: PRIVATE_PROTOCOL_VERSION,
			revision: counters.revision.toString(),
			generation: counters.generation.toString(),
			accountingGeneration: collectionState.accounting.generation.toString(),
			domainEpoch: counters.domainEpoch,
			paused: counters.paused,
			anyBusy: counters.anyBusy,
			localBusy: counters.localBusy,
			otherBusy: counters.otherBusy,
			endLoopTimeMs: counters.endLoopTimeMs?.toString() ?? null,
			activeMs: counters.activeMs.value.toString(),
			activeLoops: counters.activeLoops.value.toString(),
			taskMs: counters.taskMs.value.toString(),
			rootLoops: counters.rootLoops.value.toString(),
			allLoops: counters.allLoops.value.toString(),
			checkpointAcks: checkpointAcks(),
		});
		return Object.freeze({
			wire,
			targets: Object.freeze(Array.from(controlPeers)),
		});
	};

	const sendHostPublication = async (
		publication: HostPublication,
	): Promise<void> => {
		if (node === undefined) return;
		let firstError: unknown;
		await Promise.all(
			publication.targets.map(async (nodeId) => {
				try {
					await node?.send(nodeId, COUNTERS_CHANNEL, publication.wire);
				} catch (error) {
					const peer = node
						?.peers()
						.find((candidate) => candidate.nodeId === nodeId);
					if (peer?.status === "offline") {
						const controlRemoved = controlPeers.delete(nodeId);
						const sessionRemoved = removePeerSession(nodeId);
						if (controlRemoved || sessionRemoved)
							void publishHost().catch(() => {});
						return;
					}
					if (isTransientTransportError(error)) return;
					firstError ??= error;
				}
			}),
		);
		if (firstError !== undefined) throw firstError;
	};

	const publishHost = (): Promise<void> => {
		const publication = captureHostPublication();
		if (publication === undefined) return Promise.resolve();
		updateHostTimers();
		return queueTransport(async () => {
			try {
				await sendHostPublication(publication);
			} catch (error) {
				const reported =
					error instanceof Error
						? error
						: new Error("reflection transport write failed");
				reportError(reported);
				throw reported;
			}
		});
	};

	const scheduleTick = (): void => {
		if (
			!rootProcess ||
			node === undefined ||
			tick !== undefined ||
			collectionState === undefined ||
			!snapshotCollectionState(collectionState, now()).anyBusy
		)
			return;
		tick = clock.setTimeout(() => {
			tick = undefined;
			if (
				!rootProcess ||
				collectionState === undefined ||
				!snapshotCollectionState(collectionState, now()).anyBusy
			)
				return;
			void publishHost().catch(() => {});
			scheduleTick();
		}, activeTickMs);
		tick.unref?.();
	};

	const updateHostTimers = (): void => {
		if (!rootProcess || collectionState === undefined) return;
		if (snapshotCollectionState(collectionState, now()).anyBusy) {
			scheduleTick();
			return;
		}
		if (tick !== undefined) {
			clock.clearTimeout(tick);
			tick = undefined;
		}
	};

	const classifySynchronization = (
		replayKey: string,
		checkpoint: PeerCheckpoint,
		resumeReceipt: string | null,
		atMs: number,
	): { readonly delta: AcceptedLoopDelta; readonly receipt: string } | null => {
		const expectedReceipt = receiptFor(replayKey);
		if (resumeReceipt !== null && resumeReceipt !== expectedReceipt)
			return null;
		const registered = replayRegistry.get(replayKey);
		const previous = retainedLedger(replayKey, atMs);
		if (registered === undefined) {
			if (resumeReceipt !== null) return null;
			return {
				delta: {
					root: checkpoint.rootLoops,
					all: checkpoint.allLoops,
				},
				receipt: expectedReceipt,
			};
		}
		if (registered.ack.resumeReceipt !== expectedReceipt) return null;
		if (previous !== undefined) {
			const delta = checkpointLoopDelta(previous, checkpoint);
			return delta === null ? null : { delta, receipt: expectedReceipt };
		}
		if (resumeReceipt !== expectedReceipt) return null;
		return { delta: { root: 0n, all: 0n }, receipt: expectedReceipt };
	};

	const applyHostCheckpoint = (message: ProcessDomainDataMessage): void => {
		if (!rootProcess || node === undefined || collectionState === undefined)
			return;
		const wire = parseCheckpoint(message.value);
		if (wire === null) return;
		const peer = node
			.peers()
			.find((candidate) => candidate.nodeId === message.senderId);
		if (
			peer?.status !== "online" ||
			peer.metadata.protocol !== String(PRIVATE_PROTOCOL_VERSION) ||
			peer.metadata.incarnation !== wire.incarnation
		)
			return;
		const checkpoint: PeerCheckpoint = {
			generation: BigInt(wire.accountingGeneration),
			seq: BigInt(wire.seq),
			busy: wire.busy,
			rootLoops: BigInt(wire.rootLoops),
			allLoops: BigInt(wire.allLoops),
		};
		if (checkpoint.generation !== collectionState.accounting.generation) return;
		const replayKey = replayKeyFor(message.senderId, wire.incarnation);
		const current = peerSessions.get(message.senderId);
		let next: CollectionState;
		let receipt: string;
		if (
			current !== undefined &&
			current.incarnation === wire.incarnation &&
			current.contributorId === wire.contributorId
		) {
			if (
				wire.resumeReceipt !== null &&
				wire.resumeReceipt !== current.resumeReceipt
			)
				return;
			const previous = retainedLedger(replayKey, message.receivedAt);
			if (previous === undefined) return;
			const delta = checkpointLoopDelta(previous, checkpoint);
			if (delta === null) return;
			next = reduceCollectionState(collectionState, {
				type: "peer-checkpoint-verified",
				contributorId: wire.contributorId,
				checkpoint,
				acceptedLoopDelta: delta,
				atMs: message.receivedAt,
			});
			receipt = current.resumeReceipt;
		} else {
			const classified = classifySynchronization(
				replayKey,
				checkpoint,
				wire.resumeReceipt,
				message.receivedAt,
			);
			if (classified === null) return;
			if (current !== undefined)
				reduce({
					type: "peer-offline",
					contributorId: current.contributorId,
					atMs: message.receivedAt,
				});
			next = reduceCollectionState(collectionState, {
				type: "peer-synchronized",
				contributorId: wire.contributorId,
				replayKey,
				acceptedLoopDelta: classified.delta,
				checkpoint,
				atMs: message.receivedAt,
			});
			receipt = classified.receipt;
		}
		if (next === collectionState) return;
		collectionState = next;
		controlPeers.add(message.senderId);
		const ack: CheckpointAckWire = Object.freeze({
			nodeId: message.senderId,
			incarnation: wire.incarnation,
			contributorId: wire.contributorId,
			accountingGeneration: checkpoint.generation.toString(),
			seq: checkpoint.seq.toString(),
			resumeReceipt: receipt,
		});
		replayRegistry.set(replayKey, Object.freeze({ replayKey, ack }));
		peerSessions.set(message.senderId, {
			nodeId: message.senderId,
			incarnation: wire.incarnation,
			contributorId: wire.contributorId,
			replayKey,
			accountingGeneration: checkpoint.generation,
			seq: checkpoint.seq,
			resumeReceipt: receipt,
		});
		void publishHost()
			.then(updateHostTimers)
			.catch(() => {});
	};

	const queueCheckpoint = (): Promise<void> => {
		if (node === undefined || rootProcess || clientPaused)
			return Promise.resolve();
		const seq = ++localCheckpointSeq;
		requiredCheckpointSeq = seq;
		clearClientCounters();
		const target = node.declaration.hostNodeId;
		const wire: CheckpointWire = {
			version: PRIVATE_PROTOCOL_VERSION,
			incarnation: processIncarnation,
			contributorId: clientContributorId,
			accountingGeneration: clientAccountingGeneration.toString(),
			seq: seq.toString(),
			busy: desiredActivity(),
			rootLoops: localRootLoops.toString(),
			allLoops: localAllLoops.toString(),
			resumeReceipt: clientResumeReceipt,
		};
		return queueTransport(async () => {
			if (node === undefined || rootProcess || clientPaused) return;
			try {
				await node.send(target, CHECKPOINT_CHANNEL, wire);
			} catch (error) {
				if (isTransientTransportError(error)) {
					clearClientCounters();
					return;
				}
				const reported =
					error instanceof Error
						? error
						: new Error("reflection transport write failed");
				reportError(reported);
				throw reported;
			}
		});
	};

	const acceptClientCounters = (
		parsed: ParsedCounterMessage,
		opened: ProcessDomainNode,
	): void => {
		if (
			parsed.counters.domainEpoch !== opened.declaration.domainId ||
			(acceptedHostEpoch !== undefined &&
				parsed.counters.domainEpoch !== acceptedHostEpoch) ||
			parsed.counters.revision <= acceptedHostRevision
		)
			return;
		acceptedHostEpoch = parsed.counters.domainEpoch;
		acceptedHostRevision = parsed.counters.revision;
		const ack = parsed.checkpointAck;
		if (ack?.incarnation === processIncarnation)
			clientResumeReceipt = ack.resumeReceipt;
		const generationChanged =
			parsed.accountingGeneration !== clientAccountingGeneration;
		const wasPaused = clientPaused;
		clientAccountingGeneration = parsed.accountingGeneration;
		clientPaused = parsed.counters.paused;
		if (generationChanged) {
			clientContributorId = id();
			requiredCheckpointSeq = 0n;
		}
		if (clientPaused) {
			notify(parsed.counters);
			return;
		}
		if (generationChanged || wasPaused) {
			for (const attachment of attachments.values())
				attachment.busy = attachment.getBusy();
			clearClientCounters();
			void queueCheckpoint().catch(() => {});
			return;
		}
		if (
			ack === undefined ||
			ack.incarnation !== processIncarnation ||
			ack.contributorId !== clientContributorId ||
			BigInt(ack.accountingGeneration) !== clientAccountingGeneration ||
			BigInt(ack.seq) < requiredCheckpointSeq
		)
			return;
		clientResumeReceipt = ack.resumeReceipt;
		notify(parsed.counters);
	};

	const handleTransportEvent = (event: ProcessDomainEvent): void => {
		if (event.type !== "peer" || node === undefined) return;
		if (!rootProcess) {
			if (event.peer.nodeId !== node.declaration.hostNodeId) return;
			clearClientCounters();
			if (event.peer.status === "offline" || clientPaused) return;
			for (const attachment of attachments.values())
				attachment.busy = attachment.getBusy();
			clientContributorId = id();
			void queueCheckpoint().catch(() => {});
			return;
		}
		if (event.peer.status === "offline") {
			const controlRemoved = controlPeers.delete(event.peer.nodeId);
			const sessionRemoved = removePeerSession(event.peer.nodeId);
			if (controlRemoved || sessionRemoved)
				void publishHost()
					.then(updateHostTimers)
					.catch(() => {});
			return;
		}
		if (
			event.peer.metadata.protocol === String(PRIVATE_PROTOCOL_VERSION) &&
			validId(event.peer.metadata.incarnation)
		) {
			controlPeers.add(event.peer.nodeId);
			void publishHost().catch(() => {});
		}
		// Online peers remain isolated until a validated checkpoint arrives.
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
						protocol: String(PRIVATE_PROTOCOL_VERSION),
						incarnation: processIncarnation,
					},
					onError: (error) => {
						if (!rootProcess) clearClientCounters();
						else if (node !== undefined) {
							let changed = false;
							for (const peer of node.peers())
								if (peer.status === "offline") {
									const controlRemoved = controlPeers.delete(peer.nodeId);
									const sessionRemoved = removePeerSession(peer.nodeId);
									changed = controlRemoved || sessionRemoved || changed;
								}
							if (changed)
								void publishHost()
									.then(updateHostTimers)
									.catch(() => {});
						}
						reportError(error);
					},
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
			unsubscribeEvents = opened.subscribeEvents(handleTransportEvent);
			if (rootProcess) {
				collectionState = createCollectionState({
					nowMs: now(),
					idleResetGapMs,
				});
				for (const attachment of attachments.values())
					reduce({
						type: "local-activity",
						contributorId: attachment.contributorId,
						busy: attachment.busy,
						atMs: now(),
					});
				unsubscribeCheckpoint = opened.subscribe(
					CHECKPOINT_CHANNEL,
					applyHostCheckpoint,
				);
				unsubscribeLeave = opened.subscribe(LEAVE_CHANNEL, (message) => {
					const leave = parseLeave(message.value);
					const session = peerSessions.get(message.senderId);
					if (
						leave === null ||
						session === undefined ||
						session.incarnation !== leave.incarnation ||
						session.contributorId !== leave.contributorId
					)
						return;
					removePeerSession(message.senderId, message.receivedAt);
					void publishHost()
						.then(updateHostTimers)
						.catch(() => {});
				});
				await publishHost();
				updateHostTimers();
				return;
			}
			unsubscribeCounters = opened.subscribe(COUNTERS_CHANNEL, (message) => {
				if (message.senderId !== opened.declaration.hostNodeId) return;
				const host = opened
					.peers()
					.find((peer) => peer.nodeId === opened.declaration.hostNodeId);
				if (host?.status !== "online") return;
				const parsed = parseCounters(message.value, opened.nodeId);
				if (parsed !== null) acceptClientCounters(parsed, opened);
			});
			await queueCheckpoint();
		})().catch(async (error) => {
			const fatal = isReflectDomainFatalError(error)
				? error
				: new ReflectDomainFatalError(
						"CONNECTION_UNAVAILABLE",
						"failed to publish initial reflect-watchdog state",
						{ cause: error },
					);
			reportError(fatal);
			unsubscribeEvents?.();
			unsubscribeCheckpoint?.();
			unsubscribeCounters?.();
			unsubscribeLeave?.();
			unsubscribeEvents = undefined;
			unsubscribeCheckpoint = undefined;
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

	const closeCoordinator = async (): Promise<void> => {
		await writeTail.catch(() => {});
		unsubscribeEvents?.();
		unsubscribeCheckpoint?.();
		unsubscribeCounters?.();
		unsubscribeLeave?.();
		unsubscribeEvents = undefined;
		unsubscribeCheckpoint = undefined;
		unsubscribeCounters = undefined;
		unsubscribeLeave = undefined;
		if (tick !== undefined) clock.clearTimeout(tick);
		tick = undefined;
		const closing = node;
		node = undefined;
		rootProcess = false;
		opening = undefined;
		countersValue = undefined;
		collectionState = undefined;
		snapshotRevision = 0n;
		snapshotGeneration = 0n;
		acceptedHostRevision = 0n;
		acceptedHostEpoch = undefined;
		clientPaused = false;
		clientAccountingGeneration = 0n;
		clientContributorId = id();
		clientResumeReceipt = null;
		localCheckpointSeq = 0n;
		requiredCheckpointSeq = 0n;
		localRootLoops = 0n;
		localAllLoops = 0n;
		peerSessions.clear();
		controlPeers.clear();
		replayRegistry.clear();
		await closing?.close();
	};

	const coordinator: ReflectDomainCoordinator = {
		get rootProcess() {
			return rootProcess;
		},
		get paused() {
			return rootProcess
				? (collectionState?.accounting.paused ?? false)
				: clientPaused;
		},
		attach(instance, attachOptions) {
			return queueLifecycle(async () => {
				if (attachments.has(instance)) return;
				const attachment: Attachment = {
					contributorId: `attachment-${++nextAttachmentId}`,
					busy: attachOptions.getBusy(),
					getBusy: attachOptions.getBusy,
					onFatal: attachOptions.onFatal,
				};
				attachments.set(instance, attachment);
				const alreadyOpen = node !== undefined;
				try {
					await ensureOpen();
					if (!alreadyOpen) return;
					if (rootProcess) {
						reduce({
							type: "local-activity",
							contributorId: attachment.contributorId,
							busy: attachment.busy,
							atMs: now(),
						});
						await publishHost();
						updateHostTimers();
					} else await queueCheckpoint();
				} catch (error) {
					attachments.delete(instance);
					throw error;
				}
			});
		},
		detach(instance) {
			return queueLifecycle(async () => {
				const attachment = attachments.get(instance);
				if (attachment === undefined) return;
				attachments.delete(instance);
				if (attachments.size !== 0) {
					if (rootProcess) {
						reduce({
							type: "local-detached",
							contributorId: attachment.contributorId,
							atMs: now(),
						});
						await publishHost();
						updateHostTimers();
					} else await queueCheckpoint();
					return;
				}
				if (node !== undefined && !rootProcess) {
					const leave: LeaveWire = {
						version: PRIVATE_PROTOCOL_VERSION,
						incarnation: processIncarnation,
						contributorId: clientContributorId,
					};
					await queueTransport(() =>
						node === undefined
							? Promise.resolve()
							: node.send(node.declaration.hostNodeId, LEAVE_CHANNEL, leave),
					).catch(() => {});
				}
				await closeCoordinator();
			});
		},
		async setBusy(instance, busy) {
			const attachment = attachments.get(instance);
			if (attachment === undefined || attachment.busy === busy) return;
			attachment.busy = busy;
			if (rootProcess) {
				reduce({
					type: "local-activity",
					contributorId: attachment.contributorId,
					busy,
					atMs: now(),
				});
				await publishHost();
				updateHostTimers();
			} else if (!clientPaused) await queueCheckpoint();
		},
		async recordRootLoop() {
			if (this.paused) return countersValue ?? zeroCounters();
			if (!rootProcess) {
				localRootLoops += 1n;
				localAllLoops += 1n;
				await queueCheckpoint();
				return countersValue ?? zeroCounters();
			}
			reduce({ type: "local-loop", scope: "root", atMs: now() });
			await publishHost();
			updateHostTimers();
			return countersValue ?? projectHostCounters();
		},
		async recordAllLoop() {
			if (this.paused) return countersValue ?? zeroCounters();
			if (!rootProcess) {
				localAllLoops += 1n;
				await queueCheckpoint();
				return countersValue ?? zeroCounters();
			}
			reduce({ type: "local-loop", scope: "all", atMs: now() });
			await publishHost();
			return countersValue ?? projectHostCounters();
		},
		counters() {
			return countersValue;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setIdleResetGapSeconds(seconds) {
			if (!Number.isSafeInteger(seconds) || seconds <= 0) return;
			idleResetGapMs = seconds * 1_000;
			if (collectionState !== undefined) {
				collectionState = { ...collectionState, idleResetGapMs };
				void publishHost().catch(() => {});
			}
		},
		async resetReminderCycle() {
			if (!rootProcess || collectionState === undefined) return countersValue;
			reduce({ type: "reminder-accepted", atMs: now() });
			await publishHost();
			return countersValue;
		},
	};
	PAUSE_CONTROLS.set(coordinator, (nextPaused) =>
		queueLifecycle(async () => {
			if (
				!rootProcess ||
				collectionState === undefined ||
				collectionState.accounting.paused === nextPaused
			)
				return countersValue;
			reduce({ type: "pause-changed", paused: nextPaused, atMs: now() });
			peerSessions.clear();
			if (tick !== undefined) clock.clearTimeout(tick);
			tick = undefined;
			if (!nextPaused)
				for (const attachment of attachments.values()) {
					attachment.busy = attachment.getBusy();
					reduce({
						type: "local-activity",
						contributorId: attachment.contributorId,
						busy: attachment.busy,
						atMs: now(),
					});
				}
			await publishHost();
			updateHostTimers();
			return countersValue;
		}),
	);
	return coordinator;
}

const SHARED = Symbol.for("pi-reflect-watchdog:process-domain:v3");
type SharedHost = typeof globalThis & { [SHARED]?: ReflectDomainCoordinator };

export function getReflectDomainCoordinator(): ReflectDomainCoordinator {
	const host = globalThis as SharedHost;
	host[SHARED] ??= createReflectDomainCoordinator();
	return host[SHARED];
}
