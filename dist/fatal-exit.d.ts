import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export interface FatalExitProcess {
    exitCode: number | undefined;
    once(event: "exit", listener: (code: number) => void): unknown;
    exit(code: number): never | undefined;
}
export interface FatalExitClock {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface FatalExitAdapter {
    fail(error: Error, ctx: ExtensionContext): void;
    completeShutdown(): void;
}
export declare function sanitizedReflectDomainError(error: Error): string;
export declare function createFatalExitAdapter(options?: {
    readonly process?: FatalExitProcess;
    readonly clock?: FatalExitClock;
}): FatalExitAdapter;
