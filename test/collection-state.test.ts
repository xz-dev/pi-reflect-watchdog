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
			active:
				options.checkpoint?.activeLoops ?? options.checkpoint?.allLoops ?? 0n,
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
		anyBusy: true,
		phase: "collecting",
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

test("grace phase: main stop while subagent busy keeps collecting", () => {
	// Lean: main_stop_not_all_stop — with ≥2 busy contributors, one leaving
	// must not flip the aggregate out of collecting.
	let state = createCollectionState();
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 0,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "subagent",
		busy: true,
		atMs: 1_000,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: false,
		atMs: 2_000,
	});
	const snapshot = snapshotCollectionState(state);
	assert.equal(snapshot.phase, "collecting");
	assert.equal(snapshot.anyBusy, true);
	assert.equal(snapshot.busyContributors, 1);
});

test("grace phase: last busy stop opens grace, fence expiry settles idle", () => {
	// Lean: last_busy_enters_grace + grace_expires_to_idle — the last
	// contributor stopping opens grace at the true all-idle instant, and
	// only a fence-expired observation settles to idle with idleSince pinned
	// at that instant.
	let state = createCollectionState();
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 0,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: false,
		atMs: 5_000,
	});
	// Still inside the fence: grace, not idle, and the active interval was
	// cut at the true all-idle instant (5_000).
	let snapshot = snapshotCollectionState(state, 10_000);
	assert.equal(snapshot.phase, "grace");
	assert.equal(snapshot.anyBusy, false);
	assert.equal(snapshot.activeMs, 5_000n);
	// A tick past the fence settles to idle.
	state = reduceCollectionState(state, {
		type: "tick",
		atMs: 16_000,
	});
	snapshot = snapshotCollectionState(state);
	assert.equal(snapshot.phase, "idle");
	assert.equal(snapshot.activeMs, 5_000n);
});

test("grace phase: re-busy inside fence loses no active time", () => {
	// Lean: no_active_loss_in_grace — a contributor rejoining inside the
	// fence resumes the active interval instead of resetting the cycle.
	let state = createCollectionState();
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 0,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: false,
		atMs: 4_000,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "subagent",
		busy: true,
		atMs: 8_000,
	});
	const snapshot = snapshotCollectionState(state, 12_000);
	assert.equal(snapshot.phase, "collecting");
	// 0–4000 collecting + 8000–12000 collecting; the 4s grace gap between
	// true idle and re-busy is not counted as active.
	assert.equal(snapshot.activeMs, 8_000n);
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
		type: "main-snapshot",
		generation: state.accounting.generation,
		activeLoops: 1n,
		reminderLoops: 1n,
		atMs: 50,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: false,
		atMs: 100,
	});
	// grace opens at 100; a tick past the fence settles to idle
	// with idleSince pinned at the true all-idle instant (100).
	state = reduceCollectionState(state, {
		type: "tick",
		atMs: 10_200,
	});
	assert.equal(snapshotCollectionState(state).phase, "idle");
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
		type: "tick",
		atMs: 70_300,
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

test("cycle reset zeroes every counter and preserves the live interval", () => {
	let state = createCollectionState();
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 0,
	});
	state = reduceCollectionState(state, {
		type: "main-snapshot",
		generation: state.accounting.generation,
		activeLoops: 1n,
		reminderLoops: 1n,
		atMs: 50,
	});
	state = reduceCollectionState(state, {
		type: "cycle-reset",
		atMs: 100,
	});

	let snapshot = snapshotCollectionState(state);
	assert.equal(snapshot.activeMs, 0n);
	assert.equal(snapshot.activeLoops, 0n);
	assert.equal(snapshot.taskMs, 0n);
	assert.equal(snapshot.rootLoops, 0n);
	assert.equal(snapshot.allLoops, 0n);
	assert.equal(snapshot.phase, "collecting");
	assert.equal(snapshot.liveContributors, 1);
	assert.equal(snapshot.busyContributors, 1);
	assert.equal(state.ledger.size, 0);

	state = reduceCollectionState(state, {
		type: "tick",
		atMs: 250,
	});
	snapshot = snapshotCollectionState(state);
	assert.equal(snapshot.activeMs, 150n);
	assert.equal(snapshot.taskMs, 150n);
	assert.equal(snapshot.activeLoops, 0n);
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

test("elapsed clocks preserve milliseconds across delayed refresh and idle edges", () => {
	let state = reduceCollectionState(createCollectionState(), {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 0,
	});
	assert.equal(snapshotCollectionState(state).activeMs, 0n);
	for (const atMs of [1_100, 3_200])
		state = reduceCollectionState(state, { type: "tick", atMs });
	assert.equal(snapshotCollectionState(state).activeMs, 3_200n);
	assert.equal(snapshotCollectionState(state).activeMs / 1_000n, 3n);
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: false,
		atMs: 3_250,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "child",
		busy: true,
		atMs: 8_250,
	});
	assert.equal(snapshotCollectionState(state).activeMs, 3_250n);
	assert.equal(snapshotCollectionState(state, 9_000).activeMs, 4_000n);
});

test("every elapsed settlement caps a long proof-of-life gap at one second", () => {
	const busy = synchronize(createCollectionState(), {
		atMs: 0,
		checkpoint: checkpoint({ busy: true }),
	});
	const events = [
		{ type: "tick", atMs: 300_000 },
		{
			type: "local-activity",
			contributorId: "root",
			busy: true,
			atMs: 300_000,
		},
		{
			type: "main-snapshot",
			generation: 0n,
			activeLoops: 1n,
			reminderLoops: 1n,
			atMs: 300_000,
		},
		{
			type: "peer-checkpoint-verified",
			contributorId,
			checkpoint: checkpoint({ seq: 2n, busy: true }),
			acceptedLoopDelta: { root: 0n, all: 0n },
			atMs: 300_000,
		},
		{
			type: "peer-synchronized",
			contributorId: "new-child",
			replayKey: "new-child/process",
			checkpoint: checkpoint({ busy: true }),
			acceptedLoopDelta: { root: 0n, all: 0n },
			atMs: 300_000,
		},
		{ type: "peer-offline", contributorId, atMs: 300_000 },
		{ type: "reminder-accepted", atMs: 300_000 },
	] satisfies Parameters<typeof reduceCollectionState>[1][];
	for (const event of events) {
		const settled = reduceCollectionState(busy, event);
		assert.equal(snapshotCollectionState(settled).activeMs, 1_000n, event.type);
		if (event.type !== "reminder-accepted")
			assert.equal(snapshotCollectionState(settled).taskMs, 1_000n, event.type);
	}
	assert.equal(snapshotCollectionState(busy, 300_000).activeMs, 1_000n);
	assert.equal(snapshotCollectionState(busy, 10_000).activeMs, 10_000n);
	assert.equal(snapshotCollectionState(busy, 10_001).activeMs, 1_000n);
	const reset = reduceCollectionState(busy, {
		type: "cycle-reset",
		atMs: 300_000,
	});
	assert.equal(snapshotCollectionState(reset, 300_250).activeMs, 250n);
});

test("union clock preserves fractional full time when reminder resets", () => {
	let state = reduceCollectionState(createCollectionState(), {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 0,
	});
	state = synchronize(state, {
		atMs: 750,
		checkpoint: checkpoint({ busy: true }),
	});
	state = reduceCollectionState(state, {
		type: "main-snapshot",
		generation: state.accounting.generation,
		activeLoops: 1n,
		reminderLoops: 1n,
		atMs: 1_100,
	});
	state = reduceCollectionState(state, {
		type: "reminder-accepted",
		atMs: 3_200,
	});
	const reminder = snapshotCollectionState(state);
	assert.equal(reminder.activeMs, 3_200n);
	assert.equal(reminder.activeLoops, 1n);
	assert.equal(reminder.taskMs, 0n);
	assert.equal(reminder.rootLoops, 0n);
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: false,
		atMs: 3_500,
	});
	assert.equal(snapshotCollectionState(state, 4_250).activeMs, 4_250n);
	assert.equal(snapshotCollectionState(state, 4_250).taskMs, 1_050n);
});

test("idle reset boundary holds even when no heartbeat expires grace", () => {
	let state = reduceCollectionState(createCollectionState(), {
		type: "local-activity",
		contributorId: "root",
		busy: true,
		atMs: 0,
	});
	state = reduceCollectionState(state, {
		type: "local-activity",
		contributorId: "root",
		busy: false,
		atMs: 200,
	});
	const resume = (atMs: number) =>
		reduceCollectionState(state, {
			type: "local-activity",
			contributorId: "root",
			busy: true,
			atMs,
		});
	assert.equal(snapshotCollectionState(resume(60_200)).activeMs, 200n);
	assert.equal(snapshotCollectionState(resume(60_201)).activeMs, 0n);
});

test("main replacement changes only main view; child full/reminder deltas separate; resets fence ledger before reentry", () => {
	let state = createCollectionState();
	state = reduceCollectionState(state, {
		type: "main-snapshot",
		generation: 0n,
		activeLoops: 3n,
		reminderLoops: 2n,
		atMs: 0,
	});
	state = reduceCollectionState(state, {
		type: "child-loops",
		generation: 0n,
		active: 4n,
		reminder: 1n,
		atMs: 0,
	});
	state = reduceCollectionState(state, {
		type: "main-snapshot",
		generation: 0n,
		activeLoops: 1n,
		reminderLoops: 1n,
		atMs: 0,
	});
	assert.equal(snapshotCollectionState(state).activeLoops, 5n);
	assert.equal(snapshotCollectionState(state).rootLoops, 1n);
	assert.equal(snapshotCollectionState(state).allLoops, 2n);
	state = synchronize(state, {
		atMs: 0,
		checkpoint: checkpoint({ busy: true, activeLoops: 2n, allLoops: 1n }),
	});
	state = reduceCollectionState(state, {
		type: "reminder-accepted",
		atMs: 100,
	});
	assert.equal(snapshotCollectionState(state).generation, 1n);
	assert.equal(snapshotCollectionState(state).activeLoops, 7n);
	assert.equal(snapshotCollectionState(state).allLoops, 0n);
	assert.equal(snapshotCollectionState(state).anyBusy, true);
	assert.equal(state.ledger.get(replayKey)?.allLoops, 0n);
	const stale = reduceCollectionState(state, {
		type: "peer-checkpoint-verified",
		contributorId,
		checkpoint: checkpoint({ seq: 2n, activeLoops: 99n, allLoops: 99n }),
		acceptedLoopDelta: { active: 97n, root: 0n, all: 98n },
		atMs: 100,
	});
	assert.equal(stale, state);
	state = reduceCollectionState(state, {
		type: "peer-checkpoint-verified",
		contributorId,
		checkpoint: checkpoint({
			generation: 1n,
			seq: 2n,
			busy: true,
			activeLoops: 3n,
			allLoops: 1n,
		}),
		acceptedLoopDelta: { active: 1n, root: 0n, all: 1n },
		atMs: 250,
	});
	assert.equal(snapshotCollectionState(state).activeLoops, 8n);
	assert.equal(snapshotCollectionState(state).allLoops, 1n);
	state = reduceCollectionState(state, { type: "cycle-reset", atMs: 300 });
	assert.equal(state.ledger.get(replayKey)?.activeLoops, 0n);
	assert.equal(snapshotCollectionState(state).generation, 2n);
	assert.equal(snapshotCollectionState(state).activeLoops, 0n);
	assert.equal(snapshotCollectionState(state).anyBusy, true);
});
