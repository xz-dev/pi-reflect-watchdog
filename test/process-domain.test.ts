import assert from "node:assert/strict";
import test from "node:test";
import type {
	ProcessDomainDataMessage,
	ProcessDomainEvent,
	ProcessDomainNode,
	ProcessDomainPeer,
} from "pi-extension-utils/process-domain";
import {
	createReflectDomainCoordinator,
	FATAL_EXIT_CODE,
	type ReflectDomainClock,
	ReflectDomainFatalError,
	setReflectDomainPausedForWatchdog,
} from "../src/process-domain.js";

interface SentMessage {
	readonly targetNodeId: string;
	readonly channel: string;
	readonly value: unknown;
}

class FakeNode implements ProcessDomainNode {
	readonly declaration = {
		version: 1 as const,
		domainId: "epoch",
		endpoint: "tcp://127.0.0.1:46001",
		capability: "capability",
		hostNodeId: "host",
	};
	readonly sent: SentMessage[] = [];
	readonly nodeId: string;
	readonly role: "host" | "client";
	readonly transport = "tcp-loopback" as const;
	readonly endpoint = "tcp://127.0.0.1:46001";
	closed = false;
	sendError: Error | undefined;
	sendBarrier:
		| { readonly entered: () => void; readonly wait: Promise<void> }
		| undefined;
	private readonly eventListeners = new Set<
		(event: ProcessDomainEvent) => void
	>();
	private readonly channelListeners = new Map<
		string,
		Set<(message: ProcessDomainDataMessage) => void>
	>();
	private readonly currentPeers = new Map<string, ProcessDomainPeer>();

	constructor(role: "host" | "client", nodeId: string = role) {
		this.role = role;
		this.nodeId = nodeId;
		if (role === "client")
			this.currentPeers.set("host", {
				nodeId: "host",
				status: "online",
				metadata: {
					role: "pi-reflect-watchdog",
					protocol: "3",
					incarnation: "host-incarnation",
				},
				connectedAt: 1,
			});
	}

	peers(): readonly ProcessDomainPeer[] {
		return Array.from(this.currentPeers.values());
	}

	async send(targetNodeId: string, channel: string, value: unknown) {
		if (this.sendError) throw this.sendError;
		this.sent.push({ targetNodeId, channel, value });
		const barrier = this.sendBarrier;
		if (barrier !== undefined) {
			barrier.entered();
			await barrier.wait;
		}
	}

	async broadcast(channel: string, value: unknown) {
		for (const peer of this.currentPeers.values())
			if (peer.status === "online")
				await this.send(peer.nodeId, channel, value);
	}

	async reportLifecycle() {}

	subscribeEvents(listener: (event: ProcessDomainEvent) => void) {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	subscribe(
		channel: string,
		listener: (message: ProcessDomainDataMessage) => void,
	) {
		const listeners = this.channelListeners.get(channel) ?? new Set();
		listeners.add(listener);
		this.channelListeners.set(channel, listeners);
		return () => listeners.delete(listener);
	}

	emitPeer(
		nodeId: string,
		status: "online" | "offline",
		incarnation = "peer-incarnation",
	) {
		const peer = this.setPeerStatus(nodeId, status, incarnation);
		for (const listener of this.eventListeners)
			listener({ type: "peer", peer });
	}

	setPeerStatus(
		nodeId: string,
		status: "online" | "offline",
		incarnation = "peer-incarnation",
	): ProcessDomainPeer {
		const peer: ProcessDomainPeer = {
			nodeId,
			status,
			metadata: {
				role: "pi-reflect-watchdog",
				protocol: "3",
				incarnation,
			},
			connectedAt: 1,
		};
		this.currentPeers.set(nodeId, peer);
		return peer;
	}

	emitChannel(
		channel: string,
		value: unknown,
		senderId = this.declaration.hostNodeId,
		receivedAt = 1,
	) {
		for (const listener of this.channelListeners.get(channel) ?? [])
			listener({
				id: "message",
				senderId,
				targetId: this.nodeId,
				channel,
				value,
				receivedAt,
			});
	}

	async close() {
		this.closed = true;
	}
}

function fakeClock() {
	const callbacks: Array<{ callback: () => void; cancelled: boolean }> = [];
	const clock: ReflectDomainClock = {
		setTimeout(callback) {
			const handle = { callback, cancelled: false, unref() {} };
			callbacks.push(handle);
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
	return { clock, callbacks, fireNext };
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function checkpoint(
	incarnation: string,
	contributorId: string,
	overrides: Partial<{
		accountingGeneration: string;
		seq: string;
		busy: boolean;
		rootLoops: string;
		allLoops: string;
		resumeReceipt: string | null;
	}> = {},
) {
	return {
		version: 3,
		incarnation,
		contributorId,
		accountingGeneration: "0",
		seq: "1",
		busy: false,
		rootLoops: "0",
		allLoops: "0",
		resumeReceipt: null,
		...overrides,
	};
}

function latest(node: FakeNode, channel: string): SentMessage {
	const found = node.sent.filter((entry) => entry.channel === channel).at(-1);
	assert.ok(found, `missing ${channel}`);
	return found;
}

function counterWire(
	overrides: Partial<{
		revision: string;
		generation: string;
		accountingGeneration: string;
		paused: boolean;
		anyBusy: boolean;
		localBusy: boolean;
		otherBusy: boolean;
		rootLoops: string;
		allLoops: string;
		checkpointAcks: readonly unknown[];
	}> = {},
) {
	return {
		version: 3,
		revision: "1",
		generation: "1",
		accountingGeneration: "0",
		domainEpoch: "epoch",
		paused: false,
		anyBusy: false,
		localBusy: false,
		otherBusy: false,
		endLoopTimeMs: null,
		activeMs: "0",
		activeLoops: "0",
		taskMs: "0",
		rootLoops: "0",
		allLoops: "0",
		checkpointAcks: [],
		...overrides,
	};
}

test("abrupt peer death removes live busy state and replacement resumes accounting", async () => {
	const node = new FakeNode("host");
	const time = fakeClock();
	let nowMs = 1_000;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
		clock: time.clock,
		activeTickMs: 100,
		now: () => nowMs,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-a", "contributor-a", { busy: true }),
		"child",
		nowMs,
	);
	await flush();
	assert.equal(coordinator.counters()?.anyBusy, true);
	nowMs = 1_100;
	time.fireNext();
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 100n);

	node.emitPeer("child", "offline", "incarnation-a");
	await flush();
	assert.equal(coordinator.counters()?.anyBusy, false);
	await coordinator.recordRootLoop();
	assert.equal(coordinator.counters()?.rootLoops.value, 1n);

	node.emitPeer("child", "online", "incarnation-b");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-b", "contributor-b", { busy: true }),
		"child",
		nowMs,
	);
	await flush();
	nowMs = 1_200;
	time.fireNext();
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 200n);
	assert.equal(coordinator.counters()?.rootLoops.value, 1n);
	await coordinator.detach(instance);
});

test("offline projection reaches counters and subscribers before an earlier send releases", async () => {
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	const observations: boolean[] = [];
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	const unsubscribe = coordinator.subscribe((counters) =>
		observations.push(counters.anyBusy),
	);
	const entered = deferred();
	const release = deferred();
	node.sendBarrier = { entered: entered.resolve, wait: release.promise };
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-a", "contributor-a", { busy: true }),
		"child",
	);
	await entered.promise;
	assert.equal(coordinator.counters()?.anyBusy, true);
	const busyRevision = coordinator.counters()?.revision ?? 0n;

	node.emitPeer("child", "offline", "incarnation-a");
	assert.equal(coordinator.counters()?.anyBusy, false);
	assert.ok((coordinator.counters()?.revision ?? 0n) > busyRevision);
	assert.equal(observations.at(-1), false);
	assert.ok(observations.includes(true));

	node.sendBarrier = undefined;
	release.resolve();
	await flush();
	unsubscribe();
	await coordinator.detach(instance);
});

test("send-discovered offline session triggers a second synchronous projection", async () => {
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	const observations: boolean[] = [];
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-a", "contributor-a", { busy: true }),
		"child",
	);
	await flush();
	const unsubscribe = coordinator.subscribe((counters) =>
		observations.push(counters.anyBusy),
	);
	node.setPeerStatus("child", "offline", "incarnation-a");
	node.sendError = new Error("send failed");

	await coordinator.recordAllLoop();
	assert.equal(coordinator.counters()?.anyBusy, false);
	assert.equal(coordinator.counters()?.allLoops.value, 1n);
	assert.deepEqual(observations.slice(-2), [true, false]);
	unsubscribe();
	await coordinator.detach(instance);
});

test("retained reconnect restores exact loop delta when checkpoint ACK was lost", async () => {
	const node = new FakeNode("host");
	let nowMs = 0;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
		now: () => nowMs,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-a", "contributor-a", {
			rootLoops: "1",
			allLoops: "2",
		}),
		"child",
		nowMs,
	);
	await flush();
	const firstAck = (
		latest(node, "pi-reflect-watchdog.counters.v3").value as {
			checkpointAcks: Array<{ resumeReceipt: string }>;
		}
	).checkpointAcks[0]?.resumeReceipt;
	assert.ok(firstAck);
	nowMs = 1_000;
	node.emitPeer("child", "offline", "incarnation-a");
	await flush();
	nowMs = 9_000;
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-a", "contributor-b", {
			seq: "2",
			rootLoops: "2",
			allLoops: "5",
			resumeReceipt: null,
		}),
		"child",
		nowMs,
	);
	await flush();
	assert.equal(coordinator.counters()?.rootLoops.value, 2n);
	assert.equal(coordinator.counters()?.allLoops.value, 5n);
	const replayAck = (
		latest(node, "pi-reflect-watchdog.counters.v3").value as {
			checkpointAcks: Array<{ resumeReceipt: string }>;
		}
	).checkpointAcks[0]?.resumeReceipt;
	assert.equal(replayAck, firstAck);
	await coordinator.detach(instance);
});

test("ledger-expired reconnect needs receipt and seeds current totals as baseline", async () => {
	const node = new FakeNode("host");
	let nowMs = 0;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
		now: () => nowMs,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-a", "contributor-a", {
			rootLoops: "2",
			allLoops: "3",
		}),
		"child",
		nowMs,
	);
	await flush();
	const receipt = (
		latest(node, "pi-reflect-watchdog.counters.v3").value as {
			checkpointAcks: Array<{ resumeReceipt: string }>;
		}
	).checkpointAcks[0]?.resumeReceipt;
	assert.ok(receipt);
	node.emitPeer("child", "offline", "incarnation-a");
	await flush();
	nowMs = 11_000;
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-a", "contributor-b", {
			seq: "2",
			busy: true,
			rootLoops: "100",
			allLoops: "100",
			resumeReceipt: receipt,
		}),
		"child",
		nowMs,
	);
	await flush();
	assert.equal(coordinator.counters()?.anyBusy, true);
	assert.equal(coordinator.counters()?.rootLoops.value, 2n);
	assert.equal(coordinator.counters()?.allLoops.value, 3n);
	await coordinator.detach(instance);
});

test("compatible peer joining while paused receives current control snapshot", async () => {
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	await setReflectDomainPausedForWatchdog(coordinator, true);

	node.emitPeer("child", "online", "incarnation-a");
	await flush();
	const wire = latest(node, "pi-reflect-watchdog.counters.v3").value as {
		accountingGeneration: string;
		paused: boolean;
	};
	assert.equal(wire.accountingGeneration, "1");
	assert.equal(wire.paused, true);
	await coordinator.detach(instance);
});

test("compatible peer joining after pause and resume receives advanced generation", async () => {
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	await setReflectDomainPausedForWatchdog(coordinator, true);
	await setReflectDomainPausedForWatchdog(coordinator, false);

	node.emitPeer("child", "online", "incarnation-a");
	await flush();
	const wire = latest(node, "pi-reflect-watchdog.counters.v3").value as {
		accountingGeneration: string;
		paused: boolean;
	};
	assert.equal(wire.accountingGeneration, "2");
	assert.equal(wire.paused, false);
	await coordinator.detach(instance);
});

test("pause generations drop live peers and require fresh generation checkpoint", async () => {
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-a", "contributor-a", { busy: true }),
		"child",
	);
	await flush();
	const receipt = (
		latest(node, "pi-reflect-watchdog.counters.v3").value as {
			checkpointAcks: Array<{ resumeReceipt: string }>;
		}
	).checkpointAcks[0]?.resumeReceipt;
	assert.ok(receipt);

	await setReflectDomainPausedForWatchdog(coordinator, true);
	assert.equal(coordinator.counters()?.paused, true);
	assert.equal(coordinator.counters()?.anyBusy, false);
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-a", "stale-contributor", {
			seq: "2",
			busy: true,
			resumeReceipt: receipt,
		}),
		"child",
	);
	await flush();
	assert.equal(coordinator.counters()?.anyBusy, false);

	await setReflectDomainPausedForWatchdog(coordinator, false);
	const resumed = latest(node, "pi-reflect-watchdog.counters.v3").value as {
		accountingGeneration: string;
		paused: boolean;
	};
	assert.equal(resumed.accountingGeneration, "2");
	assert.equal(resumed.paused, false);
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-a", "fresh-contributor", {
			accountingGeneration: "2",
			seq: "3",
			busy: true,
			resumeReceipt: receipt,
		}),
		"child",
	);
	await flush();
	assert.equal(coordinator.counters()?.anyBusy, true);
	await coordinator.detach(instance);
});

test("client accepts pause control without ACK then gates resumed counters on fresh ACK", async () => {
	const node = new FakeNode("client", "client-a");
	let liveBusy = true;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, {
		getBusy: () => liveBusy,
		onFatal() {},
	});
	const initial = latest(node, "pi-reflect-watchdog.checkpoint.v3").value as {
		incarnation: string;
		contributorId: string;
		seq: string;
	};

	node.emitChannel(
		"pi-reflect-watchdog.counters.v3",
		counterWire({
			revision: "1",
			accountingGeneration: "1",
			paused: true,
		}),
	);
	await flush();
	assert.equal(coordinator.paused, true);
	assert.equal(coordinator.counters()?.paused, true);

	liveBusy = false;
	node.emitChannel(
		"pi-reflect-watchdog.counters.v3",
		counterWire({
			revision: "2",
			generation: "2",
			accountingGeneration: "2",
			paused: false,
		}),
	);
	await flush();
	assert.equal(coordinator.counters(), undefined);
	const resumed = latest(node, "pi-reflect-watchdog.checkpoint.v3").value as {
		incarnation: string;
		contributorId: string;
		accountingGeneration: string;
		seq: string;
		busy: boolean;
	};
	assert.equal(resumed.incarnation, initial.incarnation);
	assert.notEqual(resumed.contributorId, initial.contributorId);
	assert.equal(resumed.accountingGeneration, "2");
	assert.equal(resumed.busy, false);

	node.emitChannel(
		"pi-reflect-watchdog.counters.v3",
		counterWire({
			revision: "3",
			generation: "3",
			accountingGeneration: "2",
			checkpointAcks: [
				{
					nodeId: "client-a",
					incarnation: resumed.incarnation,
					contributorId: resumed.contributorId,
					accountingGeneration: "2",
					seq: resumed.seq,
					resumeReceipt: "receipt",
				},
			],
		}),
	);
	await flush();
	assert.equal(coordinator.counters()?.generation, 3n);
	assert.equal(coordinator.paused, false);
	await coordinator.detach(instance);
});

test("lost initial ACK is recovered from pause control and resume does not replay loops", async () => {
	const hostNode = new FakeNode("host");
	const clientNode = new FakeNode("client", "client-a");
	let liveBusy = false;
	const host = createReflectDomainCoordinator({ open: async () => hostNode });
	const client = createReflectDomainCoordinator({
		open: async () => clientNode,
	});
	const hostInstance = {};
	const clientInstance = {};
	await host.attach(hostInstance, { getBusy: () => false, onFatal() {} });
	await client.attach(clientInstance, {
		getBusy: () => liveBusy,
		onFatal() {},
	});
	await client.recordRootLoop();
	const initial = latest(clientNode, "pi-reflect-watchdog.checkpoint.v3")
		.value as {
		incarnation: string;
		contributorId: string;
		rootLoops: string;
		resumeReceipt: string | null;
	};
	hostNode.emitPeer("client-a", "online", initial.incarnation);
	hostNode.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		initial,
		"client-a",
	);
	await flush();
	const accepted = latest(hostNode, "pi-reflect-watchdog.counters.v3")
		.value as {
		checkpointAcks: Array<{ resumeReceipt: string }>;
	};
	const receipt = accepted.checkpointAcks[0]?.resumeReceipt;
	assert.ok(receipt);
	assert.equal(host.counters()?.rootLoops.value, 1n);
	// Deliberately do not deliver the initial ACK to the client.

	await setReflectDomainPausedForWatchdog(host, true);
	const paused = latest(hostNode, "pi-reflect-watchdog.counters.v3").value as {
		checkpointAcks: Array<{ resumeReceipt: string }>;
	};
	assert.equal(paused.checkpointAcks[0]?.resumeReceipt, receipt);
	clientNode.emitChannel("pi-reflect-watchdog.counters.v3", paused);
	await flush();
	assert.equal(client.paused, true);

	liveBusy = true;
	await setReflectDomainPausedForWatchdog(host, false);
	const resumed = latest(hostNode, "pi-reflect-watchdog.counters.v3").value;
	clientNode.emitChannel("pi-reflect-watchdog.counters.v3", resumed);
	await flush();
	const fresh = latest(clientNode, "pi-reflect-watchdog.checkpoint.v3")
		.value as {
		accountingGeneration: string;
		busy: boolean;
		contributorId: string;
		resumeReceipt: string | null;
	};
	assert.equal(fresh.accountingGeneration, "2");
	assert.equal(fresh.busy, true);
	assert.notEqual(fresh.contributorId, initial.contributorId);
	assert.equal(fresh.resumeReceipt, receipt);

	hostNode.emitChannel("pi-reflect-watchdog.checkpoint.v3", fresh, "client-a");
	await flush();
	assert.equal(host.counters()?.anyBusy, true);
	assert.equal(host.counters()?.rootLoops.value, 1n);
	await client.detach(clientInstance);
	await host.detach(hostInstance);
});

test("replacement identity fences delayed checkpoint and leave", async () => {
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-old");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-old", "contributor-old", { busy: true }),
		"child",
	);
	await flush();
	node.emitPeer("child", "offline", "incarnation-old");
	node.emitPeer("child", "online", "incarnation-new");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-new", "contributor-new", { busy: true }),
		"child",
	);
	await flush();
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		checkpoint("incarnation-old", "contributor-old", {
			seq: "2",
			busy: false,
			rootLoops: "9",
			allLoops: "9",
		}),
		"child",
	);
	node.emitChannel(
		"pi-reflect-watchdog.leave.v3",
		{
			version: 3,
			incarnation: "incarnation-old",
			contributorId: "contributor-old",
		},
		"child",
	);
	await flush();
	assert.equal(coordinator.counters()?.anyBusy, true);
	assert.equal(coordinator.counters()?.rootLoops.value, 0n);
	await coordinator.detach(instance);
});

test("v2 and malformed messages fail closed", async () => {
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.activity.v2",
		{
			revision: "1",
			busy: true,
		},
		"child",
	);
	node.emitChannel(
		"pi-reflect-watchdog.loop.v2",
		{
			revision: "1",
			rootLoops: "100",
			allLoops: "100",
		},
		"child",
	);
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v3",
		{
			...checkpoint("incarnation-a", "contributor-a"),
			allLoops: "not-a-counter",
		},
		"child",
	);
	await flush();
	assert.equal(coordinator.counters()?.anyBusy, false);
	assert.equal(coordinator.counters()?.allLoops.value, 0n);
	await coordinator.detach(instance);
});

test("local attachments, loops, tick projection, and reminder reset share reducer state", async () => {
	const node = new FakeNode("host");
	const time = fakeClock();
	let nowMs = 5_000;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
		clock: time.clock,
		activeTickMs: 250,
		now: () => nowMs,
	});
	const first = {};
	const second = {};
	await coordinator.attach(first, { getBusy: () => true, onFatal() {} });
	await coordinator.attach(second, { getBusy: () => false, onFatal() {} });
	assert.equal(coordinator.counters()?.localBusy, true);
	nowMs = 5_250;
	time.fireNext();
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 250n);
	await coordinator.recordRootLoop();
	await coordinator.recordAllLoop();
	assert.equal(coordinator.counters()?.rootLoops.value, 1n);
	assert.equal(coordinator.counters()?.allLoops.value, 2n);
	await coordinator.resetReminderCycle();
	assert.equal(coordinator.counters()?.activeMs.value, 250n);
	assert.equal(coordinator.counters()?.allLoops.value, 0n);
	await coordinator.detach(first);
	assert.equal(coordinator.counters()?.localBusy, false);
	await coordinator.detach(second);
	assert.equal(node.closed, true);
});

test("client reconnect republishes current state with fresh contributor", async () => {
	const node = new FakeNode("client", "client-a");
	let liveBusy = false;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, {
		getBusy: () => liveBusy,
		onFatal() {},
	});
	const initial = latest(node, "pi-reflect-watchdog.checkpoint.v3").value as {
		contributorId: string;
		seq: string;
	};
	node.emitPeer("host", "offline", "host-incarnation");
	liveBusy = true;
	node.emitPeer("host", "online", "host-incarnation");
	await flush();
	const replay = latest(node, "pi-reflect-watchdog.checkpoint.v3").value as {
		contributorId: string;
		seq: string;
		busy: boolean;
	};
	assert.notEqual(replay.contributorId, initial.contributorId);
	assert.ok(BigInt(replay.seq) > BigInt(initial.seq));
	assert.equal(replay.busy, true);
	await coordinator.detach(instance);
});

test("transient offline writes recover without fatal reporting", async () => {
	const node = new FakeNode("client", "client-a");
	const fatals: Error[] = [];
	let liveBusy = false;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, {
		getBusy: () => liveBusy,
		onFatal: (error) => fatals.push(error),
	});
	node.sendError = new Error("process-domain host is offline");
	liveBusy = true;
	await coordinator.setBusy(instance, true);
	assert.equal(fatals.length, 0);
	assert.equal(coordinator.counters(), undefined);
	node.sendError = undefined;
	node.emitPeer("host", "online", "host-incarnation");
	await flush();
	assert.equal(
		(
			latest(node, "pi-reflect-watchdog.checkpoint.v3").value as {
				busy: boolean;
			}
		).busy,
		true,
	);
	await coordinator.detach(instance);
});

test("initialization failure reports typed fatal and allows retry", async () => {
	let attempts = 0;
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("boom");
			return node;
		},
	});
	const first = {};
	const firstFatals: Error[] = [];
	await assert.rejects(
		coordinator.attach(first, {
			getBusy: () => false,
			onFatal: (error) => firstFatals.push(error),
		}),
		(error: unknown) =>
			error instanceof ReflectDomainFatalError &&
			error.code === "DOMAIN_UNRECOVERABLE",
	);
	assert.equal(firstFatals.length, 1);
	const second = {};
	await coordinator.attach(second, { getBusy: () => false, onFatal() {} });
	assert.equal(coordinator.rootProcess, true);
	await coordinator.detach(second);
});

test("exports sysexits-style fatal status", () => {
	assert.equal(FATAL_EXIT_CODE, 78);
});
