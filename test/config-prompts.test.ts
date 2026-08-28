import assert from "node:assert/strict";
import test from "node:test";
import {
	BUILT_IN_CONFIG,
	DEFAULT_REFLECTION_PROMPT,
	loadConfigText,
	mergeConfig,
	validateConfig,
} from "../src/index.js";

test("hookPauses validate through semantic-hook rules, deduplicate, and preserve valid lower precedence", () => {
	const globalValid = {
		hookPauses: [
			{ pause: "inquiry-started", resume: "inquiry-finished" },
			{ pause: "inquiry-started", resume: "inquiry-finished" },
		],
	};
	const globalMalformed = {
		hookPauses: [
			{ pause: "inquiry-started", resume: "inquiry-finished" },
			{ pause: "bad_name", resume: "ok-name" },
			{ pause: "same-name", resume: "same-name" },
		],
	};
	const valid = mergeConfig(globalValid, {
		hookPauses: [{ pause: "project-start", resume: "project-finish" }],
	});
	assert.deepEqual(valid.config.hookPauses, [
		{ pause: "project-start", resume: "project-finish" },
	]);
	const preserved = mergeConfig(globalValid, { hookPauses: "invalid" });
	assert.deepEqual(preserved.config.hookPauses, [
		{ pause: "inquiry-started", resume: "inquiry-finished" },
	]);
	assert.ok(preserved.diagnostics.every((item) => item.message.length <= 240));
	assert.equal(BUILT_IN_CONFIG.hookPauses.length, 0);
	const rejected = mergeConfig(globalMalformed);
	assert.deepEqual(rejected.config.hookPauses, []);
});

test("hookPauses bounds the list and malformed pair diagnostics", () => {
	const tooMany = validateConfig("project", {
		hookPauses: Array.from({ length: 65 }, () => ({
			pause: "work-started",
			resume: "work-finished",
		})),
	});
	assert.equal(tooMany.config.hookPauses, undefined);
	assert.match(tooMany.diagnostics[0]?.message ?? "", /at most 64/);
	const malformed = validateConfig("project", {
		hookPauses: [null, [], { pause: "missing-resume" }],
	});
	assert.equal(malformed.config.hookPauses, undefined);
	assert.equal(malformed.diagnostics.length, 3);

	const hostile = Object.create(null);
	Object.defineProperty(hostile, "pause", {
		get() {
			throw new Error("must not execute");
		},
	});
	Object.defineProperty(hostile, "resume", { value: "work-finished" });
	const hostileResult = validateConfig("project", { hookPauses: [hostile] });
	assert.equal(hostileResult.config.hookPauses, undefined);
	assert.equal(hostileResult.diagnostics.length, 1);
});

test("reflectionPrompt layers by field and trusted project precedence", () => {
	const result = mergeConfig(
		{ rootLoopLimit: 120, reflectionPrompt: "global semantic prefix" },
		{
			allLoopLimit: 700,
			reflectionPrompt: "project semantic prefix",
		},
	);
	assert.equal(result.config.rootLoopLimit, 120);
	assert.equal(result.config.allLoopLimit, 700);
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

test("built-in reflection prompt preserves the Oracle persona and framing", () => {
	assert.match(DEFAULT_REFLECTION_PROMPT, /The Oracle from \*The Matrix\*/);
	assert.match(
		DEFAULT_REFLECTION_PROMPT,
		/do not predict a future that is already fixed/,
	);
	assert.match(DEFAULT_REFLECTION_PROMPT, /think from first principles/);
	assert.match(
		DEFAULT_REFLECTION_PROMPT,
		/Is the stated goal the result we truly want\?/,
	);
	assert.match(
		DEFAULT_REFLECTION_PROMPT,
		/Even if the current approach succeeds, will it solve the underlying problem\?/,
	);
	assert.match(DEFAULT_REFLECTION_PROMPT, /fear, inertia, sunk costs/);
	assert.match(DEFAULT_REFLECTION_PROMPT, /Speak calmly, kindly, and directly/);
	assert.match(DEFAULT_REFLECTION_PROMPT, /short questions, simple analogies/);
	assert.match(
		DEFAULT_REFLECTION_PROMPT,
		/Distinguish facts from inference and uncertainty/,
	);
	assert.match(DEFAULT_REFLECTION_PROMPT, /Prioritize the one insight/);
});
