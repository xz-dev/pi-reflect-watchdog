import assert from "node:assert/strict";
import test from "node:test";
import {
	type AcceptedLoopDelta,
	CHECKPOINT_REPLAY_RETENTION_MS,
	type CollectionState,
	createCollectionState,
	type PeerCheckpoint,
	reduceCollectionState,
	snapshotCollectionState,
} from "../src/collection-state.js";

const contributorId = "child-live-1";
const replayKey = "child/process-1";

function checkpoint(overrides: Partial<PeerCheckpoint> = {}): PeerCheckpoint {
	return {
		generation: 0n,
		seq: 1n,
		busy: false,
		rootLoops: 0n,
		allLoops: 0n,
		...overrides,
	};
}

function synchronize(
	state: CollectionState,
	options: {
		readonly atMs: number;
		readonly contributorId?: string;
		readonly replayKey?: string;
		readonly acceptedLoopDelta?: AcceptedLoopDelta;
		readonly checkpoint?: PeerCheckpoint;
	},
): CollectionState {
	return reduceCollectionState(state, {
		type: "peer-synchronized",
		contributorId: options.contributorId ?? contributorId,
		replayKey: options.replayKey ?? replayKey,
		acceptedLoopDelta: options.acceptedLoopDelta ?? {
			root: options.checkpoint?.rootLoops ?? 0n,
			all: options.checkpoint?.allLoops ?? 0n,
		},
		checkpoint: options.checkpoint ?? checkpoint(),
		atMs: options.atMs,
	});
}

test("offline immediately removes busy contribution and only retains replay high-water", () => {
	let state = createCollectionState();
	state = synchronize(state, {
		atMs: 0,
		checkpoint: checkpoint({
			busy: true,
			rootLoops: 1n,
			allLoops: 2n,
		}),
	});
	assert.equal(snapshotCollectionState(state, 1_000).activeMs, 1_000n);

	state = reduceCollectionState(state, {
		type: "peer-offline",
		contributorId,
		atMs: 1_000,
	});

	const snapshot = snapshotCollectionState(state, 9_000);
	assert.equal(state.live.size, 0);
	assert.equal(snapshot.anyBusy, false);
	assert.equal(snapshot.activeMs, 1_000n);
	assert.equal(snapshot.taskMs, 1_000n);
	assert.equal(
		state.ledger.get(replayKey)?.replayUntilMs,
		1_000 + CHECKPOINT_REPLAY_RETENTION_MS,
	);
	assert.equal("certain" in snapshot, false);
});

test("retained reconnect restores loop delta but never backfills offline time", () => {
	let state = synchronize(createCollectionState(), {
		atMs: 0,
		checkpoint: checkpoint({
			busy: true,
			rootLoops: 1n,
			allLoops: 2n,
		}),
	});
	state = reduceCollectionState(state, {
		type: "peer-offline",
		contributorId,
		atMs: 1_000,
	});
	state = synchronize(state, {
		atMs: 9_000,
		acceptedLoopDelta: { root: 1n, all: 3n },
		checkpoint: checkpoint({
			seq: 2n,
			busy: true,
			rootLoops: 2n,
			allLoops: 5n,
		}),
	});

	assert.deepEqual(snapshotCollectionState(state, 10_000), {
		generation: 0n,
		paused: false,
		anyBusy: true,
		activeMs: 2_000n,
		activeLoops: 5n,
		taskMs: 2_000n,
		rootLoops: 2n,
		allLoops: 5n,
		liveContributors: 1,
		busyContributors: 1,
	});
});

test("adapter-supplied replay delta must exactly match retained high-water", () => {
	let state = synchronize(createCollectionState(), {
		atMs: 0,
		checkpoint: checkpoint({ rootLoops: 1n, allLoops: 2n }),
	});
	state = reduceCollectionState(state, {
		type: "peer-offline",
		contributorId,
		atMs: 1_000,
	});
	const rejected = synchronize(state, {
		atMs: 9_000,
		acceptedLoopDelta: { root: 0n, all: 0n },
		checkpoint: checkpoint({ seq: 2n, rootLoops: 2n, allLoops: 5n }),
	});

	assert.equal(rejected, state);
	assert.equal(rejected.live.size, 0);
	assert.equal(snapshotCollectionState(rejected).allLoops, 2n);
});

test("verified checkpoint delta must exactly match retained high-water", () => {
	const state = synchronize(createCollectionState(), {
		atMs: 0,
		checkpoint: checkpoint({ rootLoops: 1n, allLoops: 2n }),
	});
	const rejected = reduceCollectionState(state, {
		type: "peer-checkpoint-verified",
		contributorId,
		acceptedLoopDelta: { root: 0n, all: 0n },
		checkpoint: checkpoint({ seq: 2n, rootLoops: 2n, allLoops: 5n }),
		atMs: 100,
	});

	assert.equal(rejected, state);
	assert.equal(snapshotCollectionState(rejected).allLoops, 2n);
});

test("ledger-expired returning peer seeds a new baseline without replay", () => {
	let state = synchronize(createCollectionState(), {
		atMs: 0,
		checkpoint: checkpoint({ rootLoops: 1n, allLoops: 2n }),
	});
	state = reduceCollectionState(state, {
		type: "peer-offline",
		contributorId,
		atMs: 1_000,
	});
	state = synchronize(state, {
		atMs: 11_001,
		acceptedLoopDelta: { root: 0n, all: 0n },
		checkpoint: checkpoint({ seq: 2n, rootLoops: 2n, allLoops: 5n }),
	});

	const snapshot = snapshotCollectionState(state);
	assert.equal(snapshot.rootLoops, 1n);
	assert.equal(snapshot.allLoops, 2n);
	assert.equal(state.ledger.get(replayKey)?.allLoops, 5n);
});

test("true first join counts loops completed before its first checkpoint", () => {
	const state = synchronize(createCollectionState(), {
		atMs: 1_000,
		checkpoint: checkpoint({ rootLoops: 3n, allLoops: 7n }),
	});
	const snapshot = snapshotCollectionState(state);
	assert.equal(snapshot.activeLoops, 7n);
	assert.equal(snapshot.rootLoops, 3n);
	assert.equal(snapshot.allLoops, 7n);
});

test("pause generation crossing discards disconnected loop delta", () => {
	let state = synchronize(createCollectionState(), {
		atMs: 0,
		checkpoint: checkpoint({
			busy: true,
			rootLoops: 1n,
			allLoops: 2n,
		}),
	});
	state = reduceCollectionState(state, {
		type: "peer-offline",
		contributorId,
		atMs: 1_000,
	});
	state = reduceCollectionState(state, {
		type: "pause-changed",
		paused: true,
		atMs: 2_000,
	});
	state = reduceCollectionState(state, {
		type: "pause-changed",
		paused: false,
		atMs: 3_000,
	});
	state = synchronize(state, {
		atMs: 5_000,
		acceptedLoopDelta: { root: 0n, all: 0n },
		checkpoint: checkpoint({
			generation: 2n,
			seq: 2n,
			busy: true,
			rootLoops: 3n,
			allLoops: 6n,
		}),
	});

	const snapshot = snapshotCollectionState(state, 6_000);
	assert.equal(snapshot.generation, 2n);
	assert.equal(snapshot.rootLoops, 1n);
	assert.equal(snapshot.allLoops, 2n);
	assert.equal(snapshot.activeMs, 2_000n);
});

test("idle reset preserves exactly sixty seconds and resets only after overflow", () => {
	let state = createCollectionState({ idleResetGapMs: 60_000 });
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 0,
	});
	state = reduceCollectionState(state, {
		type: "local-loop",
		scope: "root",
		atMs: 50,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: false,
		atMs: 100,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 60_100,
	});
	assert.equal(snapshotCollectionState(state).allLoops, 1n);

	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: false,
		atMs: 60_200,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 120_201,
	});
	const reset = snapshotCollectionState(state);
	assert.equal(reset.activeMs, 0n);
	assert.equal(reset.activeLoops, 0n);
	assert.equal(reset.taskMs, 0n);
	assert.equal(reset.rootLoops, 0n);
	assert.equal(reset.allLoops, 0n);
});

test("new synchronized handle replaces the prior handle for one replay key", () => {
	let state = synchronize(createCollectionState(), {
		atMs: 0,
		checkpoint: checkpoint({
			seq: 1n,
			busy: true,
			rootLoops: 1n,
			allLoops: 2n,
		}),
	});
	state = synchronize(state, {
		atMs: 100,
		contributorId: "child-live-2",
		acceptedLoopDelta: { root: 1n, all: 1n },
		checkpoint: checkpoint({
			seq: 2n,
			busy: true,
			rootLoops: 2n,
			allLoops: 3n,
		}),
	});
	state = reduceCollectionState(state, {
		type: "peer-offline",
		contributorId,
		atMs: 200,
	});

	const snapshot = snapshotCollectionState(state, 300);
	assert.equal(state.live.size, 1);
	assert.equal(snapshot.anyBusy, true);
	assert.equal(snapshot.allLoops, 3n);
});

test("stale checkpoint and stale offline fact cannot mutate current contributor", () => {
	let state = synchronize(createCollectionState(), {
		atMs: 0,
		checkpoint: checkpoint({
			seq: 3n,
			busy: true,
			rootLoops: 2n,
			allLoops: 5n,
		}),
	});
	state = reduceCollectionState(state, {
		type: "peer-checkpoint-verified",
		contributorId,
		acceptedLoopDelta: { root: 1n, all: 2n },
		checkpoint: checkpoint({
			seq: 3n,
			busy: false,
			rootLoops: 3n,
			allLoops: 7n,
		}),
		atMs: 200,
	});
	state = reduceCollectionState(state, {
		type: "peer-offline",
		contributorId: "old-live-handle",
		atMs: 300,
	});

	const snapshot = snapshotCollectionState(state, 400);
	assert.equal(snapshot.anyBusy, true);
	assert.equal(snapshot.allLoops, 5n);
	assert.equal(state.live.size, 1);
});

test("paused accounting ignores loops and resumes from newly observed activity", () => {
	let state = createCollectionState();
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 0,
	});
	state = reduceCollectionState(state, {
		type: "pause-changed",
		paused: true,
		atMs: 1_000,
	});
	state = reduceCollectionState(state, {
		type: "local-loop",
		scope: "root",
		atMs: 2_000,
	});
	state = reduceCollectionState(state, {
		type: "pause-changed",
		paused: false,
		atMs: 3_000,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 3_000,
	});

	const snapshot = snapshotCollectionState(state, 4_000);
	assert.equal(snapshot.activeMs, 2_000n);
	assert.equal(snapshot.taskMs, 2_000n);
	assert.equal(snapshot.rootLoops, 0n);
	assert.equal(snapshot.allLoops, 0n);
});
