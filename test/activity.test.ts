import assert from "node:assert/strict";
import test from "node:test";

import { RootActivityTracker } from "../src/activity.js";

test("idle status is zero and no reset is emitted", () => {
	const tracker = new RootActivityTracker();
	assert.deepEqual(tracker.status(500), {
		active: false,
		elapsedMs: 0,
		loops: 0,
	});
	assert.equal(tracker.settle(500), undefined);
	assert.equal(tracker.startRootTask(500), undefined);
});

test("agent_start alone stays idle until the first root user message", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(100);
	assert.deepEqual(tracker.status(400), {
		active: false,
		elapsedMs: 0,
		loops: 0,
	});
});

test("root user message starts the window at zero; turns pair time with loops", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(100);
	assert.equal(tracker.startRootTask(200), undefined);
	tracker.completeRootTurn();
	tracker.completeRootTurn();
	assert.deepEqual(tracker.status(3_700), {
		active: true,
		elapsedMs: 3_500,
		loops: 2,
	});
});

test("settle snapshots the finished window and the next task starts from zero", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(0);
	tracker.startRootTask(100);
	tracker.completeRootTurn();
	assert.deepEqual(tracker.settle(1_600), {
		elapsedMs: 1_500,
		loops: 1,
	});
	assert.deepEqual(tracker.status(5_000), {
		active: false,
		elapsedMs: 0,
		loops: 0,
	});
	// A duplicate settle finds no begun window and emits nothing.
	assert.equal(tracker.settle(6_000), undefined);
	tracker.beginRun(7_000);
	assert.equal(tracker.startRootTask(7_200), undefined);
	assert.deepEqual(tracker.status(7_900), {
		active: true,
		elapsedMs: 700,
		loops: 0,
	});
});

test("idle gaps never accrue active time", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(0);
	tracker.startRootTask(0);
	tracker.completeRootTurn();
	assert.deepEqual(tracker.settle(1_000), { elapsedMs: 1_000, loops: 1 });
	// Long idle gap with no events: the next window still starts at zero.
	tracker.beginRun(60_000);
	tracker.startRootTask(61_000);
	tracker.completeRootTurn();
	assert.deepEqual(tracker.settle(62_500), {
		elapsedMs: 1_500,
		loops: 1,
	});
});

test("interjecting root user message snapshots the old window exactly once", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(0);
	tracker.startRootTask(0);
	tracker.completeRootTurn();
	tracker.completeRootTurn();
	assert.deepEqual(tracker.startRootTask(4_000), {
		elapsedMs: 4_000,
		loops: 2,
	});
	// The replacement window continues from zero.
	tracker.completeRootTurn();
	assert.deepEqual(tracker.status(6_300), {
		active: true,
		elapsedMs: 2_300,
		loops: 1,
	});
	// The later settle snapshots only the replacement window, never the old one twice.
	assert.deepEqual(tracker.settle(8_000), { elapsedMs: 4_000, loops: 1 });
});

test("interjection during an idle gap emits nothing and the next run starts clean", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(0);
	tracker.startRootTask(0);
	assert.deepEqual(tracker.settle(1_000), { elapsedMs: 1_000, loops: 0 });
	assert.equal(tracker.startRootTask(5_000), undefined);
	tracker.beginRun(6_000);
	assert.deepEqual(tracker.status(9_000), {
		active: true,
		elapsedMs: 3_000,
		loops: 0,
	});
});

test("finalize clears everything without emitting", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(0);
	tracker.startRootTask(0);
	tracker.completeRootTurn();
	tracker.finalize();
	assert.deepEqual(tracker.status(1_000), {
		active: false,
		elapsedMs: 0,
		loops: 0,
	});
	assert.equal(tracker.settle(2_000), undefined);
});

test("negative clock skew clamps to zero", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(100);
	tracker.startRootTask(200);
	assert.deepEqual(tracker.status(50), {
		active: true,
		elapsedMs: 0,
		loops: 0,
	});
	assert.deepEqual(tracker.settle(150), { elapsedMs: 0, loops: 0 });
});
