/**
 * Dedicated below-editor TUI status line for the root watchdog.
 *
 * The widget is a live component: it reads the current state on every render
 * and truncates to the terminal width, so a 1 Hz ticker refreshes it without
 * reinstalling. It never replaces Pi's footer and is only installed for the
 * current root session in TUI mode.
 */
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ActivityStatus } from "./activity.js";
export declare const WIDGET_KEY = "pi-reflect-watchdog";
export declare const WIDGET_PLACEMENT = "belowEditor";
/** Theme face needed to style the line; matches the public Theme.fg API. */
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
}
/** Compact duration: seconds under a minute, then m+s, then h+m. */
export declare function formatDuration(ms: number): string;
export declare function formatWidgetText(state: WidgetState): string;
export declare function createWatchdogWidget(theme: WidgetTheme, state: () => WidgetState): Component;
export type WatchdogWidgetFactory = (tui: TUI, theme: WidgetTheme) => Component;
