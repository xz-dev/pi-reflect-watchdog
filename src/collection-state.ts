export const CHECKPOINT_REPLAY_RETENTION_MS = 10_000;

/**
 * Grace fence after the last busy contributor goes idle before the machine
 * settles to idle. Mirrors pi-continue-watchdog's inquiry fence and the
 * formally verified model in
 * docs/programming-thinking/reflect-activity-state-machine.idea.lean.
 */
export const GRACE_FENCE_MS = 10_000;

/** Normal accounting cadence and approximate suspension-detection gap. */
export const HEARTBEAT_MS = 1_000;
export const SLEEP_GAP_MS = 10_000;

interface PeerContributor {
	readonly kind: "peer";
	readonly contributorId: string;
	readonly replayKey: string;
	readonly busy: boolean;
}

export interface PeerCheckpoint {
	readonly activeLoops?: bigint;
	readonly generation: bigint;
	readonly seq: bigint;
	readonly busy: boolean;
	readonly rootLoops: bigint;
	readonly allLoops: bigint;
}

export interface CheckpointLedgerEntry {
	readonly activeLoops?: bigint;
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
	readonly mainActiveLoops: bigint;
	readonly mainReminderLoops: bigint;
	readonly accounting: CollectionAccounting;
}

export interface CollectionSnapshot {
	readonly generation: bigint;
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
	readonly active?: bigint;
	readonly root: bigint;
	readonly all: bigint;
}

export type CollectionEvent =
	| {
			readonly type: "main-snapshot";
			readonly generation: bigint;
			readonly activeLoops: bigint;
			readonly reminderLoops: bigint;
			readonly atMs: number;
	  }
	| {
			readonly type: "child-loops";
			readonly generation: bigint;
			readonly active: bigint;
			readonly reminder: bigint;
			readonly atMs: number;
	  }
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
	| { readonly type: "tick"; readonly atMs: number }
	| { readonly type: "reminder-accepted"; readonly atMs: number }
	| { readonly type: "cycle-reset"; readonly atMs: number };

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
		checkpoint.allLoops >= checkpoint.rootLoops &&
		(checkpoint.activeLoops ?? checkpoint.allLoops) >= 0n
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
	// Every settlement, including non-timer observations, uses the same gap cap.
	const elapsed = (sinceMs: number | null): bigint => {
		if (sinceMs === null) return 0n;
		const gap = atMs - sinceMs;
		return BigInt(gap > SLEEP_GAP_MS ? HEARTBEAT_MS : gap);
	};
	const activeDelta = elapsed(accounting.activeSinceMs);
	const taskDelta = elapsed(accounting.taskSinceMs);
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

	if (!wasBusy && isBusy) {
		// Grace freezes at the true all-idle edge, even without a timer expiry.
		const idleSinceMs = accounting.idleSinceMs ?? accounting.graceSinceMs;
		if (idleSinceMs !== null && atMs > idleSinceMs + state.idleResetGapMs)
			accounting = {
				...resetCycle(accounting),
				generation: accounting.generation + 1n,
			};
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
	return {
		...state,
		nowMs: atMs,
		live,
		ledger:
			accounting.generation === state.accounting.generation
				? ledger
				: new Map(
						Array.from(ledger, ([key, entry]) => [
							key,
							{
								...entry,
								generation: accounting.generation,
								activeLoops: 0n,
								rootLoops: 0n,
								allLoops: 0n,
							},
						]),
					),
		mainActiveLoops:
			accounting.generation === state.accounting.generation
				? state.mainActiveLoops
				: 0n,
		mainReminderLoops:
			accounting.generation === state.accounting.generation
				? state.mainReminderLoops
				: 0n,
		accounting,
	};
}

function addLoopDelta(
	state: CollectionState,
	rootDelta: bigint,
	allDelta: bigint,
	activeDelta = allDelta,
): CollectionState {
	if (rootDelta < 0n || allDelta < rootDelta || activeDelta < 0n) return state;
	return {
		...state,
		accounting: {
			...state.accounting,
			activeLoops: state.accounting.activeLoops + activeDelta,
			rootLoops: state.accounting.rootLoops + rootDelta,
			allLoops: state.accounting.allLoops + allDelta,
		},
	};
}

export function checkpointLoopDelta(
	entry: CheckpointLedgerEntry,
	checkpoint: PeerCheckpoint,
): AcceptedLoopDelta | null {
	if (
		checkpoint.generation !== entry.generation ||
		checkpoint.seq <= entry.seq ||
		checkpoint.rootLoops < entry.rootLoops ||
		checkpoint.allLoops < entry.allLoops ||
		(checkpoint.activeLoops ?? checkpoint.allLoops) <
			(entry.activeLoops ?? entry.allLoops)
	)
		return null;
	const root = checkpoint.rootLoops - entry.rootLoops;
	const all = checkpoint.allLoops - entry.allLoops;
	return root <= all
		? {
				active:
					(checkpoint.activeLoops ?? checkpoint.allLoops) -
					(entry.activeLoops ?? entry.allLoops),
				root,
				all,
			}
		: null;
}

function validAcceptedLoopDelta(
	delta: AcceptedLoopDelta,
	checkpoint: PeerCheckpoint,
): boolean {
	return (
		delta.root >= 0n &&
		delta.all >= delta.root &&
		delta.root <= checkpoint.rootLoops &&
		delta.all <= checkpoint.allLoops &&
		(delta.active ?? delta.all) >= 0n &&
		(delta.active ?? delta.all) <=
			(checkpoint.activeLoops ?? checkpoint.allLoops)
	);
}

function sameLoopDelta(
	left: AcceptedLoopDelta,
	right: AcceptedLoopDelta,
): boolean {
	return (
		left.root === right.root &&
		left.all === right.all &&
		(left.active ?? left.all) === (right.active ?? right.all)
	);
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
			active: checkpoint.activeLoops ?? checkpoint.allLoops,
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
		mainActiveLoops: 0n,
		mainReminderLoops: 0n,
		accounting: {
			generation: 0n,
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
		case "main-snapshot": {
			if (
				event.generation !== state.accounting.generation ||
				event.activeLoops < event.reminderLoops ||
				event.reminderLoops < 0n
			)
				return state;
			const observed = withLive(
				state,
				new Map(state.live),
				pruneLedger(state.ledger, atMs),
				atMs,
			);
			if (observed.accounting.generation !== event.generation) return observed;
			return {
				...observed,
				mainActiveLoops: event.activeLoops,
				mainReminderLoops: event.reminderLoops,
				accounting: {
					...observed.accounting,
					activeLoops:
						observed.accounting.activeLoops -
						observed.mainActiveLoops +
						event.activeLoops,
					rootLoops:
						observed.accounting.rootLoops -
						observed.mainReminderLoops +
						event.reminderLoops,
					allLoops:
						observed.accounting.allLoops -
						observed.mainReminderLoops +
						event.reminderLoops,
				},
			};
		}
		case "child-loops": {
			if (
				event.generation !== state.accounting.generation ||
				event.active < 0n ||
				event.reminder < 0n
			)
				return state;
			const observed = withLive(
				state,
				new Map(state.live),
				pruneLedger(state.ledger, atMs),
				atMs,
			);
			if (observed.accounting.generation !== event.generation) return observed;
			return addLoopDelta(observed, 0n, event.reminder, event.active);
		}
		case "local-activity": {
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
				activeLoops: checkpoint.activeLoops ?? checkpoint.allLoops,
				rootLoops: checkpoint.rootLoops,
				allLoops: checkpoint.allLoops,
				replayUntilMs: null,
			});
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
			const observed = withLive(state, live, ledger, atMs);
			if (observed.accounting.generation !== checkpoint.generation)
				return observed;
			return addLoopDelta(
				observed,
				delta.root,
				delta.all,
				delta.active ?? delta.all,
			);
		}
		case "peer-checkpoint-verified": {
			if (
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
				activeLoops: event.checkpoint.activeLoops ?? event.checkpoint.allLoops,
				rootLoops: event.checkpoint.rootLoops,
				allLoops: event.checkpoint.allLoops,
				replayUntilMs: null,
			});
			const live = new Map(state.live);
			live.set(key, { ...contributor, busy: event.checkpoint.busy });
			const observed = withLive(state, live, ledger, atMs);
			if (observed.accounting.generation !== event.checkpoint.generation)
				return observed;
			return addLoopDelta(
				observed,
				event.acceptedLoopDelta.root,
				event.acceptedLoopDelta.all,
				event.acceptedLoopDelta.active ?? event.acceptedLoopDelta.all,
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
		case "tick": {
			// Cadence wakes accounting; settlement owns elapsed time and gap capping.
			return withLive(
				state,
				new Map(state.live),
				pruneLedger(state.ledger, atMs),
				atMs,
			);
		}
		case "reminder-accepted": {
			let accounting = settleAccounting(state.accounting, atMs);
			accounting = {
				...accounting,
				generation: accounting.generation + 1n,
				taskMs: 0n,
				rootLoops: 0n,
				allLoops: 0n,
				taskSinceMs: busyCount(state.live) > 0 ? atMs : null,
			};
			return {
				...state,
				nowMs: atMs,
				mainReminderLoops: 0n,
				ledger: new Map(
					Array.from(pruneLedger(state.ledger, atMs), ([key, entry]) => [
						key,
						{
							...entry,
							generation: accounting.generation,
							rootLoops: 0n,
							allLoops: 0n,
						},
					]),
				),
				accounting,
			};
		}
		case "cycle-reset": {
			const accounting = settleAccounting(state.accounting, atMs);
			const anyBusy = busyCount(state.live) > 0;
			return {
				...state,
				nowMs: atMs,
				mainActiveLoops: 0n,
				mainReminderLoops: 0n,
				ledger: new Map(
					Array.from(pruneLedger(state.ledger, atMs), ([key, entry]) => [
						key,
						{
							...entry,
							generation: accounting.generation + 1n,
							activeLoops: 0n,
							rootLoops: 0n,
							allLoops: 0n,
						},
					]),
				),
				accounting: {
					...accounting,
					generation: accounting.generation + 1n,
					activeMs: 0n,
					activeLoops: 0n,
					taskMs: 0n,
					rootLoops: 0n,
					allLoops: 0n,
					activeSinceMs: anyBusy ? atMs : null,
					taskSinceMs: anyBusy ? atMs : null,
					idleSinceMs: anyBusy ? null : (accounting.idleSinceMs ?? atMs),
					graceSinceMs: anyBusy ? null : accounting.graceSinceMs,
				},
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
	const phase =
		busyContributors > 0
			? "collecting"
			: accounting.graceSinceMs !== null
				? "grace"
				: "idle";
	return {
		generation: accounting.generation,
		anyBusy: busyContributors > 0,
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
