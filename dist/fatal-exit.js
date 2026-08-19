import { FATAL_EXIT_CODE, isReflectDomainFatalError, } from "./process-domain.js";
const FALLBACK_DELAY_MS = 1_000;
export function sanitizedReflectDomainError(error) {
    const code = isReflectDomainFatalError(error)
        ? error.code
        : "DOMAIN_UNRECOVERABLE";
    return `Reflect watchdog process domain failed (${code}). The Pi process will exit.`;
}
export function createFatalExitAdapter(options) {
    const processAdapter = options?.process ?? process;
    const clock = options?.clock ?? {
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (handle) => clearTimeout(handle),
    };
    let fallback;
    let failed = false;
    return {
        fail(error, ctx) {
            if (failed)
                return;
            failed = true;
            processAdapter.exitCode = FATAL_EXIT_CODE;
            processAdapter.once("exit", () => {
                processAdapter.exitCode = FATAL_EXIT_CODE;
            });
            const message = sanitizedReflectDomainError(error);
            try {
                ctx.ui.notify(message, "error");
            }
            catch {
                console.error(message);
            }
            try {
                ctx.abort();
            }
            catch {
                // No active model run is a valid fatal startup state.
            }
            if (ctx.mode === "tui" || ctx.mode === "rpc") {
                try {
                    ctx.shutdown();
                }
                catch {
                    // The bounded direct exit remains authoritative.
                }
            }
            fallback = clock.setTimeout(() => processAdapter.exit(FATAL_EXIT_CODE), FALLBACK_DELAY_MS);
        },
        completeShutdown() {
            if (failed)
                processAdapter.exitCode = FATAL_EXIT_CODE;
            if (fallback !== undefined) {
                clock.clearTimeout(fallback);
                fallback = undefined;
            }
        },
    };
}
