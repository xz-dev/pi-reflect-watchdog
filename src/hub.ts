export const HUB_SYMBOL = Symbol.for("pi-watchdog:hub:v1");

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

export function getHub<T>(): WatchdogHub<T> {
	const globalState = globalThis as typeof globalThis & {
		[HUB_SYMBOL]?: WatchdogHub<T>;
	};
	globalState[HUB_SYMBOL] ??= { nextToken: 0, nextGeneration: 0 };
	return globalState[HUB_SYMBOL];
}

export function allocateAttachmentToken<T>(
	hub: WatchdogHub<T>,
	sessionId: string,
): string {
	hub.nextToken += 1;
	return `${sessionId}:${hub.nextToken}`;
}

/**
 * Atomically reserve or promote the process root. A UI attachment has priority
 * over the headless fallback; equal-priority candidates never steal a winner.
 */
export function claimRoot<T>(
	hub: WatchdogHub<T>,
	token: string,
	priority: RootPriority,
	value: T,
): RootClaim<T> | undefined {
	const current = hub.root;
	if (current !== undefined && current.priority >= priority) return undefined;
	hub.nextGeneration += 1;
	const root = { token, generation: hub.nextGeneration, priority, value };
	hub.root = root;
	return { root, replaced: current };
}

export function isCurrentRoot<T>(
	hub: WatchdogHub<T>,
	token: string,
	generation: number,
): boolean {
	return hub.root?.token === token && hub.root.generation === generation;
}

export function releaseRoot<T>(
	hub: WatchdogHub<T>,
	token: string,
	generation: number,
): boolean {
	if (!isCurrentRoot(hub, token, generation)) return false;
	hub.root = undefined;
	return true;
}
