export const WATCHDOG_USAGE = "Usage: /watchdog [status|reset|limits [<main> <observed> <minutes>|reset]|prompt [show|<main|total|time>|reset <main|total|time|all>]]";
function positiveSafeInteger(token) {
    if (token === undefined || !/^\d+$/.test(token))
        return undefined;
    const value = Number(token);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
/** Parse user command words without touching runtime state. */
export function parseWatchdogCommand(input) {
    const words = input.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || (words.length === 1 && words[0] === "status"))
        return { command: { action: "status" } };
    if (words.length === 1 && words[0] === "reset")
        return { command: { action: "reset" } };
    if (words[0] === "limits") {
        if (words.length === 1)
            return { command: { action: "limits-show" } };
        if (words.length === 2 && words[1] === "reset")
            return { command: { action: "limits-reset" } };
        if (words.length === 4) {
            const [mainLoopLimit, observedTotalLoopLimit, wallClockMinutes] = words
                .slice(1)
                .map(positiveSafeInteger);
            if (mainLoopLimit !== undefined &&
                observedTotalLoopLimit !== undefined &&
                wallClockMinutes !== undefined)
                return {
                    command: {
                        action: "limits-set",
                        mainLoopLimit,
                        observedTotalLoopLimit,
                        wallClockMinutes,
                    },
                };
        }
        return {
            error: `Limits must use three positive safe integers. ${WATCHDOG_USAGE}`,
        };
    }
    if (words[0] === "prompt") {
        if (words.length === 2 && words[1] === "show")
            return { command: { action: "prompt-show" } };
        if (words.length === 2 &&
            (words[1] === "main" || words[1] === "total" || words[1] === "time"))
            return { command: { action: "prompt-edit", kind: words[1] } };
        if (words.length === 3 &&
            words[1] === "reset" &&
            (words[2] === "main" ||
                words[2] === "total" ||
                words[2] === "time" ||
                words[2] === "all"))
            return { command: { action: "prompt-reset", kind: words[2] } };
        return { error: `Invalid prompt command. ${WATCHDOG_USAGE}` };
    }
    return { error: `Unknown watchdog command. ${WATCHDOG_USAGE}` };
}
