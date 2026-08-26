import assert from "node:assert/strict";
import test from "node:test";
import {
	buildReflectionPrompt,
	MAX_REFLECTION_TEXT_CHARACTERS,
	parseReflectionXml,
} from "../src/index.js";

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
});
