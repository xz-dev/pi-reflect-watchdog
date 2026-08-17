import assert from "node:assert/strict";
import test from "node:test";
import { parseReflectWatchdogCommand } from "../src/controls.js";

test("reflect-watchdog parser accepts only status/reset/limits controls", () => {
	assert.deepEqual(parseReflectWatchdogCommand("  limits  1 2 3 "), {
		command: {
			action: "limits-set",
			mainLoopLimit: 1,
			observedTotalLoopLimit: 2,
			wallClockMinutes: 3,
		},
	});
	assert.deepEqual(parseReflectWatchdogCommand("status"), {
		command: { action: "status" },
	});
	assert.deepEqual(parseReflectWatchdogCommand("reset"), {
		command: { action: "reset" },
	});
	assert.ok("error" in parseReflectWatchdogCommand("prompt main"));
	assert.ok("error" in parseReflectWatchdogCommand("limits 0 2 3"));
});
