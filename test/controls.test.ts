import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { LoadedConfig } from "../src/config-loader.js";
import { parseWatchdogCommand } from "../src/controls.js";
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
type Handler = (
	event: { message?: { role?: string } },
	ctx: Context,
) => unknown | Promise<unknown>;
type Command = {
	name: string;
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

class Clock {
	value = 0;
	now = (): number => this.value;
	setTimeout = (callback: () => void): ReturnType<typeof setTimeout> =>
		({ callback, unref() {} }) as unknown as ReturnType<typeof setTimeout>;
	clearTimeout = (): void => {};
}

class Context {
	notifications: Array<[string, string | undefined]> = [];
	statuses: Array<[string, string | undefined]> = [];
	editorResult: string | undefined;
	editorCalls: Array<[string, string]> = [];
	readonly sessionManager: { getSessionId(): string };
	constructor(
		readonly sessionId: string,
		readonly hasUI: boolean,
		sessionManager?: { getSessionId(): string },
	) {
		this.sessionManager = sessionManager ?? {
			getSessionId: (): string => this.sessionId,
		};
	}
	cwd = "/work";
	mode: "tui" | "rpc" | "print" | "json" = "rpc";
	isProjectTrusted = (): boolean => false;
	isIdle = (): boolean => false;
	ui = {
		notify: (message: string, kind?: "info" | "warning" | "error"): void => {
			this.notifications.push([message, kind]);
		},
		setStatus: (key: string, value: string | undefined): void => {
			this.statuses.push([key, value]);
		},
		setWidget: (): void => {},
		editor: async (
			title: string,
			initial: string,
		): Promise<string | undefined> => {
			this.editorCalls.push([title, initial]);
			return this.editorResult;
		},
	};
	asExtension(): ExtensionContext {
		return this as unknown as ExtensionContext;
	}
	asCommand(): ExtensionCommandContext {
		return this as unknown as ExtensionCommandContext;
	}
}

class Pi {
	handlers = new Map<EventName, Handler>();
	commands: Command[] = [];
	messages: unknown[] = [];
	activeTools: string[] = [];
	on(event: EventName, handler: Handler): void {
		this.handlers.set(event, handler);
	}
	registerCommand(name: string, command: Omit<Command, "name">): void {
		this.commands.push({ name, ...command });
	}
	registerTool(): void {}
	getActiveTools(): string[] {
		return this.activeTools;
	}
	setActiveTools(names: string[]): void {
		this.activeTools = names;
	}
	sendMessage(message: unknown): void {
		this.messages.push(message);
	}
	async emit(event: EventName, ctx: Context, role?: string): Promise<void> {
		await this.handlers.get(event)?.(
			{ message: role ? { role } : undefined },
			ctx,
		);
	}
	asAPI(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}
}

function config(): LoadedConfig {
	return {
		config: {
			mainLoopLimit: 100,
			observedTotalLoopLimit: 500,
			wallClockMinutes: 30,
			prompts: {
				mainLoopLimitReached: "configured main",
				observedTotalLoopLimitReached: "configured total",
				wallClockLimitReached: "configured time",
			},
		},
		diagnostics: [],
	};
}
function setup() {
	delete (globalThis as typeof globalThis & { [HUB_SYMBOL]?: unknown })[
		HUB_SYMBOL
	];
	const clock = new Clock();
	const extension = createWatchdogExtension({
		now: clock.now,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		loadConfig: async () => config(),
	} satisfies Partial<RuntimeServices>);
	return { clock, extension };
}
async function commandReady(pi: Pi, ctx: Context): Promise<Command> {
	await pi.emit("session_start", ctx);
	assert.equal(pi.commands.length, 1);
	return pi.commands[0];
}

test("only the winning root dynamically registers /watchdog and stale handler cannot mutate replacement", async () => {
	const { extension } = setup();
	const fallbackPi = new Pi();
	const rootPi = new Pi();
	const observerPi = new Pi();
	const fallback = new Context("fallback", false);
	const root = new Context("root", true);
	const observer = new Context("child", false);
	extension(fallbackPi.asAPI());
	extension(rootPi.asAPI());
	extension(observerPi.asAPI());
	const stale = await commandReady(fallbackPi, fallback);
	await rootPi.emit("session_start", root);
	await observerPi.emit("session_start", observer);
	assert.equal(rootPi.commands.length, 1);
	assert.equal(observerPi.commands.length, 0);
	await stale.handler("limits 1 1 1", fallback.asCommand());
	assert.equal(
		fallback.notifications.length,
		0,
		"a stale command must not touch its stale UI wrapper",
	);
	await rootPi.commands[0].handler("status", root.asCommand());
	assert.match(root.notifications.at(-1)?.[0] ?? "", /main=100/);
});

test("status, reset, limits, and prompt controls preserve their separate state", async () => {
	const { extension, clock } = setup();
	const pi = new Pi();
	const ctx = new Context("root", true);
	extension(pi.asAPI());
	const command = await commandReady(pi, ctx);
	await pi.emit("agent_start", ctx);
	await pi.emit("message_start", ctx, "user");
	await pi.emit("turn_end", ctx);
	clock.value = 61_000;
	await command.handler("", ctx.asCommand());
	const status = ctx.notifications.at(-1)?.[0] ?? "";
	for (const phrase of [
		"root/main loops: 1",
		"observable total loops: 1",
		"task-cycle wall time: 1 minute",
		"latched warnings:",
		"coverage:",
		"active window: 1m1s/1 root loops",
	])
		assert.match(
			status,
			new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	ctx.editorResult = "temporary main";
	await command.handler("prompt main", ctx.asCommand());
	assert.deepEqual(ctx.editorCalls.at(-1), [
		"Watchdog main prompt",
		"configured main",
	]);
	await command.handler("limits 2 3 4", ctx.asCommand());
	await command.handler("reset", ctx.asCommand());
	await command.handler("status", ctx.asCommand());
	const resetStatus = ctx.notifications.at(-1)?.[0] ?? "";
	assert.match(resetStatus, /main=2; observed-total=3; wall-clock=4m/);
	assert.match(resetStatus, /active window: 1m1s\/1 root loops/);
	assert.equal(pi.messages.length, 0, "commands never create model turns");
	await command.handler("limits reset", ctx.asCommand());
	await command.handler("prompt show", ctx.asCommand());
	assert.match(ctx.notifications.at(-1)?.[0] ?? "", /temporary main/);
	await command.handler("prompt reset main", ctx.asCommand());
	await command.handler("prompt show", ctx.asCommand());
	assert.match(ctx.notifications.at(-1)?.[0] ?? "", /configured main/);
	ctx.editorResult = "temporary main again";
	await command.handler("prompt main", ctx.asCommand());
	await command.handler("prompt reset all", ctx.asCommand());
	await command.handler("prompt show", ctx.asCommand());
	assert.match(ctx.notifications.at(-1)?.[0] ?? "", /configured main/);
	await pi.emit("message_start", ctx, "user");
	await command.handler("prompt show", ctx.asCommand());
	assert.match(ctx.notifications.at(-1)?.[0] ?? "", /configured main/);
});

test("prompt editor cancel, empty values, non-UI calls, and invalid grammar are safe", async () => {
	const { extension } = setup();
	const pi = new Pi();
	const ctx = new Context("root", true);
	extension(pi.asAPI());
	const command = await commandReady(pi, ctx);
	ctx.editorResult = undefined;
	await command.handler("prompt main", ctx.asCommand());
	await command.handler("prompt show", ctx.asCommand());
	assert.match(ctx.notifications.at(-1)?.[0] ?? "", /configured main/);
	ctx.editorResult = "   ";
	await command.handler("prompt main", ctx.asCommand());
	assert.match(
		ctx.notifications.at(-1)?.[0] ?? "",
		/\/watchdog prompt reset main/,
	);
	await command.handler("limits 1 x 3", ctx.asCommand());
	assert.match(ctx.notifications.at(-1)?.[0] ?? "", /positive safe integers/);
	await pi.emit("session_shutdown", ctx);
	const headlessPi = new Pi();
	const noUi = new Context("headless-root", false);
	extension(headlessPi.asAPI());
	const headlessCommand = await commandReady(headlessPi, noUi);
	await headlessCommand.handler("status", noUi.asCommand());
	assert.match(noUi.notifications.at(-1)?.[0] ?? "", /Watchdog status/);
	await headlessCommand.handler("limits 2 3 4", noUi.asCommand());
	await headlessCommand.handler("reset", noUi.asCommand());
	await headlessCommand.handler("status", noUi.asCommand());
	assert.match(
		noUi.notifications.at(-1)?.[0] ?? "",
		/main=2; observed-total=3/,
	);
	await headlessCommand.handler("prompt main", noUi.asCommand());
	assert.match(
		noUi.notifications.at(-1)?.[0] ?? "",
		/requires a UI-capable root session/,
	);
});

test("command parser has deterministic whitespace and errors", () => {
	assert.deepEqual(parseWatchdogCommand("  limits  1 2 3 "), {
		command: {
			action: "limits-set",
			mainLoopLimit: 1,
			observedTotalLoopLimit: 2,
			wallClockMinutes: 3,
		},
	});
	for (const input of ["wat", "status extra", "prompt reset", "limits 0 2 3"])
		assert.ok("error" in parseWatchdogCommand(input));
});

test("every prompt alias seeds, saves, shows, resets, and reset all clears overrides", async () => {
	const { extension } = setup();
	const pi = new Pi();
	const ctx = new Context("root", true);
	extension(pi.asAPI());
	const command = await commandReady(pi, ctx);
	for (const alias of ["main", "total", "time"] as const) {
		ctx.editorResult = `temporary ${alias}`;
		await command.handler(`prompt ${alias}`, ctx.asCommand());
		assert.deepEqual(ctx.editorCalls.at(-1), [
			`Watchdog ${alias} prompt`,
			`configured ${alias}`,
		]);
		await command.handler("prompt show", ctx.asCommand());
		assert.match(
			ctx.notifications.at(-1)?.[0] ?? "",
			new RegExp(`temporary ${alias}`),
		);
		await command.handler(`prompt reset ${alias}`, ctx.asCommand());
	}
	ctx.editorResult = "temporary main";
	await command.handler("prompt main", ctx.asCommand());
	await command.handler("prompt reset all", ctx.asCommand());
	await command.handler("prompt show", ctx.asCommand());
	assert.match(ctx.notifications.at(-1)?.[0] ?? "", /configured main/);
	assert.match(ctx.notifications.at(-1)?.[0] ?? "", /configured total/);
	assert.match(ctx.notifications.at(-1)?.[0] ?? "", /configured time/);
});

test("deferred prompt editor revalidates after shutdown without touching stale UI", async () => {
	const { extension } = setup();
	const pi = new Pi();
	const ctx = new Context("root", true);
	extension(pi.asAPI());
	const command = await commandReady(pi, ctx);
	let resolveEditor!: (value: string | undefined) => void;
	ctx.ui.editor = async () =>
		new Promise<string | undefined>((resolve) => {
			resolveEditor = resolve;
		});
	const pending = command.handler("prompt main", ctx.asCommand());
	await Promise.resolve();
	await pi.emit("session_shutdown", ctx);
	resolveEditor("must not save");
	await pending;
	assert.equal(ctx.notifications.length, 0);
});

test("Pi command wrappers share a session manager while foreign or replaced managers are inert", async () => {
	const { extension } = setup();
	const pi = new Pi();
	const eventContext = new Context("root", true);
	extension(pi.asAPI());
	const command = await commandReady(pi, eventContext);
	const sameSessionWrapper = new Context(
		"root",
		true,
		eventContext.sessionManager,
	);
	await command.handler("status", sameSessionWrapper.asCommand());
	assert.match(
		sameSessionWrapper.notifications.at(-1)?.[0] ?? "",
		/Watchdog status/,
	);
	const foreignManager = new Context("root", true);
	await command.handler("limits 1 1 1", foreignManager.asCommand());
	assert.equal(
		foreignManager.notifications.length,
		0,
		"stale contexts stay untouched",
	);
	await pi.emit("session_shutdown", eventContext);
	const replacementPi = new Pi();
	const replacement = new Context("root", true);
	extension(replacementPi.asAPI());
	await commandReady(replacementPi, replacement);
	await command.handler("limits 1 1 1", replacement.asCommand());
	assert.equal(
		replacement.notifications.length,
		0,
		"old handler cannot target replacement",
	);
});

test("slash limit warnings remain UI-only across main, observed, and wall-clock boundaries", async () => {
	const { extension, clock } = setup();
	const pi = new Pi();
	const ctx = new Context("root", true);
	extension(pi.asAPI());
	const command = await commandReady(pi, ctx);
	await pi.emit("agent_start", ctx);
	await pi.emit("message_start", ctx, "user");
	await pi.emit("turn_end", ctx);
	clock.value = 60_000;
	await command.handler("limits 1 1 1", ctx.asCommand());
	assert.equal(pi.messages.length, 0, "slash limits must not steer the model");
	assert.match(ctx.notifications.at(-2)?.[0] ?? "", /mainLoopLimitReached/);
	assert.match(
		ctx.notifications.at(-2)?.[0] ?? "",
		/observedTotalLoopLimitReached/,
	);
	assert.match(ctx.notifications.at(-2)?.[0] ?? "", /wallClockLimitReached/);
	await command.handler("limits 2 2 2", ctx.asCommand());
	await command.handler("limits 1 1 1", ctx.asCommand());
	assert.equal(pi.messages.length, 0);
	assert.match(ctx.notifications.at(-2)?.[0] ?? "", /mainLoopLimitReached/);
});
