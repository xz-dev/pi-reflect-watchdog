/** Responsive below-editor status row, matching Continue Watchdog's pattern. */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { ActivityStatus } from "./activity-types.js";

export const WIDGET_KEY = "pi-reflect-watchdog";
export const WIDGET_PLACEMENT = "belowEditor";

export interface WidgetTheme {
	fg(color: string, text: string): string;
}

export interface WidgetState {
	activity: ActivityStatus;
	taskElapsedMs: number;
	taskMinutes: number;
	rootLoops: number;
	rootLoopLimit: number;
	allLoops: number;
	allLoopLimit: number;
	cooldownRemainingLoops?: number;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export function formatWidgetText(state: WidgetState): string {
	return (
		`Reflect Watchdog${state.cooldownRemainingLoops ? ` (${state.cooldownRemainingLoops} loops disable)` : ""}` +
		` | active ${formatDuration(state.activity.elapsedMs)}/${state.activity.loops} loops` +
		` · task ${formatDuration(state.taskElapsedMs)}/${state.taskMinutes}m` +
		` · root ${state.rootLoops}/${state.rootLoopLimit}` +
		` · all ${state.allLoops}/${state.allLoopLimit}`
	);
}

export function formatCompactWidgetText(state: WidgetState): string {
	return (
		`RW${state.cooldownRemainingLoops ? ` (${state.cooldownRemainingLoops} loops disable)` : ""}` +
		` | a ${formatDuration(state.activity.elapsedMs)}/${state.activity.loops}` +
		` · t ${formatDuration(state.taskElapsedMs)}/${state.taskMinutes}m` +
		` · r ${state.rootLoops}/${state.rootLoopLimit}` +
		` · all ${state.allLoops}/${state.allLoopLimit}`
	);
}

export function createWatchdogWidget(
	theme: WidgetTheme,
	state: () => WidgetState,
): Component {
	return {
		render(width: number): string[] {
			const current = state();
			const full = formatWidgetText(current);
			const compact = formatCompactWidgetText(current);
			const text = visibleWidth(full) <= width ? full : compact;
			return [truncateToWidth(theme.fg("dim", text), Math.max(1, width))];
		},
		invalidate(): void {},
	};
}
