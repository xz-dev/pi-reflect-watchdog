import assert from "node:assert/strict";
import test from "node:test";

import {
	BUILT_IN_CONFIG,
	BUILT_IN_PROMPTS,
	loadConfigText,
	mergeConfig,
	renderTemplate,
	validateConfig,
} from "../src/index.js";

test("layers approved public fields independently and retains lower values for invalid fields", () => {
	const result = mergeConfig(
		{
			mainLoopLimit: 120,
			wallClockMinutes: 45,
			prompts: { mainLoopLimitReached: "Global {{mainLoops}}" },
		},
		{
			mainLoopLimit: 0,
			observedTotalLoopLimit: 700,
			prompts: {
				mainLoopLimitReached: 42,
				observedTotalLoopLimitReached: "Project {{observedTotalLoops}}",
			},
		},
	);

	assert.equal(result.config.mainLoopLimit, 120);
	assert.equal(result.config.observedTotalLoopLimit, 700);
	assert.equal(result.config.wallClockMinutes, 45);
	assert.equal(
		result.config.prompts.mainLoopLimitReached,
		"Global {{mainLoops}}",
	);
	assert.equal(
		result.config.prompts.observedTotalLoopLimitReached,
		"Project {{observedTotalLoops}}",
	);
	assert.equal(result.diagnostics.length, 2);
});

test("rejects non-safe/inexact public values while leaving lower-precedence values effective", () => {
	const result = mergeConfig(
		{ observedTotalLoopLimit: 600 },
		{
			observedTotalLoopLimit: 1.5,
			wallClockMinutes: Number.MAX_SAFE_INTEGER + 1,
		},
	);
	assert.equal(result.config.observedTotalLoopLimit, 600);
	assert.equal(
		result.config.wallClockMinutes,
		BUILT_IN_CONFIG.wallClockMinutes,
	);
	assert.equal(result.diagnostics.length, 2);
});

test("malformed JSON produces a bounded diagnostic and leaves defaults effective", () => {
	const result = loadConfigText("global", "{not json");

	assert.deepEqual(result.config, {});
	assert.equal(result.diagnostics.length, 1);
	assert.match(result.diagnostics[0]?.message ?? "", /malformed JSON/);
	assert.ok((result.diagnostics[0]?.message.length ?? 0) <= 240);
});

test("built-in public defaults and returned prompts are insulated from consumer mutation", () => {
	assert.ok(Object.isFrozen(BUILT_IN_CONFIG));
	assert.ok(Object.isFrozen(BUILT_IN_PROMPTS));
	const first = mergeConfig().config;
	first.prompts.mainLoopLimitReached = "mutated";
	assert.notEqual(mergeConfig().config.prompts.mainLoopLimitReached, "mutated");
});

test("renders every documented built-in reminder variable while retaining stable guidance", () => {
	const main = renderTemplate(BUILT_IN_PROMPTS.mainLoopLimitReached, {
		mainLoops: 101,
		mainLoopLimit: 100,
	});
	assert.match(main, /101 loops/);
	assert.match(main, /limit of 100/);
	assert.doesNotMatch(main, /{{mainLoops}}|{{mainLoopLimit}}/);
	assert.match(main, /Do not mechanically continue the same pattern/);

	const total = renderTemplate(BUILT_IN_PROMPTS.observedTotalLoopLimitReached, {
		observedTotalLoops: 503,
		observedTotalLoopLimit: 500,
		mainLoops: 101,
		observedChildLoops: 402,
		observedChildSessions: 7,
	});
	assert.match(total, /503 loops/);
	assert.match(total, /limit of 500/);
	assert.match(total, /main agent completed 101 loops/i);
	assert.match(total, /subagents completed 402 loops across 7 child sessions/i);
	assert.doesNotMatch(
		total,
		/{{observedTotalLoops}}|{{observedTotalLoopLimit}}|{{mainLoops}}|{{observedChildLoops}}|{{observedChildSessions}}/,
	);
	assert.match(total, /only sessions observable by pi-watchdog/i);
	assert.match(total, /Do not interrupt active subagents/i);

	const time = renderTemplate(BUILT_IN_PROMPTS.wallClockLimitReached, {
		elapsed: "30 minutes",
		wallClockMinutes: 30,
	});
	assert.match(time, /continuously active for 30 minutes/i);
	assert.match(time, /limit of 30 minutes/i);
	assert.doesNotMatch(time, /{{elapsed}}|{{wallClockMinutes}}/);
	assert.match(time, /only the main agent's continuous active time/i);
	assert.match(time, /never sends wall-clock reminders to subagents/i);

	const inherited = Object.create({ inherited: "not substituted" }) as Record<
		string,
		string
	>;
	inherited.owned = "substituted";
	assert.equal(
		renderTemplate("{{owned}} / {{inherited}} / {{unknown}}", inherited),
		"substituted / {{inherited}} / {{unknown}}",
	);
});

test("validates only approved prompt keys and preserves partial prompt typing", () => {
	const result = validateConfig("test", {
		prompts: { mainLoopLimitReached: "Custom", unsupported: 3 },
	});
	assert.deepEqual(result.config.prompts, { mainLoopLimitReached: "Custom" });
	assert.deepEqual(result.diagnostics, []);
});
