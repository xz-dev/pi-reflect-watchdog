import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type LoadedConfig } from "./config-loader.js";
type Timer = ReturnType<typeof setTimeout>;
export type WatchdogTimerRole = "threshold" | "tui-refresh" | "rpc-status";
export interface RuntimeServices {
    now(): number;
    /**
     * Legacy timer seam retained for existing internal consumers. New test
     * adapters can use scheduleTimer to observe the watchdog's timer purpose
     * without guessing from a delay that can legitimately collide.
     */
    setTimeout(callback: () => void, delay: number): Timer;
    clearTimeout(timer: Timer): void;
    loadConfig(cwd: string, trusted: boolean): Promise<LoadedConfig>;
    /** Optional role-aware scheduling seam; production falls back to setTimeout. */
    scheduleTimer?(role: WatchdogTimerRole, callback: () => void, delay: number): Timer;
}
export declare function createWatchdogExtension(overrides?: Partial<RuntimeServices>): (pi: ExtensionAPI) => void;
declare const _default: (pi: ExtensionAPI) => void;
export default _default;
