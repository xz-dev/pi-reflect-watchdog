import { StringEnum, Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { type LoadedConfig, loadRuntimeConfig } from "./config-loader.js";
import {
	type ControllerTransition,
	controllerOptionsFromConfig,
	TaskController,
	type TaskStatus,
} from "./controller.js";
import {
	type PromptAlias,
	parseWatchdogCommand,
	WATCHDOG_USAGE,
} from "./controls.js";
import {
	allocateAttachmentToken,
	claimRoot,
	getHub,
	isCurrentRoot,
	type RootPriority,
	releaseRoot,
} from "./hub.js";
import { type PromptKind, renderTemplate } from "./prompts.js";
import {
	createWatchdogWidget,
	formatDuration,
	WIDGET_KEY,
	type WidgetState,
} from "./widget.js";

const STATUS_KEY = "pi-watchdog";
const TOOL_NAME = "watchdog_control";
const COMMAND_NAME = "watchdog";
const WARNING_TYPE = "pi-watchdog-warning";
type Timer = ReturnType<typeof setTimeout>;

// Node clamps any setTimeout delay above 2^31-1 ms to 1 ms, which would fire
// the wall-clock threshold far too early. Large valid limits are instead
// scheduled as capped chunks that recompute the exact remaining delay.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// The dedicated TUI widget shows seconds, so it refreshes at about one
// second while the root is active and stops entirely while idle. The wall-
// clock threshold timer is a separate role and keeps its exact semantics.
const WIDGET_TICK_MS = 1_000;
const RPC_STATUS_TICK_MS = 30_000;

type AttachmentState = "new" | "loading" | "root" | "observer" | "shutdown";

export type WatchdogTimerRole = "threshold" | "tui-refresh" | "rpc-status";

export interface RuntimeServices {
	now(): number;
	/**
	 * Legacy timer seam retained for existing internal consumers. New test
	 * adapters can use scheduleTimer to observe the watchdog's timer purpose
	 * without guessing from a delay that can legitimately collide.
	 */
	setTimeout(callback: () => void, delay: number): Timer;
	clearTimeout(timer: Timer): void;
	loadConfig(cwd: string, trusted: boolean): Promise<LoadedConfig>;
	/** Optional role-aware scheduling seam; production falls back to setTimeout. */
	scheduleTimer?(
		role: WatchdogTimerRole,
		callback: () => void,
		delay: number,
	): Timer;
}

const defaultServices: RuntimeServices = {
	now: () => Date.now(),
	setTimeout: (callback, delay) => setTimeout(callback, delay),
	clearTimeout: (timer) => clearTimeout(timer),
	loadConfig: loadRuntimeConfig,
};

interface ObserverBinding {
	observerAttachmentToken: string;
	rootGeneration: number;
	taskEpoch: number;
}

interface Runtime {
	pi: ExtensionAPI;
	token: string;
	sessionId: string;
	state: AttachmentState;
	root?: { generation: number };
	controller?: TaskController;
	ctx?: ExtensionContext;
	sessionManager?: ExtensionContext["sessionManager"];
	timer?: Timer;
	ticker?: Timer;
	timerLifecycle?: { generation: number; epoch: number };
	widgetOwner?: object;
	widgetRequestRender?: () => void;
	observerBinding?: ObserverBinding;
	toolRegistered: boolean;
	commandRegistered: boolean;
}

function positiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function elapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function priority(ctx: ExtensionContext): RootPriority {
	return ctx.hasUI ? 2 : 1;
}

function rootIsCurrent(runtime: Runtime): runtime is Runtime & {
	root: { generation: number };
	controller: TaskController;
	ctx: ExtensionContext;
} {
	return (
		runtime.state === "root" &&
		runtime.root !== undefined &&
		runtime.controller !== undefined &&
		runtime.ctx !== undefined &&
		isCurrentRoot(getHub<Runtime>(), runtime.token, runtime.root.generation)
	);
}

function scheduleTimer(
	services: RuntimeServices,
	role: WatchdogTimerRole,
	callback: () => void,
	delay: number,
): Timer {
	return (
		services.scheduleTimer?.(role, callback, delay) ??
		services.setTimeout(callback, delay)
	);
}

function clearTimers(runtime: Runtime, services: RuntimeServices): void {
	if (runtime.timer) services.clearTimeout(runtime.timer);
	if (runtime.ticker) services.clearTimeout(runtime.ticker);
	runtime.timer = undefined;
	runtime.ticker = undefined;
	// Invalidate callbacks that a host may still deliver after clearTimeout;
	// staleness is scoped to the root generation and task epoch.
	runtime.timerLifecycle = undefined;
}

function removeControlTool(runtime: Runtime): void {
	if (!runtime.toolRegistered) return;
	// Dynamic tool state is public API. Remove only our name so unrelated tools stay active.
	runtime.pi.setActiveTools(
		runtime.pi.getActiveTools().filter((name) => name !== TOOL_NAME),
	);
}

function deactivate(runtime: Runtime, services: RuntimeServices): void {
	clearTimers(runtime, services);
	clearWidget(runtime);
	if (runtime.ctx) runtime.ctx.ui.setStatus(STATUS_KEY, undefined);
	removeControlTool(runtime);
	runtime.observerBinding = undefined;
	runtime.root = undefined;
	runtime.controller?.finalize();
	runtime.controller = undefined;
	runtime.ctx = undefined;
	runtime.sessionManager = undefined;
	if (runtime.state !== "shutdown") runtime.state = "observer";
}

function statusLine(status: TaskStatus): string {
	return `WD main ${status.mainLoops}/${status.limits.mainLoopLimit} · observed ${status.observedTotalLoops}/${status.limits.observedTotalLoopLimit} · ${elapsed(status.wallClockElapsedMs)}/${status.limits.wallClockMinutes}m`;
}

function widgetState(
	runtime: Runtime & {
		root: { generation: number };
		controller: TaskController;
		ctx: ExtensionContext;
	},
	now: number,
): WidgetState {
	const status = runtime.controller.status(now);
	return {
		activity: status.activity,
		taskElapsedMs: status.wallClockElapsedMs,
		wallClockMinutes: status.limits.wallClockMinutes,
		rootLoops: status.mainLoops,
		mainLoopLimit: status.limits.mainLoopLimit,
		observedTotalLoops: status.observedTotalLoops,
		observedTotalLoopLimit: status.limits.observedTotalLoopLimit,
	};
}

// The TUI widget owns its status line. RPC retains the footer status because
// it is the only non-TUI mode where that status is meaningful.
function updateStatus(runtime: Runtime, services: RuntimeServices): void {
	if (!rootIsCurrent(runtime) || runtime.ctx.mode !== "rpc") return;
	runtime.ctx.ui.setStatus(
		STATUS_KEY,
		statusLine(runtime.controller.status(services.now())),
	);
}

function installWidget(runtime: Runtime, services: RuntimeServices): void {
	if (!rootIsCurrent(runtime) || runtime.ctx.mode !== "tui") return;
	const ctx = runtime.ctx;
	const owner = {};
	runtime.widgetOwner = owner;
	runtime.widgetRequestRender = undefined;
	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			// A factory can be invoked after its widget has been replaced. Only the
			// current root/context/widget instance may retain this TUI callback.
			if (
				rootIsCurrent(runtime) &&
				runtime.ctx === ctx &&
				runtime.widgetOwner === owner
			)
				runtime.widgetRequestRender = () => tui.requestRender();
			return createWatchdogWidget(theme, () =>
				widgetState(runtime, services.now()),
			);
		},
		{ placement: "belowEditor" },
	);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function clearWidget(runtime: Runtime): void {
	// Clear first: queued timers and late factory calls must never redraw a
	// removed, demoted, shut-down, or replaced context.
	runtime.widgetRequestRender = undefined;
	runtime.widgetOwner = undefined;
	if (runtime.ctx?.mode === "tui")
		runtime.ctx.ui.setWidget(WIDGET_KEY, undefined);
}

// The reset notification is user-only TUI output. Pi exposes no reliable
// public user-abort provenance at agent_settled, so the wording stays
// neutral and the line never enters the model context or triggers a turn.
function emitResetNotification(
	runtime: Runtime,
	snapshot: { elapsedMs: number; loops: number } | undefined,
): void {
	if (snapshot === undefined || !rootIsCurrent(runtime)) return;
	if (runtime.ctx.mode !== "tui") return;
	runtime.ctx.ui.notify(
		`Watchdog reset | active ${formatDuration(snapshot.elapsedMs)}/${snapshot.loops} loops`,
		"info",
	);
}

function scheduleTimers(runtime: Runtime, services: RuntimeServices): void {
	clearTimers(runtime, services);
	if (!rootIsCurrent(runtime)) return;
	const generation = runtime.root.generation;
	const epoch = runtime.controller.status(services.now()).epoch;
	const lifecycle = { generation, epoch };
	runtime.timerLifecycle = lifecycle;
	// Each scheduled callback fires exactly once; a host that delivers a
	// callback again (or after clearTimeout) hits the consumed flag and the
	// superseded lifecycle token, never the live state.
	const stale = (fired: { consumed: boolean }): boolean => {
		if (fired.consumed) return true;
		fired.consumed = true;
		return (
			!rootIsCurrent(runtime) ||
			runtime.timerLifecycle !== lifecycle ||
			runtime.controller.status(services.now()).epoch !== epoch
		);
	};
	// scheduleWallClock runs at most once per timer callback; early delivery
	// rearms the remaining delay in place instead of stacking timers.
	const scheduleWallClock = (): void => {
		const status = runtime.controller.status(services.now());
		if (!status.rootActive) return;
		const remaining =
			status.limits.wallClockMinutes * 60_000 - status.wallClockElapsedMs;
		if (remaining <= 0) {
			// Already at or beyond the boundary (a rearmed limit can land there):
			// evaluate exactly once instead of scheduling a zero-delay timer.
			deliverWarnings(
				runtime,
				runtime.controller.evaluateWallClock(services.now()),
				services,
			);
			return;
		}
		const fired = { consumed: false };
		runtime.timer = scheduleTimer(
			services,
			"threshold",
			() => {
				if (stale(fired)) return;
				runtime.timer = undefined;
				const delivered = deliverWarnings(
					runtime,
					runtime.controller.evaluateWallClock(services.now()),
					services,
				);
				// A warning reset creates a fresh timer lifecycle. Only an early or
				// capped callback without a warning may rearm this lifecycle in place.
				if (!delivered) scheduleWallClock();
				updateStatus(runtime, services);
			},
			Math.min(remaining, MAX_TIMER_DELAY_MS),
		);
		runtime.timer.unref?.();
	};
	scheduleWallClock();
	const scheduleRefreshTick = (
		role: Extract<WatchdogTimerRole, "tui-refresh" | "rpc-status">,
		delay: number,
		refresh: () => void,
	): void => {
		const fired = { consumed: false };
		runtime.ticker = scheduleTimer(
			services,
			role,
			() => {
				if (stale(fired)) return;
				runtime.ticker = undefined;
				refresh();
				scheduleRefreshTick(role, delay, refresh);
			},
			delay,
		);
		runtime.ticker.unref?.();
	};
	// Refresh roles are deliberately mode-specific. The widget needs a
	// second-level redraw while any current-epoch participant runs; RPC keeps
	// its established bounded footer refresh; print/json/headless have no
	// changing UI surface to refresh.
	if (!runtime.controller.status(services.now()).activity.active) return;
	if (runtime.ctx.mode === "tui")
		scheduleRefreshTick("tui-refresh", WIDGET_TICK_MS, () => {
			runtime.widgetRequestRender?.();
		});
	else if (runtime.ctx.mode === "rpc")
		scheduleRefreshTick("rpc-status", RPC_STATUS_TICK_MS, () =>
			updateStatus(runtime, services),
		);
}

function templateVariables(
	status: TaskStatus,
): Record<string, string | number> {
	return {
		mainLoops: status.mainLoops,
		mainLoopLimit: status.limits.mainLoopLimit,
		observedChildLoops: status.observedChildLoops,
		observedChildSessions: status.observedChildSessions,
		observedTotalLoops: status.observedTotalLoops,
		observedTotalLoopLimit: status.limits.observedTotalLoopLimit,
		wallClockMinutes: status.limits.wallClockMinutes,
		elapsed: elapsed(status.wallClockElapsedMs),
		coverage: status.coverage,
	};
}

function deliverWarnings(
	runtime: Runtime,
	transition: ControllerTransition,
	services: RuntimeServices,
): boolean {
	if (transition.warnings.length === 0 || !rootIsCurrent(runtime)) return false;
	const status = transition.triggerStatus;
	if (status === undefined)
		throw new Error("warning transition must include its pre-reset status");
	const content = transition.warnings
		.map((kind) =>
			renderTemplate(status.prompts[kind], templateVariables(status)),
		)
		.join("\n\n");
	runtime.ctx.ui.notify(
		`Watchdog warning: ${transition.warnings.join(", ")}`,
		"warning",
	);
	runtime.pi.sendMessage(
		{
			customType: WARNING_TYPE,
			content,
			display: true,
			details: { warnings: transition.warnings, status },
		},
		{ deliverAs: status.rootActive ? "steer" : "nextTurn", triggerTurn: false },
	);
	// Recreate timers only from the reset state, so old callbacks are stale and
	// a running root receives a full fresh wall-clock interval before another warning.
	scheduleTimers(runtime, services);
	updateStatus(runtime, services);
	return true;
}

export function createWatchdogExtension(
	overrides: Partial<RuntimeServices> = {},
): (pi: ExtensionAPI) => void {
	const services: RuntimeServices = { ...defaultServices, ...overrides };
	return (pi) => {
		const runtime: Runtime = {
			pi,
			token: "",
			sessionId: "",
			state: "new",
			toolRegistered: false,
			commandRegistered: false,
		};

		pi.on("session_start", async (_event, ctx) => {
			const hub = getHub<Runtime>();
			if (runtime.state !== "new") return;
			// Pi command contexts are distinct wrappers, but retain this exact
			// session-owned manager plus its stable ID from session_start.
			runtime.sessionManager = ctx.sessionManager;
			runtime.sessionId = ctx.sessionManager.getSessionId();
			runtime.token = allocateAttachmentToken(hub, runtime.sessionId);
			runtime.state = "loading";
			// Reserve ownership before awaiting configuration. This is the atomic
			// priority decision: a UI reservation may replace a fallback, but no
			// delayed equal/lower-priority callback may steal it afterward.
			const claim = claimRoot(hub, runtime.token, priority(ctx), runtime);
			if (!claim) {
				runtime.state = "observer";
				return;
			}
			runtime.root = { generation: claim.root.generation };
			if (claim.replaced) deactivate(claim.replaced.value, services);
			const loaded = await services.loadConfig(ctx.cwd, ctx.isProjectTrusted());
			// A shutdown/replacement has no cancellation hook; all post-await work is inert.
			if (
				runtime.state !== "loading" ||
				!isCurrentRoot(hub, runtime.token, claim.root.generation)
			)
				return;
			runtime.ctx = ctx;
			runtime.controller = new TaskController(
				controllerOptionsFromConfig(loaded.config),
			);
			runtime.state = "root";
			for (const diagnostic of loaded.diagnostics.slice(0, 3))
				ctx.ui.notify(
					`pi-watchdog ${diagnostic.source}: ${diagnostic.message}`,
					"warning",
				);
			registerControlTool(pi, runtime, services);
			registerWatchdogCommand(pi, runtime, services);
			// Recreate the dedicated widget for every fresh root context; TUI
			// mode uses it as the status UI and never gets a footer status.
			installWidget(runtime, services);
			updateStatus(runtime, services);
		});

		pi.on("message_start", (event) => {
			if (event.message.role !== "user") return;
			if (rootIsCurrent(runtime)) {
				// An interjecting/new root user message replaces a begun activity
				// window; the finished window is announced exactly once.
				const snapshot = runtime.controller.startRootTask(
					services.now(),
					runtime.controller.status(services.now()).rootActive,
				);
				emitResetNotification(runtime, snapshot);
				scheduleTimers(runtime, services);
				updateStatus(runtime, services);
				return;
			}
			const root = getHub<Runtime>().root?.value;
			if (!root || !rootIsCurrent(root)) return;
			const epoch = root.controller.bindObserver(runtime.token);
			if (epoch === 0) return;
			runtime.observerBinding = {
				observerAttachmentToken: runtime.token,
				rootGeneration: root.root.generation,
				taskEpoch: epoch,
			};
		});

		pi.on("agent_start", () => {
			if (rootIsCurrent(runtime)) {
				// Pi emits this before the initial root user message; it arms no task alone.
				runtime.controller.startRootActiveSegment(services.now());
				scheduleTimers(runtime, services);
				updateStatus(runtime, services);
				return;
			}
			const root = getHub<Runtime>().root?.value;
			const binding = runtime.observerBinding;
			if (
				!root ||
				!rootIsCurrent(root) ||
				!binding ||
				binding.observerAttachmentToken !== runtime.token ||
				binding.rootGeneration !== root.root.generation
			)
				return;
			root.controller.startObserverRun(runtime.token, services.now());
			scheduleTimers(root, services);
			updateStatus(root, services);
		});
		pi.on("agent_settled", () => {
			if (rootIsCurrent(runtime)) {
				const snapshot = runtime.controller.settleRootActiveSegment(
					services.now(),
				);
				emitResetNotification(runtime, snapshot);
				scheduleTimers(runtime, services);
				updateStatus(runtime, services);
				return;
			}
			const root = getHub<Runtime>().root?.value;
			const binding = runtime.observerBinding;
			if (
				!root ||
				!rootIsCurrent(root) ||
				!binding ||
				binding.observerAttachmentToken !== runtime.token ||
				binding.rootGeneration !== root.root.generation
			)
				return;
			const snapshot = root.controller.settleObserverRun(
				runtime.token,
				binding.taskEpoch,
				services.now(),
			);
			emitResetNotification(root, snapshot);
			scheduleTimers(root, services);
			updateStatus(root, services);
		});
		pi.on("turn_end", () => {
			if (rootIsCurrent(runtime)) {
				// Root turns count once in the root and observed aggregate cycles.
				deliverWarnings(
					runtime,
					runtime.controller.completeRootTurn(services.now()),
					services,
				);
				updateStatus(runtime, services);
				return;
			}
			const root = getHub<Runtime>().root?.value;
			const binding = runtime.observerBinding;
			if (
				!root ||
				!rootIsCurrent(root) ||
				!binding ||
				binding.observerAttachmentToken !== runtime.token ||
				binding.rootGeneration !== root.root.generation
			)
				return;
			deliverWarnings(
				root,
				root.controller.completeObserverTurn(
					runtime.token,
					binding.taskEpoch,
					services.now(),
				),
				services,
			);
		});
		pi.on("session_shutdown", () => {
			if (runtime.state === "shutdown") return;
			runtime.state = "shutdown";
			const hub = getHub<Runtime>();
			// Release the exact hub reservation, including a pending one whose
			// configuration never resolved, so an equal-priority replacement can
			// become root while the stale resolution stays inert.
			const generation = runtime.root?.generation;
			if (
				generation !== undefined &&
				releaseRoot(hub, runtime.token, generation)
			)
				deactivate(runtime, services);
			else {
				const root = hub.root?.value;
				const binding = runtime.observerBinding;
				if (
					root &&
					rootIsCurrent(root) &&
					binding &&
					binding.rootGeneration === root.root.generation
				) {
					const snapshot = root.controller.unbindObserver(
						runtime.token,
						services.now(),
						binding.taskEpoch,
					);
					emitResetNotification(root, snapshot);
					scheduleTimers(root, services);
					updateStatus(root, services);
				}
				clearTimers(runtime, services);
				clearWidget(runtime);
				runtime.observerBinding = undefined;
			}
		});
	};
}

export default createWatchdogExtension();

const PROMPT_ALIAS: Record<PromptAlias, PromptKind> = {
	main: "mainLoopLimitReached",
	total: "observedTotalLoopLimitReached",
	time: "wallClockLimitReached",
};

function commandIsCurrent(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): runtime is Runtime & {
	root: { generation: number };
	controller: TaskController;
	ctx: ExtensionContext;
	sessionManager: ExtensionContext["sessionManager"];
} {
	// Pi 0.82.1 deliberately wraps event and command contexts separately. The
	// session manager is the stable session-owned object shared by those
	// wrappers; pair it with the session ID and current hub token/generation.
	return (
		rootIsCurrent(runtime) &&
		runtime.sessionManager !== undefined &&
		ctx.sessionManager === runtime.sessionManager &&
		ctx.sessionManager.getSessionId() === runtime.sessionId
	);
}

function userStatusText(runtime: Runtime, services: RuntimeServices): string {
	const status = runtime.controller?.status(services.now());
	if (!status) return "Watchdog is not active for this session.";
	return [
		"Watchdog status",
		`root/main loops: ${status.mainLoops}`,
		`observed child loops: ${status.observedChildLoops}`,
		`observed child sessions: ${status.observedChildSessions}`,
		`observable total loops: ${status.observedTotalLoops}`,
		`task-cycle wall time: ${elapsed(status.wallClockElapsedMs)}`,
		`limits: main=${status.limits.mainLoopLimit}; observed-total=${status.limits.observedTotalLoopLimit}; wall-clock=${status.limits.wallClockMinutes}m`,
		`configured defaults: main=${status.configuredLimits.mainLoopLimit}; observed-total=${status.configuredLimits.observedTotalLoopLimit}; wall-clock=${status.configuredLimits.wallClockMinutes}m`,
		`latched warnings: ${status.latchedWarnings.join(", ") || "none"}`,
		`coverage: ${status.coverage}`,
		`active window: ${formatDuration(status.activity.elapsedMs)}/${status.activity.loops} root loops`,
	].join("\n");
}

function promptText(runtime: Runtime, services: RuntimeServices): string {
	const prompts = runtime.controller?.status(services.now()).prompts;
	if (!prompts) return "Watchdog is not active for this session.";
	return [
		"Watchdog effective prompts",
		`main:\n${prompts.mainLoopLimitReached}`,
		`total:\n${prompts.observedTotalLoopLimitReached}`,
		`time:\n${prompts.wallClockLimitReached}`,
	].join("\n\n");
}

function notifyCommand(
	ctx: ExtensionCommandContext,
	message: string,
	kind: "info" | "warning" | "error" = "info",
): void {
	ctx.ui.notify(message, kind);
}

function notifyCommandWarnings(
	ctx: ExtensionCommandContext,
	warnings: PromptKind[],
): void {
	if (warnings.length !== 0)
		notifyCommand(ctx, `Watchdog warning: ${warnings.join(", ")}`, "warning");
}

function registerWatchdogCommand(
	pi: ExtensionAPI,
	runtime: Runtime,
	services: RuntimeServices,
): void {
	if (runtime.commandRegistered) return;
	runtime.commandRegistered = true;
	// Pi has no public command unregistration. Registration occurs only after
	// this attachment wins root ownership; a stale handler validates generation
	// and context before reading or changing any current root state.
	pi.registerCommand(COMMAND_NAME, {
		description: "Inspect and control the current root watchdog task",
		async handler(args, ctx) {
			// Never read the stale wrapper's UI before proving stable session identity.
			if (!commandIsCurrent(runtime, ctx)) return;
			const parsed = parseWatchdogCommand(args);
			if ("error" in parsed) {
				notifyCommand(ctx, parsed.error, "error");
				return;
			}
			const current = services.now();
			switch (parsed.command.action) {
				case "status":
					notifyCommand(ctx, userStatusText(runtime, services));
					return;
				case "reset":
					runtime.controller.resetRuntime(current);
					scheduleTimers(runtime, services);
					updateStatus(runtime, services);
					notifyCommand(
						ctx,
						"Watchdog task cycle reset. Active window is unchanged.",
					);
					return;
				case "limits-show":
					notifyCommand(ctx, userStatusText(runtime, services));
					return;
				case "limits-set": {
					const transition = runtime.controller.setLimits(
						parsed.command,
						current,
					);
					scheduleTimers(runtime, services);
					notifyCommandWarnings(ctx, transition.warnings);
					updateStatus(runtime, services);
					notifyCommand(ctx, "Watchdog current-task limits updated.");
					return;
				}
				case "limits-reset": {
					const transition =
						runtime.controller.restoreConfiguredDefaults(current);
					scheduleTimers(runtime, services);
					notifyCommandWarnings(ctx, transition.warnings);
					updateStatus(runtime, services);
					notifyCommand(
						ctx,
						"Watchdog configured limits restored for this task.",
					);
					return;
				}
				case "prompt-show":
					notifyCommand(ctx, promptText(runtime, services));
					return;
				case "prompt-reset":
					if (parsed.command.kind === "all")
						runtime.controller.resetPromptOverride();
					else
						runtime.controller.resetPromptOverride(
							PROMPT_ALIAS[parsed.command.kind],
						);
					updateStatus(runtime, services);
					notifyCommand(ctx, "Watchdog temporary prompt override reset.");
					return;
				case "prompt-edit": {
					if (!ctx.hasUI) {
						notifyCommand(
							ctx,
							"Watchdog prompt editing requires a UI-capable root session.",
							"error",
						);
						return;
					}
					const kind = PROMPT_ALIAS[parsed.command.kind];
					const template = runtime.controller.status(current).prompts[kind];
					const edited = await ctx.ui.editor(
						`Watchdog ${parsed.command.kind} prompt`,
						template,
					);
					// The editor is asynchronous: a demotion, shutdown, or replacement
					// makes this invocation inert. Do not touch its stale UI wrapper.
					if (!commandIsCurrent(runtime, ctx)) return;
					if (edited === undefined) return;
					if (edited.trim().length === 0) {
						notifyCommand(
							ctx,
							`Watchdog prompt cannot be empty. Use '/watchdog prompt reset ${parsed.command.kind}' to remove this override. ${WATCHDOG_USAGE}`,
							"warning",
						);
						return;
					}
					runtime.controller.setPromptOverride(kind, edited);
					updateStatus(runtime, services);
					notifyCommand(ctx, "Watchdog temporary prompt override saved.");
					return;
				}
			}
		},
	});
}

function registerControlTool(
	pi: ExtensionAPI,
	runtime: Runtime,
	services: RuntimeServices,
): void {
	runtime.toolRegistered = true;
	pi.registerTool({
		name: TOOL_NAME,
		label: "Watchdog Control",
		description:
			"Inspect or adjust current-task watchdog counters and limits. Use after a genuine reassessment, not merely to silence a warning.",
		promptSnippet:
			"Inspect or adjust current watchdog limits after reassessing work",
		promptGuidelines: [
			"Use watchdog_control to inspect or deliberately adjust the current task's watchdog; do not reset it mechanically just to silence a warning.",
		],
		parameters: Type.Object({
			action: StringEnum(["status", "reset", "set_limits", "restore_defaults"]),
			mainLoopLimit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
			),
			observedTotalLoopLimit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
			),
			wallClockMinutes: Type.Optional(
				Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
			),
		}),
		async execute(_id, params) {
			if (!rootIsCurrent(runtime))
				throw new Error(
					"watchdog_control is available only to the current root session",
				);
			const current = services.now();
			let transition: ControllerTransition = { warnings: [] };
			if (params.action === "reset") runtime.controller.resetRuntime(current);
			else if (params.action === "set_limits") {
				const limits = {
					mainLoopLimit: params.mainLoopLimit,
					observedTotalLoopLimit: params.observedTotalLoopLimit,
					wallClockMinutes: params.wallClockMinutes,
				};
				const values = Object.values(limits).filter(
					(value) => value !== undefined,
				);
				if (values.length === 0)
					throw new Error(
						"set_limits requires at least one positive safe integer",
					);
				if (!values.every(positiveSafeInteger))
					throw new Error(
						"set_limits accepts only positive safe integer limits",
					);
				transition = runtime.controller.setLimits(limits, current, true);
			} else if (params.action === "restore_defaults")
				transition = runtime.controller.restoreConfiguredDefaults(
					current,
					true,
				);
			if (!deliverWarnings(runtime, transition, services))
				scheduleTimers(runtime, services);
			updateStatus(runtime, services);
			const status = runtime.controller.status(current);
			return {
				content: [
					{
						type: "text",
						text: `watchdog ${params.action}\nmain/root loops: ${status.mainLoops}\nobserved child loops: ${status.observedChildLoops}\nobserved child sessions: ${status.observedChildSessions}\nobserved total loops: ${status.observedTotalLoops}\nlimits: main=${status.limits.mainLoopLimit}; observed-total=${status.limits.observedTotalLoopLimit}; wall-clock=${status.limits.wallClockMinutes}m\nwall-clock elapsed: ${elapsed(status.wallClockElapsedMs)}\nroot active: ${status.rootActive}\nlatched warnings: ${status.latchedWarnings.join(", ") || "none"}\ncoverage: ${status.coverage}`,
					},
				],
				details: status,
			};
		},
	});
	pi.setActiveTools([...new Set([...pi.getActiveTools(), TOOL_NAME])]);
}
