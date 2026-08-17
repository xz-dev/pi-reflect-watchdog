import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeConfig } from "../src/index.js";

test("loads global and trusted project configuration with independent reflectionPrompt precedence", async () => {
	const files = new Map([
		[
			"/agent/pi-reflect-watchdog.json",
			JSON.stringify({ mainLoopLimit: 120, reflectionPrompt: "global" }),
		],
		[
			"/work/.pi/pi-reflect-watchdog.json",
			JSON.stringify({
				observedTotalLoopLimit: 700,
				reflectionPrompt: "project",
				wallClockMinutes: 0,
			}),
		],
	]);
	const io = {
		readFile: async (path: string) => {
			const text = files.get(path);
			if (text === undefined)
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return text;
		},
	};
	const trusted = await loadRuntimeConfig("/work", true, io, "/agent");
	assert.equal(trusted.config.mainLoopLimit, 120);
	assert.equal(trusted.config.observedTotalLoopLimit, 700);
	assert.equal(trusted.config.reflectionPrompt, "project");
	assert.equal(trusted.diagnostics.length, 1);
	const untrusted = await loadRuntimeConfig("/work", false, io, "/agent");
	assert.equal(untrusted.config.observedTotalLoopLimit, 500);
});

test("malformed and inaccessible configuration stay bounded and nonfatal", async () => {
	const io = {
		readFile: async (path: string) => {
			if (path === "/agent/pi-reflect-watchdog.json") return "{ not json";
			throw Object.assign(new Error("E".repeat(500)), { code: "EACCES" });
		},
	};
	const loaded = await loadRuntimeConfig("/work", true, io, "/agent");
	assert.equal(loaded.diagnostics.length, 2);
	assert.ok(loaded.diagnostics.every((item) => item.message.length <= 240));
});
