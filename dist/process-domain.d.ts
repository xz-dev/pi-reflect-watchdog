import { type CycleCounterSnapshot, openDomain } from "pi-process-domain";
export interface ReflectDomainCounters {
    readonly rootLoops: CycleCounterSnapshot;
    readonly domainLoops: CycleCounterSnapshot;
    readonly activeMs: CycleCounterSnapshot;
}
export interface ReflectDomainCoordinator {
    readonly rootProcess: boolean;
    attach(instance: object, onFatal: (error: Error) => void): Promise<void>;
    detach(instance: object): Promise<void>;
    setBusy(instance: object, busy: boolean): Promise<void>;
    recordRootLoop(): Promise<ReflectDomainCounters>;
    recordDomainLoop(): Promise<ReflectDomainCounters>;
    counters(): ReflectDomainCounters | undefined;
    subscribe(listener: (counters: ReflectDomainCounters) => void): () => void;
    pauseAndReset(): Promise<ReflectDomainCounters | undefined>;
    resume(): Promise<void>;
}
export interface ReflectDomainClock {
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}
export interface ReflectDomainOptions {
    readonly open?: typeof openDomain;
    readonly clock?: ReflectDomainClock;
    readonly activeTickMs?: number;
    readonly idleGraceMs?: number;
}
export declare function createReflectDomainCoordinator(options?: ReflectDomainOptions): ReflectDomainCoordinator;
export declare function getReflectDomainCoordinator(): ReflectDomainCoordinator;
