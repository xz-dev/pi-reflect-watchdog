/**
 * Dedicated below-editor TUI status line for the root watchdog.
 *
 * The widget is a live component: it reads the current state on every render
 * and truncates to the terminal width, so a 1 Hz ticker refreshes it without
 * reinstalling. It never replaces Pi's footer and is only installed for the
 * current root session in TUI mode.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { ActivityStatus } from "./activity.js";

export const WIDGET_KEY = "pi-reflect-watchdog";
export const WIDGET_PLACEMENT = "belowEditor";

/** Theme face needed to style the line; matches the public Theme.fg API. */
export interface WidgetTheme {
	fg(color: string, text: string): string;
}

export interface WidgetState {
	activity: ActivityStatus;
	taskElapsedMs: number;
	wallClockMinutes: number;
	rootLoops: number;
	mainLoopLimit: number;
	observedTotalLoops: number;
	observedTotalLoopLimit: number;
}

/** Compact duration: seconds under a minute, then m+s, then h+m. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export function formatWidgetText(state: WidgetState): string {
	const active = state.activity;
	const head = active.active
		? `active ${formatDuration(active.elapsedMs)}/${active.loops} loops`
		: `idle · active ${formatDuration(active.elapsedMs)}/${active.loops} loops`;
	return (
		`Watchdog | ${head}` +
		` · task ${formatDuration(state.taskElapsedMs)}/${state.wallClockMinutes}m` +
		` · root ${state.rootLoops}/${state.mainLoopLimit}` +
		` · observed ${state.observedTotalLoops}/${state.observedTotalLoopLimit}`
	);
}

export function createWatchdogWidget(
	theme: WidgetTheme,
	state: () => WidgetState,
): Component {
	return {
		render(width: number): string[] {
			return [
				truncateToWidth(theme.fg("muted", formatWidgetText(state())), width),
			];
		},
		// The line is recomputed from live state on every render; no cache.
		invalidate(): void {},
	};
}

export type WatchdogWidgetFactory = (tui: TUI, theme: WidgetTheme) => Component;
