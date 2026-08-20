/* biome-ignore-all lint/suspicious/noExplicitAny: focused fake implements a dynamic ExtensionAPI event registry */
import assert from "node:assert/strict";
import test from "node:test";
import { createWatchdogExtension } from "../src/extension.js";
import {
	HUB_SYMBOL,
	REFLECT_WATCHDOG_API_SYMBOL,
	type ReflectWatchdogApi,
} from "../src/hub.js";
import type {
	ReflectDomainCoordinator,
	ReflectDomainCounters,
} from "../src/process-domain.js";
import { DEFAULT_REFLECTION_PROMPT } from "../src/prompts.js";

class Pi {
	handlers = new Map<string, (event: any, ctx: any) => any>();
	commands: Array<{ name: string; handler: (args: string, ctx: any) => any }> =
		[];
	tools: any[] = [];
	messages: any[] = [];
	entries: any[] = [];
	activeTools = ["read"];
	on(name: string, handler: (event: any, ctx: any) => any) {
		this.handlers.set(name, handler);
	}
	registerCommand(name: string, command: any) {
		this.commands.push({ name, handler: command.handler });
	}
	registerTool(tool: any) {
		this.tools.push(tool);
	}
	registerEntryRenderer() {}
	appendEntry(type: string, data: unknown) {
		this.entries.push({ type, data });
	}
	getActiveTools() {
		return this.activeTools;
	}
	setActiveTools(names: string[]) {
		this.activeTools = names;
	}
	sendMessage(message: unknown, options: unknown) {
		this.messages.push({ message, options });
	}
	async emit(name: string, event: any, ctx: any) {
		return await this.handlers.get(name)?.(event, ctx);
	}
}

function context() {
	const notifications: Array<[string, string | undefined]> = [];
	const manager = {
		getSessionId: () => "root",
		getBranch: () => [],
	};
	let idle = false;
	return {
		hasUI: true,
		mode: "rpc",
		cwd: "/work",
		isProjectTrusted: () => false,
		isIdle: () => idle,
		setIdle: (value: boolean) => {
			idle = value;
		},
		sessionManager: manager,
		ui: {
			notify: (text: string, kind?: string) => notifications.push([text, kind]),
			setStatus() {},
			setWidget() {},
		},
		notifications,
	};
}

function reset() {
	delete (globalThis as any)[HUB_SYMBOL];
	delete (globalThis as any)[REFLECT_WATCHDOG_API_SYMBOL];
}

function counter() {
	return { value: 0n, paused: false };
}

const counters: ReflectDomainCounters = {
	domainEpoch: "domain",
	revision: 1n,
	generation: 1n,
	certain: true,
	anyBusy: false,
	endLoopTimeMs: null,
	fence: { domainEpoch: "domain", generation: 1n },
	activeMs: counter(),
	activeLoops: counter(),
	taskMs: counter(),
	rootLoops: counter(),
	allLoops: counter(),
};

function fakeDomain(activityWrites: boolean[] = []): ReflectDomainCoordinator {
	let rootLoops = 0n;
	let allLoops = 0n;
	let activeLoops = 0n;
	let snapshot = counters;
	const listeners = new Set<(value: ReflectDomainCounters) => void>();
	return {
		rootProcess: true,
		get paused() {
			return snapshot.activeMs.paused;
		},
		async attach() {},
		async detach() {},
		async setBusy(_instance, busy) {
			activityWrites.push(busy);
		},
		async recordRootLoop() {
			rootLoops += 1n;
			allLoops += 1n;
			activeLoops += 1n;
			snapshot = {
				...snapshot,
				rootLoops: { ...snapshot.rootLoops, value: rootLoops },
				allLoops: { ...snapshot.allLoops, value: allLoops },
				activeLoops: { ...snapshot.activeLoops, value: activeLoops },
			};
			for (const listener of listeners) listener(snapshot);
			return snapshot;
		},
		async recordAllLoop() {
			return snapshot;
		},
		counters: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setIdleResetGapSeconds() {},
		async resetReminderCycle() {
			return snapshot;
		},
		async pause() {
			snapshot = {
				...snapshot,
				activeMs: { ...snapshot.activeMs, paused: true },
				activeLoops: { ...snapshot.activeLoops, paused: true },
				taskMs: { ...snapshot.taskMs, paused: true },
				rootLoops: { ...snapshot.rootLoops, paused: true },
				allLoops: { ...snapshot.allLoops, paused: true },
			};
			return snapshot;
		},
		async resume() {
			snapshot = {
				...snapshot,
				activeMs: { ...snapshot.activeMs, paused: false },
				activeLoops: { ...snapshot.activeLoops, paused: false },
				taskMs: { ...snapshot.taskMs, paused: false },
				rootLoops: { ...snapshot.rootLoops, paused: false },
				allLoops: { ...snapshot.allLoops, paused: false },
			};
		},
	};
}

const validNoIssue =
	"<reflection><type>NO_ISSUE</type><reason>sound</reason><done>checked</done><current_step>verify</current_step><next_step>continue</next_step></reflection>";
const validCorrection =
	"<reflection><type>ROUTE_CORRECTION</type><reason>wrong route</reason><done>checked</done><current_step>replace</current_step><next_step>use corrected route</next_step></reflection>";

function assistant(text: string) {
	return { message: { role: "assistant", content: [{ type: "text", text }] } };
}

function turnEnd(stopReason: string) {
	return { message: { role: "assistant", stopReason } };
}

async function submitReflection(pi: Pi, ctx: ReturnType<typeof context>) {
	await new Promise<void>((resolve) => setImmediate(resolve));
	const message = pi.messages.at(-1)?.message;
	assert.ok(message);
	await pi.emit(
		"message_start",
		{ message: { role: "custom", ...message } },
		ctx,
	);
}

function install() {
	reset();
	const pi = new Pi();
	const ctx = context();
	const activityWrites: boolean[] = [];
	const extension = createWatchdogExtension({
		processDomain: fakeDomain(activityWrites),
		loadConfig: async () => ({
			config: {
				rootLoopLimit: 2,
				allLoopLimit: 3,
				taskMinutes: 30,
				idleResetGapSeconds: 60,
				reflectionPrompt: DEFAULT_REFLECTION_PROMPT,
			},
			diagnostics: [],
		}),
	});
	extension(pi as any);
	return { pi, ctx, activityWrites };
}

test("root registers new commands, history tools, and no legacy command aliases", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	assert.deepEqual(
		pi.commands.map((item) => item.name),
		["reflect-watchdog", "reflect", "reflect-timeline"],
	);
	assert.deepEqual(
		pi.tools.map((tool) => tool.name),
		[
			"reflect_watchdog_control",
			"reflect_history_count",
			"reflect_history_get",
		],
	);
});

test("/reflect queues one fixed-context inquiry with explicit empty supplement", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	const reflect = pi.commands.find((item) => item.name === "reflect");
	assert.ok(reflect);
	await reflect.handler("", ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 1);
	assert.match(
		pi.messages[0].message.content,
		/Trigger source\(s\): USER_REQUEST/,
	);
	assert.match(pi.messages[0].message.content, /User supplement: \(none\)/);
	assert.equal(pi.messages[0].options.triggerTurn, true);
	assert.deepEqual(pi.messages[0].message.details, {
		version: 1,
		namespace: "pi-reflect-watchdog",
		inquiryId: "reflection-1",
		attempt: 1,
	});
});

test("unrelated custom inquiries fail closed to ordinary work", async () => {
	const { pi, ctx, activityWrites } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit(
		"message_start",
		{
			message: {
				role: "custom",
				customType: "unrelated:inquiry",
				details: {
					version: 1,
					namespace: "unrelated",
					inquiryId: "foreign",
					attempt: 1,
				},
			},
		},
		ctx,
	);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(activityWrites, [true, false]);
});

test("live Pi state reopens activity after a completed round", async () => {
	const { pi, ctx, activityWrites } = install();
	await pi.emit("session_start", {}, ctx);

	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);

	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	assert.deepEqual(activityWrites, [true, false, true]);
});

test("a false-idle settled event cannot freeze a live run", async () => {
	const { pi, ctx, activityWrites } = install();
	await pi.emit("session_start", {}, ctx);

	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(activityWrites, [true]);

	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(activityWrites, [true, false]);
});

test("user input remains ordinary work during unrelated custom traffic", async () => {
	const { pi, ctx, activityWrites } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "custom" } }, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(activityWrites, [true, false]);
});

test("unknown activity metadata fails closed to ordinary work", async () => {
	const { pi, ctx, activityWrites } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit(
		"message_start",
		{
			message: {
				role: "custom",
				customType: "pi-reflect-watchdog:inquiry",
				details: {
					version: 2,
					namespace: "pi-reflect-watchdog",
					inquiryId: "forged",
					attempt: 1,
				},
			},
		},
		ctx,
	);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	ctx.setIdle(true);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(activityWrites, [true, false]);
});

test("public API and command pause every loop then resume from current live state", async () => {
	const { pi, ctx, activityWrites } = install();
	await pi.emit("session_start", {}, ctx);
	const api = (globalThis as any)[
		REFLECT_WATCHDOG_API_SYMBOL
	] as ReflectWatchdogApi;
	assert.equal(api.paused, false);

	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await api.pause();
	assert.equal(api.paused, true);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await pi.emit("turn_end", turnEnd("toolUse"), ctx);
	assert.equal(pi.messages.length, 0);

	ctx.setIdle(true);
	await api.resume();
	assert.equal(api.paused, false);
	assert.deepEqual(activityWrites, [true, false]);

	const command = pi.commands.find((item) => item.name === "reflect-watchdog");
	assert.ok(command);
	await command.handler("pause", ctx);
	assert.equal(api.paused, true);
	ctx.setIdle(false);
	await command.handler("resume", ctx);
	assert.equal(api.paused, false);
	assert.deepEqual(activityWrites, [true, false, true]);
});

test("message traffic cannot reopen local activity while paused", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	const api = (globalThis as any)[
		REFLECT_WATCHDOG_API_SYMBOL
	] as ReflectWatchdogApi;

	ctx.setIdle(false);
	await pi.emit("agent_start", {}, ctx);
	await api.pause();
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("message_start", { message: { role: "assistant" } }, ctx);
	await pi.emit("message_start", { message: { role: "toolResult" } }, ctx);
	ctx.setIdle(true);
	await api.resume();

	const command = pi.commands.find((item) => item.name === "reflect-watchdog");
	assert.ok(command);
	await command.handler("status", ctx);
	assert.match(ctx.notifications.at(-1)?.[0] ?? "", /root loops: 0/);
	assert.match(
		ctx.notifications.at(-1)?.[0] ?? "",
		/active window: 0s\/0 loops/,
	);
});

test("only successful model outcomes count toward loop thresholds", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);

	for (const stopReason of ["error", "aborted", "length"])
		await pi.emit("turn_end", turnEnd(stopReason), ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 0);

	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await pi.emit("turn_end", turnEnd("toolUse"), ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 1);
	assert.match(pi.messages[0].message.content, /ROOT_LOOP_LIMIT/);
});

test("threshold inquiry is queued instead of using legacy warning message", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("message_start", { message: { role: "user" } }, ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(pi.messages.length, 1);
	assert.match(pi.messages[0].message.content, /ROOT_LOOP_LIMIT/);
	assert.equal(
		pi.messages[0].message.customType,
		"pi-reflect-watchdog:inquiry",
	);
});

test("reflection tool budget blocks call eleven before execution across reasks", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	const reflect = pi.commands.find((item) => item.name === "reflect");
	assert.ok(reflect);
	await reflect.handler("budget", ctx);
	for (let index = 0; index < 10; index += 1)
		assert.equal(await pi.handlers.get("tool_call")?.({}, ctx), undefined);
	assert.deepEqual(await pi.handlers.get("tool_call")?.({}, ctx), {
		block: true,
		reason: "Reflection tool-call budget exhausted.",
	});
	await submitReflection(pi, ctx);
	await pi.emit("message_end", assistant("invalid"), ctx);
	assert.deepEqual(await pi.handlers.get("tool_call")?.({}, ctx), {
		block: true,
		reason: "Reflection tool-call budget exhausted.",
	});
});

test("three total invalid XML attempts fail and finish the inquiry", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	const reflect = pi.commands.find((item) => item.name === "reflect");
	assert.ok(reflect);
	await reflect.handler("", ctx);
	await submitReflection(pi, ctx);
	await pi.emit("message_end", assistant("invalid one"), ctx);
	await submitReflection(pi, ctx);
	await pi.emit("message_end", assistant("invalid two"), ctx);
	await submitReflection(pi, ctx);
	await pi.emit("message_end", assistant("invalid three"), ctx);
	assert.equal(pi.messages.length, 4, "initial request, two reasks, and fold");
	assert.equal(
		pi.messages.at(-1)?.message.customType,
		"pi-reflect-watchdog:inquiry-fold",
	);
	assert.equal(pi.messages.at(-1)?.options.triggerTurn, false);
	assert.match(ctx.notifications.at(-1)?.[0] ?? "", /Reflection failed/);
});

test("NO_ISSUE persists one report and starts no ordinary follow-up turn", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	const reflect = pi.commands.find((item) => item.name === "reflect");
	assert.ok(reflect);
	await reflect.handler("", ctx);
	await submitReflection(pi, ctx);
	const replacement = await pi.emit(
		"message_end",
		assistant(validNoIssue),
		ctx,
	);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(replacement.message.content, []);
	assert.deepEqual(replacement.message.details.piInquiry, {
		version: 1,
		namespace: "pi-reflect-watchdog",
		inquiryId: "reflection-1",
		attempt: 1,
	});
	assert.equal(pi.entries.length, 1);
	assert.equal(pi.entries[0].data.decision.type, "NO_ISSUE");
	assert.equal(pi.messages.length, 2);
	assert.equal(
		pi.messages[1].message.customType,
		"pi-reflect-watchdog:inquiry-fold",
	);

	const persisted = (sent: any, timestamp: number) => ({
		role: "custom",
		customType: sent.customType,
		content: [{ type: "text", text: sent.content }],
		display: sent.display,
		details: sent.details,
		timestamp,
	});
	const folded = await pi.emit(
		"context",
		{
			messages: [
				persisted(pi.messages[0].message, 1),
				{ ...replacement.message, timestamp: 2 },
				persisted(pi.messages[1].message, 3),
			],
		},
		ctx,
	);
	assert.deepEqual(folded.messages, []);
});

test("ROUTE_CORRECTION persists then dispatches one readable ordinary turn", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	const reflect = pi.commands.find((item) => item.name === "reflect");
	assert.ok(reflect);
	await reflect.handler("", ctx);
	await submitReflection(pi, ctx);
	const replacement = await pi.emit(
		"message_end",
		assistant(validCorrection),
		ctx,
	);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.deepEqual(replacement.message.content, []);
	assert.equal(pi.entries.length, 1);
	assert.equal(pi.entries[0].data.decision.type, "ROUTE_CORRECTION");
	assert.equal(pi.messages.length, 3);
	assert.equal(
		pi.messages[1].message.customType,
		"pi-reflect-watchdog:inquiry-fold",
	);
	assert.match(
		pi.messages[2].message.content,
		/Next step: use corrected route/,
	);
	assert.equal(pi.messages[2].options.triggerTurn, true);
	assert.equal(pi.messages[2].options.deliverAs, "steer");
});

test("reflection and correction attempts do not re-trigger loop counting", async () => {
	const { pi, ctx } = install();
	await pi.emit("session_start", {}, ctx);
	const reflect = pi.commands.find((item) => item.name === "reflect");
	assert.ok(reflect);
	await reflect.handler("", ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await submitReflection(pi, ctx);
	await pi.emit("message_end", assistant("invalid"), ctx);
	await pi.emit("turn_end", turnEnd("stop"), ctx);
	await submitReflection(pi, ctx);
	await pi.emit("message_end", assistant(validNoIssue), ctx);
	assert.equal(pi.messages.length, 3);
});
