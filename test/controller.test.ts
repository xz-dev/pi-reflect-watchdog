import assert from "node:assert/strict";
import test from "node:test";
import { TaskController } from "../src/index.js";

const limits = {
	rootLoopLimit: 2,
	allLoopLimit: 3,
	taskMinutes: 1,
	idleResetGapSeconds: 60,
};

test("root and all loop thresholds combine and reset task/root/all before continuation", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	controller.startRootActiveSegment(0);
	const child = controller.bindObserver("child");
	assert.deepEqual(controller.completeRootTurn(1).warnings, []);
	assert.deepEqual(
		controller.completeObserverTurn("child", child, 2).warnings,
		[],
	);
	const warning = controller.completeRootTurn(3);
	assert.deepEqual(warning.warnings, ["ROOT_LOOP_LIMIT", "ALL_LOOP_LIMIT"]);
	assert.equal(warning.triggerStatus?.rootLoops, 2);
	assert.equal(controller.status(3).rootLoops, 0);
	assert.equal(controller.status(3).allLoops, 0);
	assert.equal(controller.status(3).activity.loops, 3);
	assert.equal(controller.status(3).observableAgentSessions, 1);
	assert.deepEqual(controller.completeRootTurn(4).warnings, []);
});

test("all threshold includes root and observer loops", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	controller.startRootActiveSegment(0);
	const child = controller.bindObserver("child");
	controller.completeRootTurn(1);
	controller.completeObserverTurn("child", child, 2);
	const warning = controller.completeObserverTurn("child", child, 3);
	assert.deepEqual(warning.warnings, ["ALL_LOOP_LIMIT"]);
	assert.equal(warning.triggerStatus?.allLoops, 3);
	assert.equal(controller.status(3).allLoops, 0);
	assert.equal(controller.status(3).activity.loops, 3);
});

test("task time uses aggregate active time and resets after warning", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	controller.startRootActiveSegment(0);
	assert.deepEqual(controller.evaluateTaskTime(59_999).warnings, []);
	const warning = controller.evaluateTaskTime(60_000);
	assert.deepEqual(warning.warnings, ["TASK_TIME_LIMIT"]);
	assert.equal(warning.triggerStatus?.taskElapsedMs, 60_000);
	assert.equal(controller.status(60_000).taskElapsedMs, 0);
	assert.equal(controller.status(60_000).activity.elapsedMs, 60_000);
});

test("active cycle freezes at all-idle, resumes at the exact gap, and resets only after it", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	controller.startRootActiveSegment(1_000);
	controller.completeRootTurn(2_000);
	controller.settleRootActiveSegment(11_000);
	assert.equal(controller.status(70_999).activity.active, false);
	assert.equal(controller.status(70_999).activity.elapsedMs, 10_000);
	assert.equal(controller.status(70_999).activity.loops, 1);

	controller.startRootActiveSegment(71_000);
	controller.settleRootActiveSegment(72_000);
	assert.equal(controller.status(72_000).activity.elapsedMs, 11_000);
	assert.equal(controller.status(72_000).activity.loops, 1);

	controller.startRootActiveSegment(132_001);
	assert.equal(controller.status(132_001).activity.elapsedMs, 0);
	assert.equal(controller.status(132_001).activity.loops, 0);
	assert.equal(controller.status(132_001).rootLoops, 0);
	assert.equal(controller.status(132_001).taskElapsedMs, 0);
});

test("pause while idle excludes paused time from the reset gap", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	controller.startRootActiveSegment(0);
	controller.completeRootTurn(1_000);
	controller.settleRootActiveSegment(10_000);

	controller.pauseActivity(40_000);
	controller.resumeActivity(140_000, true);
	assert.equal(controller.status(140_000).rootLoops, 1);
	assert.equal(controller.status(140_000).activity.loops, 1);

	controller.settleRootActiveSegment(150_000);
	controller.startRootActiveSegment(150_000);
	controller.settleRootActiveSegment(150_000);
	controller.pauseActivity(210_002);
	controller.resumeActivity(310_002, true);
	assert.equal(controller.status(310_001).rootLoops, 0);
	assert.equal(controller.status(340_001).activity.loops, 0);
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
	assert.equal(controller.status(3).otherAgentLoops, 1);
});

test("manual reset preserves active and runtime limits while threshold reset restores configured limits", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	controller.startRootActiveSegment(0);
	controller.completeRootTurn(1_000);
	controller.setLimits({ rootLoopLimit: 8 }, 1_000);
	controller.resetReminderCycle(2_000);
	assert.equal(controller.status(2_000).limits.rootLoopLimit, 8);
	assert.equal(controller.status(2_000).activity.loops, 1);
	controller.setLimits({ rootLoopLimit: 1 }, 2_000);
	const warning = controller.completeRootTurn(3_000);
	assert.deepEqual(warning.warnings, ["ROOT_LOOP_LIMIT"]);
	assert.deepEqual(controller.status(3_000).limits, limits);
	assert.equal(controller.status(3_000).activity.loops, 2);
});
