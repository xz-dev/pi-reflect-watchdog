/**
 * Dedicated below-editor TUI status line for the root watchdog.
 *
 * The widget is a live component: it reads the current state on every render
 * and truncates to the terminal width, so a 1 Hz ticker refreshes it without
 * reinstalling. It never replaces Pi's footer and is only installed for the
 * current root session in TUI mode.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
export const WIDGET_KEY = "pi-reflect-watchdog";
export const WIDGET_PLACEMENT = "belowEditor";
/** Compact duration: seconds under a minute, then m+s, then h+m. */
export function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${minutes % 60}m`;
}
export function formatWidgetText(state) {
    const active = state.activity;
    return (`Reflect Watchdog | active ${formatDuration(active.elapsedMs)}/${active.loops} loops` +
        ` · task ${formatDuration(state.taskElapsedMs)}/${state.taskMinutes}m` +
        ` · root ${state.rootLoops}/${state.rootLoopLimit}` +
        ` · all ${state.allLoops}/${state.allLoopLimit}`);
}
export function createWatchdogWidget(theme, state) {
    return {
        render(width) {
            return [
                truncateToWidth(theme.fg("muted", formatWidgetText(state())), width),
            ];
        },
        // The line is recomputed from live state on every render; no cache.
        invalidate() { },
    };
}
