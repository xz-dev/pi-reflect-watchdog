import assert from "node:assert/strict";
import test from "node:test";
import {
	BUILT_IN_CONFIG,
	DEFAULT_REFLECTION_PROMPT,
	loadConfigText,
	mergeConfig,
	validateConfig,
} from "../src/index.js";

test("reflectionPrompt layers by field and trusted project precedence", () => {
	const result = mergeConfig(
		{ mainLoopLimit: 120, reflectionPrompt: "global semantic prefix" },
		{
			observedTotalLoopLimit: 700,
			reflectionPrompt: "project semantic prefix",
		},
	);
	assert.equal(result.config.mainLoopLimit, 120);
	assert.equal(result.config.observedTotalLoopLimit, 700);
	assert.equal(result.config.reflectionPrompt, "project semantic prefix");
	assert.equal(result.diagnostics.length, 0);
});

test("reflectionPrompt rejects blank and overlong Unicode values", () => {
	const invalid = validateConfig("project", {
		reflectionPrompt: `${"😀".repeat(16_385)}`,
	});
	assert.equal(invalid.config.reflectionPrompt, undefined);
	assert.equal(invalid.diagnostics.length, 1);
	assert.equal(
		validateConfig("project", { reflectionPrompt: "   " }).diagnostics.length,
		1,
	);
});

test("malformed config keeps built-in reflection prompt", () => {
	const result = loadConfigText("global", "{not json");
	assert.deepEqual(result.config, {});
	assert.equal(
		mergeConfig().config.reflectionPrompt,
		DEFAULT_REFLECTION_PROMPT,
	);
	assert.equal(BUILT_IN_CONFIG.reflectionPrompt, DEFAULT_REFLECTION_PROMPT);
});
