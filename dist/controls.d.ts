export type PromptAlias = "main" | "total" | "time";
export type WatchdogCommand = {
    action: "status";
} | {
    action: "reset";
} | {
    action: "limits-show";
} | {
    action: "limits-set";
    mainLoopLimit: number;
    observedTotalLoopLimit: number;
    wallClockMinutes: number;
} | {
    action: "limits-reset";
} | {
    action: "prompt-show";
} | {
    action: "prompt-edit";
    kind: PromptAlias;
} | {
    action: "prompt-reset";
    kind: PromptAlias | "all";
};
export type ParseResult = {
    command: WatchdogCommand;
} | {
    error: string;
};
export declare const WATCHDOG_USAGE = "Usage: /watchdog [status|reset|limits [<main> <observed> <minutes>|reset]|prompt [show|<main|total|time>|reset <main|total|time|all>]]";
/** Parse user command words without touching runtime state. */
export declare function parseWatchdogCommand(input: string): ParseResult;
