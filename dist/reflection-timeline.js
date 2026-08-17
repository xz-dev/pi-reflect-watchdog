import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
const MAX_TIMELINE_ITEMS = 100;
const MAX_FALLBACK_CHARACTERS = 16_384;
const VISIBLE_LINES = 20;
export function boundedTimelineText(entries) {
    const selected = entries.slice(-MAX_TIMELINE_ITEMS);
    const firstOrdinal = Math.max(1, entries.length - selected.length + 1);
    const text = selected.length === 0
        ? "No completed reflections on the current branch."
        : selected
            .map((entry, index) => `#${firstOrdinal + index}\n${entry.report}`)
            .join("\n\n");
    return Array.from(text).length <= MAX_FALLBACK_CHARACTERS
        ? text
        : `${Array.from(text)
            .slice(0, MAX_FALLBACK_CHARACTERS - 3)
            .join("")}...`;
}
export function createReflectionEntryRenderer() {
    return (entry, _options, theme) => {
        const data = entry.data;
        if (data === undefined || typeof data.report !== "string")
            return undefined;
        const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
        box.addChild(new Text(`${theme.fg("accent", `Reflection · ${data.decision.type}`)}\n${theme.fg("toolOutput", data.report)}`, 0, 0));
        return box;
    };
}
class ReflectionTimelineComponent {
    tui;
    theme;
    done;
    offset = 0;
    lines;
    constructor(text, tui, theme, done) {
        this.tui = tui;
        this.theme = theme;
        this.done = done;
        this.lines = text.split("\n");
    }
    handleInput(data) {
        if (data === "\u001b" || data === "\u0003" || data === "q") {
            this.done();
            return;
        }
        if (data === "\u001b[A" || data === "k")
            this.offset = Math.max(0, this.offset - 1);
        else if (data === "\u001b[B" || data === "j")
            this.offset = Math.min(Math.max(0, this.lines.length - VISIBLE_LINES), this.offset + 1);
        else if (data === "\u001b[5~")
            this.offset = Math.max(0, this.offset - VISIBLE_LINES);
        else if (data === "\u001b[6~")
            this.offset = Math.min(Math.max(0, this.lines.length - VISIBLE_LINES), this.offset + VISIBLE_LINES);
        else
            return;
        this.tui.requestRender();
    }
    render(width) {
        const inner = Math.max(1, width - 2);
        const end = Math.min(this.lines.length, this.offset + VISIBLE_LINES);
        const header = ` Reflection timeline · ${this.offset + 1}-${Math.max(this.offset + 1, end)}/${this.lines.length} · ↑↓/jk scroll · q/Esc close `;
        const rows = [
            this.theme.fg("border", "─".repeat(inner)),
            this.theme.fg("accent", truncateToWidth(header, inner)),
            ...this.lines
                .slice(this.offset, end)
                .map((line) => this.theme.fg("toolOutput", truncateToWidth(line, inner))),
            this.theme.fg("border", "─".repeat(inner)),
        ];
        return rows;
    }
    invalidate() { }
}
export async function showReflectionTimeline(ctx, entries) {
    const text = boundedTimelineText(entries);
    if (ctx.mode !== "tui") {
        ctx.ui.notify(text);
        return;
    }
    await ctx.ui.custom((tui, theme, _keybindings, done) => new ReflectionTimelineComponent(text, tui, theme, done));
}
