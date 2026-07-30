import assert from "node:assert/strict";
import test from "node:test";

import { loadRuntimeConfig } from "../src/index.js";

test("loads global then trusted project configuration and keeps invalid project fields diagnostic", async () => {
	const files = new Map([
		[
			"/agent/pi-watchdog.json",
			JSON.stringify({ mainLoopLimit: 120, wallClockMinutes: 20 }),
		],
		[
			"/work/.pi/pi-watchdog.json",
			JSON.stringify({ observedTotalLoopLimit: 700, wallClockMinutes: 0 }),
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
	assert.deepEqual(trusted.config.mainLoopLimit, 120);
	assert.deepEqual(trusted.config.observedTotalLoopLimit, 700);
	assert.deepEqual(trusted.config.wallClockMinutes, 20);
	assert.equal(trusted.diagnostics.length, 1);
	const untrusted = await loadRuntimeConfig("/work", false, io, "/agent");
	assert.equal(untrusted.config.observedTotalLoopLimit, 500);
});

test("malformed JSON in one layer keeps the other layers and stays nonfatal", async () => {
	const io = {
		readFile: async (path: string) => {
			if (path === "/agent/pi-watchdog.json") return "{ not json";
			if (path === "/work/.pi/pi-watchdog.json")
				return JSON.stringify({ mainLoopLimit: 7 });
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		},
	};
	const loaded = await loadRuntimeConfig("/work", true, io, "/agent");
	assert.equal(loaded.config.mainLoopLimit, 7, "valid project layer wins");
	assert.equal(
		loaded.config.observedTotalLoopLimit,
		500,
		"built-in default fills the rest",
	);
	assert.equal(loaded.diagnostics.length, 1);
	assert.match(loaded.diagnostics[0].message, /malformed JSON/);
	assert.equal(loaded.diagnostics[0].source, "global");
});

test("non-ENOENT read errors are bounded diagnostics and never throw", async () => {
	const io = {
		readFile: async (path: string) => {
			if (path === "/agent/pi-watchdog.json")
				throw Object.assign(new Error("E".repeat(500)), { code: "EACCES" });
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		},
	};
	const loaded = await loadRuntimeConfig("/work", true, io, "/agent");
	assert.equal(loaded.diagnostics.length, 1);
	assert.ok(loaded.diagnostics[0].message.length <= 240, "message is bounded");
	assert.match(loaded.diagnostics[0].message, /could not read configuration/);
	assert.equal(
		loaded.config.mainLoopLimit,
		100,
		"defaults remain after a read failure",
	);
});

test("extension root reports at most three bounded diagnostics and stays functional", async () => {
	const { createWatchdogExtension } = await import("../src/extension.js");
	const { HUB_SYMBOL } = await import("../src/hub.js");
	delete (globalThis as Record<PropertyKey, unknown>)[HUB_SYMBOL];
	let resolveConfig!: (value: unknown) => void;
	const pi = {
		handlers: new Map<string, (event: unknown, ctx: unknown) => unknown>(),
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			this.handlers.set(event, handler);
		},
		registerCommand() {},
		registerTool() {},
		getActiveTools: () => ["read"],
		setActiveTools() {},
		sendMessage() {},
	};
	const notifications: Array<[string, string | undefined]> = [];
	const ctx = {
		hasUI: true,
		cwd: "/work",
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "diag" },
		ui: {
			notify: (message: string, kind?: string) =>
				notifications.push([message, kind]),
			setStatus() {},
		},
	};
	createWatchdogExtension({
		loadConfig: () =>
			new Promise((resolve) => {
				resolveConfig = resolve;
			}) as never,
	})(pi as never);
	const started = pi.handlers.get("session_start")?.({}, ctx);
	resolveConfig({
		config: {
			mainLoopLimit: 100,
			observedTotalLoopLimit: 500,
			wallClockMinutes: 30,
			prompts: {
				mainLoopLimitReached: "main",
				observedTotalLoopLimitReached: "total",
				wallClockLimitReached: "time",
			},
		},
		diagnostics: [
			{ source: "global", message: "d1".padEnd(300, "x") },
			{ source: "global", message: "d2" },
			{ source: "project", message: "d3" },
			{ source: "project", message: "d4" },
		],
	});
	await started;
	assert.equal(notifications.length, 3, "notifications are capped at three");
	assert.ok(
		notifications.every(
			([message, kind]) => kind === "warning" && message.length <= 320,
		),
		"each notification is a bounded warning",
	);
	assert.ok(pi.handlers.has("session_start"), "extension remains functional");
	delete (globalThis as Record<PropertyKey, unknown>)[HUB_SYMBOL];
});
