import assert from "node:assert/strict";
import test from "node:test";
import { parseReflectWatchdogCommand } from "../src/controls.js";

test("reflect-watchdog parser accepts status/pause/resume/reset/limits controls", () => {
	assert.deepEqual(parseReflectWatchdogCommand("  limits  1 2 3 60 "), {
		command: {
			action: "limits-set",
			rootLoopLimit: 1,
			allLoopLimit: 2,
			taskMinutes: 3,
			idleResetGapSeconds: 60,
		},
	});
	assert.deepEqual(parseReflectWatchdogCommand("status"), {
		command: { action: "status" },
	});
	assert.deepEqual(parseReflectWatchdogCommand("pause"), {
		command: { action: "pause" },
	});
	assert.deepEqual(parseReflectWatchdogCommand("resume"), {
		command: { action: "resume" },
	});
	assert.deepEqual(parseReflectWatchdogCommand("reset"), {
		command: { action: "reset" },
	});
	assert.ok("error" in parseReflectWatchdogCommand("prompt main"));
	assert.ok("error" in parseReflectWatchdogCommand("limits 0 2 3 60"));
});
