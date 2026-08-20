export declare const HUB_SYMBOL: unique symbol;
export declare const REFLECT_WATCHDOG_API_SYMBOL: unique symbol;
export interface ReflectWatchdogApi {
    readonly paused: boolean;
    pause(): void;
    resume(): void;
}
export type RootPriority = 1 | 2;
export interface RootAttachment<T> {
    token: string;
    generation: number;
    priority: RootPriority;
    value: T;
}
export interface WatchdogHub<T> {
    nextToken: number;
    nextGeneration: number;
    root?: RootAttachment<T>;
}
export interface RootClaim<T> {
    root: RootAttachment<T>;
    replaced?: RootAttachment<T>;
}
export declare function getHub<T>(): WatchdogHub<T>;
export declare function installReflectWatchdogApi(api: ReflectWatchdogApi): () => void;
export declare function allocateAttachmentToken<T>(hub: WatchdogHub<T>, sessionId: string): string;
/**
 * Atomically reserve or promote the process root. A UI attachment has priority
 * over the headless fallback; equal-priority candidates never steal a winner.
 */
export declare function claimRoot<T>(hub: WatchdogHub<T>, token: string, priority: RootPriority, value: T): RootClaim<T> | undefined;
export declare function isCurrentRoot<T>(hub: WatchdogHub<T>, token: string, generation: number): boolean;
export declare function releaseRoot<T>(hub: WatchdogHub<T>, token: string, generation: number): boolean;
