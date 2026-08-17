import assert from "node:assert/strict";
import test from "node:test";
import { TaskController } from "../src/index.js";

const limits = {
	mainLoopLimit: 2,
	observedTotalLoopLimit: 3,
	wallClockMinutes: 1,
};

test("root and domain loop thresholds combine and reset before continuation", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	const child = controller.bindObserver("child");
	assert.deepEqual(controller.completeRootTurn(1).warnings, []);
	assert.deepEqual(
		controller.completeObserverTurn("child", child, 2).warnings,
		[],
	);
	const warning = controller.completeRootTurn(3);
	assert.deepEqual(warning.warnings, ["ROOT_LOOP_LIMIT", "DOMAIN_LOOP_LIMIT"]);
	assert.equal(warning.triggerStatus?.mainLoops, 2);
	assert.equal(controller.status(3).mainLoops, 0);
	assert.equal(controller.status(3).observedChildSessions, 1);
	assert.deepEqual(controller.completeRootTurn(4).warnings, []);
});

test("domain threshold includes root and observer loops", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	const child = controller.bindObserver("child");
	controller.completeRootTurn(1);
	controller.completeObserverTurn("child", child, 2);
	const warning = controller.completeObserverTurn("child", child, 3);
	assert.deepEqual(warning.warnings, ["DOMAIN_LOOP_LIMIT"]);
	assert.equal(warning.triggerStatus?.observedTotalLoops, 3);
	assert.equal(controller.status(3).observedTotalLoops, 0);
});

test("continuous domain active time uses root-only time and resets after warning", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	controller.startRootActiveSegment(0);
	assert.deepEqual(controller.evaluateWallClock(59_999).warnings, []);
	const warning = controller.evaluateWallClock(60_000);
	assert.deepEqual(warning.warnings, ["CONTINUOUS_DOMAIN_ACTIVE_TIME"]);
	assert.equal(warning.triggerStatus?.wallClockElapsedMs, 60_000);
	assert.equal(controller.status(60_000).wallClockElapsedMs, 0);
});

test("observer epochs are rejected after a new root task", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	const oldEpoch = controller.bindObserver("child");
	controller.startRootTask(1);
	assert.deepEqual(
		controller.completeObserverTurn("child", oldEpoch, 2).warnings,
		[],
	);
	const current = controller.bindObserver("child");
	controller.completeObserverTurn("child", current, 3);
	assert.equal(controller.status(3).observedChildLoops, 1);
});

test("manual reset retains runtime limits while threshold reset restores configured limits", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	controller.setLimits({ mainLoopLimit: 8 }, 0);
	controller.resetRuntime(1);
	assert.equal(controller.status(1).limits.mainLoopLimit, 8);
	controller.setLimits({ mainLoopLimit: 1 }, 2);
	controller.startRootActiveSegment(2);
	const warning = controller.completeRootTurn(3);
	assert.deepEqual(warning.warnings, ["ROOT_LOOP_LIMIT"]);
	assert.deepEqual(controller.status(3).limits, limits);
});
