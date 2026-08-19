export const REFLECT_WATCHDOG_COMMAND = "reflect-watchdog";
export const REFLECT_COMMAND = "reflect";
export const REFLECT_TIMELINE_COMMAND = "reflect-timeline";
export const REFLECT_WATCHDOG_USAGE = "Usage: /reflect-watchdog [status|reset|limits [<root> <all> <minutes> <idle-reset-seconds>|reset]]";
function positiveSafeInteger(token) {
    if (token === undefined || !/^\d+$/.test(token))
        return undefined;
    const value = Number(token);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
/** Parse the reflect-watchdog control command without touching runtime state. */
export function parseReflectWatchdogCommand(input) {
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
        if (words.length === 5) {
            const [rootLoopLimit, allLoopLimit, taskMinutes, idleResetGapSeconds] = words.slice(1).map(positiveSafeInteger);
            if (rootLoopLimit !== undefined &&
                allLoopLimit !== undefined &&
                taskMinutes !== undefined &&
                idleResetGapSeconds !== undefined)
                return {
                    command: {
                        action: "limits-set",
                        rootLoopLimit,
                        allLoopLimit,
                        taskMinutes,
                        idleResetGapSeconds,
                    },
                };
        }
        return {
            error: `Limits must use four positive safe integers. ${REFLECT_WATCHDOG_USAGE}`,
        };
    }
    return {
        error: `Unknown reflect-watchdog command. ${REFLECT_WATCHDOG_USAGE}`,
    };
}
