export const HUB_SYMBOL = Symbol.for("pi-reflect-watchdog:hub:v1");
export function getHub() {
    const globalState = globalThis;
    globalState[HUB_SYMBOL] ??= { nextToken: 0, nextGeneration: 0 };
    return globalState[HUB_SYMBOL];
}
export function allocateAttachmentToken(hub, sessionId) {
    hub.nextToken += 1;
    return `${sessionId}:${hub.nextToken}`;
}
/**
 * Atomically reserve or promote the process root. A UI attachment has priority
 * over the headless fallback; equal-priority candidates never steal a winner.
 */
export function claimRoot(hub, token, priority, value) {
    const current = hub.root;
    if (current !== undefined && current.priority >= priority)
        return undefined;
    hub.nextGeneration += 1;
    const root = { token, generation: hub.nextGeneration, priority, value };
    hub.root = root;
    return { root, replaced: current };
}
export function isCurrentRoot(hub, token, generation) {
    return hub.root?.token === token && hub.root.generation === generation;
}
export function releaseRoot(hub, token, generation) {
    if (!isCurrentRoot(hub, token, generation))
        return false;
    hub.root = undefined;
    return true;
}
