import assert from "node:assert/strict";
import test from "node:test";
import type {
	ProcessDomainDataMessage,
	ProcessDomainEvent,
	ProcessDomainNode,
} from "pi-extension-utils/process-domain";
import {
	createReflectDomainCoordinator,
	type ReflectDomainClock,
	type ReflectDomainCounters,
} from "../src/process-domain.js";

class FakeNode implements ProcessDomainNode {
	readonly nodeId: string;
	readonly transport = "ipc" as const;
	readonly endpoint = "ipc://temporary";
	readonly declaration;
	readonly sent: Array<{ targetId: string; channel: string; value: unknown }> =
		[];
	readonly broadcasts: Array<{ channel: string; value: unknown }> = [];
	closeCount = 0;
	sendError: Error | null = null;
	broadcastError: Error | null = null;
	sendBarrier: Promise<void> | null = null;
	private readonly channelListeners = new Map<
		string,
		Set<(message: ProcessDomainDataMessage) => void>
	>();
	private readonly eventListeners = new Set<
		(event: ProcessDomainEvent) => void
	>();
	private readonly peerValues = new Map<
		string,
		ReturnType<ProcessDomainNode["peers"]>[number]
	>();

	constructor(
		readonly role: "host" | "client",
		nodeId: string = role,
	) {
		this.nodeId = nodeId;
		this.declaration = {
			version: 1 as const,
			domainId: "domain",
			endpoint: this.endpoint,
			capability: "capability",
			hostNodeId: "host",
		};
	}

	peers() {
		return Array.from(this.peerValues.values());
	}

	async send(targetId: string, channel: string, value: unknown): Promise<void> {
		this.sent.push({ targetId, channel, value });
		if (this.sendBarrier !== null) await this.sendBarrier;
		if (this.sendError !== null) throw this.sendError;
	}

	async broadcast(channel: string, value: unknown): Promise<void> {
		this.broadcasts.push({ channel, value });
		if (this.broadcastError !== null) throw this.broadcastError;
	}

	async reportLifecycle(): Promise<void> {}

	subscribe(
		channel: string,
		listener: (message: ProcessDomainDataMessage) => void,
	): () => void {
		const listeners = this.channelListeners.get(channel) ?? new Set();
		listeners.add(listener);
		this.channelListeners.set(channel, listeners);
		return () => listeners.delete(listener);
	}

	subscribeEvents(listener: (event: ProcessDomainEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}

	emitChannel(channel: string, value: unknown, senderId = "child"): void {
		const message: ProcessDomainDataMessage = {
			id: "message",
			channel,
			value,
			senderId,
			targetId: this.nodeId,
			receivedAt: Date.now(),
		};
		for (const listener of this.channelListeners.get(channel) ?? [])
			listener(message);
	}

	emitPeer(nodeId: string, status: "online" | "offline"): void {
		const peer = {
			nodeId,
			status,
			metadata: { activity: "idle" },
			connectedAt: Date.now(),
			...(status === "offline" ? { disconnectedAt: Date.now() } : {}),
		} as const;
		this.peerValues.set(nodeId, peer);
		for (const listener of this.eventListeners)
			listener({ type: "peer", peer });
	}
}

function fakeClock() {
	const callbacks: Array<{ callback: () => void; cancelled: boolean }> = [];
	const delays: number[] = [];
	const clock: ReflectDomainClock = {
		setTimeout(callback, delayMs) {
			const handle = { callback, cancelled: false, unref() {} };
			callbacks.push(handle);
			delays.push(delayMs);
			return handle as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout(handle) {
			(handle as unknown as { cancelled: boolean }).cancelled = true;
		},
	};
	const fireNext = (): void => {
		while (callbacks.length > 0) {
			const next = callbacks.shift();
			if (next && !next.cancelled) {
				next.callback();
				return;
			}
		}
	};
	return { clock, callbacks, delays, fireNext };
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

const counterSends = (node: FakeNode) =>
	node.sent.filter(
		(entry) => entry.channel === "pi-reflect-watchdog.counters.v2",
	);

test("root owns root/domain counters and child loop increments aggregate", async () => {
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	const first = await coordinator.recordRootLoop();
	assert.equal(first.rootLoops.value, 1n);
	assert.equal(first.allLoops.value, 1n);

	node.emitPeer("child", "online");
	await flush();
	node.emitChannel("pi-reflect-watchdog.activity.v2", {
		revision: "1",
		busy: false,
	});
	await flush();
	node.emitChannel("pi-reflect-watchdog.loop.v2", {
		revision: "1",
		rootLoops: "0",
		allLoops: "1",
	});
	await flush();
	const counters = coordinator.counters();
	assert.equal(counters?.rootLoops.value, 1n);
	assert.equal(counters?.allLoops.value, 2n);
	assert.deepEqual(counterSends(node).at(-1)?.value, {
		revision: "5",
		generation: "5",
		domainEpoch: "domain",
		certain: true,
		anyBusy: false,
		localBusy: false,
		otherBusy: false,
		endLoopTimeMs: null,
		activeMs: "0",
		activeLoops: "2",
		taskMs: "0",
		rootLoops: "1",
		allLoops: "2",
		activityRevisions: [{ nodeId: "child", revision: "1" }],
		loopRevisions: [{ nodeId: "child", revision: "1" }],
	});
	await coordinator.detach(instance);
	assert.equal(node.closeCount, 1);
});

test("active tick freezes at aggregate idle and only a strict idle-gap overflow resets all counters", async () => {
	const node = new FakeNode("host");
	const time = fakeClock();
	let nowMs = 10_000;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
		clock: time.clock,
		activeTickMs: 250,
		idleResetGapMs: 60_000,
		now: () => nowMs,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	await coordinator.recordRootLoop();
	await coordinator.setBusy(instance, true);
	assert.deepEqual(time.delays, [250]);
	time.fireNext();
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 250n);
	assert.equal(coordinator.counters()?.taskMs.value, 250n);
	assert.equal(coordinator.counters()?.activeLoops.value, 1n);

	await coordinator.setBusy(instance, false);
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 250n);
	assert.equal(coordinator.counters()?.taskMs.value, 250n);
	assert.equal(coordinator.counters()?.endLoopTimeMs, 10_000n);
	assert.equal(
		time.callbacks.filter((entry) => !entry.cancelled).length,
		0,
		"all-idle freezes immediately without scheduling a debounce",
	);

	nowMs = 70_000;
	await coordinator.setBusy(instance, true);
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 250n);
	assert.equal(coordinator.counters()?.rootLoops.value, 1n);
	assert.equal(coordinator.counters()?.allLoops.value, 1n);
	assert.equal(coordinator.counters()?.endLoopTimeMs, null);

	await coordinator.setBusy(instance, false);
	await flush();
	nowMs = 130_001;
	await coordinator.setBusy(instance, true);
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 0n);
	assert.equal(coordinator.counters()?.activeLoops.value, 0n);
	assert.equal(coordinator.counters()?.taskMs.value, 0n);
	assert.equal(coordinator.counters()?.rootLoops.value, 0n);
	assert.equal(coordinator.counters()?.allLoops.value, 0n);
	assert.equal(coordinator.counters()?.endLoopTimeMs, null);
	await coordinator.detach(instance);
});

test("attach and reconnect query the live busy source", async () => {
	const node = new FakeNode("client", "child");
	node.emitPeer("host", "online");
	let busy = true;
	let probes = 0;
	const coordinator = createReflectDomainCoordinator({
		env: { PI_EXTENSION_UTILS_PROCESS_DOMAIN: "declaration" },
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, {
		getBusy: () => {
			probes += 1;
			return busy;
		},
		onFatal() {},
	});
	assert.equal(probes, 1);
	assert.deepEqual(node.sent.at(-1)?.value, { revision: "1", busy: true });

	busy = false;
	node.emitPeer("host", "online");
	await flush();
	assert.equal(probes, 2);
	assert.deepEqual(
		node.sent
			.filter(
				(message) => message.channel === "pi-reflect-watchdog.activity.v2",
			)
			.at(-1)?.value,
		{ revision: "2", busy: false },
	);
	await coordinator.detach(instance);
});

test("client requires snapshot echoes for activity and loop revisions", async () => {
	const node = new FakeNode("client", "child");
	node.emitPeer("host", "online");
	const coordinator = createReflectDomainCoordinator({
		env: { PI_EXTENSION_UTILS_PROCESS_DOMAIN: "declaration" },
		open: async () => node,
	});
	const instance = {};
	const seen: ReflectDomainCounters[] = [];
	coordinator.subscribe((counters) => seen.push(counters));
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	assert.deepEqual(node.sent.at(-1)?.value, { revision: "1", busy: false });
	await coordinator.recordAllLoop();
	assert.deepEqual(node.sent.at(-1)?.value, {
		revision: "1",
		rootLoops: "0",
		allLoops: "1",
	});

	node.emitChannel(
		"pi-reflect-watchdog.counters.v2",
		{
			revision: "1",
			generation: "1",
			domainEpoch: "domain",
			certain: true,
			anyBusy: false,
			localBusy: false,
			otherBusy: false,
			endLoopTimeMs: null,
			activeMs: "0",
			activeLoops: "0",
			taskMs: "0",
			rootLoops: "0",
			allLoops: "0",
			activityRevisions: [{ nodeId: "child", revision: "1" }],
			loopRevisions: [],
		},
		"host",
	);
	assert.equal(coordinator.counters(), undefined);
	node.emitChannel(
		"pi-reflect-watchdog.counters.v2",
		{
			revision: "2",
			generation: "2",
			domainEpoch: "domain",
			certain: true,
			anyBusy: false,
			localBusy: false,
			otherBusy: false,
			endLoopTimeMs: null,
			activeMs: "0",
			activeLoops: "0",
			taskMs: "0",
			rootLoops: "0",
			allLoops: "1",
			activityRevisions: [{ nodeId: "child", revision: "1" }],
			loopRevisions: [{ nodeId: "child", revision: "1" }],
		},
		"host",
	);
	assert.equal(coordinator.counters()?.allLoops.value, 1n);
	node.emitChannel(
		"pi-reflect-watchdog.counters.v2",
		{
			revision: "1",
			generation: "1",
			domainEpoch: "domain",
			certain: true,
			anyBusy: false,
			localBusy: false,
			otherBusy: false,
			endLoopTimeMs: null,
			activeMs: "0",
			activeLoops: "0",
			taskMs: "0",
			rootLoops: "0",
			allLoops: "0",
			activityRevisions: [{ nodeId: "child", revision: "1" }],
			loopRevisions: [{ nodeId: "child", revision: "1" }],
		},
		"host",
	);
	assert.equal(coordinator.counters()?.allLoops.value, 1n);
	assert.equal(seen.length, 1);
	await coordinator.detach(instance);
});

test("host transport errors revoke certainty while a peer is still tracked", async () => {
	const node = new FakeNode("host");
	let transportError: ((error: Error) => void) | undefined;
	const coordinator = createReflectDomainCoordinator({
		open: async (options) => {
			transportError = options?.onError;
			return node;
		},
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online");
	node.emitChannel("pi-reflect-watchdog.activity.v2", {
		revision: "1",
		busy: false,
	});
	await flush();
	assert.equal(coordinator.counters()?.certain, true);
	transportError?.(new Error("read loop failed"));
	assert.equal(coordinator.counters()?.certain, false);
	await coordinator.detach(instance);
});

test("graceful leave stays certain even if the closed channel reports an error", async () => {
	const node = new FakeNode("host");
	let transportError: ((error: Error) => void) | undefined;
	const coordinator = createReflectDomainCoordinator({
		open: async (options) => {
			transportError = options?.onError;
			return node;
		},
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online");
	node.emitChannel("pi-reflect-watchdog.activity.v2", {
		revision: "1",
		busy: false,
	});
	await flush();
	node.emitChannel("pi-reflect-watchdog.leave.v2", { version: 1 });
	await flush();
	assert.equal(coordinator.counters()?.certain, true);
	transportError?.(new Error("closed peer channel"));
	assert.equal(coordinator.counters()?.certain, true);
	await coordinator.detach(instance);
});

test("host counter-send rejection revokes certainty", async () => {
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online");
	node.sendError = new Error("broadcast failed");
	await assert.rejects(coordinator.recordRootLoop(), /broadcast failed/);
	assert.equal(coordinator.counters()?.certain, false);
	node.sendError = null;
	await coordinator.detach(instance);
});

test("cumulative loop state repairs a missing intermediate write", async () => {
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online");
	node.emitChannel("pi-reflect-watchdog.activity.v2", {
		revision: "1",
		busy: false,
	});
	await flush();

	// Revision 1 was lost. Revision 2 carries both cumulative events.
	node.emitChannel("pi-reflect-watchdog.loop.v2", {
		revision: "2",
		rootLoops: "1",
		allLoops: "2",
	});
	await flush();
	assert.equal(coordinator.counters()?.rootLoops.value, 1n);
	assert.equal(coordinator.counters()?.allLoops.value, 2n);
	const lastCounterSend = counterSends(node).at(-1)?.value;
	assert.ok(lastCounterSend);
	assert.deepEqual(
		(lastCounterSend as { loopRevisions: unknown }).loopRevisions,
		[{ nodeId: "child", revision: "2" }],
	);
	await coordinator.detach(instance);
});

test("failed loop write is replayed cumulatively after reconnect", async () => {
	const node = new FakeNode("client", "child");
	node.emitPeer("host", "online");
	const coordinator = createReflectDomainCoordinator({
		env: { PI_EXTENSION_UTILS_PROCESS_DOMAIN: "declaration" },
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.sendError = new Error("offline");
	await assert.rejects(coordinator.recordRootLoop(), /offline/);
	node.sendError = null;
	node.emitPeer("host", "online");
	await flush();
	assert.deepEqual(node.sent.at(-1)?.value, {
		revision: "1",
		rootLoops: "1",
		allLoops: "1",
	});
	await coordinator.detach(instance);
});

test("offline writes stay recoverable and reconnect republishes current state", async () => {
	const node = new FakeNode("client", "child");
	node.emitPeer("host", "online");
	const coordinator = createReflectDomainCoordinator({
		env: { PI_EXTENSION_UTILS_PROCESS_DOMAIN: "declaration" },
		open: async () => node,
	});
	const instance = {};
	let busy = false;
	await coordinator.attach(instance, { getBusy: () => busy, onFatal() {} });
	node.sendError = new Error("offline");
	busy = true;
	const write = coordinator.setBusy(instance, true);
	assert.equal(coordinator.counters(), undefined);
	await assert.rejects(write, /offline/);
	node.sendError = null;
	node.emitPeer("host", "online");
	await flush();
	assert.deepEqual(node.sent.at(-1)?.value, { revision: "3", busy: true });
	await coordinator.detach(instance);
});
