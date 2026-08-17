import type { EntryRenderer, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReflectionHistoryEntry } from "./reflection-history.js";
export declare function boundedTimelineText(entries: readonly ReflectionHistoryEntry[]): string;
export declare function createReflectionEntryRenderer(): EntryRenderer<ReflectionHistoryEntry>;
export declare function showReflectionTimeline(ctx: ExtensionCommandContext, entries: readonly ReflectionHistoryEntry[]): Promise<void>;
