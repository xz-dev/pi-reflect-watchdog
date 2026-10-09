import { createHmac, randomBytes } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
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
	type BranchAccounting,
	deriveBranchAccounting,
} from "./branch-accounting.js";
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

const CHECKPOINT_CHANNEL = "pi-reflect-watchdog.checkpoint.v4";
const COUNTERS_CHANNEL = "pi-reflect-watchdog.counters.v4";
const COMPLETION_CHANNEL = "pi-reflect-watchdog.completion.v4";
const LEAVE_CHANNEL = "pi-reflect-watchdog.leave.v4";
const PRIVATE_PROTOCOL_VERSION = 4;
const MAX_REPLAY_ATTACHMENTS = 1024;
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

interface CompletionIdentity {
	readonly attachmentId: string;
	readonly scope: string;
	readonly entryId: string;
	readonly position: string;
}
interface CompletionWire extends CompletionIdentity {
	readonly version: typeof PRIVATE_PROTOCOL_VERSION;
	readonly incarnation: string;
	readonly contributorId: string;
	readonly accountingGeneration: string;
	readonly seq: string;
}
interface CheckpointWire {
	readonly scopes: readonly {
		readonly attachmentId: string;
		readonly scope: string;
	}[];
	readonly activeLoops: string;
	readonly completion: CompletionIdentity | null;
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
	readonly fullGeneration: string;
	readonly version: typeof PRIVATE_PROTOCOL_VERSION;
	readonly revision: string;
	readonly generation: string;
	readonly accountingGeneration: string;
	readonly domainEpoch: string;
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

export interface ReflectBranchSource {
	readonly getBranch: () => readonly SessionEntry[];
	readonly getLeafId: () => string | null;
	/** Only current main may adopt history or contribute root loops. */
	readonly isMain: () => boolean;
	readonly boundaryPolicy: "recorded" | "legacy";
	/** Current main records implicit long-idle resets before observers see them. */
	readonly recordFullBoundary?: () => void;
}
export interface ReflectFreshCompletion {
	/** Present only for an in-process producer; allows C to reject replaced attachment scope. */
	readonly attachmentInstance?: object;
	readonly contributorId: string;
	readonly attachmentId: string;
	readonly scope: string;
	readonly messageEntryId: string;
	readonly snapshotSeq: bigint;
	readonly accountingGeneration: bigint;
	readonly counters: ReflectDomainCounters;
}
export interface ReflectBranchDomainCoordinator
	extends ReflectDomainCoordinator {
	refreshBranch(instance: object): Promise<ReflectDomainCounters | undefined>;
	/** Navigation/initial main adoption only; never creates a completion. */
	rebaseBranch(
		instance: object,
		options?: {
			readonly adoptHistory?: boolean;
			readonly fullAfterEntryId?: string | null;
			readonly reminderAfterEntryId?: string | null;
		},
	): Promise<ReflectDomainCounters | undefined>;
	/** Real public turn_end only, after persisted assistant and whole tool batch. */
	completeTurn(
		instance: object,
		messageEntryId: string,
	): Promise<ReflectDomainCounters | undefined>;
	subscribeCompletions(
		listener: (completion: ReflectFreshCompletion) => void,
	): () => void;
}
interface Attachment {
	readonly source: ReflectBranchSource;
	scope: bigint;
	fullAfterEntryId: string | null;
	reminderAfterEntryId: string | null;
	fullIds: readonly string[];
	reminderIds: readonly string[];
	completedPosition: number;

	readonly contributorId: string;
	busy: boolean;
	readonly getBusy: () => boolean;
	readonly onFatal: (error: Error) => void;
}

interface PeerSession {
	readonly completion: CompletionIdentity | null;
	completedSeq: bigint;
	readonly nodeId: string;
	readonly incarnation: string;
	readonly contributorId: string;
	readonly replayKey: string;
	readonly accountingGeneration: bigint;
	readonly seq: bigint;
	readonly resumeReceipt: string;
}

interface ReplayRegistryEntry {
	readonly scopes: Map<string, bigint>;
	readonly completions: Map<string, { scope: bigint; position: bigint }>;
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
	readonly fullGeneration: bigint;
	readonly checkpointAck: CheckpointAckWire | undefined;
}

export interface ReflectDomainCoordinator {
	readonly rootProcess: boolean;
	attach(
		instance: object,
		options: {
			/** Queried at attach and after every client reconnect. */
			readonly getBusy: () => boolean;
			readonly source: ReflectBranchSource;
			readonly onFatal: (error: Error) => void;
		},
	): Promise<void>;
	detach(instance: object): Promise<void>;
	setBusy(instance: object, busy: boolean): Promise<void>;
	counters(): ReflectDomainCounters | undefined;
	subscribe(listener: (counters: ReflectDomainCounters) => void): () => void;
	setIdleResetGapSeconds(seconds: number): void;
	resetReminderCycle(): Promise<ReflectDomainCounters | undefined>;
	resetCycleOnUserTakeover(): Promise<ReflectDomainCounters | undefined>;
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

function parseCompletionIdentity(value: unknown): CompletionIdentity | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as Partial<CompletionIdentity>;
	return validId(wire.attachmentId) &&
		validCounterValue(wire.scope) &&
		typeof wire.entryId === "string" &&
		wire.entryId.length > 0 &&
		wire.entryId.length <= 1024 &&
		validPositive(wire.position)
		? {
				attachmentId: wire.attachmentId,
				scope: wire.scope,
				entryId: wire.entryId,
				position: wire.position,
			}
		: null;
}
function parseCheckpoint(value: unknown): CheckpointWire | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as Partial<CheckpointWire>;
	if (
		!Array.isArray(wire.scopes) ||
		wire.scopes.length > MAX_REPLAY_ATTACHMENTS
	)
		return null;
	const scopeIds = new Set<string>();
	for (const entry of wire.scopes) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!validId(entry.attachmentId) ||
			!validCounterValue(entry.scope) ||
			scopeIds.has(entry.attachmentId)
		)
			return null;
		scopeIds.add(entry.attachmentId);
	}
	if (
		wire.version !== PRIVATE_PROTOCOL_VERSION ||
		!validId(wire.incarnation) ||
		!validId(wire.contributorId) ||
		!validCounterValue(wire.accountingGeneration) ||
		!validPositive(wire.seq) ||
		typeof wire.busy !== "boolean" ||
		!validCounterValue(wire.rootLoops) ||
		!validCounterValue(wire.allLoops) ||
		!validCounterValue(wire.activeLoops) ||
		(wire.completion !== null &&
			parseCompletionIdentity(wire.completion) === null) ||
		(wire.resumeReceipt !== null && !validId(wire.resumeReceipt))
	)
		return null;
	if (
		BigInt(wire.rootLoops) !== 0n ||
		BigInt(wire.activeLoops) < BigInt(wire.allLoops) ||
		(wire.completion !== null &&
			BigInt(wire.completion?.position ?? "0") > BigInt(wire.activeLoops))
	)
		return null;
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
		!validCounterValue(wire.fullGeneration) ||
		!validId(wire.domainEpoch) ||
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
		fullGeneration: BigInt(wire.fullGeneration),
		checkpointAck: checkpointAcks.find((ack) => ack.nodeId === nodeId),
	};
}

export function createReflectDomainCoordinator(
	options: ReflectDomainOptions = {},
): ReflectBranchDomainCoordinator {
	const open = options.open ?? openSharedProcessDomain;
	const env = options.env ?? process.env;
	const clock = options.clock ?? {
		setTimeout: (callback: () => void, delayMs: number) =>
			setTimeout(callback, delayMs),
		clearTimeout: (handle: ReturnType<typeof setTimeout>) =>
			clearTimeout(handle),
	};
	const activeTickMs = options.activeTickMs ?? ACTIVE_TICK_MS;
	const now =
		options.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
	let idleResetGapMs = options.idleResetGapMs ?? IDLE_RESET_GAP_MS;
	const processIncarnation = id();
	const receiptSecret = randomBytes(32);
	const attachments = new Map<object, Attachment>();
	const listeners = new Set<(counters: ReflectDomainCounters) => void>();
	const completionListeners = new Set<
		(completion: ReflectFreshCompletion) => void
	>();
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
	let clientAccountingGeneration = 0n;
	let fullGeneration = 0n;
	let clientFullGeneration = 0n;
	let localActiveLoops = 0n;
	let clientContributorId = id();
	let clientResumeReceipt: string | null = null;
	let localCheckpointSeq = 0n;
	let requiredCheckpointSeq = 0n;
	let localAllLoops = 0n;
	let tick: ReturnType<typeof setTimeout> | undefined;
	let unsubscribeEvents: (() => void) | undefined;
	let unsubscribeCheckpoint: (() => void) | undefined;
	let unsubscribeCounters: (() => void) | undefined;
	let unsubscribeLeave: (() => void) | undefined;
	let unsubscribeCompletion: (() => void) | undefined;
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

	const rebaseAttachment = (
		attachment: Attachment,
		window: "full" | "reminder",
		adoptHistory = false,
	): void => {
		const leaf = attachment.source.getLeafId();
		attachment.scope += 1n;
		if (window === "full") {
			attachment.fullAfterEntryId = adoptHistory ? null : leaf;
			attachment.fullIds = [];
		}
		attachment.reminderAfterEntryId = adoptHistory ? null : leaf;
		attachment.reminderIds = [];
		// Already counted replies may still be executing tools: reset fences them.
		attachment.completedPosition =
			window === "full" ? 0 : attachment.fullIds.length;
	};
	const fenceAttachments = (window: "full" | "reminder"): void => {
		for (const attachment of attachments.values())
			rebaseAttachment(attachment, window);
	};
	let recordingBoundary = false;
	const recordImplicitBoundary = (): void => {
		recordingBoundary = true;
		try {
			for (const attachment of attachments.values())
				if (attachment.source.isMain())
					attachment.source.recordFullBoundary?.();
		} catch (error) {
			const fatal = new ReflectDomainFatalError(
				"DOMAIN_UNRECOVERABLE",
				"failed to record implicit accounting boundary",
				{ cause: error },
			);
			reportError(fatal);
			throw fatal;
		} finally {
			recordingBoundary = false;
		}
	};
	const reduce = (event: Parameters<typeof reduceCollectionState>[1]): void => {
		if (collectionState === undefined) return;
		const previous = collectionState.accounting.generation;
		collectionState = reduceCollectionState(collectionState, event);
		if (previous !== collectionState.accounting.generation) {
			const window = event.type === "reminder-accepted" ? "reminder" : "full";
			if (window === "full") fullGeneration += 1n;
			// Claim generation before external recording; fence even if recording fails.
			try {
				if (window === "full" && event.type !== "cycle-reset")
					recordImplicitBoundary();
			} finally {
				fenceAttachments(window);
			}
			for (const [key, session] of peerSessions)
				peerSessions.set(key, {
					...session,
					accountingGeneration: collectionState.accounting.generation,
					completion: null,
				});
		}
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
		const snapshot = snapshotCollectionState(collectionState);
		const busy = localAndOtherBusy();
		const domainEpoch = node.declaration.domainId;
		return {
			domainEpoch,
			revision: snapshotRevision,
			generation: snapshotGeneration,
			anyBusy: snapshot.anyBusy,
			localBusy: busy.localBusy,
			otherBusy: busy.otherBusy,
			endLoopTimeMs:
				!snapshot.anyBusy && collectionState.accounting.idleSinceMs !== null
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
		const acks: CheckpointAckWire[] = [];
		for (const nodeId of controlPeers) {
			const session = peerSessions.get(nodeId);
			// Retained receipts let reconnecting clients recover their checkpoint ACK.
			if (session !== undefined) {
				const entry = replayRegistry.get(session.replayKey);
				if (entry !== undefined) acks.push(entry.ack);
				continue;
			}
			for (const [key, entry] of replayRegistry)
				if (key.startsWith(`${nodeId}:`)) acks.push(entry.ack);
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
		if (
			recordingBoundary ||
			!rootProcess ||
			node === undefined ||
			collectionState === undefined
		)
			return undefined;
		// Publishing is proof of life even when a duplicate admitted no loop delta.
		reduce({ type: "tick", atMs: now() });
		snapshotRevision += 1n;
		snapshotGeneration += 1n;
		const counters = projectHostCounters();
		const wire: CountersWire = Object.freeze({
			version: PRIVATE_PROTOCOL_VERSION,
			revision: counters.revision.toString(),
			generation: counters.generation.toString(),
			accountingGeneration: collectionState.accounting.generation.toString(),
			fullGeneration: fullGeneration.toString(),
			domainEpoch: counters.domainEpoch,
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
		const publication = Object.freeze({
			wire,
			targets: Object.freeze(Array.from(controlPeers)),
		});
		// Observers may synchronously reset or accept another checkpoint.
		notify(counters);
		return publication;
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
			for (const attachment of attachments.values()) observeBranch(attachment);
			// Cadence and publication observations share elapsed settlement/gap rules.
			reduce({ type: "tick", atMs: now() });
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
					active: checkpoint.activeLoops ?? checkpoint.allLoops,
					root: checkpoint.rootLoops,
					all: checkpoint.allLoops,
				},
				receipt: expectedReceipt,
			};
		}
		if (
			registered.ack.resumeReceipt !== expectedReceipt ||
			checkpoint.seq <= BigInt(registered.ack.seq)
		)
			return null;
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
		if (peer?.status !== "online") return;
		// Transport timestamps are not in this owner's monotonic clock domain.
		const atMs = now();
		const checkpoint: PeerCheckpoint = {
			generation: BigInt(wire.accountingGeneration),
			seq: BigInt(wire.seq),
			busy: wire.busy,
			activeLoops: BigInt(wire.activeLoops),
			rootLoops: BigInt(wire.rootLoops),
			allLoops: BigInt(wire.allLoops),
		};
		const replayKey = replayKeyFor(message.senderId, wire.incarnation);
		const current = peerSessions.get(message.senderId);
		const scopes =
			replayRegistry.get(replayKey)?.scopes ?? new Map<string, bigint>();
		if (
			scopes.size +
				wire.scopes.filter((entry) => !scopes.has(entry.attachmentId)).length >
			MAX_REPLAY_ATTACHMENTS
		)
			return;
		if (
			wire.scopes.some(
				(entry) => BigInt(entry.scope) < (scopes.get(entry.attachmentId) ?? 0n),
			) ||
			(wire.completion !== null &&
				!wire.scopes.some(
					(entry) =>
						entry.attachmentId === wire.completion?.attachmentId &&
						entry.scope === wire.completion.scope,
				))
		)
			return;
		const refreshControl = (): void => {
			// Control-plane synchronization without accounting admission: the
			// Rejected payloads receive only authoritative accepted receipts, never an ACK for rejected coordinates.
			const publication = captureHostPublication();
			if (publication === undefined) return;
			const registered = replayRegistry.get(replayKey);
			const counters: CountersWire =
				registered === undefined ||
				publication.wire.checkpointAcks.some(
					(ack) => ack.nodeId === message.senderId,
				)
					? publication.wire
					: Object.freeze({
							...publication.wire,
							checkpointAcks: Object.freeze([
								...publication.wire.checkpointAcks,
								registered.ack,
							]),
						});
			void queueTransport(async () => {
				try {
					await node?.send(message.senderId, COUNTERS_CHANNEL, counters);
				} catch (error) {
					if (!isTransientTransportError(error))
						reportError(
							error instanceof Error ? error : new Error(String(error)),
						);
				}
			});
		};
		if (checkpoint.generation !== collectionState.accounting.generation) {
			refreshControl();
			return;
		}
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
			) {
				refreshControl();
				return;
			}
			const previous = retainedLedger(replayKey, atMs);
			if (previous === undefined) {
				refreshControl();
				return;
			}
			const delta = checkpointLoopDelta(previous, checkpoint);
			if (delta === null) {
				refreshControl();
				return;
			}
			next = reduceCollectionState(collectionState, {
				type: "peer-checkpoint-verified",
				contributorId: wire.contributorId,
				checkpoint,
				acceptedLoopDelta: delta,
				atMs,
			});
			receipt = current.resumeReceipt;
		} else {
			// Fencing is now private-protocol identity, not transport metadata:
			// a live session for a *different* incarnation on this nodeId must
			// reject delayed messages from the superseded incarnation.
			if (current !== undefined && current.incarnation !== wire.incarnation) {
				refreshControl();
				return;
			}
			const classified = classifySynchronization(
				replayKey,
				checkpoint,
				wire.resumeReceipt,
				atMs,
			);
			if (classified === null) {
				refreshControl();
				return;
			}
			if (current !== undefined)
				reduce({
					type: "peer-offline",
					contributorId: current.contributorId,
					atMs,
				});
			next = reduceCollectionState(collectionState, {
				type: "peer-synchronized",
				contributorId: wire.contributorId,
				replayKey,
				acceptedLoopDelta: classified.delta,
				checkpoint,
				atMs,
			});
			receipt = classified.receipt;
		}
		if (next === collectionState) {
			refreshControl();
			return;
		}
		if (next.accounting.generation !== checkpoint.generation) {
			collectionState = next;
			fullGeneration += 1n;
			try {
				recordImplicitBoundary();
			} finally {
				fenceAttachments("full");
			}
			for (const [key, session] of peerSessions)
				peerSessions.set(key, {
					...session,
					accountingGeneration: next.accounting.generation,
					completion: null,
				});
			refreshControl();
			return;
		}
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
		for (const entry of wire.scopes)
			scopes.set(entry.attachmentId, BigInt(entry.scope));
		replayRegistry.set(
			replayKey,
			Object.freeze({
				scopes,
				replayKey,
				ack,
				completions: replayRegistry.get(replayKey)?.completions ?? new Map(),
			}),
		);
		peerSessions.set(message.senderId, {
			nodeId: message.senderId,
			incarnation: wire.incarnation,
			contributorId: wire.contributorId,
			replayKey,
			accountingGeneration: checkpoint.generation,
			seq: checkpoint.seq,
			completion: wire.completion,
			completedSeq: current?.completedSeq ?? 0n,
			resumeReceipt: receipt,
		});
		void publishHost()
			.then(updateHostTimers)
			.catch(() => {});
	};

	const deliverCompletion = (
		identity: CompletionIdentity,
		contributorId: string,
		seq: bigint,
		generation: bigint,
		attachmentInstance?: object,
	): void => {
		const counters = countersValue;
		if (attachmentInstance !== undefined) {
			const attachment = attachments.get(attachmentInstance);
			if (
				attachment === undefined ||
				attachment.scope.toString() !== identity.scope ||
				!attachment.fullIds.includes(identity.entryId)
			)
				return;
		}
		if (
			recordingBoundary ||
			!rootProcess ||
			collectionState?.accounting.generation !== generation ||
			counters === undefined
		)
			return;
		const completion: ReflectFreshCompletion = Object.freeze({
			contributorId,
			attachmentId: identity.attachmentId,
			scope: identity.scope,
			messageEntryId: identity.entryId,
			snapshotSeq: seq,
			accountingGeneration: generation,
			counters,
			attachmentInstance,
		});
		for (const listener of Array.from(completionListeners)) {
			if (collectionState?.accounting.generation !== generation) break;
			try {
				listener(completion);
			} catch {
				/* Observers cannot corrupt accounting. */
			}
		}
	};
	const applyHostCompletion = (message: ProcessDomainDataMessage): void => {
		const identity = parseCompletionIdentity(message.value);
		if (
			identity === null ||
			typeof message.value !== "object" ||
			message.value === null ||
			node === undefined
		)
			return;
		const wire = message.value as Partial<CompletionWire>;
		const session = peerSessions.get(message.senderId);
		if (
			wire.version !== PRIVATE_PROTOCOL_VERSION ||
			!validPositive(wire.seq) ||
			!validCounterValue(wire.accountingGeneration) ||
			session === undefined ||
			node.peers().find((peer) => peer.nodeId === message.senderId)?.status !==
				"online" ||
			wire.incarnation !== session.incarnation ||
			wire.contributorId !== session.contributorId ||
			BigInt(wire.accountingGeneration) !==
				collectionState?.accounting.generation ||
			BigInt(wire.seq) !== session.seq ||
			session.completedSeq >= BigInt(wire.seq) ||
			session.completion === null ||
			JSON.stringify(identity) !== JSON.stringify(session.completion)
		)
			return;
		const completed = replayRegistry.get(session.replayKey)?.completions;
		if (completed === undefined) return;
		const previous = completed.get(identity.attachmentId);
		const scope = BigInt(identity.scope);
		const position = BigInt(identity.position);
		if (
			previous !== undefined &&
			(scope < previous.scope ||
				(scope === previous.scope && position <= previous.position))
		)
			return;
		// ponytail: lifetime scope/entry high-water capped at 1024 attachment identities per peer; excess snapshots fail closed.
		if (previous === undefined && completed.size >= MAX_REPLAY_ATTACHMENTS)
			return;
		completed.set(identity.attachmentId, { scope, position });
		session.completedSeq = BigInt(wire.seq);
		const generation = BigInt(wire.accountingGeneration);
		// Fresh settled counts visible before callback; observers may reset here.
		void publishHost().catch(() => {});
		if (peerSessions.get(message.senderId) !== session) return;
		deliverCompletion(identity, session.contributorId, session.seq, generation);
	};
	const queueCheckpoint = (
		completion: CompletionIdentity | null = null,
	): Promise<void> => {
		if (
			completion !== null &&
			node?.peers().find((peer) => peer.nodeId === node?.declaration.hostNodeId)
				?.status !== "online"
		)
			completion = null;
		if (node === undefined || rootProcess) return Promise.resolve();
		const seq = ++localCheckpointSeq;
		requiredCheckpointSeq = seq;
		clearClientCounters();
		const target = node.declaration.hostNodeId;
		const wire: CheckpointWire = {
			scopes: Array.from(attachments.values(), (attachment) => ({
				attachmentId: attachment.contributorId,
				scope: attachment.scope.toString(),
			})),
			version: PRIVATE_PROTOCOL_VERSION,
			incarnation: processIncarnation,
			contributorId: clientContributorId,
			accountingGeneration: clientAccountingGeneration.toString(),
			seq: seq.toString(),
			busy: desiredActivity(),
			rootLoops: "0",
			allLoops: localAllLoops.toString(),
			activeLoops: localActiveLoops.toString(),
			completion,
			resumeReceipt: clientResumeReceipt,
		};
		return queueTransport(async () => {
			if (node === undefined || rootProcess) return;
			try {
				await node.send(target, CHECKPOINT_CHANNEL, wire);
				if (
					completion !== null &&
					clientAccountingGeneration === BigInt(wire.accountingGeneration) &&
					clientContributorId === wire.contributorId &&
					node.peers().find((peer) => peer.nodeId === target)?.status ===
						"online"
				) {
					const fresh: CompletionWire = {
						...completion,
						version: PRIVATE_PROTOCOL_VERSION,
						incarnation: wire.incarnation,
						contributorId: wire.contributorId,
						accountingGeneration: wire.accountingGeneration,
						seq: wire.seq,
					};
					await node.send(target, COMPLETION_CHANNEL, fresh);
				}
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
		clientAccountingGeneration = parsed.accountingGeneration;
		if (generationChanged) {
			fenceAttachments(
				parsed.fullGeneration !== clientFullGeneration ? "full" : "reminder",
			);
			if (parsed.fullGeneration !== clientFullGeneration) localActiveLoops = 0n;
			localAllLoops = 0n;
			clientFullGeneration = parsed.fullGeneration;
			clientContributorId = id();
			requiredCheckpointSeq = 0n;
		}
		if (generationChanged) {
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
			if (event.peer.status === "offline") return;
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
		// A validated checkpoint already admitted peerSessions; any recorded
		// acceptance for this exact nodeId/incarnation (including one retained
		// after an offline projection) is eligible for the control snapshot.
		// Enrollment authority is Reflect-private protocol messages, not shared
		// transport metadata.
		const session = peerSessions.get(event.peer.nodeId);
		const receipt =
			session === undefined
				? replayRegistry.get(
						replayKeyFor(
							event.peer.nodeId,
							String(event.peer.metadata.incarnation ?? ""),
						),
					)
				: undefined;
		if (session === undefined && receipt === undefined) return;
		controlPeers.add(event.peer.nodeId);
		void publishHost().catch(() => {});
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
				unsubscribeCompletion = opened.subscribe(
					COMPLETION_CHANNEL,
					applyHostCompletion,
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
					removePeerSession(message.senderId);
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
			unsubscribeCompletion?.();
			unsubscribeEvents = undefined;
			unsubscribeCheckpoint = undefined;
			unsubscribeCounters = undefined;
			unsubscribeLeave = undefined;
			unsubscribeCompletion = undefined;
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
		unsubscribeCompletion?.();
		unsubscribeEvents = undefined;
		unsubscribeCheckpoint = undefined;
		unsubscribeCounters = undefined;
		unsubscribeLeave = undefined;
		unsubscribeCompletion = undefined;
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
		clientAccountingGeneration = 0n;
		clientContributorId = id();
		clientResumeReceipt = null;
		localCheckpointSeq = 0n;
		requiredCheckpointSeq = 0n;
		localAllLoops = 0n;
		localActiveLoops = 0n;
		fullGeneration = 0n;
		clientFullGeneration = 0n;
		peerSessions.clear();
		controlPeers.clear();
		replayRegistry.clear();
		await closing?.close();
	};

	const prefix = (
		previous: readonly string[],
		next: readonly string[],
	): boolean => previous.every((entry, index) => next[index] === entry);
	const observeBranch = (
		attachment: Attachment,
	): BranchAccounting | undefined => {
		if (recordingBoundary) return undefined;
		const source = attachment.source;
		const view = deriveBranchAccounting(source.getBranch(), {
			cooldownLoops: 0,
			boundaryPolicy:
				rootProcess && source.isMain() ? source.boundaryPolicy : "baselines",
			fullAfterEntryId: attachment.fullAfterEntryId,
			reminderAfterEntryId: attachment.reminderAfterEntryId,
		});
		if (
			!view.baselineFound ||
			!prefix(attachment.fullIds, view.full.entryIds) ||
			!prefix(attachment.reminderIds, view.reminder.entryIds)
		) {
			rebaseAttachment(attachment, "full");
			if (rootProcess && source.isMain())
				reduce({
					type: "main-snapshot",
					generation: collectionState?.accounting.generation ?? 0n,
					activeLoops: 0n,
					reminderLoops: 0n,
					atMs: now(),
				});
			return undefined;
		}
		const active = BigInt(
			view.full.entryIds.length - attachment.fullIds.length,
		);
		const reminder = BigInt(
			view.reminder.entryIds.length - attachment.reminderIds.length,
		);
		attachment.fullIds = view.full.entryIds;
		attachment.reminderIds = view.reminder.entryIds;
		if (rootProcess) {
			if (source.isMain())
				reduce({
					type: "main-snapshot",
					generation: collectionState?.accounting.generation ?? 0n,
					activeLoops: view.activeLoops,
					reminderLoops: view.reminderLoops,
					atMs: now(),
				});
			else
				reduce({
					type: "child-loops",
					generation: collectionState?.accounting.generation ?? 0n,
					active,
					reminder,
					atMs: now(),
				});
		} else {
			localActiveLoops += active;
			localAllLoops += reminder;
		}
		return view;
	};
	const publishBranch = (
		completion: CompletionIdentity | null = null,
	): Promise<void> =>
		rootProcess ? publishHost() : queueCheckpoint(completion);
	const coordinator: ReflectBranchDomainCoordinator = {
		get rootProcess() {
			return rootProcess;
		},
		attach(instance, attachOptions) {
			return queueLifecycle(async () => {
				if (attachments.has(instance)) return;
				const attachment: Attachment = {
					contributorId: `attachment-${++nextAttachmentId}`,
					source: attachOptions.source,
					scope: 0n,
					fullAfterEntryId: attachOptions.source.getLeafId(),
					reminderAfterEntryId: attachOptions.source.getLeafId(),
					fullIds: [],
					reminderIds: [],
					completedPosition: 0,
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
			} else await queueCheckpoint();
		},
		async refreshBranch(instance) {
			const attachment = attachments.get(instance);
			if (attachment === undefined) return countersValue;
			observeBranch(attachment);
			await publishBranch();
			return countersValue;
		},
		async rebaseBranch(instance, rebaseOptions = {}) {
			const attachment = attachments.get(instance);
			if (attachment === undefined) return countersValue;
			const main = rootProcess && attachment.source.isMain();
			if (rebaseOptions.adoptHistory && !main)
				throw new Error("Only current main may adopt branch history");
			rebaseAttachment(attachment, "full", rebaseOptions.adoptHistory);
			if (rebaseOptions.adoptHistory) {
				attachment.fullAfterEntryId = rebaseOptions.fullAfterEntryId ?? null;
				attachment.reminderAfterEntryId =
					rebaseOptions.reminderAfterEntryId ?? attachment.fullAfterEntryId;
			}
			observeBranch(attachment);
			attachment.completedPosition = attachment.fullIds.length;
			await publishBranch();
			return countersValue;
		},
		async completeTurn(instance, messageEntryId) {
			const attachment = attachments.get(instance);
			if (attachment === undefined) return countersValue;
			const observedScope = attachment.scope;
			const view = observeBranch(attachment);
			const position = view?.full.entryIds.indexOf(messageEntryId) ?? -1;
			if (
				view === undefined ||
				attachment.scope !== observedScope ||
				position < 0 ||
				!view.reminder.entryIds.includes(messageEntryId) ||
				position + 1 <= attachment.completedPosition
			) {
				await publishBranch();
				return countersValue;
			}
			attachment.completedPosition = position + 1;
			const generation = rootProcess
				? (collectionState?.accounting.generation ?? 0n)
				: clientAccountingGeneration;
			const completion: CompletionIdentity = {
				attachmentId: attachment.contributorId,
				scope: attachment.scope.toString(),
				entryId: messageEntryId,
				position: String(position + 1),
			};
			// Capture count update now, not after queued transport awaits.
			const publication = publishBranch(rootProcess ? null : completion);
			if (rootProcess)
				deliverCompletion(
					completion,
					attachment.contributorId,
					++localCheckpointSeq,
					generation,
					instance,
				);
			await publication;
			return countersValue;
		},
		subscribeCompletions(listener) {
			completionListeners.add(listener);
			return () => completionListeners.delete(listener);
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
		async resetCycleOnUserTakeover() {
			if (!rootProcess || collectionState === undefined) return countersValue;
			reduce({ type: "cycle-reset", atMs: now() });
			await publishHost();
			return countersValue;
		},
	};
	return coordinator;
}

const SHARED = Symbol.for("pi-reflect-watchdog:process-domain:v4");
type SharedHost = typeof globalThis & {
	[SHARED]?: ReflectBranchDomainCoordinator;
};

export function getReflectDomainCoordinator(): ReflectBranchDomainCoordinator {
	const host = globalThis as SharedHost;
	host[SHARED] ??= createReflectDomainCoordinator();
	return host[SHARED];
}
