import assert from "node:assert/strict";
import test from "node:test";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	createWatchdogWidget,
	formatDuration,
	formatWidgetText,
	WIDGET_KEY,
	WIDGET_PLACEMENT,
	type WidgetState,
} from "../src/widget.js";

function fakeTheme() {
	return {
		fg: (_color: string, text: string): string => text,
	};
}

test("widget identity uses the dedicated below-editor row", () => {
	assert.equal(WIDGET_KEY, "pi-watchdog");
	assert.equal(WIDGET_PLACEMENT, "belowEditor");
});

test("formatDuration renders compact paired units", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(999), "0s");
	assert.equal(formatDuration(45_000), "45s");
	assert.equal(formatDuration(60_000), "1m0s");
	assert.equal(formatDuration(12 * 60_000 + 40_000), "12m40s");
	assert.equal(formatDuration(2 * 3_600_000 + 14 * 60_000), "2h14m");
	assert.equal(formatDuration(26 * 3_600_000 + 5 * 60_000), "26h5m");
});

test("idle state renders the meaningful zero line", () => {
	const state: WidgetState = {
		activity: { active: false, elapsedMs: 0, loops: 0 },
		taskElapsedMs: 0,
		wallClockMinutes: 30,
		rootLoops: 0,
		mainLoopLimit: 100,
		observedTotalLoops: 0,
		observedTotalLoopLimit: 500,
	};
	assert.equal(
		formatWidgetText(state),
		"Watchdog | idle · active 0s/0 loops · task 0s/30m · root 0/100 · observed 0/500",
	);
});

test("live state renders the exact approved example format", () => {
	const state: WidgetState = {
		activity: {
			active: true,
			elapsedMs: 2 * 3_600_000 + 14 * 60_000,
			loops: 137,
		},
		taskElapsedMs: 12 * 60_000 + 40_000,
		wallClockMinutes: 30,
		rootLoops: 37,
		mainLoopLimit: 100,
		observedTotalLoops: 128,
		observedTotalLoopLimit: 500,
	};
	assert.equal(
		formatWidgetText(state),
		"Watchdog | active 2h14m/137 loops · task 12m40s/30m · root 37/100 · observed 128/500",
	);
});

test("component renders one truncated line through truncateToWidth", () => {
	let width = 200;
	const widget = createWatchdogWidget(fakeTheme(), () => ({
		activity: { active: true, elapsedMs: 8_040_000, loops: 137 },
		taskElapsedMs: 760_000,
		wallClockMinutes: 30,
		rootLoops: 37,
		mainLoopLimit: 100,
		observedTotalLoops: 128,
		observedTotalLoopLimit: 500,
	}));
	const full = widget.render(width);
	assert.equal(full.length, 1);
	assert.equal(
		full[0],
		"Watchdog | active 2h14m/137 loops · task 12m40s/30m · root 37/100 · observed 128/500",
	);
	width = 40;
	const narrow = widget.render(width);
	assert.equal(narrow.length, 1);
	assert.equal(narrow[0], truncateToWidth(full[0], width));
	assert.ok(visibleWidth(narrow[0]) <= width);
});

test("component re-reads live state on every render", () => {
	let elapsed = 1_000;
	const widget = createWatchdogWidget(fakeTheme(), () => ({
		activity: { active: true, elapsedMs: elapsed, loops: 1 },
		taskElapsedMs: elapsed,
		wallClockMinutes: 30,
		rootLoops: 1,
		mainLoopLimit: 100,
		observedTotalLoops: 1,
		observedTotalLoopLimit: 500,
	}));
	assert.match(widget.render(200)[0], /active 1s\/1 loops/);
	elapsed = 2_000;
	assert.match(widget.render(200)[0], /active 2s\/1 loops/);
});
