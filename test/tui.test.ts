import assert from "node:assert/strict";
import test from "node:test";
import { boundedTimelineText } from "../src/reflection-timeline.js";
import { formatWidgetText } from "../src/widget.js";

test("widget keeps one stable compact line", () => {
	const text = formatWidgetText({
		activity: { active: true, elapsedMs: 134_000, loops: 7 },
		taskElapsedMs: 12_000,
		taskMinutes: 30,
		rootLoops: 2,
		rootLoopLimit: 100,
		allLoops: 3,
		allLoopLimit: 500,
	});
	assert.match(text, /Reflect Watchdog \| active 2m14s\/7 loops/);
});

test("timeline fallback is bounded", () => {
	const entry = {
		version: 1 as const,
		timestamp: "2026-08-16T13:00:00Z",
		reasons: ["USER_REQUEST" as const],
		thresholds: {
			activeMs: 0,
			activeLoops: 1,
			taskMs: 0,
			taskMinutes: 30,
			rootLoops: 1,
			rootLoopLimit: 2,
			allLoops: 1,
			allLoopLimit: 3,
		},
		decision: {
			type: "NO_ISSUE" as const,
			reason: "r",
			done: "d",
			currentStep: "c",
			nextStep: "n",
		},
		report: "report",
	};
	assert.match(boundedTimelineText([entry]), /#1\nreport/);
});
