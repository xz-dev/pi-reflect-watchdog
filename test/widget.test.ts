import assert from "node:assert/strict";
import test from "node:test";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { formatDuration } from "../src/duration.js";
import {
	createWatchdogWidget,
	formatCompactWidgetText,
	formatWidgetText,
	WIDGET_KEY,
	WIDGET_PLACEMENT,
	type WidgetState,
} from "../src/widget.js";

function fakeTheme() {
	return {
		fg: (_color: string, text: string): string => text,
		bg: (_color: string, text: string): string => text,
	};
}

test("widget identity uses the dedicated below-editor row", () => {
	assert.equal(WIDGET_KEY, "pi-reflect-watchdog");
	assert.equal(WIDGET_PLACEMENT, "belowEditor");
});

test("formatDuration renders compact paired units", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(999), "0s");
	assert.equal(formatDuration(45_000), "45s");
	assert.equal(formatDuration(1_200_767), "20m0s");
	assert.equal(formatDuration(60_000), "1m0s");
	assert.equal(formatDuration(12 * 60_000 + 40_000), "12m40s");
	assert.equal(formatDuration(2 * 3_600_000 + 14 * 60_000), "2h14m");
	assert.equal(formatDuration(26 * 3_600_000 + 5 * 60_000), "26h5m");
});

test("idle state renders the meaningful zero line", () => {
	const state: WidgetState = {
		activity: { active: false, elapsedMs: 0, loops: 0 },
		taskElapsedMs: 0,
		taskMinutes: 20,
		rootLoops: 0,
		rootLoopLimit: 60,
		allLoops: 0,
		allLoopLimit: 300,
	};
	assert.equal(
		formatWidgetText(state),
		"Reflect Watchdog | active 0s/0 loops · task 0s/20m · root 0/60 · all 0/300",
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
		taskMinutes: 20,
		rootLoops: 37,
		rootLoopLimit: 60,
		allLoops: 128,
		allLoopLimit: 300,
	};
	assert.equal(
		formatWidgetText(state),
		"Reflect Watchdog | active 2h14m/137 loops · task 12m40s/20m · root 37/60 · all 128/300",
	);
});

test("cooldown suffix renders only while loops remain", () => {
	const state: WidgetState = {
		activity: { active: false, elapsedMs: 0, loops: 0 },
		taskElapsedMs: 0,
		taskMinutes: 20,
		rootLoops: 0,
		rootLoopLimit: 60,
		allLoops: 0,
		allLoopLimit: 300,
		cooldownRemainingLoops: 3,
	};
	assert.match(
		formatWidgetText(state),
		/^Reflect Watchdog \(3 loops disable\) \| active/,
	);
	assert.match(formatCompactWidgetText(state), /^RW \(3 loops disable\) \| a/);
	assert.doesNotMatch(
		formatWidgetText({ ...state, cooldownRemainingLoops: 0 }),
		/loops disable/,
	);
	assert.doesNotMatch(
		formatCompactWidgetText({ ...state, cooldownRemainingLoops: 0 }),
		/loops disable/,
	);
});

test("component switches to compact text before final truncation", () => {
	let width = 200;
	const widget = createWatchdogWidget(fakeTheme(), () => ({
		activity: { active: true, elapsedMs: 8_040_000, loops: 137 },
		taskElapsedMs: 760_000,
		taskMinutes: 20,
		rootLoops: 37,
		rootLoopLimit: 60,
		allLoops: 128,
		allLoopLimit: 300,
	}));
	const full = widget.render(width);
	assert.equal(full.length, 1);
	assert.equal(
		full[0],
		"Reflect Watchdog | active 2h14m/137 loops · task 12m40s/20m · root 37/60 · all 128/300",
	);
	width = 40;
	const narrow = widget.render(width);
	assert.equal(narrow.length, 1);
	assert.equal(
		narrow[0],
		truncateToWidth(
			formatCompactWidgetText({
				activity: { active: true, elapsedMs: 8_040_000, loops: 137 },
				taskElapsedMs: 760_000,
				taskMinutes: 20,
				rootLoops: 37,
				rootLoopLimit: 60,
				allLoops: 128,
				allLoopLimit: 300,
			}),
			width,
		),
	);
	assert.ok(visibleWidth(narrow[0]) <= width);
});

test("component re-reads live state on every render", () => {
	let elapsed = 1_000;
	const widget = createWatchdogWidget(fakeTheme(), () => ({
		activity: { active: true, elapsedMs: elapsed, loops: 1 },
		taskElapsedMs: elapsed,
		taskMinutes: 20,
		rootLoops: 1,
		rootLoopLimit: 60,
		allLoops: 1,
		allLoopLimit: 300,
	}));
	assert.match(widget.render(200)[0], /active 1s\/1 loops/);
	elapsed = 2_000;
	assert.match(widget.render(200)[0], /active 2s\/1 loops/);
});

test("queued reflection appends the effective cancel label to full and compact rows", () => {
	const state: WidgetState = {
		activity: { active: true, elapsedMs: 5_000, loops: 2 },
		taskElapsedMs: 5_000,
		taskMinutes: 20,
		rootLoops: 2,
		rootLoopLimit: 60,
		allLoops: 2,
		allLoopLimit: 300,
		queuedCancelLabel: "alt+x",
	};
	assert.equal(
		formatWidgetText(state),
		"Reflect Watchdog | active 5s/2 loops · task 5s/20m · root 2/60 · all 2/300 · queued · alt+x to cancel",
	);
	assert.match(formatCompactWidgetText(state), /· q alt\+x$/);
});

test("disabled shortcut surfaces the cancel command in the queued segment", () => {
	const state: WidgetState = {
		activity: { active: true, elapsedMs: 5_000, loops: 2 },
		taskElapsedMs: 5_000,
		taskMinutes: 20,
		rootLoops: 2,
		rootLoopLimit: 60,
		allLoops: 2,
		allLoopLimit: 300,
		queuedCancelLabel: "/cancel-reflect",
	};
	assert.match(
		formatWidgetText(state),
		/· queued · \/cancel-reflect to cancel$/,
	);
	assert.match(formatCompactWidgetText(state), /· q \/cancel-reflect$/);
});

test("private progress stays stage-first across resize and theme changes", () => {
	const state: WidgetState = {
		activity: { active: true, elapsedMs: 5_000, loops: 2 },
		taskElapsedMs: 5_000,
		taskMinutes: 20,
		rootLoops: 2,
		rootLoopLimit: 60,
		allLoops: 2,
		allLoopLimit: 300,
		cooldownRemainingLoops: 3,
		queuedCancelLabel: "alt+x",
		progress: {
			stage: "waiting for model",
			elapsedMs: 18_000,
			attempt: 1,
			attemptLimit: 3,
		},
	};
	const colors: string[] = [];
	let palette = "dark";
	const widget = createWatchdogWidget(
		{
			fg: (color, text) => {
				colors.push(`${palette}:fg:${color}`);
				return text;
			},
			bg: (color, text) => {
				colors.push(`${palette}:bg:${color}`);
				return text;
			},
		},
		() => state,
	);
	const full = widget.render(240)[0];
	assert.match(full, /^Reflect Watchdog \| waiting for model · 18s · 1\/3/);
	assert.match(
		full,
		/active 5s\/2 loops · task 5s\/20m · root 2\/60 · all 2\/300/,
	);
	assert.match(full, /3 loops disable/);
	assert.match(full, /queued · alt\+x to cancel/);
	assert.ok(colors.includes("dark:fg:accent"));
	assert.ok(colors.includes("dark:bg:toolPendingBg"));
	assert.match(widget.render(24)[0], /^RW \| waiting for model/);
	for (const width of [0, 1, 10, 24, 40, 80]) {
		const lines = widget.render(width);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= width);
	}
	palette = "light";
	assert.equal(
		widget.render(240)[0],
		full,
		"resize restores all stored values",
	);
	assert.ok(colors.includes("light:fg:accent"));
	assert.ok(colors.includes("light:bg:toolPendingBg"));
	assert.equal(formatWidgetText(state).includes("\x1b"), false);
	state.progress = undefined;
	widget.render(240);
	assert.equal(
		colors.at(-1),
		"light:fg:dim",
		"ordinary busy/queue/cooldown stay muted",
	);
});

test("content-free stream label replaces model waiting in full and compact rows", () => {
	const base: WidgetState = {
		activity: { active: false, elapsedMs: 0, loops: 0 },
		taskElapsedMs: 0,
		taskMinutes: 20,
		rootLoops: 0,
		rootLoopLimit: 60,
		allLoops: 0,
		allLoopLimit: 300,
		progress: {
			stage: "waiting for model",
			elapsedMs: 18_000,
			attempt: 1,
			attemptLimit: 3,
			stream: { kind: "writing", count: 1234 },
		},
	};
	const progress = base.progress;
	assert.ok(progress !== undefined);
	const full = formatWidgetText(base);
	assert.match(full, /writing ⠙ 1.2k · 18s · 1\/3/);
	assert.doesNotMatch(full, /waiting for model/);
	assert.match(formatCompactWidgetText(base), /writing ⠙ 1.2k/);
	// Correcting keeps its prefix while streaming.
	progress.stage = "correcting";
	assert.match(formatWidgetText(base), /correcting · writing ⠙ 1.2k/);
	// Helpers keep precedence: tools stage ignores the stream fields.
	progress.stage = "tools";
	progress.tools = ["read"];
	assert.match(formatWidgetText(base), /tools: read/);
	assert.doesNotMatch(formatWidgetText(base), /writing/);
	// No stream observed yet: plain stage text is unchanged.
	progress.stage = "waiting for model";
	progress.stream = undefined;
	assert.match(formatWidgetText(base), /waiting for model · 18s/);
});

test("safe helper names, elapsed time and attempt remain plain text", () => {
	const text = formatWidgetText({
		activity: { active: false, elapsedMs: 0, loops: 0 },
		taskElapsedMs: 0,
		taskMinutes: 20,
		rootLoops: 0,
		rootLoopLimit: 60,
		allLoops: 0,
		allLoopLimit: 300,
		progress: {
			stage: "tools",
			tools: ["read", "grep"],
			elapsedMs: 19_200,
			attempt: 2,
			attemptLimit: 3,
		},
	});
	assert.match(text, /tools: read, grep · 19s · 2\/3/);
	assert.doesNotMatch(text, /cancel|%|ETA/);
	assert.equal(text.includes("\x1b"), false);
});
