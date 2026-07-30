import assert from "node:assert/strict";
import test from "node:test";

import type { TSchema } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { LoadedConfig } from "../src/config-loader.js";
import {
	createWatchdogExtension,
	type RuntimeServices,
} from "../src/extension.js";
import { HUB_SYMBOL } from "../src/hub.js";

type EventName =
	| "session_start"
	| "message_start"
	| "agent_start"
	| "agent_settled"
	| "turn_end"
	| "session_shutdown";
type EventHandler = (
	event: { message?: { role?: string } },
	ctx: FakeContext,
) => unknown | Promise<unknown>;
type ControlAction = "status" | "reset" | "set_limits" | "restore_defaults";
type ControlParams = {
	action: ControlAction;
	mainLoopLimit?: number;
	observedTotalLoopLimit?: number;
	wallClockMinutes?: number;
};
type ControlResult = {
	content: Array<{ type: string; text: string }>;
	details: {
		mainLoops: number;
		observedChildLoops: number;
		observedChildSessions: number;
		observedTotalLoops: number;
		limits: {
			mainLoopLimit: number;
			observedTotalLoopLimit: number;
			wallClockMinutes: number;
		};
		wallClockElapsedMs: number;
		rootActive: boolean;
		latchedWarnings: string[];
		coverage: string;
	};
};
type RegisteredTool = {
	name: string;
	parameters: {
		properties: Record<
			string,
			{ type: string; enum?: string[]; maximum?: number }
		>;
	};
	execute(id: string, params: ControlParams): Promise<ControlResult>;
};

class FakeClock {
	value = 0;
	private nextId = 0;
	private readonly liveCallbacks = new Map<number, () => void>();
	readonly scheduled: Array<{
		id: number;
		role: "threshold" | "tui-refresh" | "rpc-status";
		delay: number;
		callback: () => void;
	}> = [];

	now = (): number => this.value;
	setTimeout = (
		callback: () => void,
		delay: number,
	): ReturnType<typeof setTimeout> => {
		const id = ++this.nextId;
		this.liveCallbacks.set(id, callback);
		this.scheduled.push({ id, role: "threshold", delay, callback });
		return { id, unref() {} } as unknown as ReturnType<typeof setTimeout>; // Legacy timer seam; role-aware tests use scheduleTimer.
	};
	scheduleTimer = (
		role: "threshold" | "tui-refresh" | "rpc-status",
		callback: () => void,
		delay: number,
	): ReturnType<typeof setTimeout> => {
		const id = ++this.nextId;
		this.liveCallbacks.set(id, callback);
		this.scheduled.push({ id, role, delay, callback });
		return { id, unref() {} } as unknown as ReturnType<typeof setTimeout>;
	};
	clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
		this.liveCallbacks.delete((timer as unknown as { id: number }).id);
	};
	fire(id: number): void {
		const timer = this.scheduled.find((entry) => entry.id === id);
		assert.ok(timer, `timer ${id} must be scheduled`);
		this.liveCallbacks.delete(id);
		timer.callback();
	}
	liveCount(): number {
		return this.liveCallbacks.size;
	}
	live(role: "threshold" | "tui-refresh" | "rpc-status"): TimerEntry {
		const live = this.scheduled.filter(
			(entry) => entry.role === role && this.liveCallbacks.has(entry.id),
		);
		assert.equal(live.length, 1, `exactly one live ${role} timer`);
		return live[0];
	}
	liveThreshold(): TimerEntry {
		return this.live("threshold");
	}
	liveTicker(): TimerEntry {
		return this.live("rpc-status");
	}
	fireStale(id: number): void {
		// Invoke a callback that was cancelled, as a host that fires queued work
		// despite clearTimeout; guards must make the late delivery inert.
		const timer = this.scheduled.find((entry) => entry.id === id);
		assert.ok(timer, `timer ${id} must be scheduled`);
		timer.callback();
	}
	pending(): number {
		return this.liveCallbacks.size;
	}
}

class FakePi {
	readonly handlers = new Map<EventName, EventHandler>();
	readonly tools: RegisteredTool[] = [];
	readonly messages: Array<{
		message: { content?: string; details?: unknown };
		options: { deliverAs?: string; triggerTurn?: boolean };
	}> = [];
	activeTools = ["read", "bash"];
	readonly activeToolChanges: string[][] = [];

	on(event: EventName, handler: EventHandler): void {
		this.handlers.set(event, handler);
	}
	registerCommand(): void {}
	registerTool<TSchemaType extends TSchema>(tool: {
		name: string;
		parameters: TSchemaType;
		execute(id: string, params: ControlParams): Promise<ControlResult>;
	}): void {
		this.tools.push(tool as unknown as RegisteredTool);
	}
	getActiveTools(): string[] {
		return [...this.activeTools];
	}
	setActiveTools(names: string[]): void {
		this.activeTools = [...names];
		this.activeToolChanges.push([...names]);
	}
	sendMessage(
		message: { content?: string; details?: unknown },
		options: { deliverAs?: string; triggerTurn?: boolean },
	): void {
		this.messages.push({ message, options });
	}
	async emit(
		event: EventName,
		value: { message?: { role?: string } },
		ctx: FakeContext,
	): Promise<void> {
		await this.handlers.get(event)?.(value, ctx);
	}
	asAPI(): ExtensionAPI {
		return this as unknown as ExtensionAPI; // Test fake exposes only the public methods exercised by this extension.
	}
}

class FakeContext {
	readonly notifications: Array<[string, string | undefined]> = [];
	readonly statuses: Array<[string, string | undefined]> = [];
	constructor(
		readonly sessionId: string,
		readonly hasUI: boolean,
		private readonly idle = false,
		readonly mode: "tui" | "rpc" | "print" | "json" = "rpc",
	) {}
	readonly cwd = "/work";
	isProjectTrusted = (): boolean => false;
	isIdle = (): boolean => this.idle;
	readonly sessionManager = { getSessionId: (): string => this.sessionId };
	readonly ui = {
		notify: (message: string, kind?: "info" | "warning" | "error"): void => {
			this.notifications.push([message, kind]);
		},
		setStatus: (key: string, value: string | undefined): void => {
			this.statuses.push([key, value]);
		},
	};
	asContext(): ExtensionContext {
		return this as unknown as ExtensionContext; // Runtime only consumes the documented fields implemented above.
	}
}

function resetHub(): void {
	delete (globalThis as typeof globalThis & { [HUB_SYMBOL]?: unknown })[
		HUB_SYMBOL
	];
}

function config(): LoadedConfig {
	return {
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
		diagnostics: [],
	};
}

function fixture(
	loadConfig: RuntimeServices["loadConfig"] = async () => config(),
) {
	resetHub();
	const clock = new FakeClock();
	const extension = createWatchdogExtension({
		now: clock.now,
		setTimeout: clock.setTimeout,
		scheduleTimer: clock.scheduleTimer,
		clearTimeout: clock.clearTimeout,
		loadConfig,
	});
	return { clock, extension };
}

async function rootReady(
	pi: FakePi,
	ctx: FakeContext,
): Promise<RegisteredTool> {
	await pi.emit("session_start", {}, ctx);
	assert.equal(pi.tools.length, 1);
	return pi.tools[0];
}

async function control(
	tool: RegisteredTool,
	action: ControlAction,
	limits: Omit<ControlParams, "action"> = {},
): Promise<ControlResult> {
	return tool.execute("id", { action, ...limits });
}

type TimerEntry = {
	id: number;
	role: "threshold" | "tui-refresh" | "rpc-status";
	delay: number;
	callback: () => void;
};
function timerEntries(
	clock: FakeClock,
	role: TimerEntry["role"],
): TimerEntry[] {
	return clock.scheduled.filter((entry) => entry.role === role);
}

test("factory has no side effects before session binding", () => {
	const { extension } = fixture();
	const pi = new FakePi();
	extension(pi.asAPI());
	assert.deepEqual(pi.tools, []);
	assert.deepEqual(pi.activeToolChanges, []);
	const globalState = globalThis as typeof globalThis & {
		[HUB_SYMBOL]?: unknown;
	};
	assert.equal(
		globalState[HUB_SYMBOL],
		undefined,
		"hub must stay lazy before session_start",
	);
	resetHub();
});

test("delayed fallback cannot replace a UI reservation, and equal UI candidates cannot steal", async () => {
	let releaseFallback!: (value: LoadedConfig) => void;
	const delayedFallback = new Promise<LoadedConfig>((resolve) => {
		releaseFallback = resolve;
	});
	let loadCount = 0;
	const { extension } = fixture(async () => {
		loadCount += 1;
		return loadCount === 1 ? delayedFallback : config();
	});
	const fallbackPi = new FakePi();
	const uiPi = new FakePi();
	const secondUiPi = new FakePi();
	const fallback = new FakeContext("fallback", false);
	const ui = new FakeContext("ui", true);
	const secondUi = new FakeContext("ui-2", true);
	extension(fallbackPi.asAPI());
	extension(uiPi.asAPI());
	extension(secondUiPi.asAPI());
	const pending = fallbackPi.emit("session_start", {}, fallback);
	await uiPi.emit("session_start", {}, ui);
	await secondUiPi.emit("session_start", {}, secondUi);
	await fallbackPi.emit("session_shutdown", {}, fallback);
	releaseFallback(config());
	await pending;
	assert.equal(uiPi.tools.length, 1);
	assert.equal(secondUiPi.tools.length, 0);
	assert.equal(fallbackPi.tools.length, 0);
});

test("pending config shutdown releases its reservation so an equal-priority replacement wins while the old resolution stays inert", async () => {
	let releaseOld!: (value: LoadedConfig) => void;
	let loadCount = 0;
	const { extension } = fixture(async () => {
		loadCount += 1;
		return loadCount === 1
			? new Promise<LoadedConfig>((resolve) => {
					releaseOld = resolve;
				})
			: config();
	});
	const oldPi = new FakePi();
	const replacementPi = new FakePi();
	const old = new FakeContext("old", true);
	const replacement = new FakeContext("replacement", true);
	extension(oldPi.asAPI());
	extension(replacementPi.asAPI());
	const pendingOld = oldPi.emit("session_start", {}, old);
	await oldPi.emit("session_shutdown", {}, old);
	await rootReady(replacementPi, replacement);
	releaseOld(config());
	await pendingOld;
	assert.equal(replacementPi.tools.length, 1, "replacement becomes root");
	assert.equal(oldPi.tools.length, 0, "late old resolution stays inert");
	assert.equal(old.statuses.length, 0);
});

test("shutdown while config is pending is inert", async () => {
	let release!: (value: LoadedConfig) => void;
	const { extension } = fixture(
		() =>
			new Promise((resolve: (value: LoadedConfig) => void) => {
				release = resolve;
			}),
	);
	const pi = new FakePi();
	const ctx = new FakeContext("gone", true);
	extension(pi.asAPI());
	const pending = pi.emit("session_start", {}, ctx);
	await pi.emit("session_shutdown", {}, ctx);
	release(config());
	await pending;
	assert.equal(pi.tools.length, 0);
	assert.equal(ctx.statuses.length, 0);
});

test("UI promotion demotes fallback: clears status and timers, removes only watchdog tool, and rejects stale control", async () => {
	const { extension, clock } = fixture();
	const fallbackPi = new FakePi();
	const uiPi = new FakePi();
	const fallback = new FakeContext("fallback", false);
	const ui = new FakeContext("ui", true);
	extension(fallbackPi.asAPI());
	extension(uiPi.asAPI());
	const staleTool = await rootReady(fallbackPi, fallback);
	await fallbackPi.emit("agent_start", {}, fallback);
	await fallbackPi.emit(
		"message_start",
		{ message: { role: "user" } },
		fallback,
	);
	assert.ok(clock.pending() > 0);
	await rootReady(uiPi, ui);
	assert.equal(clock.pending(), 0);
	assert.deepEqual(fallback.statuses.at(-1), ["pi-watchdog", undefined]);
	assert.deepEqual(fallbackPi.activeTools, ["read", "bash"]);
	await assert.rejects(() => control(staleTool, "status"), /current root/);
});

test("actual Pi order starts timing after agent_start then root user message, resets while active, and settles", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	assert.equal(
		clock.liveCount(),
		0,
		"no live timer exists before the root user message",
	);
	clock.value = 10;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	assert.equal(
		clock.scheduled.at(-2)?.delay,
		30 * 60_000,
		"task starts active timer at user epoch",
	);
	clock.value = 80;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	assert.equal((await control(tool, "status")).details.wallClockElapsedMs, 0);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(clock.pending(), 0);
});

test("observer identity includes attachment token, root generation, and epoch", async () => {
	const { extension } = fixture();
	const observerPi = new FakePi();
	const rootAPi = new FakePi();
	const rootBPi = new FakePi();
	const observer = new FakeContext("child", false);
	const rootA = new FakeContext("root-a", true);
	const rootB = new FakeContext("root-b", true);
	extension(observerPi.asAPI());
	extension(rootAPi.asAPI());
	extension(rootBPi.asAPI());
	const toolA = await rootReady(rootAPi, rootA);
	await observerPi.emit("session_start", {}, observer);
	await rootAPi.emit("message_start", { message: { role: "user" } }, rootA);
	await observerPi.emit(
		"message_start",
		{ message: { role: "user" } },
		observer,
	);
	await observerPi.emit("turn_end", {}, observer);
	assert.equal((await control(toolA, "status")).details.observedChildLoops, 1);
	await rootAPi.emit("session_shutdown", {}, rootA);
	const toolB = await rootReady(rootBPi, rootB);
	await rootBPi.emit("message_start", { message: { role: "user" } }, rootB);
	await observerPi.emit("turn_end", {}, observer);
	assert.equal((await control(toolB, "status")).details.observedChildLoops, 0);
	await observerPi.emit(
		"message_start",
		{ message: { role: "user" } },
		observer,
	);
	await observerPi.emit("turn_end", {}, observer);
	assert.equal((await control(toolB, "status")).details.observedChildLoops, 1);
});

test("timer remaining duration is exact and stale generation callbacks are inert", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	clock.value = 10;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await control(tool, "set_limits", { wallClockMinutes: 1 });
	assert.equal(clock.scheduled.at(-2)?.delay, 60_000);
	assert.ok(clock.scheduled.at(-1));
	const thresholdId = clock.scheduled.at(-2)?.id;
	assert.ok(thresholdId !== undefined);
	await pi.emit("session_shutdown", {}, ctx);
	clock.value = 60_010;
	clock.fireStale(thresholdId);
	assert.equal(pi.messages.length, 0);
});

test("warnings steer active work, queue idle observer warnings, never abort, and latch", async () => {
	const { extension } = fixture();
	const rootPi = new FakePi();
	const childPi = new FakePi();
	const root = new FakeContext("root", true);
	const child = new FakeContext("child", false);
	extension(rootPi.asAPI());
	extension(childPi.asAPI());
	const tool = await rootReady(rootPi, root);
	await childPi.emit("session_start", {}, child);
	await rootPi.emit("agent_start", {}, root);
	await rootPi.emit("message_start", { message: { role: "user" } }, root);
	await control(tool, "set_limits", { mainLoopLimit: 1 });
	await rootPi.emit("turn_end", {}, root);
	assert.deepEqual(rootPi.messages.at(-1)?.options, {
		deliverAs: "steer",
		triggerTurn: false,
	});
	await rootPi.emit("turn_end", {}, root);
	assert.equal(rootPi.messages.length, 1);
	await rootPi.emit("agent_settled", {}, root);
	await childPi.emit("message_start", { message: { role: "user" } }, child);
	await control(tool, "set_limits", { observedTotalLoopLimit: 3 });
	await childPi.emit("turn_end", {}, child);
	assert.deepEqual(rootPi.messages.at(-1)?.options, {
		deliverAs: "nextTurn",
		triggerTurn: false,
	});
});

test("control status reset limits restore and schema use a provider-compatible string enum", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	assert.deepEqual(tool.parameters.properties.action, {
		type: "string",
		enum: ["status", "reset", "set_limits", "restore_defaults"],
	});
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("turn_end", {}, ctx);
	await control(tool, "set_limits", { mainLoopLimit: 1 });
	assert.equal(pi.messages.length, 1);
	clock.value = 100;
	const reset = await control(tool, "reset");
	assert.equal(reset.details.mainLoops, 0);
	assert.equal(reset.details.wallClockElapsedMs, 0);
	await control(tool, "restore_defaults");
	await pi.emit("turn_end", {}, ctx);
	const afterReset = await control(tool, "status");
	assert.match(afterReset.content[0].text, /main\/root loops: 1/);
	assert.match(afterReset.content[0].text, /observed total loops: 1/);
	assert.equal(JSON.stringify(tool.parameters).includes("prompt"), false);
});

test("watchdog_control schema bounds all limit integers at Number.MAX_SAFE_INTEGER", async () => {
	const { extension } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	for (const key of [
		"mainLoopLimit",
		"observedTotalLoopLimit",
		"wallClockMinutes",
	] as const)
		assert.equal(
			tool.parameters.properties[key].maximum,
			Number.MAX_SAFE_INTEGER,
			`${key} schema bounds its integer at Number.MAX_SAFE_INTEGER`,
		);
});

test("set_limits rejects invalid or unsafe limits atomically", async () => {
	const { extension } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	const before = (await control(tool, "status")).content[0].text;
	await assert.rejects(() => control(tool, "set_limits"), /at least one/);
	await assert.rejects(
		() =>
			control(tool, "set_limits", {
				mainLoopLimit: 2,
				observedTotalLoopLimit: Number.MAX_SAFE_INTEGER + 1,
			}),
		/positive safe integer/,
	);
	assert.equal(pi.messages.length, 0, "rejection delivers no warning");
	assert.equal(
		(await control(tool, "status")).content[0].text,
		before,
		"mixed valid and unsafe inputs do not partially mutate limits",
	);
});

test("root shutdown and observer shutdown clean their own bindings without harming replacement", async () => {
	const { extension } = fixture();
	const rootPi = new FakePi();
	const observerPi = new FakePi();
	const root = new FakeContext("root", true);
	const observer = new FakeContext("child", false);
	extension(rootPi.asAPI());
	extension(observerPi.asAPI());
	const tool = await rootReady(rootPi, root);
	await observerPi.emit("session_start", {}, observer);
	await rootPi.emit("message_start", { message: { role: "user" } }, root);
	await observerPi.emit(
		"message_start",
		{ message: { role: "user" } },
		observer,
	);
	await observerPi.emit("session_shutdown", {}, observer);
	await observerPi.emit("turn_end", {}, observer);
	assert.equal((await control(tool, "status")).details.observedChildLoops, 0);
	assert.equal(
		(await control(tool, "status")).details.observedChildSessions,
		0,
		"observer shutdown unbinds its session from the count",
	);
	await rootPi.emit("session_shutdown", {}, root);
	assert.deepEqual(root.statuses.at(-1), ["pi-watchdog", undefined]);
});

test("live wall-clock boundary warns once and duplicate timer callbacks never duplicate", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await control(tool, "set_limits", { wallClockMinutes: 1 });
	const boundary = timerEntries(clock, "threshold")
		.filter((entry) => entry.delay === 60_000)
		.at(-1);
	assert.ok(boundary, "boundary timer must be scheduled");
	clock.value = 60_000;
	clock.fire(boundary.id);
	assert.equal(pi.messages.length, 1, "exact boundary warns once");
	assert.match(pi.messages[0].message.content ?? "", /^time/);
	clock.fireStale(boundary.id);
	assert.equal(pi.messages.length, 1, "duplicate threshold callback is inert");
	assert.equal(
		clock.pending(),
		1,
		"only the status ticker remains after a latched boundary warning",
	);
	assert.equal(
		timerEntries(clock, "threshold").filter((entry) => entry.delay === 0)
			.length,
		0,
		"a latched boundary never schedules a zero-delay rearm",
	);
	const tickerOnly = clock.liveTicker();
	clock.value = 120_000;
	clock.fire(tickerOnly.id);
	assert.equal(pi.messages.length, 1, "latched warning never repeats");
});

test("early threshold delivery rearms the exact remaining delay without parallel timers", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await control(tool, "set_limits", { wallClockMinutes: 1 });
	const early = timerEntries(clock, "threshold")
		.filter((entry) => entry.delay === 60_000)
		.at(-1);
	assert.ok(early, "threshold timer must be scheduled");
	clock.value = 45_000;
	clock.fire(early.id);
	assert.equal(pi.messages.length, 0, "early delivery cannot warn");
	const rearmed = clock.scheduled.at(-1);
	assert.equal(rearmed?.delay, 15_000, "rearm keeps the exact remaining delay");
	assert.equal(
		clock.pending(),
		2,
		"one threshold timer plus one status ticker",
	);
	assert.equal(
		timerEntries(clock, "threshold")
			.filter((entry) => entry.delay === 60_000)
			.filter((entry) => entry.id > early.id).length,
		0,
		"no parallel full-length threshold timer",
	);
	clock.value = 60_000;
	clock.fire(rearmed?.id ?? 0);
	assert.equal(
		pi.messages.length,
		1,
		"boundary warns exactly once after rearm",
	);
	assert.equal(
		clock.pending(),
		1,
		"only the status ticker remains after the boundary warning",
	);
	assert.equal(
		timerEntries(clock, "threshold").filter((entry) => entry.delay === 0)
			.length,
		0,
		"latched boundary never schedules a zero-delay rearm",
	);
	const tickerOnly = clock.liveTicker();
	clock.value = 120_000;
	clock.fire(tickerOnly.id);
	assert.equal(pi.messages.length, 1, "latched boundary warning never repeats");
});

test("oversized threshold delays chunk to the exact boundary without a post-warning timer", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	// 71,583 minutes is a valid safe-integer limit whose millisecond delay far
	// exceeds Node's maximum setTimeout delay; a naive scheduler would let the
	// host coerce it and warn far too early.
	await control(tool, "set_limits", { wallClockMinutes: 71_583 });
	const MAX = 2_147_483_647;
	const limitMs = 71_583 * 60_000;
	const first = clock.liveThreshold();
	assert.equal(
		first.delay,
		MAX,
		"oversized delay must be capped at the Node timer range",
	);
	assert.equal(
		clock.pending(),
		2,
		"capped threshold timer plus one status ticker",
	);
	clock.value = MAX;
	clock.fire(first.id);
	assert.equal(pi.messages.length, 0, "a below-boundary chunk cannot warn");
	const second = clock.liveThreshold();
	assert.equal(
		second.delay,
		MAX,
		"next chunk stays capped while the remainder is large",
	);
	assert.notEqual(second.id, first.id, "each chunk owns exactly one timer");
	assert.equal(clock.pending(), 2, "chunks never stack parallel timers");
	clock.value = 2 * MAX;
	clock.fire(second.id);
	assert.equal(pi.messages.length, 0, "second chunk still below boundary");
	const final = clock.liveThreshold();
	assert.equal(
		final.delay,
		limitMs - 2 * MAX,
		"final chunk rearm is the exact remaining delay",
	);
	assert.equal(clock.pending(), 2);
	clock.value = limitMs;
	clock.fire(final.id);
	assert.equal(pi.messages.length, 1, "boundary warns exactly once");
	assert.match(pi.messages[0].message.content ?? "", /^time/);
	assert.equal(
		clock.pending(),
		1,
		"only the status ticker remains after the boundary warning",
	);
	assert.equal(
		timerEntries(clock, "threshold").filter((entry) => entry.delay === 0)
			.length,
		0,
		"latched boundary never schedules a zero-delay rearm",
	);
	const tickerOnly = clock.liveTicker();
	clock.value = 2 * limitMs;
	clock.fire(tickerOnly.id);
	assert.equal(pi.messages.length, 1, "latched warning never repeats");
});

test("RPC status ticker refreshes at 30s exactly once per interval and never duplicates", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	assert.equal(clock.pending(), 2, "threshold timer plus one ticker");
	const tick = timerEntries(clock, "rpc-status").at(-1);
	assert.ok(tick, "ticker must be scheduled");
	const statusesBefore = ctx.statuses.length;
	clock.value = 30_000;
	clock.fire(tick.id);
	assert.ok(ctx.statuses.length > statusesBefore, "tick refreshes RPC status");
	assert.equal(clock.pending(), 2, "ticker re-arms exactly one timer");
	const nextTick = clock.scheduled.at(-1);
	assert.equal(nextTick?.delay, 30_000);
	assert.notEqual(nextTick?.id, tick.id);
	clock.fireStale(tick.id);
	assert.equal(
		clock.pending(),
		2,
		"duplicate tick callback cannot arm extra timers",
	);
	const scheduledTicks = timerEntries(clock, "rpc-status").length;
	clock.fire(clock.scheduled.at(-1)?.id ?? 0);
	assert.equal(timerEntries(clock, "rpc-status").length, scheduledTicks + 1);
	assert.equal(clock.pending(), 2, "no duplicate tickers accumulate");
});

test("reset, new task, and raising or restoring limits rearm the threshold from the live cycle", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await control(tool, "set_limits", { wallClockMinutes: 1 });
	clock.value = 60_000;
	clock.fire(
		timerEntries(clock, "threshold")
			.filter((entry) => entry.delay === 60_000)
			.at(-1)?.id ?? 0,
	);
	assert.equal(pi.messages.length, 1, "first boundary warns once");
	assert.equal(
		clock.pending(),
		1,
		"only the status ticker remains after the latched warning",
	);

	clock.value = 70_000;
	await control(tool, "reset");
	const afterReset = clock.liveThreshold();
	assert.equal(
		afterReset.delay,
		60_000,
		"manual reset schedules the threshold from the reset cycle",
	);
	clock.value = 130_000;
	clock.fire(afterReset.id);
	assert.equal(
		pi.messages.length,
		2,
		"reset cycle warns again at its boundary",
	);
	assert.equal(clock.pending(), 1, "ticker only after the reset-cycle warning");

	// Raising the limit above the elapsed time rearms the remaining delay.
	// activeSince is still 70_000, so at 130_000 the elapsed time is 60_000.
	await control(tool, "set_limits", { wallClockMinutes: 3 });
	const raised = clock.liveThreshold();
	assert.equal(
		raised.delay,
		120_000,
		"raising the limit above elapsed rearms the remaining delay",
	);
	clock.value = 250_000;
	clock.fire(raised.id);
	assert.equal(pi.messages.length, 3, "raised boundary warns once");
	assert.equal(clock.pending(), 1);

	// Restoring the configured 30-minute limit rearms the exact remainder.
	// Elapsed at 250_000 is 250_000 - 70_000 = 180_000.
	await control(tool, "restore_defaults");
	const restored = clock.liveThreshold();
	assert.equal(
		restored.delay,
		30 * 60_000 - 180_000,
		"restoring the configured limit rearms the exact remaining delay",
	);
	clock.value = 70_000 + 30 * 60_000;
	clock.fire(restored.id);
	assert.equal(pi.messages.length, 4, "restored boundary warns once");
	assert.equal(clock.pending(), 1);

	clock.value = 70_000 + 31 * 60_000;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	const newTask = clock.liveThreshold();
	assert.equal(
		newTask.delay,
		30 * 60_000,
		"a new task schedules the full threshold from its own epoch",
	);
	clock.value = 70_000 + 61 * 60_000;
	clock.fire(newTask.id);
	assert.equal(pi.messages.length, 5, "new task boundary warns once");
	assert.equal(clock.pending(), 1, "ticker only after the new-task warning");
	assert.equal(
		timerEntries(clock, "threshold").filter((entry) => entry.delay === 0)
			.length,
		0,
		"no zero-delay rearm survives any cycle",
	);
});

test("stale task epoch makes late threshold and tick callbacks inert", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	const thresholdId = timerEntries(clock, "threshold")
		.filter((entry) => entry.delay === 30 * 60_000)
		.at(-1)?.id;
	const tickerId = timerEntries(clock, "rpc-status").at(-1)?.id;
	assert.ok(thresholdId !== undefined && tickerId !== undefined);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	assert.equal(clock.pending(), 2, "new epoch owns exactly two live timers");
	clock.value = 30 * 60_000;
	clock.fireStale(thresholdId);
	clock.fireStale(tickerId);
	assert.equal(pi.messages.length, 0, "stale epoch threshold is inert");
	assert.equal(
		ctx.statuses.at(-1)?.[1],
		"WD main 0/100 · observed 0/500 · 0 seconds/30m",
		"stale epoch tick cannot rewrite the status",
	);
});

test("late threshold callback after settle and after shutdown stays inert", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	const thresholdId = timerEntries(clock, "threshold")
		.filter((entry) => entry.delay === 30 * 60_000)
		.at(-1)?.id;
	const tickerId = timerEntries(clock, "rpc-status").at(-1)?.id;
	assert.ok(thresholdId !== undefined && tickerId !== undefined);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(clock.pending(), 0, "settle clears every timer");
	clock.value = 30 * 60_000;
	clock.fireStale(thresholdId);
	clock.fireStale(tickerId);
	assert.equal(pi.messages.length, 0, "settled threshold callback is inert");
	const settledStatuses = ctx.statuses.length;
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	const secondThresholdId = timerEntries(clock, "threshold")
		.filter((entry) => entry.delay === 30 * 60_000)
		.at(-1)?.id;
	assert.ok(secondThresholdId !== undefined);
	await pi.emit("session_shutdown", {}, ctx);
	assert.equal(clock.pending(), 0, "shutdown clears every timer");
	clock.fireStale(secondThresholdId);
	assert.equal(pi.messages.length, 0, "post-shutdown callback is inert");
	assert.equal(ctx.statuses.length, settledStatuses + 3);
	assert.deepEqual(ctx.statuses.at(-1), ["pi-watchdog", undefined]);
});

test("status content lists every count, limit, and state; details mirror it", async () => {
	const { extension, clock } = fixture();
	const rootPi = new FakePi();
	const childPi = new FakePi();
	const root = new FakeContext("root", true);
	const child = new FakeContext("child", false);
	extension(rootPi.asAPI());
	extension(childPi.asAPI());
	const tool = await rootReady(rootPi, root);
	await childPi.emit("session_start", {}, child);
	await rootPi.emit("agent_start", {}, root);
	await rootPi.emit("message_start", { message: { role: "user" } }, root);
	await childPi.emit("message_start", { message: { role: "user" } }, child);
	await childPi.emit("turn_end", {}, child);
	await rootPi.emit("turn_end", {}, root);
	clock.value = 65_000;
	const status = await control(tool, "status");
	const text = status.content[0].text;
	for (const line of [
		"main/root loops: 1",
		"observed child loops: 1",
		"observed child sessions: 1",
		"observed total loops: 2",
		"limits: main=100; observed-total=500; wall-clock=30m",
		"wall-clock elapsed: 1 minute",
		"root active: true",
		"latched warnings: none",
		"coverage: Observable total includes the root",
	])
		assert.ok(text.includes(line), `status content must include "${line}"`);
	assert.equal(status.details.mainLoops, 1);
	assert.equal(status.details.observedChildLoops, 1);
	assert.equal(status.details.observedChildSessions, 1);
	assert.equal(status.details.observedTotalLoops, 2);
	assert.deepEqual(status.details.limits, {
		mainLoopLimit: 100,
		observedTotalLoopLimit: 500,
		wallClockMinutes: 30,
	});
	assert.equal(status.details.wallClockElapsedMs, 65_000);
	assert.equal(status.details.rootActive, true);
	assert.deepEqual(status.details.latchedWarnings, []);
	assert.ok(status.details.coverage.includes("Observable total"));
});

test("RPC role-aware collision keeps a 30s threshold and status ticker independent", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true);
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	clock.value = 30_000;
	await control(tool, "set_limits", { wallClockMinutes: 1 });
	const threshold = clock.live("threshold");
	const rpcStatus = clock.live("rpc-status");
	assert.equal(threshold.delay, 30_000);
	assert.equal(rpcStatus.delay, 30_000);
	assert.notEqual(
		threshold.id,
		rpcStatus.id,
		"same delay still has two handles",
	);
	const statusesBeforeThreshold = ctx.statuses.length;
	clock.value = 60_000;
	clock.fire(threshold.id);
	assert.equal(
		pi.messages.length,
		1,
		"threshold delivers exactly one wall warning",
	);
	assert.match(pi.messages[0].message.content ?? "", /^time/);
	assert.equal(
		clock.live("rpc-status").id,
		rpcStatus.id,
		"threshold leaves status tick live",
	);
	assert.equal(clock.pending(), 1, "latched threshold does not rearm");
	clock.fireStale(threshold.id);
	assert.equal(pi.messages.length, 1, "stale threshold copy is inert");
	assert.equal(
		ctx.statuses.length,
		statusesBeforeThreshold + 2,
		"threshold warning and its schedule completion update status, never the status-tick callback",
	);
	clock.fire(rpcStatus.id);
	assert.equal(
		pi.messages.length,
		1,
		"status tick cannot repeat a latched warning",
	);
	assert.equal(clock.pending(), 1, "only the rearmed rpc status timer remains");
	const nextStatus = clock.live("rpc-status");
	assert.notEqual(
		nextStatus.id,
		rpcStatus.id,
		"status tick alone rearms itself",
	);
	clock.fireStale(rpcStatus.id);
	assert.equal(
		clock.live("rpc-status").id,
		nextStatus.id,
		"stale status copy is inert",
	);
});
