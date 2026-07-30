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

test("latches threshold crossings and reports observable coverage and session count", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	const observerEpoch = controller.bindObserver("child");

	assert.deepEqual(controller.completeRootTurn(1).warnings, []);
	assert.deepEqual(controller.completeRootTurn(2).warnings, [
		"mainLoopLimitReached",
	]);
	assert.deepEqual(
		controller.completeObserverTurn("child", observerEpoch, 3).warnings,
		["observedTotalLoopLimitReached"],
	);
	assert.deepEqual(controller.completeRootTurn(4).warnings, []);

	const status = controller.status(4);
	assert.equal(status.mainLoops, 3);
	assert.equal(status.observedChildLoops, 1);
	assert.equal(status.observedTotalLoops, 4);
	assert.equal(status.observedChildSessions, 1);
	assert.match(status.coverage, /observable/i);
	assert.deepEqual(status.latchedWarnings, [
		"mainLoopLimitReached",
		"observedTotalLoopLimitReached",
	]);
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

test("runtime reset retains limits and prompts but clears latches and restarts active wall time", () => {
	const controller = new TaskController(limits);
	controller.startRootTask(0);
	controller.setPromptOverride(
		"mainLoopLimitReached",
		"Temporary {{mainLoops}}",
	);
	controller.startRootActiveSegment(10);
	controller.completeRootTurn(11);
	controller.completeRootTurn(12);
	controller.resetRuntime(20);

	const status = controller.status(21);
	assert.equal(status.mainLoops, 0);
	assert.equal(status.limits.mainLoopLimit, 2);
	assert.equal(status.prompts.mainLoopLimitReached, "Temporary {{mainLoops}}");
	assert.equal(status.wallClockElapsedMs, 1);
	assert.deepEqual(status.latchedWarnings, []);
});

test("evaluates wall-clock only while root remains active and settles it", () => {
	const controller = new TaskController({ ...limits, wallClockMinutes: 1 });
	controller.startRootTask(0);
	controller.startRootActiveSegment(10);
	assert.deepEqual(controller.evaluateWallClock(60_009).warnings, []);
	assert.deepEqual(controller.evaluateWallClock(60_010).warnings, [
		"wallClockLimitReached",
	]);
	controller.settleRootActiveSegment(60_020);
	assert.equal(controller.status(200_000).wallClockElapsedMs, 60_010);
	assert.deepEqual(controller.evaluateWallClock(200_000).warnings, []);
});

test("rearms a warning only after its current value falls below a new limit, then evaluates exact boundaries", () => {
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
	assert.deepEqual(controller.evaluateWallClock(60_000).warnings, [
		"wallClockLimitReached",
	]);

	assert.deepEqual(
		controller.setLimits(
			{
				mainLoopLimit: 3,
				observedTotalLoopLimit: 3,
				wallClockMinutes: 2,
			},
			60_000,
		).warnings,
		[],
	);
	assert.deepEqual(
		controller.setLimits(
			{
				mainLoopLimit: 2,
				observedTotalLoopLimit: 2,
				wallClockMinutes: 1,
			},
			60_000,
		).warnings,
		[
			"mainLoopLimitReached",
			"observedTotalLoopLimitReached",
			"wallClockLimitReached",
		],
	);
});

test("restoring defaults rearms every warning above current values and warns at restored boundaries", () => {
	const controller = new TaskController({
		mainLoopLimit: 2,
		observedTotalLoopLimit: 3,
		wallClockMinutes: 1,
	});
	controller.startRootTask(0);
	controller.startRootActiveSegment(0);
	const observerEpoch = controller.bindObserver("child");
	controller.completeRootTurn(1);
	assert.deepEqual(controller.completeRootTurn(2).warnings, [
		"mainLoopLimitReached",
	]);
	assert.deepEqual(
		controller.completeObserverTurn("child", observerEpoch, 3).warnings,
		["observedTotalLoopLimitReached"],
	);
	assert.deepEqual(controller.evaluateWallClock(60_000).warnings, [
		"wallClockLimitReached",
	]);

	assert.deepEqual(
		controller.setLimits(
			{
				mainLoopLimit: 3,
				observedTotalLoopLimit: 4,
				wallClockMinutes: 2,
			},
			60_000,
		).warnings,
		[],
	);
	assert.deepEqual(controller.status(60_000).latchedWarnings, []);

	assert.deepEqual(controller.restoreConfiguredDefaults(60_000).warnings, [
		"mainLoopLimitReached",
		"observedTotalLoopLimitReached",
		"wallClockLimitReached",
	]);
	const status = controller.status(60_000);
	assert.equal(status.mainLoops, 2);
	assert.equal(status.observedTotalLoops, 3);
	assert.equal(status.wallClockElapsedMs, 60_000);
	assert.deepEqual(status.limits, {
		mainLoopLimit: 2,
		observedTotalLoopLimit: 3,
		wallClockMinutes: 1,
	});
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
	const observerEpoch = controller.bindObserver("child");
	controller.completeRootTurn(1);
	controller.completeRootTurn(2);
	controller.completeObserverTurn("child", observerEpoch, 3);

	const status = controller.status(60_000);
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
	assert.deepEqual(controller.evaluateWallClock(60_000).warnings, [
		"wallClockLimitReached",
	]);
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
