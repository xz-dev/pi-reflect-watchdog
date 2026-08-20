import { openProcessDomain, type ProcessDomainOpenErrorCode } from "pi-extension-utils/process-domain";
export declare const FATAL_EXIT_CODE = 78;
export type ReflectDomainFatalCode = ProcessDomainOpenErrorCode | "DOMAIN_UNRECOVERABLE";
export declare class ReflectDomainFatalError extends Error {
    readonly code: ReflectDomainFatalCode;
    readonly isReflectDomainFatalError: true;
    constructor(code: ReflectDomainFatalCode, message: string, options?: {
        readonly cause?: unknown;
    });
}
export declare function isReflectDomainFatalError(value: unknown): value is ReflectDomainFatalError;
export interface ReflectCounterValue {
    readonly value: bigint;
    readonly paused: boolean;
}
export interface ReflectDomainFence {
    readonly domainEpoch: string;
    readonly generation: bigint;
}
export interface ReflectDomainCounters {
    readonly domainEpoch: string;
    readonly revision: bigint;
    readonly generation: bigint;
    readonly certain: boolean;
    readonly anyBusy: boolean;
    readonly endLoopTimeMs: bigint | null;
    readonly fence: ReflectDomainFence;
    readonly activeMs: ReflectCounterValue;
    readonly activeLoops: ReflectCounterValue;
    readonly taskMs: ReflectCounterValue;
    readonly rootLoops: ReflectCounterValue;
    readonly allLoops: ReflectCounterValue;
}
export interface ReflectDomainCoordinator {
    readonly rootProcess: boolean;
    attach(instance: object, options: {
        /** Queried at attach and after every client reconnect. */
        readonly getBusy: () => boolean;
        readonly onFatal: (error: Error) => void;
    }): Promise<void>;
    detach(instance: object): Promise<void>;
    setBusy(instance: object, busy: boolean): Promise<void>;
    recordRootLoop(): Promise<ReflectDomainCounters>;
    recordAllLoop(): Promise<ReflectDomainCounters>;
    counters(): ReflectDomainCounters | undefined;
    subscribe(listener: (counters: ReflectDomainCounters) => void): () => void;
    setIdleResetGapSeconds(seconds: number): void;
    resetReminderCycle(): Promise<ReflectDomainCounters | undefined>;
    pauseForReflection(resetReminderCycle: boolean): Promise<ReflectDomainCounters | undefined>;
    resume(): Promise<void>;
}
export interface ReflectDomainClock {
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}
export interface ReflectDomainOptions {
    readonly open?: typeof openProcessDomain;
    readonly env?: NodeJS.ProcessEnv;
    readonly clock?: ReflectDomainClock;
    readonly activeTickMs?: number;
    readonly idleResetGapMs?: number;
    readonly now?: () => number;
}
export declare function createReflectDomainCoordinator(options?: ReflectDomainOptions): ReflectDomainCoordinator;
export declare function getReflectDomainCoordinator(): ReflectDomainCoordinator;
