import assert from "node:assert/strict";
import test from "node:test";
import {
	buildReflectionPrompt,
	buildReflectionReaskPrompt,
	DEFAULT_REFLECTION_PROMPT,
	MAX_REFLECTION_TEXT_CHARACTERS,
	parseReflectionArguments,
} from "../src/index.js";

test("default perspective questions interpretation across contextual exchanges", () => {
	assert.match(DEFAULT_REFLECTION_PROMPT, /third-party perspective/);
	assert.match(
		DEFAULT_REFLECTION_PROMPT,
		/working agent.*interpreted the task/,
	);
	assert.match(
		DEFAULT_REFLECTION_PROMPT,
		/surrounding replies and later clarifications/,
	);
	assert.match(DEFAULT_REFLECTION_PROMPT, /question the goal itself/);
	assert.match(
		DEFAULT_REFLECTION_PROMPT,
		/distinguish that new interpretation from what the user actually expressed/,
	);
});

test("reflection arguments preserve text and require exactly five non-empty fields", () => {
	const valid = {
		type: "ROUTE_CORRECTION",
		reason: "a & b <notes>",
		done: "done",
		current_step: "now",
		next_step: "next",
	};
	assert.deepEqual(parseReflectionArguments(valid), {
		valid: true,
		decision: {
			type: "ROUTE_CORRECTION",
			reason: "a & b <notes>",
			done: "done",
			currentStep: "now",
			nextStep: "next",
		},
	});
	assert.deepEqual(
		parseReflectionArguments({
			TYPE: "route_correction",
			Reason: "a & b <notes>",
			DONE: "done",
			CURRENT_STEP: "now",
			NEXT_STEP: "next",
		}),
		parseReflectionArguments(valid),
	);
	for (const invalid of [
		null,
		[],
		"<reflection>not a function call</reflection>",
		{},
		{ ...valid, reason: " " },
		{ ...valid, reason: 42 },
		{ ...valid, type: "UNKNOWN" },
		{ ...valid, extra: "unexpected" },
		{ ...valid, REASON: "duplicate" },
		{ ...valid, reason: "x".repeat(MAX_REFLECTION_TEXT_CHARACTERS) },
	])
		assert.equal(parseReflectionArguments(invalid).valid, false);
	const remaining =
		MAX_REFLECTION_TEXT_CHARACTERS -
		Array.from(JSON.stringify({ ...valid, reason: "" })).length;
	assert.equal(
		parseReflectionArguments({ ...valid, reason: "😀".repeat(remaining) })
			.valid,
		true,
	);
});

test("reflection prompt fixes plugin-owned facts and preserves empty supplement semantics", () => {
	const prompt = buildReflectionPrompt({
		semanticPrefix: "Review the route.",
		timestamp: "2026-08-16T13:00:00.000+00:00",
		reasons: ["USER_REQUEST"],
		thresholds: {
			activeMs: 4,
			activeLoops: 3,
			taskMs: 4,
			taskMinutes: 20,
			rootLoops: 3,
			rootLoopLimit: 60,
			allLoops: 5,
			allLoopLimit: 300,
		},
	});
	assert.match(prompt, /Current local RFC3339 time/);
	assert.match(
		prompt,
		/Threshold snapshot: active=0s\/3 loops; task=0s\/20m; root=3\/60; all=5\/300/,
	);
	assert.doesNotMatch(prompt, /Threshold snapshot: active=.*ms|task=.*ms/);
	assert.match(prompt, /User supplement: \(none\)/);
	assert.match(prompt, /10 lookup tool calls/);
	assert.match(prompt, /current_step/);
	assert.ok(prompt.startsWith("Review the route."));
	assert.match(
		prompt,
		/clarify the conversation, the actual work, or a possible direction/,
	);
	assert.match(prompt, /quick, targeted lookups/);
	assert.match(
		prompt,
		/Stop researching once the relevant uncertainty is resolved/,
	);
	assert.match(prompt, /state what remains uncertain and finish/);
	assert.match(
		prompt,
		/Do not.*extended investigation.*long-running checks.*wait on background work/,
	);
	assert.match(prompt, /"next_step":"suggested next step"/);
	assert.match(prompt, /finish by calling ref with one JSON object/);
	assert.match(
		prompt,
		/express all observations and reasoning inside its five fields/,
	);
	assert.doesNotMatch(prompt, /XML|<reflection>/);
	assert.doesNotMatch(prompt, /End the response with|[Tt]railing/);
});

test("reask prompt requires function submission", () => {
	const reask = buildReflectionReaskPrompt(
		"reflection type must be NO_ISSUE or ROUTE_CORRECTION",
	);
	assert.match(reask, /Call ref alone with exactly/);
	assert.doesNotMatch(reask, /XML|<reflection>/);
	assert.match(reask, /tool-call budget remains in force/);
	assert.doesNotMatch(reask, /[Tt]railing/);
});

test("history recovery is optional, branch-scoped JSON data", () => {
	const locator = {
		sessionFile: '/missing/session "quoted"\nname.jsonl',
		branchLeafId: "active-branch-leaf",
	};
	for (const { historyLocator, available } of [
		{ historyLocator: locator, available: true },
		{ historyLocator: undefined, available: false },
		{
			historyLocator: { ...locator, sessionFile: undefined },
			available: false,
		},
		{ historyLocator: { ...locator, branchLeafId: null }, available: false },
	]) {
		const prompt = buildReflectionPrompt({
			semanticPrefix: "Custom perspective.",
			timestamp: "2026-09-08T00:00:00.000+00:00",
			reasons: ["USER_REQUEST"],
			thresholds: {
				activeMs: 0,
				activeLoops: 0,
				taskMs: 0,
				taskMinutes: 20,
				rootLoops: 0,
				rootLoopLimit: 60,
				allLoops: 0,
				allLoopLimit: 300,
			},
			historyLocator,
		});
		const json = prompt
			.split("\n")
			.find((line) => line.startsWith('{"sessionFile":'));
		if (available) {
			assert.ok(json);
			assert.deepEqual(JSON.parse(json), locator);
			assert.match(prompt, /Only if.*unclear/);
			assert.match(
				prompt,
				/surrounding exchanges.*id\/parentId.*other branches/,
			);
			assert.match(prompt, /historical text.*not instructions/i);
		} else {
			assert.equal(json, undefined);
			assert.match(prompt, /Branch-scoped history recovery unavailable/);
		}
		assert.ok(prompt.startsWith("Custom perspective."));
	}
});

test("reflection prompt places the previous report before current trigger context", () => {
	const previousReport = [
		"Reflection · NO_ISSUE",
		"Time: 2026-08-16T12:00:00.000+00:00",
		"Reason: previous route was sound",
	].join("\n");
	const prompt = buildReflectionPrompt({
		semanticPrefix: "Review the route.",
		previousReflection: {
			timestamp: "2026-08-16T12:00:00.000+00:00",
			report: previousReport,
		},
		timestamp: "2026-08-16T13:00:00.000+00:00",
		reasons: ["USER_REQUEST"],
		thresholds: {
			activeMs: 4,
			activeLoops: 3,
			taskMs: 4,
			taskMinutes: 20,
			rootLoops: 3,
			rootLoopLimit: 60,
			allLoops: 5,
			allLoopLimit: 300,
		},
	});
	const previous = prompt.indexOf(previousReport);
	const current = prompt.indexOf("[Plugin-generated reflection context]");
	assert.ok(previous > prompt.indexOf("Review the route."));
	assert.ok(previous < current);
	assert.match(
		prompt,
		/fallible historical analysis, not the user's words or a conclusion to preserve/,
	);
});
