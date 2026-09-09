import assert from "node:assert/strict";
import test from "node:test";
import {
	buildReflectionPrompt,
	buildReflectionReaskPrompt,
	DEFAULT_REFLECTION_PROMPT,
	MAX_REFLECTION_TEXT_CHARACTERS,
	parseReflectionXml,
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

test("reflection XML is strict, decodes entities, and requires unique fields", () => {
	const result = parseReflectionXml(
		"thought\n<reflection><type>ROUTE_CORRECTION</type><reason>a &amp; b</reason><done>done</done><current_step>now</current_step><next_step>next</next_step></reflection>",
	);
	assert.deepEqual(result, {
		valid: true,
		decision: {
			type: "ROUTE_CORRECTION",
			reason: "a & b",
			done: "done",
			currentStep: "now",
			nextStep: "next",
		},
	});
	assert.equal(
		parseReflectionXml(
			"<reflection><type>NO_ISSUE</type><reason>x</reason><reason>y</reason><done>d</done><current_step>c</current_step><next_step>n</next_step></reflection>",
		).valid,
		false,
	);
	assert.deepEqual(
		parseReflectionXml(
			"<Reflection><TYPE>no_issue</TYPE><Reason>x</Reason><DONE>d</DONE><CURRENT_STEP>c</CURRENT_STEP><NEXT_STEP>n</NEXT_STEP></Reflection>",
		),
		{
			valid: true,
			decision: {
				type: "NO_ISSUE",
				reason: "x",
				done: "d",
				currentStep: "c",
				nextStep: "n",
			},
		},
	);
});

test("reflection XML rejects duplicate roots, attributes, missing values, and oversized text", () => {
	const valid =
		"<reflection><type>NO_ISSUE</type><reason>r</reason><done>d</done><current_step>c</current_step><next_step>n</next_step></reflection>";
	assert.equal(parseReflectionXml(`${valid}${valid}`).valid, false);
	assert.equal(
		parseReflectionXml(valid.replace("<type>", "<type x='1'>")).valid,
		false,
	);
	assert.equal(
		parseReflectionXml(
			valid.replace("<reason>r</reason>", "<reason> </reason>"),
		).valid,
		false,
	);
	assert.equal(
		parseReflectionXml(`${"x".repeat(MAX_REFLECTION_TEXT_CHARACTERS)}${valid}`)
			.valid,
		false,
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
			taskMinutes: 30,
			rootLoops: 3,
			rootLoopLimit: 100,
			allLoops: 5,
			allLoopLimit: 500,
		},
	});
	assert.match(prompt, /Current local RFC3339 time/);
	assert.match(prompt, /User supplement: \(none\)/);
	assert.match(prompt, /MAX_REFLECTION_TOOL_CALLS|10 tool calls/);
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
	assert.match(prompt, /<next_step>suggested next step<\/next_step>/);
	assert.match(
		prompt,
		/Your entire response must be exactly one <reflection>\.\.\.<\/reflection> XML document, with no text before or after it/,
	);
	assert.match(
		prompt,
		/express all observations and reasoning inside the five fields/,
	);
	assert.doesNotMatch(prompt, /End the response with|[Tt]railing/);
});

test("reask prompt demands the entire-response XML contract", () => {
	const reask = buildReflectionReaskPrompt(
		"reflection type must be NO_ISSUE or ROUTE_CORRECTION",
	);
	assert.match(
		reask,
		/entire response must be exactly one valid <reflection> XML document with no text before or after it/,
	);
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
				taskMinutes: 30,
				rootLoops: 0,
				rootLoopLimit: 100,
				allLoops: 0,
				allLoopLimit: 500,
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
			taskMinutes: 30,
			rootLoops: 3,
			rootLoopLimit: 100,
			allLoops: 5,
			allLoopLimit: 500,
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
