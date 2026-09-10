export const CHECKPOINT_REPLAY_RETENTION_MS = 10_000;

/**
 * Grace fence after the last busy contributor goes idle before the machine
 * settles to idle. Mirrors pi-continue-watchdog's inquiry fence and the
 * formally verified model in
 * docs/programming-thinking/reflect-activity-state-machine.idea.lean.
 */
export const GRACE_FENCE_MS = 10_000;

/** Host heartbeat period and sleep-detection gap (Lean: BEAT_MS/SLEEP_GAP_MS). */
export const HEARTBEAT_MS = 5_000;
export const SLEEP_GAP_MS = 10_000;

interface PeerContributor {
	readonly kind: "peer";
	readonly contributorId: string;
	readonly replayKey: string;
	readonly busy: boolean;
}

export interface PeerCheckpoint {
	readonly generation: bigint;
	readonly seq: bigint;
	readonly busy: boolean;
	readonly rootLoops: bigint;
	readonly allLoops: bigint;
}

export interface CheckpointLedgerEntry {
	readonly generation: bigint;
	readonly seq: bigint;
	readonly rootLoops: bigint;
	readonly allLoops: bigint;
	readonly replayUntilMs: number | null;
}

interface LocalContributor {
	readonly kind: "local";
	readonly contributorId: string;
	readonly busy: boolean;
}

export type LiveContributor = LocalContributor | PeerContributor;

export interface CollectionAccounting {
	readonly generation: bigint;
	readonly paused: boolean;
	readonly pausedAtMs: number | null;
	readonly activeMs: bigint;
	readonly activeLoops: bigint;
	readonly taskMs: bigint;
	readonly rootLoops: bigint;
	readonly allLoops: bigint;
	readonly activeSinceMs: number | null;
	readonly taskSinceMs: number | null;
	readonly idleSinceMs: number | null;
	readonly graceSinceMs: number | null;
}

export interface CollectionState {
	readonly nowMs: number;
	readonly idleResetGapMs: number;
	readonly live: ReadonlyMap<string, LiveContributor>;
	readonly ledger: ReadonlyMap<string, CheckpointLedgerEntry>;
	readonly accounting: CollectionAccounting;
}

export interface CollectionSnapshot {
	readonly generation: bigint;
	readonly paused: boolean;
	readonly anyBusy: boolean;
	readonly phase: "idle" | "collecting" | "grace";
	readonly activeMs: bigint;
	readonly activeLoops: bigint;
	readonly taskMs: bigint;
	readonly rootLoops: bigint;
	readonly allLoops: bigint;
	readonly liveContributors: number;
	readonly busyContributors: number;
}

export interface AcceptedLoopDelta {
	readonly root: bigint;
	readonly all: bigint;
}

export type CollectionEvent =
	| {
			readonly type: "local-activity";
			readonly contributorId: string;
			readonly busy: boolean;
			readonly atMs: number;
	  }
	| {
			readonly type: "local-detached";
			readonly contributorId: string;
			readonly atMs: number;
	  }
	| {
			readonly type: "local-loop";
			readonly scope: "root" | "all";
			readonly atMs: number;
	  }
	| {
			readonly type: "peer-synchronized";
			/** Opaque live-contributor identity already fenced by the adapter. */
			readonly contributorId: string;
			/** Opaque incarnation replay identity already verified by the adapter. */
			readonly replayKey: string;
			/** Adapter-verified delta to apply; receipt/history decisions stay outside. */
			readonly acceptedLoopDelta: AcceptedLoopDelta;
			readonly checkpoint: PeerCheckpoint;
			readonly atMs: number;
	  }
	| {
			readonly type: "peer-checkpoint-verified";
			readonly contributorId: string;
			readonly checkpoint: PeerCheckpoint;
			readonly acceptedLoopDelta: AcceptedLoopDelta;
			readonly atMs: number;
	  }
	| {
			readonly type: "peer-offline";
			readonly contributorId: string;
			readonly atMs: number;
	  }
	| {
			readonly type: "pause-changed";
			readonly paused: boolean;
			readonly atMs: number;
	  }
	| { readonly type: "tick"; readonly atMs: number }
	| { readonly type: "reminder-accepted"; readonly atMs: number };

function localContributorKey(contributorId: string): string {
	return `local:${JSON.stringify(contributorId)}`;
}

function peerContributorKey(contributorId: string): string {
	return `peer:${JSON.stringify(contributorId)}`;
}

function validTime(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function eventTime(state: CollectionState, atMs: number): number | null {
	if (!validTime(atMs)) return null;
	return Math.max(state.nowMs, atMs);
}

function validCheckpoint(checkpoint: PeerCheckpoint): boolean {
	return (
		checkpoint.generation >= 0n &&
		checkpoint.seq > 0n &&
		checkpoint.rootLoops >= 0n &&
		checkpoint.allLoops >= checkpoint.rootLoops
	);
}

function busyCount(live: ReadonlyMap<string, LiveContributor>): number {
	let count = 0;
	for (const contributor of live.values()) if (contributor.busy) count += 1;
	return count;
}

function settleAccounting(
	accounting: CollectionAccounting,
	atMs: number,
): CollectionAccounting {
	if (accounting.paused) return accounting;
	const activeDelta =
		accounting.activeSinceMs === null
			? 0n
			: BigInt(atMs - accounting.activeSinceMs);
	const taskDelta =
		accounting.taskSinceMs === null
			? 0n
			: BigInt(atMs - accounting.taskSinceMs);
	return {
		...accounting,
		activeMs: accounting.activeMs + activeDelta,
		taskMs: accounting.taskMs + taskDelta,
		activeSinceMs: accounting.activeSinceMs === null ? null : atMs,
		taskSinceMs: accounting.taskSinceMs === null ? null : atMs,
	};
}

function resetCycle(accounting: CollectionAccounting): CollectionAccounting {
	return {
		...accounting,
		activeMs: 0n,
		activeLoops: 0n,
		taskMs: 0n,
		rootLoops: 0n,
		allLoops: 0n,
	};
}

function pruneLedger(
	ledger: ReadonlyMap<string, CheckpointLedgerEntry>,
	atMs: number,
): Map<string, CheckpointLedgerEntry> {
	const next = new Map(ledger);
	for (const [key, entry] of next)
		if (entry.replayUntilMs !== null && atMs > entry.replayUntilMs)
			next.delete(key);
	return next;
}

function withLive(
	state: CollectionState,
	live: Map<string, LiveContributor>,
	ledger: Map<string, CheckpointLedgerEntry>,
	atMs: number,
): CollectionState {
	const wasBusy = busyCount(state.live) > 0;
	const isBusy = busyCount(live) > 0;
	const inGrace = state.accounting.graceSinceMs !== null;
	let accounting = settleAccounting(state.accounting, atMs);

	if (accounting.paused) {
		return { ...state, nowMs: atMs, live: new Map(), ledger, accounting };
	}
	if (!wasBusy && !inGrace && isBusy) {
		// idle -> collecting: reopen the active interval; a long idle gap
		// resets counters only, never timestamps beyond the reopen.
		if (
			accounting.idleSinceMs !== null &&
			atMs > accounting.idleSinceMs + state.idleResetGapMs
		)
			accounting = resetCycle(accounting);
		accounting = {
			...accounting,
			activeSinceMs: atMs,
			taskSinceMs: atMs,
			idleSinceMs: null,
			graceSinceMs: null,
		};
	} else if (inGrace && isBusy) {
		// grace -> collecting: a contributor rejoined inside the fence, so the
		// aggregate never truly went idle; reopen the interval with no loss.
		accounting = {
			...accounting,
			activeSinceMs: atMs,
			taskSinceMs: atMs,
			idleSinceMs: null,
			graceSinceMs: null,
		};
	} else if (wasBusy && !isBusy) {
		// collecting -> grace: the last busy contributor stopped, but the
		// aggregate may pick up again (e.g. a subagent checkpoint landing after
		// the main model settled). Cut the active interval at the true
		// all-idle instant and open grace instead of settling immediately.
		accounting = {
			...accounting,
			activeSinceMs: null,
			taskSinceMs: null,
			idleSinceMs: null,
			graceSinceMs: atMs,
		};
	} else if (inGrace && !isBusy) {
		// grace -> idle: only after the fence elapsed with zero contributors.
		const graceSinceMs = accounting.graceSinceMs as number;
		if (atMs - graceSinceMs > GRACE_FENCE_MS) {
			accounting = {
				...accounting,
				activeSinceMs: null,
				taskSinceMs: null,
				idleSinceMs: graceSinceMs,
				graceSinceMs: null,
			};
		}
	} else if (!isBusy) {
		accounting = {
			...accounting,
			activeSinceMs: null,
			taskSinceMs: null,
			idleSinceMs: accounting.idleSinceMs ?? atMs,
			graceSinceMs: null,
		};
	}
	return { ...state, nowMs: atMs, live, ledger, accounting };
}

function addLoopDelta(
	state: CollectionState,
	rootDelta: bigint,
	allDelta: bigint,
): CollectionState {
	if (state.accounting.paused || rootDelta < 0n || allDelta < rootDelta)
		return state;
	return {
		...state,
		accounting: {
			...state.accounting,
			activeLoops: state.accounting.activeLoops + allDelta,
			rootLoops: state.accounting.rootLoops + rootDelta,
			allLoops: state.accounting.allLoops + allDelta,
		},
	};
}

export function checkpointLoopDelta(
	entry: CheckpointLedgerEntry,
	checkpoint: PeerCheckpoint,
): { readonly root: bigint; readonly all: bigint } | null {
	if (
		checkpoint.generation !== entry.generation ||
		checkpoint.seq <= entry.seq ||
		checkpoint.rootLoops < entry.rootLoops ||
		checkpoint.allLoops < entry.allLoops
	)
		return null;
	const root = checkpoint.rootLoops - entry.rootLoops;
	const all = checkpoint.allLoops - entry.allLoops;
	return root <= all ? { root, all } : null;
}

function validAcceptedLoopDelta(
	delta: AcceptedLoopDelta,
	checkpoint: PeerCheckpoint,
): boolean {
	return (
		delta.root >= 0n &&
		delta.all >= delta.root &&
		delta.root <= checkpoint.rootLoops &&
		delta.all <= checkpoint.allLoops
	);
}

function sameLoopDelta(
	left: AcceptedLoopDelta,
	right: AcceptedLoopDelta,
): boolean {
	return left.root === right.root && left.all === right.all;
}

function synchronizationDeltaAllowed(
	previous: CheckpointLedgerEntry | undefined,
	checkpoint: PeerCheckpoint,
	delta: AcceptedLoopDelta,
): boolean {
	if (!validAcceptedLoopDelta(delta, checkpoint)) return false;
	if (previous !== undefined) {
		const exact = checkpointLoopDelta(previous, checkpoint);
		return exact !== null && sameLoopDelta(delta, exact);
	}
	return (
		sameLoopDelta(delta, { root: 0n, all: 0n }) ||
		sameLoopDelta(delta, {
			root: checkpoint.rootLoops,
			all: checkpoint.allLoops,
		})
	);
}

export function createCollectionState(
	options: { readonly nowMs?: number; readonly idleResetGapMs?: number } = {},
): CollectionState {
	const nowMs = options.nowMs ?? 0;
	const idleResetGapMs = options.idleResetGapMs ?? 60_000;
	if (
		!validTime(nowMs) ||
		!Number.isSafeInteger(idleResetGapMs) ||
		idleResetGapMs <= 0
	)
		throw new RangeError(
			"collection timing must use positive safe milliseconds",
		);
	return {
		nowMs,
		idleResetGapMs,
		live: new Map(),
		ledger: new Map(),
		accounting: {
			generation: 0n,
			paused: false,
			pausedAtMs: null,
			activeMs: 0n,
			activeLoops: 0n,
			taskMs: 0n,
			rootLoops: 0n,
			allLoops: 0n,
			activeSinceMs: null,
			taskSinceMs: null,
			idleSinceMs: null,
			graceSinceMs: null,
		},
	};
}

export function reduceCollectionState(
	state: CollectionState,
	event: CollectionEvent,
): CollectionState {
	const atMs = eventTime(state, event.atMs);
	if (atMs === null) return state;

	switch (event.type) {
		case "local-activity": {
			if (state.accounting.paused) return state;
			const live = new Map(state.live);
			live.set(localContributorKey(event.contributorId), {
				kind: "local",
				contributorId: event.contributorId,
				busy: event.busy,
			});
			return withLive(state, live, pruneLedger(state.ledger, atMs), atMs);
		}
		case "local-detached": {
			const key = localContributorKey(event.contributorId);
			if (!state.live.has(key)) return state;
			const live = new Map(state.live);
			live.delete(key);
			return withLive(state, live, pruneLedger(state.ledger, atMs), atMs);
		}
		case "local-loop": {
			if (state.accounting.paused) return state;
			const advanced = withLive(
				state,
				new Map(state.live),
				pruneLedger(state.ledger, atMs),
				atMs,
			);
			return addLoopDelta(advanced, event.scope === "root" ? 1n : 0n, 1n);
		}
		case "peer-synchronized": {
			const checkpoint = event.checkpoint;
			if (
				!validCheckpoint(checkpoint) ||
				checkpoint.generation !== state.accounting.generation
			)
				return state;
			const ledger = pruneLedger(state.ledger, atMs);
			const previous = ledger.get(event.replayKey);
			const delta = event.acceptedLoopDelta;
			if (!synchronizationDeltaAllowed(previous, checkpoint, delta))
				return state;
			ledger.set(event.replayKey, {
				generation: checkpoint.generation,
				seq: checkpoint.seq,
				rootLoops: checkpoint.rootLoops,
				allLoops: checkpoint.allLoops,
				replayUntilMs: null,
			});
			if (state.accounting.paused) return { ...state, nowMs: atMs, ledger };
			const live = new Map(state.live);
			for (const [key, contributor] of live)
				if (
					contributor.kind === "peer" &&
					contributor.replayKey === event.replayKey
				)
					live.delete(key);
			live.set(peerContributorKey(event.contributorId), {
				kind: "peer",
				contributorId: event.contributorId,
				replayKey: event.replayKey,
				busy: checkpoint.busy,
			});
			return addLoopDelta(
				withLive(state, live, ledger, atMs),
				delta.root,
				delta.all,
			);
		}
		case "peer-checkpoint-verified": {
			if (
				state.accounting.paused ||
				!validCheckpoint(event.checkpoint) ||
				event.checkpoint.generation !== state.accounting.generation
			)
				return state;
			const key = peerContributorKey(event.contributorId);
			const contributor = state.live.get(key);
			if (contributor?.kind !== "peer") return state;
			const ledger = pruneLedger(state.ledger, atMs);
			const previous = ledger.get(contributor.replayKey);
			if (
				previous === undefined ||
				!synchronizationDeltaAllowed(
					previous,
					event.checkpoint,
					event.acceptedLoopDelta,
				)
			)
				return state;
			ledger.set(contributor.replayKey, {
				generation: event.checkpoint.generation,
				seq: event.checkpoint.seq,
				rootLoops: event.checkpoint.rootLoops,
				allLoops: event.checkpoint.allLoops,
				replayUntilMs: null,
			});
			const live = new Map(state.live);
			live.set(key, { ...contributor, busy: event.checkpoint.busy });
			return addLoopDelta(
				withLive(state, live, ledger, atMs),
				event.acceptedLoopDelta.root,
				event.acceptedLoopDelta.all,
			);
		}
		case "peer-offline": {
			const key = peerContributorKey(event.contributorId);
			const contributor = state.live.get(key);
			if (contributor?.kind !== "peer") return state;
			const live = new Map(state.live);
			live.delete(key);
			const ledger = pruneLedger(state.ledger, atMs);
			const entry = ledger.get(contributor.replayKey);
			if (entry !== undefined)
				ledger.set(contributor.replayKey, {
					...entry,
					replayUntilMs: atMs + CHECKPOINT_REPLAY_RETENTION_MS,
				});
			return withLive(state, live, ledger, atMs);
		}
		case "pause-changed": {
			if (state.accounting.paused === event.paused) return state;
			let accounting = settleAccounting(state.accounting, atMs);
			if (event.paused) {
				accounting = {
					...accounting,
					generation: accounting.generation + 1n,
					paused: true,
					pausedAtMs: atMs,
					activeSinceMs: null,
					taskSinceMs: null,
					graceSinceMs: null,
				};
			} else {
				const pausedDuration =
					accounting.pausedAtMs === null ? 0 : atMs - accounting.pausedAtMs;
				accounting = {
					...accounting,
					generation: accounting.generation + 1n,
					paused: false,
					pausedAtMs: null,
					activeSinceMs: null,
					taskSinceMs: null,
					graceSinceMs: null,
					idleSinceMs:
						accounting.idleSinceMs === null
							? null
							: accounting.idleSinceMs + pausedDuration,
				};
			}
			return {
				...state,
				nowMs: atMs,
				live: new Map(),
				ledger: new Map(),
				accounting,
			};
		}
		case "tick": {
			// Host heartbeat (Lean: advance/heartbeat). Detect sleep by the gap
			// since the previous tick and freeze open timestamps forward so the
			// slept wall time is never counted; then drive the phase machine so a
			// fence-expired grace settles to idle even when no other event lands.
			if (state.accounting.paused) return { ...state, nowMs: atMs };
			// Sleep freeze (Lean: sleep_freeze_exact, precondition collecting):
			// only an OPEN active interval loses wall time when the host sleeps,
			// so only then is the gap since the last proof-of-life frozen. A gap
			// while idle or in grace is just quiet time and shifts nothing.
			const gap = atMs - state.nowMs;
			let accounting = state.accounting;
			if (accounting.activeSinceMs !== null && gap > SLEEP_GAP_MS) {
				const shift = gap - HEARTBEAT_MS;
				accounting = {
					...accounting,
					activeSinceMs: accounting.activeSinceMs + shift,
					taskSinceMs:
						accounting.taskSinceMs === null
							? null
							: accounting.taskSinceMs + shift,
				};
			}
			return withLive(
				{ ...state, accounting },
				new Map(state.live),
				pruneLedger(state.ledger, atMs),
				atMs,
			);
		}
		case "reminder-accepted": {
			let accounting = settleAccounting(state.accounting, atMs);
			accounting = {
				...accounting,
				taskMs: 0n,
				rootLoops: 0n,
				allLoops: 0n,
				taskSinceMs:
					!accounting.paused && busyCount(state.live) > 0 ? atMs : null,
			};
			return {
				...state,
				nowMs: atMs,
				ledger: pruneLedger(state.ledger, atMs),
				accounting,
			};
		}
	}
}

export function snapshotCollectionState(
	state: CollectionState,
	atMs = state.nowMs,
): CollectionSnapshot {
	const nowMs = validTime(atMs) ? Math.max(state.nowMs, atMs) : state.nowMs;
	const accounting = settleAccounting(state.accounting, nowMs);
	const busyContributors = busyCount(state.live);
	const phase = accounting.paused
		? "idle"
		: busyContributors > 0
			? "collecting"
			: accounting.graceSinceMs !== null
				? "grace"
				: "idle";
	return {
		generation: accounting.generation,
		paused: accounting.paused,
		anyBusy: !accounting.paused && busyContributors > 0,
		phase,
		activeMs: accounting.activeMs,
		activeLoops: accounting.activeLoops,
		taskMs: accounting.taskMs,
		rootLoops: accounting.rootLoops,
		allLoops: accounting.allLoops,
		liveContributors: state.live.size,
		busyContributors,
	};
}
