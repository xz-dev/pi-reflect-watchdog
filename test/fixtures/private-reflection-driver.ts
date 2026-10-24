/* biome-ignore-all lint/suspicious/noExplicitAny: test fixture boundary */
import { readFile, writeFile } from "node:fs/promises";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type PrivateChildSession,
	type PrivateForkInput,
	type PrivateInquiryOptions,
	type PrivateInquiryResult,
	type PrivateRuntime,
	runPrivateInquiry,
} from "pi-extension-utils/private-inquiry";
import type { ReflectionDecision } from "../../src/reflection-protocol.js";

/** Matches the (non-exported) PrivateInquiryServices seam in extension.ts —
 * the duck-typed contract install() accepts via `privateInquiry`. */
interface DriverInquiryServices {
	createRuntime(): Promise<PrivateRuntime>;
	run(
		options: PrivateInquiryOptions<ReflectionDecision>,
	): Promise<PrivateInquiryResult<ReflectionDecision>>;
}

/**
 * Real-file private-inquiry driver (Continue pattern, adapted to the
 * PrivateInquiryServices seam). The shared `runPrivateInquiry` core owns
 * validation, correction prompts, result-file reset, abort and terminal
 * classification; the fake `PrivateRuntime.fork` supplies a scripted child
 * whose own terminal assistant carries full legitimate provider metadata so
 * the private-source gate sees the real captured fields — no fabrication.
 *
 * A prompt with an empty script queue parks until `respond()` (or `abort()`),
 * mirroring a real child awaiting a model response.
 */

export interface ReflectionDriverReply {
	/** Raw string written to the real result file. Omitted = file untouched. */
	readonly write?: string;
	/** Throw from prompt() — provider/transport failure. */
	readonly throw?: Error;
	/** Terminal assistant stopReason override. */
	readonly stopReason?: "stop" | "error" | "aborted";
	readonly errorMessage?: string;
	/** Emit a provider error and native retry lifecycle inside this one prompt. */
	readonly nativeRetry?: boolean;
	/** Runner-side format diagnostic for a normally settled response. */
	readonly attemptError?: string;
	/** Settled prompt appends no own assistant reply. */
	readonly noOwnReply?: boolean;
	/** Terminal assistant metadata override for the child's own reply. */
	readonly assistantMeta?: {
		readonly api?: string;
		readonly provider?: string;
		readonly model?: string;
		readonly responseId?: string;
	};
	/** Prepend opaque content blocks (thinking/signature) to the child's
	 * own terminal assistant — exercises the sanitize gate so wire
	 * assertions on opaque leakage are non-vacuous. */
	readonly assistantOpaqueContent?: readonly Record<string, unknown>[];
	/** Optional gate: the prompt does not settle until this resolves. */
	readonly hold?: Promise<void>;
	/** Write the result before `hold` (a valid file staged, not yet
	 * accepted, when the hold is aborted). */
	readonly writeBeforeHold?: boolean;
}

export interface ReflectionDriverChild extends PrivateChildSession {
	readonly messages: readonly AgentMessage[];
	readonly prompts: readonly string[];
	readonly fileStates: readonly string[];
	readonly aborted: boolean;
	readonly disposed: boolean;
}

export interface TrackedReflectionOperation {
	readonly options: PrivateInquiryOptions<ReflectionDecision>;
	readonly result: Promise<PrivateInquiryResult<ReflectionDecision>>;
	readonly settled: boolean;
}

const usage = () => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function createReflectionDriver(
	options: {
		/** Locator returned as each child's `sessionFile` — point it at a real
		 * file to exercise retained-evidence availability; undefined leaves
		 * the child reporting no session file (no-session evidence). */
		readonly sessionFile?: string;
	} = {},
) {
	const queue: ReflectionDriverReply[] = [];
	const children: ReflectionDriverChild[] = [];
	const operations: TrackedReflectionOperation[] = [];
	const forkInputs: PrivateForkInput[] = [];
	const waiting: Array<{
		readonly child: ReflectionDriverChild;
		resolve(reply: ReflectionDriverReply): void;
	}> = [];

	const nextReply = (
		child: ReflectionDriverChild,
	): Promise<ReflectionDriverReply> => {
		const scripted = queue.shift();
		if (scripted !== undefined) return Promise.resolve(scripted);
		return new Promise<ReflectionDriverReply>((resolve) => {
			waiting.push({ child, resolve });
		});
	};

	const runtime: PrivateRuntime = {
		async fork(input) {
			forkInputs.push(input);
			const prompts: string[] = [];
			const fileStates: string[] = [];
			const messages: AgentMessage[] = [];
			const state = {
				aborted: false,
				disposed: false,
				attemptError: undefined as string | undefined,
				releaseHold: undefined as (() => void) | undefined,
			};
			const sessionId = `private-child-${children.length + 1}`;
			const listeners = new Set<(event: unknown) => void>();
			const emitEvent = (type: string, extra?: Record<string, unknown>) => {
				for (const listener of listeners) listener({ type, ...extra });
			};
			const child: ReflectionDriverChild = {
				sessionId,
				modelId: "fixture-provider/fixture-model",
				sessionFile: options.sessionFile,
				messages,
				get attemptError() {
					return state.attemptError;
				},
				helperCalls: 0,
				inheritedProvider: "fixture-provider",
				get aborted() {
					return state.aborted;
				},
				get disposed() {
					return state.disposed;
				},
				prompts,
				fileStates,
				async prompt(text: string) {
					const abortedError = () => {
						const error = new Error("aborted");
						error.name = "AbortError";
						return error;
					};
					if (state.aborted) throw abortedError();
					prompts.push(text);
					emitEvent(prompts.length === 1 ? "agent_start" : "turn_start");
					try {
						fileStates.push(
							await readFile(input.resultFile, "utf8").catch(() => "{}"),
						);
						// Abort can arrive during file I/O, before a waiter exists.
						if (state.aborted) throw abortedError();
						const reply = await nextReply(child);
						if (state.aborted) throw abortedError();
						if (reply.nativeRetry) {
							messages.push({
								role: "assistant",
								api: "openai-completions",
								provider: "fixture-provider",
								model: "fixture-model",
								content: [],
								usage: usage(),
								timestamp: Date.now(),
								stopReason: "error",
								errorMessage: "native provider retry fixture",
							} as AgentMessage);
							emitEvent("agent_end", { willRetry: true });
							emitEvent("auto_retry_start");
						}
						if (reply.writeBeforeHold && reply.write !== undefined)
							await writeFile(input.resultFile, reply.write);
						if (reply.hold !== undefined) {
							await new Promise<void>((resolve, reject) => {
								state.releaseHold = resolve;
								void reply.hold?.then(resolve, reject);
							});
							state.releaseHold = undefined;
							if (state.aborted) throw abortedError();
						}
						if (reply.nativeRetry)
							emitEvent("auto_retry_end", {
								success: reply.stopReason !== "error",
							});
						if (
							reply.write !== undefined &&
							!reply.writeBeforeHold &&
							!state.aborted
						)
							await writeFile(input.resultFile, reply.write);
						state.attemptError = reply.attemptError;
						if (reply.noOwnReply !== true) {
							messages.push({
								role: "assistant",
								api: reply.assistantMeta?.api ?? "openai-completions",
								provider: reply.assistantMeta?.provider ?? "fixture-provider",
								model: reply.assistantMeta?.model ?? "fixture-model",
								responseId:
									reply.assistantMeta?.responseId ??
									`${sessionId}-response-${prompts.length}`,
								usage: usage(),
								content: [
									...(reply.assistantOpaqueContent ?? []),
									{ type: "text", text: "reply" },
								],
								stopReason: reply.stopReason ?? "stop",
								...(reply.errorMessage === undefined
									? {}
									: { errorMessage: reply.errorMessage }),
								timestamp: Date.now(),
							} as unknown as AgentMessage);
						}
						if (reply.throw !== undefined) throw reply.throw;
					} finally {
						// A prompt that ends — settled or aborted — always emits
						// the terminal pair so observers release the working flag.
						emitEvent("agent_end", { willRetry: false });
						emitEvent("agent_settled");
					}
				},

				async abort() {
					state.aborted = true;
					state.releaseHold?.();
					// Release this child's parked prompt so it surfaces AbortError.
					for (let index = waiting.length - 1; index >= 0; index -= 1) {
						const parked = waiting[index];
						if (parked?.child === child) {
							waiting.splice(index, 1);
							parked.resolve({});
						}
					}
				},
				async dispose() {
					state.disposed = true;
				},
				subscribe(listener: (event: unknown) => void) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			} as unknown as ReflectionDriverChild;
			children.push(child);
			return child;
		},
		async dispose() {},
	};

	const service: DriverInquiryServices = {
		createRuntime: () => Promise.resolve(runtime),
		run: (options) => {
			const tracked = {
				options,
				settled: false,
				result: runPrivateInquiry(options),
			} as TrackedReflectionOperation & { settled: boolean };
			void tracked.result.then(
				() => {
					tracked.settled = true;
				},
				() => {
					tracked.settled = true;
				},
			);
			operations.push(tracked);
			return tracked.result;
		},
	};

	return {
		service,
		children,
		operations,
		forkInputs,
		waiting,
		/** Queue a scripted reply for the next consumed prompt. */
		respond(reply: ReflectionDriverReply): void {
			const blocked = waiting.shift();
			if (blocked !== undefined) {
				blocked.resolve(reply);
				return;
			}
			queue.push(reply);
		},
		get awaitingResponse(): boolean {
			return waiting.length > 0;
		},
		get current(): TrackedReflectionOperation | undefined {
			return operations.at(-1);
		},
	};
}

export type ReflectionDriver = ReturnType<typeof createReflectionDriver>;

/** One event-loop turn: real file I/O and promise chains need real turns. */
const turn = (): Promise<void> =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, 1);
	});

/** Wait until a private run has been started (dispatch is async). */
export async function awaitReflectionOperation(
	driver: ReflectionDriver,
	options?: { readonly turns?: number },
): Promise<TrackedReflectionOperation> {
	const limit = options?.turns ?? 2000;
	for (let attempt = 0; attempt < limit; attempt += 1) {
		const operation = driver.operations.at(-1);
		if (operation !== undefined) return operation;
		await turn();
	}
	throw new Error("no private reflection operation was started");
}

/** Wait until the latest operation settles, failing fast on a parked prompt
 * that was never scripted. Publication continues asynchronously after the
 * result resolves; a bounded extra drain covers it. */
export async function settleReflectionOperation(
	driver: ReflectionDriver,
	options?: { readonly turns?: number },
): Promise<PrivateInquiryResult<ReflectionDecision> | undefined> {
	const operation = driver.operations.at(-1);
	if (operation === undefined)
		throw new Error("no private reflection operation to settle");
	const limit = options?.turns ?? 2000;
	for (let attempt = 0; attempt < limit && !operation.settled; attempt += 1) {
		if (driver.awaitingResponse)
			throw new Error(
				"private child is waiting for a scripted response that was never queued",
			);
		await turn();
	}
	if (!operation.settled)
		throw new Error("private reflection operation did not settle");
	const result = await operation.result;
	for (let attempt = 0; attempt < 40; attempt += 1) await turn();
	return result;
}
