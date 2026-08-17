import assert from "node:assert/strict";
import test from "node:test";
import {
	formatHistoryResult,
	queryReflectionHistory,
	reflectionHistory,
} from "../src/index.js";

const entry = (n: number) => ({
	version: 1 as const,
	timestamp: `2026-08-16T13:0${n}:00.000Z`,
	reasons: ["USER_REQUEST" as const],
	thresholds: {
		rootLoops: n,
		rootLoopLimit: 100,
		domainLoops: n,
		domainLoopLimit: 500,
		continuousDomainActiveMs: 0,
		continuousDomainActiveMinutes: 30,
	},
	decision: {
		type: "NO_ISSUE" as const,
		reason: "r",
		done: "d",
		currentStep: "c",
		nextStep: "n",
	},
	report: `report ${n}`,
});

test("history selectors are mutually exclusive and use current branch ordinals", () => {
	const history = [entry(1), entry(2), entry(3)];
	assert.equal(
		queryReflectionHistory(history, { latest: true })[0]?.report,
		"report 3",
	);
	assert.equal(
		queryReflectionHistory(history, { index: 2 })[0]?.report,
		"report 2",
	);
	assert.equal(
		queryReflectionHistory(history, { range: { start: 2, end: 3 } }).length,
		2,
	);
	assert.match(formatHistoryResult(history.slice(1), 2), /#2/);
	assert.throws(() => queryReflectionHistory(history, { index: 0 }));
	assert.throws(() =>
		queryReflectionHistory(history, { range: { start: 3, end: 2 } }),
	);
});

test("history ignores unrelated and malformed branch entries", () => {
	const branch = [
		{ type: "custom", customType: "other", data: entry(1) },
		{
			type: "custom",
			customType: "pi-reflect-watchdog:reflection",
			data: entry(2),
		},
		{
			type: "custom",
			customType: "pi-reflect-watchdog:reflection",
			data: { bad: true },
		},
	];
	assert.equal(
		reflectionHistory({ getBranch: () => branch } as never).length,
		1,
	);
});
