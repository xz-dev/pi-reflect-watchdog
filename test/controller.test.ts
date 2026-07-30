import assert from "node:assert/strict";
import test from "node:test";

import {
	controllerOptionsFromConfig,
	mergeConfig,
	TaskController,
} from "../src/index.js";

const limits = {
	mainLoopLimit: 2,
	observedTotalLoopLimit: 3,
	wallClockMinutes: 1,
};

test("has no phantom task and ignores observer activity until a root task begins", () => {
	const controller = new TaskController(limits);
	assert.equal(controller.status(0).epoch, 0);
	assert.equal(controller.bindObserver("child"), 0);
	assert.deepEqual(controller.completeObserverTurn("child", 0, 1).warnings, []);
	assert.equal(controller.status(1).observedChildLoops, 0);

	controller.startRootTask(2);
	assert.equal(controller.status(2).epoch, 1);
	assert.deepEqual(controller.completeObserverTurn("child", 0, 3).warnings, []);
});

test("captures simultaneous warnings then resets a cycle without dropping its observer", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	const observerEpoch = controller.bindObserver("child");

	assert.deepEqual(controller.completeRootTurn(1).warnings, []);
	const main = controller.completeRootTurn(2);
	assert.deepEqual(main.warnings, ["mainLoopLimitReached"]);
	assert.equal(main.triggerStatus?.mainLoops, 2);
	assert.equal(controller.status(2).mainLoops, 0);
	assert.equal(controller.status(2).observedChildSessions, 1);

	assert.deepEqual(
		controller.completeObserverTurn("child", observerEpoch, 3).warnings,
		[],
	);
	assert.deepEqual(controller.completeRootTurn(4).warnings, []);
	const simultaneous = controller.completeRootTurn(5);
	assert.deepEqual(simultaneous.warnings, [
		"mainLoopLimitReached",
		"observedTotalLoopLimitReached",
	]);
	assert.deepEqual(
		{
			mainLoops: simultaneous.triggerStatus?.mainLoops,
			observedChildLoops: simultaneous.triggerStatus?.observedChildLoops,
			observedTotalLoops: simultaneous.triggerStatus?.observedTotalLoops,
			observedChildSessions: simultaneous.triggerStatus?.observedChildSessions,
		},
		{
			mainLoops: 2,
			observedChildLoops: 1,
			observedTotalLoops: 3,
			observedChildSessions: 1,
		},
	);
	const status = controller.status(5);
	assert.equal(status.mainLoops, 0);
	assert.equal(status.observedChildLoops, 0);
	assert.equal(status.observedChildSessions, 1);
	assert.match(status.coverage, /observable/i);
	assert.deepEqual(status.latchedWarnings, []);
	assert.deepEqual(
		controller.completeObserverTurn("child", observerEpoch, 6).warnings,
		[],
		"the retained child binding participates in the fresh cycle",
	);
	assert.equal(controller.status(6).observedChildLoops, 1);
});

test("resets the warning cycle before the triggering root continuation", () => {
	const controller = new TaskController(limits);
	controller.startRootActiveSegment(0);
	controller.startRootTask(0);

	assert.deepEqual(controller.completeRootTurn(1).warnings, []);
	const warning = controller.completeRootTurn(2);
	assert.deepEqual(warning.warnings, ["mainLoopLimitReached"]);
	assert.deepEqual(
		{
			mainLoops: warning.triggerStatus?.mainLoops,
			observedTotalLoops: warning.triggerStatus?.observedTotalLoops,
		},
		{ mainLoops: 2, observedTotalLoops: 2 },
	);
	assert.deepEqual(
		{
			mainLoops: controller.status(2).mainLoops,
			observedTotalLoops: controller.status(2).observedTotalLoops,
			latchedWarnings: controller.status(2).latchedWarnings,
		},
		{ mainLoops: 0, observedTotalLoops: 0, latchedWarnings: [] },
	);

	assert.deepEqual(controller.completeRootTurn(3).warnings, []);
	assert.deepEqual(
		{
			mainLoops: controller.status(3).mainLoops,
			observedTotalLoops: controller.status(3).observedTotalLoops,
		},
		{ mainLoops: 1, observedTotalLoops: 1 },
	);
});

test("rejects stale observer turns after a new root epoch and counts a new binding", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	const epochA = controller.bindObserver("child");
	assert.deepEqual(
		controller.completeObserverTurn("child", epochA, 1).warnings,
		[],
	);

	controller.startRootTask(10);
	assert.deepEqual(
		controller.completeObserverTurn("child", epochA, 11).warnings,
		[],
	);
	const epochB = controller.bindObserver("child");
	controller.completeObserverTurn("child", epochB, 12);

	assert.equal(controller.status(12).observedChildLoops, 1);
	assert.equal(controller.status(12).observedChildSessions, 1);
});

test("duplicate root starts do not restart a current root wall-clock segment", () => {
	const controller = new TaskController({ ...limits, wallClockMinutes: 1 });
	controller.startRootActiveSegment(0);
	controller.startRootTask(0);
	controller.startRootActiveSegment(10_000);

	assert.equal(controller.status(60_000).wallClockElapsedMs, 60_000);
	const warning = controller.evaluateWallClock(60_000);
	assert.deepEqual(warning.warnings, ["wallClockLimitReached"]);
	assert.equal(warning.triggerStatus?.wallClockElapsedMs, 60_000);
});

test("root wall-clock accumulates root segments across a child-only gap", () => {
	const controller = new TaskController({ ...limits, wallClockMinutes: 1 });
	controller.startRootActiveSegment(0);
	controller.startRootTask(0);
	const childEpoch = controller.bindObserver("child");
	controller.startObserverRun("child", 1);
	controller.settleRootActiveSegment(40_000);

	assert.equal(controller.status(100_000).wallClockElapsedMs, 40_000);
	controller.startRootActiveSegment(100_000);
	assert.equal(controller.status(120_000).wallClockElapsedMs, 60_000);
	const warning = controller.evaluateWallClock(120_000);
	assert.deepEqual(warning.warnings, ["wallClockLimitReached"]);
	assert.equal(warning.triggerStatus?.wallClockElapsedMs, 60_000);
	assert.equal(controller.status(120_000).wallClockElapsedMs, 0);
	assert.equal(controller.status(120_000).activity.active, true);
	assert.equal(controller.settleRootActiveSegment(120_000), undefined);
	assert.equal(controller.status(180_000).wallClockElapsedMs, 0);
	assert.equal(
		controller.settleRootActiveSegment(180_000),
		undefined,
		"a duplicate root settle cannot add another segment",
	);
	assert.equal(controller.status(180_000).wallClockElapsedMs, 0);
	assert.deepEqual(controller.settleObserverRun("child", childEpoch, 180_000), {
		elapsedMs: 180_000,
		loops: 0,
	});
	assert.equal(
		controller.settleObserverRun("child", childEpoch, 180_000),
		undefined,
	);
	assert.deepEqual(controller.status(180_000).activity, {
		active: false,
		elapsedMs: 0,
		loops: 0,
	});
});

test("bound running children keep activity open while root wall-clock freezes", () => {
	const controller = new TaskController({ ...limits, wallClockMinutes: 1 });
	controller.startRootActiveSegment(0);
	controller.startRootTask(0);
	const childEpoch = controller.bindObserver("child");
	controller.startObserverRun("child", 1_000);
	assert.equal(controller.settleRootActiveSegment(2_000), undefined);

	const whileChildRuns = controller.status(5_000);
	assert.deepEqual(whileChildRuns.activity, {
		active: true,
		elapsedMs: 5_000,
		loops: 0,
	});
	assert.equal(whileChildRuns.rootActive, false);
	assert.equal(whileChildRuns.wallClockElapsedMs, 2_000);
	assert.deepEqual(controller.evaluateWallClock(5_000).warnings, []);
	assert.deepEqual(controller.settleObserverRun("child", childEpoch, 6_000), {
		elapsedMs: 6_000,
		loops: 0,
	});
	assert.deepEqual(controller.status(6_000).activity, {
		active: false,
		elapsedMs: 0,
		loops: 0,
	});
});

test("old-epoch child starts and settles are inert after a new root task", () => {
	const controller = new TaskController(limits);
	controller.startRootActiveSegment(0);
	controller.startRootTask(0);
	const oldEpoch = controller.bindObserver("child");
	controller.startObserverRun("child", 1);
	assert.equal(controller.settleRootActiveSegment(2), undefined);

	controller.startRootTask(3);
	controller.startObserverRun("child", 4);
	assert.equal(controller.status(4).activity.active, false);
	assert.equal(controller.settleObserverRun("child", oldEpoch, 5), undefined);
	assert.equal(controller.status(5).activity.active, false);
});

test("an observer must bind before its start can participate", () => {
	const controller = new TaskController(limits);
	controller.startRootActiveSegment(0);
	controller.startRootTask(0);
	controller.startObserverRun("child", 1);
	assert.deepEqual(controller.settleRootActiveSegment(2), {
		elapsedMs: 2,
		loops: 0,
	});
	assert.equal(controller.status(3).activity.active, false);

	const epoch = controller.bindObserver("child");
	controller.startObserverRun("child", 4);
	assert.equal(controller.status(5).activity.active, true);
	assert.deepEqual(controller.settleObserverRun("child", epoch, 6), {
		elapsedMs: 2,
		loops: 0,
	});
});

test("warning reset restores configured runtime defaults while manual reset retains overrides", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	controller.setLimits({ mainLoopLimit: 1 }, 0);
	controller.setPromptOverride(
		"mainLoopLimitReached",
		"Temporary {{mainLoops}}",
	);
	controller.startRootActiveSegment(10);
	const warning = controller.completeRootTurn(11);
	assert.deepEqual(warning.warnings, ["mainLoopLimitReached"]);
	const triggerStatus = warning.triggerStatus;
	assert.equal(triggerStatus?.mainLoops, 1);
	assert.equal(triggerStatus?.observedTotalLoops, 1);
	assert.deepEqual(triggerStatus?.limits, { ...limits, mainLoopLimit: 1 });
	assert.equal(
		triggerStatus?.prompts.mainLoopLimitReached,
		"Temporary {{mainLoops}}",
	);
	assert.deepEqual(triggerStatus?.latchedWarnings, ["mainLoopLimitReached"]);
	assert.deepEqual(triggerStatus?.activity, {
		active: true,
		elapsedMs: 1,
		loops: 1,
	});

	const afterWarning = controller.status(13);
	assert.equal(afterWarning.mainLoops, 0);
	assert.deepEqual(afterWarning.limits, limits);
	assert.notEqual(
		afterWarning.prompts.mainLoopLimitReached,
		"Temporary {{mainLoops}}",
	);
	assert.equal(afterWarning.wallClockElapsedMs, 2);
	assert.deepEqual(afterWarning.latchedWarnings, []);
	assert.deepEqual(
		triggerStatus?.limits,
		{ ...limits, mainLoopLimit: 1 },
		"reset does not mutate captured nested limits",
	);
	assert.equal(
		triggerStatus?.prompts.mainLoopLimitReached,
		"Temporary {{mainLoops}}",
		"reset does not mutate the captured prompt rendered in the warning",
	);

	controller.setLimits({ mainLoopLimit: 8 }, 14);
	controller.setPromptOverride("mainLoopLimitReached", "Manual {{mainLoops}}");
	controller.resetRuntime(20);
	const afterManualReset = controller.status(21);
	assert.equal(afterManualReset.limits.mainLoopLimit, 8);
	assert.equal(
		afterManualReset.prompts.mainLoopLimitReached,
		"Manual {{mainLoops}}",
	);
	assert.equal(afterManualReset.wallClockElapsedMs, 1);
});

test("resets wall-clock timing only after an active root threshold", () => {
	const controller = new TaskController({ ...limits, wallClockMinutes: 1 });
	controller.startRootTask(0);
	controller.startRootActiveSegment(10);
	assert.deepEqual(controller.evaluateWallClock(60_009).warnings, []);
	const warning = controller.evaluateWallClock(60_010);
	assert.deepEqual(warning.warnings, ["wallClockLimitReached"]);
	assert.equal(warning.triggerStatus?.wallClockElapsedMs, 60_000);
	assert.equal(controller.status(60_010).wallClockElapsedMs, 0);
	controller.settleRootActiveSegment(60_020);
	assert.equal(controller.status(200_000).wallClockElapsedMs, 10);
	assert.deepEqual(controller.evaluateWallClock(200_000).warnings, []);
});

test("evaluates updated limits at exact fresh-cycle boundaries", () => {
	const controller = new TaskController({
		mainLoopLimit: 2,
		observedTotalLoopLimit: 2,
		wallClockMinutes: 1,
	});
	controller.startRootTask(0);
	controller.startRootActiveSegment(0);
	controller.completeRootTurn(1);
	assert.deepEqual(controller.completeRootTurn(2).warnings, [
		"mainLoopLimitReached",
		"observedTotalLoopLimitReached",
	]);
	assert.equal(controller.status(2).mainLoops, 0);

	assert.deepEqual(
		controller.setLimits(
			{
				mainLoopLimit: 3,
				observedTotalLoopLimit: 3,
				wallClockMinutes: 2,
			},
			3,
		).warnings,
		[],
	);
	controller.completeRootTurn(4);
	controller.completeRootTurn(5);
	assert.deepEqual(controller.completeRootTurn(6).warnings, [
		"mainLoopLimitReached",
		"observedTotalLoopLimitReached",
	]);
	assert.equal(controller.status(6).mainLoops, 0);

	controller.setLimits(
		{ mainLoopLimit: 2, observedTotalLoopLimit: 2, wallClockMinutes: 1 },
		7,
	);
	const wallClock = controller.evaluateWallClock(60_007);
	assert.deepEqual(wallClock.warnings, ["wallClockLimitReached"]);
	assert.equal(wallClock.triggerStatus?.wallClockElapsedMs, 60_001);
});

test("restores configured defaults for the next warning cycle", () => {
	const controller = new TaskController({
		mainLoopLimit: 2,
		observedTotalLoopLimit: 3,
		wallClockMinutes: 1,
	});
	controller.startRootTask(0);
	controller.startRootActiveSegment(0);
	controller.completeRootTurn(1);
	assert.deepEqual(controller.completeRootTurn(2).warnings, [
		"mainLoopLimitReached",
	]);

	assert.deepEqual(
		controller.setLimits(
			{
				mainLoopLimit: 3,
				observedTotalLoopLimit: 4,
				wallClockMinutes: 2,
			},
			3,
		).warnings,
		[],
	);
	assert.deepEqual(controller.restoreConfiguredDefaults(4).warnings, []);
	const restored = controller.status(4);
	assert.deepEqual(restored.limits, {
		mainLoopLimit: 2,
		observedTotalLoopLimit: 3,
		wallClockMinutes: 1,
	});
	controller.completeRootTurn(5);
	const nextCycle = controller.completeRootTurn(6);
	assert.deepEqual(nextCycle.warnings, ["mainLoopLimitReached"]);
	assert.equal(nextCycle.triggerStatus?.mainLoops, 2);
});

test("maps all approved config fields into controller options without legacy aliases", () => {
	const { config } = mergeConfig({
		mainLoopLimit: 2,
		observedTotalLoopLimit: 3,
		wallClockMinutes: 1,
		observableLoopLimit: 99,
		wallClockMs: 99,
		prompts: {
			mainLoopLimitReached: "Configured main {{mainLoops}}",
			observedTotalLoopLimitReached: "Configured total {{observedTotalLoops}}",
			wallClockLimitReached: "Configured time {{elapsed}}",
			main: "Legacy main",
			total: "Legacy total",
			time: "Legacy time",
		},
	});
	const controller = new TaskController(controllerOptionsFromConfig(config));
	controller.startRootTask(0);
	controller.startRootActiveSegment(0);
	const status = controller.status(0);
	assert.deepEqual(status.limits, {
		mainLoopLimit: 2,
		observedTotalLoopLimit: 3,
		wallClockMinutes: 1,
	});
	assert.deepEqual(status.prompts, {
		mainLoopLimitReached: "Configured main {{mainLoops}}",
		observedTotalLoopLimitReached: "Configured total {{observedTotalLoops}}",
		wallClockLimitReached: "Configured time {{elapsed}}",
	});
	assert.deepEqual(controller.evaluateWallClock(59_999).warnings, []);
	const warning = controller.evaluateWallClock(60_000);
	assert.deepEqual(warning.warnings, ["wallClockLimitReached"]);
	assert.equal(warning.triggerStatus?.wallClockElapsedMs, 60_000);
	assert.equal(controller.status(60_000).wallClockElapsedMs, 0);
});

test("a new root task clears temporary prompt overrides and restores configured defaults", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	controller.setLimits({ mainLoopLimit: 8 }, 1);
	controller.setPromptOverride("observedTotalLoopLimitReached", "Temporary");
	controller.startRootTask(2);

	const status = controller.status(2);
	assert.equal(status.limits.mainLoopLimit, 2);
	assert.notEqual(status.prompts.observedTotalLoopLimitReached, "Temporary");
});
