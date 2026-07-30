import assert from "node:assert/strict";
import test from "node:test";

import type { TSchema } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

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
	execute(id: string, params: ControlParams): Promise<ControlResult>;
};
type Mode = "tui" | "rpc" | "print" | "json";
type RenderableComponent = {
	render(width: number): string[];
	dispose?(): void;
};
type WidgetEntry = {
	content: unknown;
	options?: { placement?: string };
};

const TICK_MS = 1_000;

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
	liveTimers(
		role: "threshold" | "tui-refresh" | "rpc-status",
	): Array<{ id: number; role: string; delay: number }> {
		return this.scheduled.filter(
			(entry) => entry.role === role && this.liveCallbacks.has(entry.id),
		);
	}
	liveTickers(): Array<{ id: number; role: string; delay: number }> {
		return this.liveTimers("tui-refresh");
	}
	liveThresholds(): Array<{ id: number; role: string; delay: number }> {
		return this.liveTimers("threshold");
	}
	liveTicker(): { id: number; role: string; delay: number } {
		const live = this.liveTickers();
		assert.equal(live.length, 1, "exactly one live widget ticker");
		return live[0];
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
	readonly widgetCalls: Array<{
		key: string;
		content: unknown;
		options?: { placement?: string };
	}> = [];
	readonly widgets = new Map<string, WidgetEntry>();
	requestRenderCalls = 0;
	readonly tui = {
		requestRender: (): void => {
			this.requestRenderCalls += 1;
		},
	} as Pick<TUI, "requestRender">;
	constructor(
		readonly sessionId: string,
		readonly hasUI: boolean,
		readonly mode: Mode,
	) {}
	readonly cwd = "/work";
	isProjectTrusted = (): boolean => false;
	isIdle = (): boolean => false;
	readonly sessionManager = { getSessionId: (): string => this.sessionId };
	readonly ui = {
		notify: (message: string, kind?: "info" | "warning" | "error"): void => {
			this.notifications.push([message, kind]);
		},
		setStatus: (key: string, value: string | undefined): void => {
			this.statuses.push([key, value]);
		},
		setWidget: (
			key: string,
			content: unknown,
			options?: { placement?: string },
		): void => {
			this.widgetCalls.push({ key, content, options });
			if (content === undefined) this.widgets.delete(key);
			else this.widgets.set(key, { content, options });
		},
	};
	asContext(): ExtensionContext {
		return this as unknown as ExtensionContext; // Runtime only consumes the documented fields implemented above.
	}
	widgetComponent(): RenderableComponent {
		const entry = this.widgets.get("pi-watchdog");
		assert.ok(entry, "watchdog widget must be installed");
		assert.equal(typeof entry.content, "function");
		const factory = entry.content as (
			tui: Pick<TUI, "requestRender">,
			theme: { fg(color: string, text: string): string },
		) => RenderableComponent;
		return factory(this.tui, { fg: (_color: string, text: string) => text });
	}
	widgetLine(width = 200): string {
		const lines = this.widgetComponent().render(width);
		assert.equal(lines.length, 1, "widget renders exactly one line");
		return lines[0];
	}
	resetNotifications(): Array<string> {
		return this.notifications
			.filter(([message]) => message.startsWith("Watchdog reset |"))
			.map(([message]) => message);
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

function thresholdAt(clock: FakeClock, delay: number): number {
	const entries = clock.scheduled.filter(
		(entry) => entry.role === "threshold" && entry.delay === delay,
	);
	const live = clock.liveThresholds().find((entry) => entry.delay === delay);
	assert.ok(live ?? entries.at(-1), `threshold timer ${delay} must exist`);
	return (live ?? entries.at(-1))?.id ?? 0;
}

test("TUI root gets exactly one belowEditor widget and an idle zero line", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	assert.equal(ctx.widgetCalls.length, 1);
	assert.equal(ctx.widgetCalls[0].key, "pi-watchdog");
	assert.deepEqual(ctx.widgetCalls[0].options, { placement: "belowEditor" });
	assert.deepEqual(
		ctx.statuses,
		[["pi-watchdog", undefined]],
		"TUI installs the widget and clears any stale footer status",
	);
	assert.equal(
		ctx.widgetLine(),
		"Watchdog | idle · active 0s/0 loops · task 0s/30m · root 0/100 · observed 0/500",
	);
	assert.equal(clock.pending(), 0, "no ticker or threshold while idle");
});

test("isolated roots get mode-specific refresh tickers while observers get none", async () => {
	async function activeRoot(mode: Mode, hasUI: boolean) {
		const local = fixture();
		const pi = new FakePi();
		const ctx = new FakeContext(mode, hasUI, mode);
		local.extension(pi.asAPI());
		await rootReady(pi, ctx);
		await pi.emit("agent_start", {}, ctx);
		await pi.emit("message_start", { message: { role: "user" } }, ctx);
		return { ...local, pi, ctx };
	}

	const tui = await activeRoot("tui", true);
	assert.equal(
		tui.clock.liveTimers("tui-refresh").length,
		1,
		"TUI gets one 1s redraw ticker",
	);
	assert.equal(
		tui.clock.liveTimers("rpc-status").length,
		0,
		"TUI gets no RPC ticker",
	);

	const rpc = await activeRoot("rpc", true);
	assert.equal(rpc.ctx.widgetCalls.length, 0, "RPC gets no widget");
	assert.equal(
		rpc.clock.liveTimers("tui-refresh").length,
		0,
		"RPC gets no 1s ticker",
	);
	assert.equal(
		rpc.clock.liveTimers("rpc-status").length,
		1,
		"RPC gets one 30s status ticker",
	);
	const statusesBefore = rpc.ctx.statuses.length;
	rpc.clock.value = 30_000;
	rpc.clock.fire(rpc.clock.liveTimers("rpc-status")[0].id);
	assert.equal(
		rpc.ctx.statuses.length,
		statusesBefore + 1,
		"RPC tick refreshes status",
	);
	assert.equal(
		rpc.clock.liveTimers("rpc-status").length,
		1,
		"RPC ticker rearms",
	);

	for (const mode of ["print", "json"] as const) {
		const root = await activeRoot(mode, false);
		assert.equal(
			root.clock.liveTimers("tui-refresh").length,
			0,
			`${mode} gets no 1s ticker`,
		);
		assert.equal(
			root.clock.liveTimers("rpc-status").length,
			0,
			`${mode} gets no status ticker`,
		);
	}

	const { extension, clock } = fixture();
	const rootPi = new FakePi();
	const childPi = new FakePi();
	const root = new FakeContext("root", true, "tui");
	const child = new FakeContext("child", false, "tui");
	extension(rootPi.asAPI());
	extension(childPi.asAPI());
	await rootReady(rootPi, root);
	await childPi.emit("session_start", {}, child);
	await rootPi.emit("agent_start", {}, root);
	await rootPi.emit("message_start", { message: { role: "user" } }, root);
	await childPi.emit("agent_start", {}, child);
	await childPi.emit("message_start", { message: { role: "user" } }, child);
	assert.equal(
		clock.liveTimers("tui-refresh").length,
		1,
		"observer owns no ticker",
	);
	assert.equal(child.widgetCalls.length, 0, "observer gets no widget");
});

test("live widget shows the exact approved format from events", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const childPi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	const child = new FakeContext("child", false, "tui");
	extension(pi.asAPI());
	extension(childPi.asAPI());
	await rootReady(pi, ctx);
	await childPi.emit("session_start", {}, child);
	await pi.emit("agent_start", {}, ctx);
	clock.value = 0;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	// Drive the approved example numbers: root 37 turns, 1 observed child turn,
	// active window at 2h14m with 137 root loops needs a long window; instead
	// assert the same format shape with the small deterministic values.
	for (let i = 0; i < 37; i += 1) await pi.emit("turn_end", {}, ctx);
	await childPi.emit("message_start", { message: { role: "user" } }, child);
	await childPi.emit("turn_end", {}, child);
	clock.value = 12 * 60_000 + 40_000;
	assert.equal(
		ctx.widgetLine(),
		"Watchdog | active 12m40s/37 loops · task 12m40s/30m · root 37/100 · observed 38/500",
	);
});

test("a bound running child keeps the active window after root settle", async () => {
	const { extension, clock } = fixture();
	const rootPi = new FakePi();
	const childPi = new FakePi();
	const root = new FakeContext("root", true, "tui");
	const child = new FakeContext("child", false, "tui");
	extension(rootPi.asAPI());
	extension(childPi.asAPI());
	await rootReady(rootPi, root);
	await childPi.emit("session_start", {}, child);
	await rootPi.emit("agent_start", {}, root);
	await rootPi.emit("message_start", { message: { role: "user" } }, root);
	clock.value = 1_000;
	await childPi.emit("message_start", { message: { role: "user" } }, child);
	await childPi.emit("agent_start", {}, child);
	clock.value = 2_000;
	await rootPi.emit("agent_settled", {}, root);
	clock.value = 5_000;

	assert.equal(
		root.widgetLine(),
		"Watchdog | active 5s/0 loops · task 2s/30m · root 0/100 · observed 0/500",
	);
	assert.deepEqual(root.resetNotifications(), []);
	assert.equal(clock.liveTimers("threshold").length, 0);
	assert.equal(clock.liveTimers("tui-refresh").length, 1);
});

test("the final bound child settle closes the window once", async () => {
	const { extension, clock } = fixture();
	const rootPi = new FakePi();
	const childAPi = new FakePi();
	const childBPi = new FakePi();
	const root = new FakeContext("root", true, "tui");
	const childA = new FakeContext("child-a", false, "tui");
	const childB = new FakeContext("child-b", false, "tui");
	extension(rootPi.asAPI());
	extension(childAPi.asAPI());
	extension(childBPi.asAPI());
	await rootReady(rootPi, root);
	await childAPi.emit("session_start", {}, childA);
	await childBPi.emit("session_start", {}, childB);
	await rootPi.emit("agent_start", {}, root);
	await rootPi.emit("message_start", { message: { role: "user" } }, root);
	await childAPi.emit("message_start", { message: { role: "user" } }, childA);
	await childBPi.emit("message_start", { message: { role: "user" } }, childB);
	await childAPi.emit("agent_start", {}, childA);
	await childBPi.emit("agent_start", {}, childB);
	clock.value = 1_000;
	await rootPi.emit("agent_settled", {}, root);
	clock.value = 2_000;
	await childAPi.emit("agent_settled", {}, childA);
	assert.match(root.widgetLine(), /^Watchdog \| active 2s\/0 loops/);
	assert.deepEqual(root.resetNotifications(), []);

	clock.value = 3_000;
	await childBPi.emit("agent_settled", {}, childB);
	assert.equal(
		root.widgetLine(),
		"Watchdog | idle · active 0s/0 loops · task 1s/30m · root 0/100 · observed 0/500",
	);
	assert.deepEqual(root.resetNotifications(), [
		"Watchdog reset | active 3s/0 loops",
	]);
	assert.equal(clock.pending(), 0);
});

test("a child settling before root leaves the window active", async () => {
	const { extension, clock } = fixture();
	const rootPi = new FakePi();
	const childPi = new FakePi();
	const root = new FakeContext("root", true, "tui");
	const child = new FakeContext("child", false, "tui");
	extension(rootPi.asAPI());
	extension(childPi.asAPI());
	await rootReady(rootPi, root);
	await childPi.emit("session_start", {}, child);
	await rootPi.emit("agent_start", {}, root);
	await rootPi.emit("message_start", { message: { role: "user" } }, root);
	await childPi.emit("message_start", { message: { role: "user" } }, child);
	await childPi.emit("agent_start", {}, child);
	clock.value = 1_000;
	await childPi.emit("agent_settled", {}, child);
	clock.value = 2_000;
	assert.match(root.widgetLine(), /^Watchdog \| active 2s\/0 loops/);
	assert.deepEqual(root.resetNotifications(), []);
	await rootPi.emit("agent_settled", {}, root);
	assert.deepEqual(root.resetNotifications(), [
		"Watchdog reset | active 2s/0 loops",
	]);
});

test("observer shutdown closes a root-settled active window once", async () => {
	const { extension, clock } = fixture();
	const rootPi = new FakePi();
	const childPi = new FakePi();
	const root = new FakeContext("root", true, "tui");
	const child = new FakeContext("child", false, "tui");
	extension(rootPi.asAPI());
	extension(childPi.asAPI());
	await rootReady(rootPi, root);
	await childPi.emit("session_start", {}, child);
	await rootPi.emit("agent_start", {}, root);
	await rootPi.emit("message_start", { message: { role: "user" } }, root);
	await childPi.emit("message_start", { message: { role: "user" } }, child);
	await childPi.emit("agent_start", {}, child);
	clock.value = 1_000;
	await rootPi.emit("agent_settled", {}, root);
	clock.value = 2_000;
	await childPi.emit("session_shutdown", {}, child);
	assert.equal(
		root.widgetLine(),
		"Watchdog | idle · active 0s/0 loops · task 1s/30m · root 0/100 · observed 0/500",
	);
	assert.deepEqual(root.resetNotifications(), [
		"Watchdog reset | active 2s/0 loops",
	]);
});

test("a root start after full quiescence stays idle until the next user task", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	clock.value = 1_000;
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(ctx.resetNotifications(), [
		"Watchdog reset | active 1s/0 loops",
	]);

	clock.value = 2_000;
	await pi.emit("agent_start", {}, ctx);
	assert.equal(
		ctx.widgetLine(),
		"Watchdog | idle · active 0s/0 loops · task 1s/30m · root 0/100 · observed 0/500",
	);
	assert.equal(clock.pending(), 0, "admission alone owns no timers");
	assert.deepEqual(ctx.resetNotifications(), [
		"Watchdog reset | active 1s/0 loops",
	]);

	clock.value = 3_000;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	assert.equal(
		ctx.widgetLine(),
		"Watchdog | active 0s/0 loops · task 0s/30m · root 0/100 · observed 0/500",
	);
	assert.equal(clock.liveTimers("tui-refresh").length, 1);
	assert.equal(clock.liveTimers("threshold").length, 1);
	assert.deepEqual(ctx.resetNotifications(), [
		"Watchdog reset | active 1s/0 loops",
	]);
});

test("a root continuation rejoins a child-held active task", async () => {
	const { extension, clock } = fixture();
	const rootPi = new FakePi();
	const childPi = new FakePi();
	const root = new FakeContext("root", true, "tui");
	const child = new FakeContext("child", false, "tui");
	extension(rootPi.asAPI());
	extension(childPi.asAPI());
	await rootReady(rootPi, root);
	await childPi.emit("session_start", {}, child);
	await rootPi.emit("agent_start", {}, root);
	await rootPi.emit("message_start", { message: { role: "user" } }, root);
	await childPi.emit("message_start", { message: { role: "user" } }, child);
	await childPi.emit("agent_start", {}, child);
	clock.value = 40_000;
	await rootPi.emit("agent_settled", {}, root);
	clock.value = 100_000;
	await rootPi.emit("agent_start", {}, root);
	assert.match(root.widgetLine(), /^Watchdog \| active 1m40s\/0 loops/);
	assert.equal(clock.liveTimers("threshold").length, 1);
	assert.equal(clock.liveTimers("tui-refresh").length, 1);
	clock.value = 120_000;
	await rootPi.emit("turn_end", {}, root);
	assert.equal(
		root.widgetLine(),
		"Watchdog | active 2m0s/1 loops · task 1m0s/30m · root 1/100 · observed 1/500",
	);
	assert.deepEqual(root.resetNotifications(), []);
});

test("active excludes settled idle and the next task starts at zero", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	clock.value = 0;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("turn_end", {}, ctx);
	clock.value = 5_000;
	await pi.emit("agent_settled", {}, ctx);
	// Idle for a long gap: active time must not accrue.
	clock.value = 600_000;
	await pi.emit("agent_start", {}, ctx);
	clock.value = 601_000;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	clock.value = 603_500;
	assert.equal(
		ctx.widgetLine(),
		"Watchdog | active 2s/0 loops · task 2s/30m · root 0/100 · observed 0/500",
	);
});

test("root turn increments active and root; observer increments observed only", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const childPi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	const child = new FakeContext("child", false, "tui");
	extension(pi.asAPI());
	extension(childPi.asAPI());
	const tool = await rootReady(pi, ctx);
	await childPi.emit("session_start", {}, child);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("turn_end", {}, ctx);
	clock.value = 2_000;
	assert.match(
		ctx.widgetLine(),
		/active 2s\/1 loops · task 2s\/30m · root 1\/100 · observed 1\/500/,
	);
	await childPi.emit("message_start", { message: { role: "user" } }, child);
	await childPi.emit("turn_end", {}, child);
	assert.equal((await control(tool, "status")).details.observedChildLoops, 1);
	clock.value = 3_000;
	assert.match(
		ctx.widgetLine(),
		/active 3s\/1 loops · task 3s\/30m · root 1\/100 · observed 2\/500/,
	);
});

test("manual reset zeroes the cycle counters but active continues", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("turn_end", {}, ctx);
	clock.value = 5_000;
	await control(tool, "reset");
	assert.deepEqual(ctx.resetNotifications(), [], "manual reset never prints");
	clock.value = 6_000;
	assert.equal(
		ctx.widgetLine(),
		"Watchdog | active 6s/1 loops · task 1s/30m · root 0/100 · observed 0/500",
	);
	await pi.emit("turn_end", {}, ctx);
	clock.value = 7_000;
	assert.equal(
		ctx.widgetLine(),
		"Watchdog | active 7s/2 loops · task 2s/30m · root 1/100 · observed 1/500",
	);
});

test("threshold crossings and limit operations never print the reset line", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await control(tool, "set_limits", { wallClockMinutes: 1 });
	clock.value = 60_000;
	clock.fire(thresholdAt(clock, 60_000));
	assert.equal(pi.messages.length, 1, "threshold warning still delivered");
	await control(tool, "set_limits", { wallClockMinutes: 2 });
	await control(tool, "restore_defaults");
	await control(tool, "reset");
	assert.deepEqual(ctx.resetNotifications(), []);
	// The active window survived every threshold and control operation.
	clock.value = 70_000;
	assert.match(ctx.widgetLine(), /^Watchdog \| active 1m10s\/0 loops/);
});

test("settle prints the pre-reset snapshot once, then the widget idles at zero", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	clock.value = 0;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("turn_end", {}, ctx);
	clock.value = 65_000;
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(ctx.resetNotifications(), [
		"Watchdog reset | active 1m5s/1 loops",
	]);
	assert.equal(pi.messages.length, 0, "reset print never enters model context");
	assert.equal(
		ctx.widgetLine(),
		"Watchdog | idle · active 0s/0 loops · task 1m5s/30m · root 1/100 · observed 1/500",
	);
	assert.equal(clock.pending(), 0, "settle stops the ticker");
	// The next task starts live from zero.
	await pi.emit("agent_start", {}, ctx);
	clock.value = 70_000;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	clock.value = 72_000;
	assert.equal(
		ctx.widgetLine(),
		"Watchdog | active 2s/0 loops · task 2s/30m · root 0/100 · observed 0/500",
	);
});

test("interjecting root user message prints the old window once; later settle does not duplicate", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	clock.value = 0;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("turn_end", {}, ctx);
	clock.value = 10_000;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	assert.deepEqual(ctx.resetNotifications(), [
		"Watchdog reset | active 10s/1 loops",
	]);
	clock.value = 13_000;
	assert.match(ctx.widgetLine(), /^Watchdog \| active 3s\/0 loops/);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(ctx.resetNotifications(), [
		"Watchdog reset | active 10s/1 loops",
		"Watchdog reset | active 3s/0 loops",
	]);
});

test("settle after an interjection snapshots the replacement window once", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	clock.value = 0;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	clock.value = 10_000;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(ctx.resetNotifications(), [
		"Watchdog reset | active 10s/0 loops",
		"Watchdog reset | active 0s/0 loops",
	]);
});

test("settle before an armed window begins emits no empty duplicate", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	clock.value = 0;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("agent_settled", {}, ctx);
	// A task inserted while idle arms the next window but begins nothing.
	clock.value = 5_000;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(ctx.resetNotifications(), [
		"Watchdog reset | active 0s/0 loops",
	]);
});

test("no print when no active window existed", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_settled", {}, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	clock.value = 1_000;
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	assert.deepEqual(ctx.resetNotifications(), []);
});

test("narrow width truncates through the real component render", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("turn_end", {}, ctx);
	clock.value = 8_040_000;
	const full = ctx.widgetLine(200);
	const narrow = ctx.widgetLine(40);
	assert.equal(narrow, truncateToWidth(full, 40));
	assert.ok(visibleWidth(narrow) <= 40);
});

test("ticker refreshes at ~1s while active and stops when idle", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	assert.equal(clock.liveTickers().length, 0, "no ticker while idle");
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	assert.equal(
		ctx.widgetLine(),
		"Watchdog | active 0s/0 loops · task 0s/30m · root 0/100 · observed 0/500",
		"initial renderer pass installs the context-bound redraw callback",
	);
	const tick = clock.liveTicker();
	assert.equal(tick.delay, TICK_MS);
	const callsBefore = ctx.widgetCalls.length;
	const rendersBefore = ctx.requestRenderCalls;
	clock.value = 1_000;
	clock.fire(tick.id);
	const followUp = clock.liveTicker();
	assert.equal(
		ctx.requestRenderCalls,
		rendersBefore + 1,
		"each valid TUI tick requests exactly one real renderer refresh",
	);
	assert.equal(
		ctx.widgetCalls.length,
		callsBefore,
		"tick refreshes the live component without reinstalling the widget",
	);
	clock.value = 2_000;
	// This models the TUI's render pass after requestRender rather than treating
	// manual component rendering as evidence that a refresh was requested.
	assert.equal(
		ctx.widgetLine(),
		"Watchdog | active 2s/0 loops · task 2s/30m · root 0/100 · observed 0/500",
		"renderer sees the current line after the requested refresh",
	);
	assert.equal(clock.liveTickers().length, 1, "ticker re-arms exactly once");
	assert.equal(clock.pending(), 2, "threshold timer plus one ticker");
	clock.fireStale(tick.id);
	assert.equal(
		ctx.requestRenderCalls,
		rendersBefore + 1,
		"stale tick cannot redraw",
	);
	assert.equal(
		clock.liveTickers().length,
		1,
		"stale tick cannot arm a duplicate ticker",
	);
	assert.equal(
		clock.liveTickers()[0].id,
		followUp.id,
		"stale tick leaves the live follow-up tick untouched",
	);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(clock.pending(), 0, "settle stops every root timer");
	assert.equal(clock.liveTickers().length, 0);
	const redrawsAfterSettle = ctx.requestRenderCalls;
	clock.fireStale(followUp.id);
	assert.equal(
		ctx.requestRenderCalls,
		redrawsAfterSettle,
		"settled ticker cannot redraw or rearm",
	);
	assert.equal(clock.liveTickers().length, 0);
});

test("demotion clears the widget and ticker; the replacement owns a fresh widget", async () => {
	const { extension, clock } = fixture();
	const fallbackPi = new FakePi();
	const uiPi = new FakePi();
	const fallback = new FakeContext("fallback", false, "rpc");
	const ui = new FakeContext("ui", true, "tui");
	extension(fallbackPi.asAPI());
	extension(uiPi.asAPI());
	const staleTool = await rootReady(fallbackPi, fallback);
	await fallbackPi.emit("agent_start", {}, fallback);
	await fallbackPi.emit(
		"message_start",
		{ message: { role: "user" } },
		fallback,
	);
	assert.equal(fallback.widgets.size, 0, "RPC fallback never had a widget");
	assert.equal(
		fallback.statuses.at(-1)?.[0],
		"pi-watchdog",
		"fallback keeps footer status",
	);
	// A UI candidate outranks the headless fallback and demotes it; the
	// replacement TUI root owns the dedicated widget and the only ticker.
	await rootReady(uiPi, ui);
	assert.deepEqual(fallback.statuses.at(-1), ["pi-watchdog", undefined]);
	assert.equal(ui.widgets.size, 1, "replacement TUI root owns the widget");
	await uiPi.emit("agent_start", {}, ui);
	await uiPi.emit("message_start", { message: { role: "user" } }, ui);
	assert.equal(clock.liveTickers().length, 1, "only the replacement ticks");
	await assert.rejects(() => control(staleTool, "status"), /current root/);
	assert.deepEqual(ui.resetNotifications(), []);
	assert.deepEqual(
		fallback.resetNotifications(),
		[],
		"demotion never emits the reset notification",
	);
});

test("the dedicated widget key leaves foreign widgets and statuses untouched", async () => {
	const { extension } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	ctx.ui.setWidget("other-ext", ["foreign"], { placement: "belowEditor" });
	ctx.ui.setStatus("other-ext", "foreign status");
	await rootReady(pi, ctx);
	assert.ok(ctx.widgets.has("other-ext"), "foreign widget survives install");
	assert.ok(
		ctx.statuses.some(
			([key, value]) => key === "other-ext" && value === "foreign status",
		),
		"foreign footer status is never cleared",
	);
	await pi.emit("session_shutdown", {}, ctx);
	assert.ok(ctx.widgets.has("other-ext"), "foreign widget survives cleanup");
	assert.equal(ctx.widgets.size, 1, "only the watchdog widget was removed");
});

test("root shutdown demotes a TUI root: widget clears and the equal-priority replacement starts fresh", async () => {
	const { extension, clock } = fixture();
	const oldPi = new FakePi();
	const replacementPi = new FakePi();
	const old = new FakeContext("old", true, "tui");
	const replacement = new FakeContext("replacement", true, "tui");
	extension(oldPi.asAPI());
	extension(replacementPi.asAPI());
	await rootReady(oldPi, old);
	await oldPi.emit("agent_start", {}, old);
	await oldPi.emit("message_start", { message: { role: "user" } }, old);
	assert.equal(clock.liveTickers().length, 1);
	await oldPi.emit("session_shutdown", {}, old);
	assert.equal(old.widgets.size, 0, "shutdown clears the old widget");
	assert.equal(clock.liveTickers().length, 0, "old ticker stops");
	await rootReady(replacementPi, replacement);
	assert.equal(replacement.widgets.size, 1, "replacement owns a fresh widget");
	assert.equal(
		replacement.widgetLine(),
		"Watchdog | idle · active 0s/0 loops · task 0s/30m · root 0/100 · observed 0/500",
		"replacement starts from the idle zero state",
	);
	await replacementPi.emit("agent_start", {}, replacement);
	await replacementPi.emit(
		"message_start",
		{ message: { role: "user" } },
		replacement,
	);
	assert.equal(clock.liveTickers().length, 1, "replacement owns the ticker");
	assert.deepEqual(replacement.resetNotifications(), []);
	assert.deepEqual(old.resetNotifications(), []);
});

test("shutdown clears the widget and timers and emits nothing", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	ctx.widgetLine();
	assert.ok(clock.pending() > 0);
	const ticker = clock.liveTicker();
	await pi.emit("session_shutdown", {}, ctx);
	assert.equal(ctx.widgets.size, 0, "shutdown clears the widget");
	assert.equal(clock.pending(), 0);
	const redrawsBeforeStale = ctx.requestRenderCalls;
	clock.fireStale(ticker.id);
	assert.equal(
		ctx.requestRenderCalls,
		redrawsBeforeStale,
		"stale callback cannot redraw",
	);
	assert.deepEqual(ctx.resetNotifications(), []);
	assert.equal(ctx.widgetCalls.at(-1)?.content, undefined);
});

test("TUI role-aware collision keeps a 1s threshold and redraw ticker independent", async () => {
	const { extension, clock } = fixture();
	const pi = new FakePi();
	const ctx = new FakeContext("root", true, "tui");
	extension(pi.asAPI());
	const tool = await rootReady(pi, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	clock.value = 59_000;
	await control(tool, "set_limits", { wallClockMinutes: 1 });
	ctx.widgetLine();
	const threshold = clock.liveTimers("threshold")[0];
	const refresh = clock.liveTimers("tui-refresh")[0];
	assert.equal(threshold.delay, TICK_MS);
	assert.equal(refresh.delay, TICK_MS);
	assert.notEqual(threshold.id, refresh.id, "same delay still has two handles");
	const rendersBeforeThreshold = ctx.requestRenderCalls;
	clock.value = 60_000;
	clock.fire(threshold.id);
	assert.equal(
		pi.messages.length,
		1,
		"threshold delivers exactly one wall warning",
	);
	assert.equal(
		ctx.requestRenderCalls,
		rendersBeforeThreshold,
		"threshold never redraws",
	);
	assert.equal(
		clock.liveTimers("tui-refresh")[0].id,
		refresh.id,
		"threshold leaves redraw tick live",
	);
	assert.equal(clock.pending(), 1, "latched threshold does not rearm");
	clock.fireStale(threshold.id);
	assert.equal(pi.messages.length, 1, "stale threshold copy is inert");
	assert.equal(ctx.requestRenderCalls, rendersBeforeThreshold);
	clock.fire(refresh.id);
	assert.equal(
		pi.messages.length,
		1,
		"redraw tick cannot repeat a latched warning",
	);
	assert.equal(
		ctx.requestRenderCalls,
		rendersBeforeThreshold + 1,
		"refresh requests exactly one render",
	);
	assert.equal(clock.pending(), 1, "only the rearmed redraw timer remains");
	const nextRefresh = clock.liveTimers("tui-refresh")[0];
	assert.notEqual(
		nextRefresh.id,
		refresh.id,
		"refresh tick alone rearms itself",
	);
	clock.fireStale(refresh.id);
	assert.equal(
		ctx.requestRenderCalls,
		rendersBeforeThreshold + 1,
		"stale redraw copy is inert",
	);
	assert.equal(clock.liveTimers("tui-refresh")[0].id, nextRefresh.id);
});
