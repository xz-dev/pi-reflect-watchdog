import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	FATAL_EXIT_CODE,
	isReflectDomainFatalError,
} from "./process-domain.js";

const FALLBACK_DELAY_MS = 1_000;

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

export function sanitizedReflectDomainError(error: Error): string {
	const code = isReflectDomainFatalError(error)
		? error.code
		: "DOMAIN_UNRECOVERABLE";
	return `Reflect watchdog process domain failed (${code}). The Pi process will exit.`;
}

export function createFatalExitAdapter(options?: {
	readonly process?: FatalExitProcess;
	readonly clock?: FatalExitClock;
}): FatalExitAdapter {
	const processAdapter = options?.process ?? process;
	const clock = options?.clock ?? {
		setTimeout: (callback: () => void, delayMs: number) =>
			setTimeout(callback, delayMs),
		clearTimeout: (handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	let fallback: unknown | undefined;
	let failed = false;

	return {
		fail(error, ctx): void {
			if (failed) return;
			failed = true;
			processAdapter.exitCode = FATAL_EXIT_CODE;
			processAdapter.once("exit", () => {
				processAdapter.exitCode = FATAL_EXIT_CODE;
			});
			const message = sanitizedReflectDomainError(error);
			try {
				ctx.ui.notify(message, "error");
			} catch {
				console.error(message);
			}
			try {
				ctx.abort();
			} catch {
				// No active model run is a valid fatal startup state.
			}
			if (ctx.mode === "tui" || ctx.mode === "rpc") {
				try {
					ctx.shutdown();
				} catch {
					// The bounded direct exit remains authoritative.
				}
			}
			fallback = clock.setTimeout(
				() => processAdapter.exit(FATAL_EXIT_CODE),
				FALLBACK_DELAY_MS,
			);
		},
		completeShutdown(): void {
			if (failed) processAdapter.exitCode = FATAL_EXIT_CODE;
			if (fallback !== undefined) {
				clock.clearTimeout(fallback);
				fallback = undefined;
			}
		},
	};
}
