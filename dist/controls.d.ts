export type ReflectWatchdogCommand = {
    action: "status";
} | {
    action: "reset";
} | {
    action: "limits-show";
} | {
    action: "limits-set";
    rootLoopLimit: number;
    allLoopLimit: number;
    taskMinutes: number;
    idleResetGapSeconds: number;
} | {
    action: "limits-reset";
};
export type ParseReflectWatchdogResult = {
    command: ReflectWatchdogCommand;
} | {
    error: string;
};
export declare const REFLECT_WATCHDOG_COMMAND = "reflect-watchdog";
export declare const REFLECT_COMMAND = "reflect";
export declare const REFLECT_TIMELINE_COMMAND = "reflect-timeline";
export declare const REFLECT_WATCHDOG_USAGE = "Usage: /reflect-watchdog [status|reset|limits [<root> <all> <minutes> <idle-reset-seconds>|reset]]";
/** Parse the reflect-watchdog control command without touching runtime state. */
export declare function parseReflectWatchdogCommand(input: string): ParseReflectWatchdogResult;
