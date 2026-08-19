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

test("root user message starts active time at zero and pairs it with loops", () => {
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

test("settle freezes active state and an exact idle gap resumes it", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(0);
	tracker.startRootTask(100);
	tracker.completeRootTurn();
	assert.deepEqual(tracker.settle(1_600), {
		elapsedMs: 1_500,
		loops: 1,
	});
	assert.deepEqual(tracker.status(61_599), {
		active: false,
		elapsedMs: 1_500,
		loops: 1,
	});
	tracker.startRootTask(61_600);
	tracker.beginRun(61_600);
	tracker.completeRootTurn();
	assert.deepEqual(tracker.settle(62_100), {
		elapsedMs: 2_000,
		loops: 2,
	});
});

test("only a strictly longer idle gap starts a fresh active cycle", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(0);
	tracker.startRootTask(0);
	tracker.completeRootTurn();
	assert.deepEqual(tracker.settle(1_000), { elapsedMs: 1_000, loops: 1 });
	tracker.startRootTask(61_001);
	tracker.beginRun(61_001);
	tracker.completeRootTurn();
	assert.deepEqual(tracker.status(62_500), {
		active: true,
		elapsedMs: 1_499,
		loops: 1,
	});
});

test("interjecting root user message continues the active cycle", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(0);
	tracker.startRootTask(0);
	tracker.completeRootTurn();
	tracker.completeRootTurn();
	assert.equal(tracker.startRootTask(4_000), undefined);
	tracker.completeRootTurn();
	assert.deepEqual(tracker.status(6_300), {
		active: true,
		elapsedMs: 6_300,
		loops: 3,
	});
	assert.deepEqual(tracker.settle(8_000), { elapsedMs: 8_000, loops: 3 });
});

test("interjection during an idle gap arms the next run without losing the cycle", () => {
	const tracker = new RootActivityTracker();
	tracker.beginRun(0);
	tracker.startRootTask(0);
	assert.deepEqual(tracker.settle(1_000), { elapsedMs: 1_000, loops: 0 });
	assert.equal(tracker.startRootTask(5_000), undefined);
	tracker.beginRun(6_000);
	assert.deepEqual(tracker.status(9_000), {
		active: true,
		elapsedMs: 4_000,
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
