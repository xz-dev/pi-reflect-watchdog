import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	ProcessDomainDataMessage,
	ProcessDomainEvent,
	ProcessDomainNode,
	ProcessDomainPeer,
} from "pi-extension-utils/process-domain";
import { ACCOUNTING_BOUNDARY_ENTRY } from "../src/branch-accounting.js";
import {
	createReflectDomainCoordinator as createDomain,
	FATAL_EXIT_CODE,
	type ReflectBranchDomainCoordinator,
	type ReflectDomainClock,
	ReflectDomainFatalError,
} from "../src/process-domain.js";

const fixtureSources = new WeakMap<
	object,
	Map<object, { session: SessionManager; main: boolean }>
>();
function createReflectDomainCoordinator(
	options: Parameters<typeof createDomain>[0] = {},
) {
	const domain = createDomain(options);
	const attach = domain.attach.bind(domain);
	const sources = new Map<object, { session: SessionManager; main: boolean }>();
	fixtureSources.set(domain, sources);
	domain.attach = (instance, options) => {
		if (options.source) return attach(instance, options);
		const item = { session: SessionManager.inMemory(), main: true };
		sources.set(instance, item);
		return attach(instance, {
			...options,
			source: { ...branchSource(item.session), isMain: () => item.main },
		});
	};
	return domain as Omit<ReflectBranchDomainCoordinator, "attach"> & {
		attach(
			instance: object,
			options: Omit<
				Parameters<ReflectBranchDomainCoordinator["attach"]>[1],
				"source"
			> & {
				source?: Parameters<
					ReflectBranchDomainCoordinator["attach"]
				>[1]["source"];
			},
		): Promise<void>;
	};
}
async function appendLoop(
	domain: ReflectBranchDomainCoordinator,
	instance: object,
	main = true,
) {
	const item = fixtureSources.get(domain)?.get(instance);
	assert.ok(item);
	item.main = main;
	const id = item.session.appendMessage(ordinaryReply());
	await domain.completeTurn(instance, id);
}

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
					protocol: "4",
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
		metadata?: Record<string, string>,
	) {
		const peer = this.setPeerStatus(nodeId, status, incarnation, metadata);
		for (const listener of this.eventListeners)
			listener({ type: "peer", peer });
	}

	setPeerStatus(
		nodeId: string,
		status: "online" | "offline",
		incarnation = "peer-incarnation",
		metadata?: Record<string, string>,
	): ProcessDomainPeer {
		const peer: ProcessDomainPeer = {
			nodeId,
			status,
			metadata: metadata ?? {
				role: "pi-reflect-watchdog",
				protocol: "4",
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
		version: 4,
		scopes: [],
		incarnation,
		contributorId,
		accountingGeneration: "0",
		activeLoops: overrides.allLoops ?? "0",
		completion: null,
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

test("shared first-opener metadata preserves child accounting in either load order", async () => {
	const run = async (metadata: Record<string, string>) => {
		const node = new FakeNode("host");
		const time = fakeClock();
		let nowMs = 1_000;
		const coordinator = createReflectDomainCoordinator({
			open: async () => node,
			clock: time.clock,
			activeTickMs: 1_000,
			now: () => nowMs,
		});
		const instance = {};
		await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
		node.emitPeer("child", "online", "incarnation-a", metadata);
		node.emitChannel(
			"pi-reflect-watchdog.checkpoint.v4",
			checkpoint("incarnation-a", "contributor-a", { busy: true }),
			"child",
			nowMs,
		);
		await flush();
		for (let tick = 0; tick < 2; tick += 1) {
			nowMs += 1_000;
			time.fireNext();
			await flush();
		}
		node.emitChannel(
			"pi-reflect-watchdog.checkpoint.v4",
			checkpoint("incarnation-a", "contributor-a", {
				seq: "2",
				busy: true,
				allLoops: "3",
			}),
			"child",
			nowMs,
		);
		await flush();
		const counters = coordinator.counters();
		assert.equal(counters?.otherBusy, true);
		assert.equal(counters?.activeMs.value, 2_000n);
		assert.equal(counters?.taskMs.value, 2_000n);
		assert.equal(counters?.rootLoops.value, 0n);
		assert.equal(counters?.allLoops.value, 3n);
		await coordinator.detach(instance);
	};
	await run({ role: "pi-continue-watchdog", pid: "child-pid" });
	await run({
		role: "pi-reflect-watchdog",
		pid: "child-pid",
		protocol: "4",
		incarnation: "incarnation-a",
	});
});

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
		"pi-reflect-watchdog.checkpoint.v4",
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
	await appendLoop(coordinator, instance);
	assert.equal(coordinator.counters()?.rootLoops.value, 1n);

	node.emitPeer("child", "online", "incarnation-b");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
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
		"pi-reflect-watchdog.checkpoint.v4",
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
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-a", "contributor-a", { busy: true }),
		"child",
	);
	await flush();
	const unsubscribe = coordinator.subscribe((counters) =>
		observations.push(counters.anyBusy),
	);
	node.setPeerStatus("child", "offline", "incarnation-a");
	node.sendError = new Error("send failed");

	await appendLoop(coordinator, instance, false);
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
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-a", "contributor-a", {
			rootLoops: "0",
			allLoops: "2",
		}),
		"child",
		nowMs,
	);
	await flush();
	const firstAck = (
		latest(node, "pi-reflect-watchdog.counters.v4").value as {
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
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-a", "contributor-b", {
			seq: "2",
			rootLoops: "0",
			allLoops: "5",
			resumeReceipt: null,
		}),
		"child",
		nowMs,
	);
	await flush();
	assert.equal(coordinator.counters()?.rootLoops.value, 0n);
	assert.equal(coordinator.counters()?.allLoops.value, 5n);
	const replayAck = (
		latest(node, "pi-reflect-watchdog.counters.v4").value as {
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
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-a", "contributor-a", {
			rootLoops: "0",
			allLoops: "3",
		}),
		"child",
		nowMs,
	);
	await flush();
	const receipt = (
		latest(node, "pi-reflect-watchdog.counters.v4").value as {
			checkpointAcks: Array<{ resumeReceipt: string }>;
		}
	).checkpointAcks[0]?.resumeReceipt;
	assert.ok(receipt);
	node.emitPeer("child", "offline", "incarnation-a");
	await flush();
	nowMs = 11_000;
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-a", "contributor-b", {
			seq: "2",
			busy: true,
			rootLoops: "0",
			allLoops: "100",
			resumeReceipt: receipt,
		}),
		"child",
		nowMs,
	);
	await flush();
	assert.equal(coordinator.counters()?.anyBusy, true);
	assert.equal(coordinator.counters()?.rootLoops.value, 0n);
	assert.equal(coordinator.counters()?.allLoops.value, 3n);
	await coordinator.detach(instance);
});

test("delayed duplicate is fenced without identity replacement", async () => {
	const node = new FakeNode("host");
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-a", "contributor-a", { busy: true }),
		"child",
	);
	await flush();
	// Deliberately do not deliver the initial ACK. A delayed duplicate
	// (replay of the accepted seq) classifies as zero-delta acceptance:
	// counters and busy are unchanged, and the in-place publish re-sends
	// the authoritative ACK for recovery.
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-a", "contributor-a", { busy: true }),
		"child",
	);
	await flush();
	const after = latest(node, "pi-reflect-watchdog.counters.v4").value as {
		rootLoops: string;
		allLoops: string;
		anyBusy: boolean;
	};
	assert.equal(after.anyBusy, true);
	assert.equal(after.rootLoops, "0");
	assert.equal(after.allLoops, "0");
	assert.equal(coordinator.counters()?.anyBusy, true);
	assert.equal(coordinator.counters()?.rootLoops.value, 0n);
	await coordinator.detach(instance);
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
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-old", "contributor-old", { busy: true }),
		"child",
	);
	await flush();
	node.emitPeer("child", "offline", "incarnation-old");
	node.emitPeer("child", "online", "incarnation-new");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-new", "contributor-new", { busy: true }),
		"child",
	);
	await flush();
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-old", "contributor-old", {
			seq: "2",
			busy: false,
			rootLoops: "9",
			allLoops: "9",
		}),
		"child",
	);
	node.emitChannel(
		"pi-reflect-watchdog.leave.v4",
		{
			version: 4,
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
			rootLoops: "0",
			allLoops: "100",
		},
		"child",
	);
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
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
	await appendLoop(coordinator, first);
	await appendLoop(coordinator, second, false);
	assert.equal(coordinator.counters()?.rootLoops.value, 1n);
	assert.equal(coordinator.counters()?.allLoops.value, 2n);
	await coordinator.resetReminderCycle();
	assert.equal(coordinator.counters()?.activeMs.value, 250n);
	assert.equal(coordinator.counters()?.allLoops.value, 0n);
	const beforeTakeoverReset = coordinator.counters()?.revision ?? 0n;
	await coordinator.resetCycleOnUserTakeover();
	assert.equal(coordinator.counters()?.activeMs.value, 0n);
	assert.equal(coordinator.counters()?.activeLoops.value, 0n);
	assert.equal(coordinator.counters()?.taskMs.value, 0n);
	assert.equal(coordinator.counters()?.rootLoops.value, 0n);
	assert.equal(coordinator.counters()?.allLoops.value, 0n);
	assert.ok((coordinator.counters()?.revision ?? 0n) > beforeTakeoverReset);
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
	const initial = latest(node, "pi-reflect-watchdog.checkpoint.v4").value as {
		contributorId: string;
		seq: string;
	};
	node.emitPeer("host", "offline", "host-incarnation");
	liveBusy = true;
	node.emitPeer("host", "online", "host-incarnation");
	await flush();
	const replay = latest(node, "pi-reflect-watchdog.checkpoint.v4").value as {
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
			latest(node, "pi-reflect-watchdog.checkpoint.v4").value as {
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

test("default elapsed clock ignores wall-clock changes and retains delayed milliseconds", async (t) => {
	const node = new FakeNode("host");
	const time = fakeClock();
	let nanoseconds = 50_000_000_000n;
	let wallMs = 1_700_000_000_000;
	t.mock.method(process.hrtime, "bigint", () => nanoseconds);
	t.mock.method(Date, "now", () => wallMs);
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
		clock: time.clock,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => true, onFatal() {} });
	assert.equal(coordinator.counters()?.activeMs.value, 0n);
	nanoseconds += 3_200_000_000n;
	wallMs -= 86_400_000;
	time.fireNext();
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 3_200n);
	nanoseconds += 800_000_000n;
	wallMs += 172_800_000;
	time.fireNext();
	await flush();
	assert.equal(coordinator.counters()?.taskMs.value, 4_000n);
	await coordinator.detach(instance);
});

test("child update before heartbeat caps suspension gap and rebases elapsed clock", async () => {
	const node = new FakeNode("host");
	const time = fakeClock();
	let nowMs = 0;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
		clock: time.clock,
		now: () => nowMs,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-a", "contributor-a", { busy: true }),
		"child",
	);
	await flush();
	nowMs = 300_000;
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-a", "contributor-a", {
			seq: "2",
			busy: true,
			allLoops: "1",
		}),
		"child",
		1_700_000_000_000,
	);
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 1_000n);
	assert.equal(coordinator.counters()?.taskMs.value, 1_000n);
	assert.equal(coordinator.counters()?.allLoops.value, 1n);
	nowMs += 250;
	time.fireNext();
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 1_250n);
	await coordinator.detach(instance);
});

test("peer leave uses owner clock, not transport wall time", async () => {
	const node = new FakeNode("host");
	const time = fakeClock();
	let nowMs = 0;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
		clock: time.clock,
		now: () => nowMs,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-a", "contributor-a", { busy: true }),
		"child",
		1_700_000_000_000,
	);
	await flush();
	nowMs = 3_200;
	node.emitChannel(
		"pi-reflect-watchdog.leave.v4",
		{
			version: 4,
			incarnation: "incarnation-a",
			contributorId: "contributor-a",
		},
		"child",
		1_700_000_003_200,
	);
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 3_200n);
	assert.equal(coordinator.counters()?.anyBusy, false);
	nowMs += 60_000;
	await coordinator.setBusy(instance, true);
	assert.equal(coordinator.counters()?.activeMs.value, 3_200n);
	await coordinator.detach(instance);
});

test("duplicate checkpoint publications rebase clock without admitting stale loop authority", async () => {
	const node = new FakeNode("host");
	const time = fakeClock();
	let nowMs = 0;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
		clock: time.clock,
		now: () => nowMs,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => true, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	const first = checkpoint("incarnation-a", "contributor-a", {
		busy: true,
		allLoops: "1",
	});
	node.emitChannel("pi-reflect-watchdog.checkpoint.v4", first, "child");
	await flush();
	for (const atMs of [9_000, 11_000]) {
		nowMs = atMs;
		node.emitChannel(
			"pi-reflect-watchdog.checkpoint.v4",
			{ ...first, activeLoops: "999", allLoops: "999" },
			"child",
		);
		await flush();
		assert.equal(coordinator.counters()?.activeMs.value, BigInt(atMs));
		assert.equal(coordinator.counters()?.taskMs.value, BigInt(atMs));
		assert.equal(coordinator.counters()?.allLoops.value, 1n);
	}
	time.fireNext();
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 11_000n);
	assert.equal(coordinator.counters()?.taskMs.value, 11_000n);
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		{ ...first, seq: "2", activeLoops: "2", allLoops: "2" },
		"child",
	);
	await flush();
	assert.equal(coordinator.counters()?.allLoops.value, 2n);
	await coordinator.detach(instance);
});

test("first repair-only publication after quiet suspension caps once then rebases", async () => {
	const node = new FakeNode("host");
	const time = fakeClock();
	let nowMs = 0;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
		clock: time.clock,
		now: () => nowMs,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => true, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	const first = checkpoint("incarnation-a", "contributor-a", { busy: true });
	node.emitChannel("pi-reflect-watchdog.checkpoint.v4", first, "child");
	await flush();
	nowMs = 300_000;
	node.emitChannel("pi-reflect-watchdog.checkpoint.v4", first, "child");
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 1_000n);
	nowMs += 200;
	node.emitChannel("pi-reflect-watchdog.checkpoint.v4", first, "child");
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 1_200n);
	time.fireNext();
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 1_200n);
	assert.equal(coordinator.counters()?.taskMs.value, 1_200n);
	assert.equal(coordinator.counters()?.allLoops.value, 0n);
	await coordinator.detach(instance);
});

test("publication captures counters and checkpoint generation before synchronous observers", async () => {
	const node = new FakeNode("host");
	const time = fakeClock();
	let nowMs = 0;
	const coordinator = createReflectDomainCoordinator({
		open: async () => node,
		clock: time.clock,
		now: () => nowMs,
	});
	const instance = {};
	await coordinator.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online", "incarnation-a");
	const snapshots = new Map<string, { allLoops: string; generation: string }>();
	const unsubscribe = coordinator.subscribe((counters) => {
		snapshots.set(counters.revision.toString(), {
			allLoops: counters.allLoops.value.toString(),
			generation: counters.generation.toString(),
		});
		if (counters.allLoops.value !== 1n) return;
		nowMs = 1;
		node.emitChannel(
			"pi-reflect-watchdog.checkpoint.v4",
			checkpoint("incarnation-a", "contributor-a", { seq: "2", allLoops: "2" }),
			"child",
		);
	});
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		checkpoint("incarnation-a", "contributor-a", { allLoops: "1" }),
		"child",
	);
	await flush();
	const wires = node.sent
		.filter((message) => message.channel === "pi-reflect-watchdog.counters.v4")
		.map(
			(message) =>
				message.value as {
					revision: string;
					generation: string;
					accountingGeneration: string;
					allLoops: string;
					checkpointAcks: Array<{ seq: string; accountingGeneration: string }>;
				},
		);
	for (const count of ["1", "2"]) {
		const wire = wires.find((candidate) => candidate.allLoops === count);
		assert.ok(wire);
		assert.deepEqual(snapshots.get(wire.revision), {
			allLoops: wire.allLoops,
			generation: wire.generation,
		});
		assert.deepEqual(
			wire.checkpointAcks.map((ack) => ack.seq),
			[count],
		);
		assert.equal(
			wire.accountingGeneration,
			wire.checkpointAcks[0]?.accountingGeneration,
		);
	}
	unsubscribe();
	await coordinator.detach(instance);
});

function ordinaryReply(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "test",
		stopReason: "stop",
		content: [{ type: "text", text: "ordinary" }],
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function branchSource(session: SessionManager, main = false) {
	return {
		getBranch: () => session.getBranch(),
		getLeafId: () => session.getLeafId(),
		isMain: () => main,
		boundaryPolicy: "recorded" as const,
	};
}

test("Pi snapshots adopt main history explicitly; repair never completes; unchanged-count turn completes once", async () => {
	const node = new FakeNode("host");
	const domain = createReflectDomainCoordinator({ open: async () => node });
	const session = SessionManager.inMemory();
	session.appendMessage(ordinaryReply());
	const instance = {};
	await domain.attach(instance, {
		getBusy: () => true,
		onFatal() {},
		source: branchSource(session, true),
	});
	const completions: string[] = [];
	domain.subscribeCompletions((event) => {
		assert.equal(
			domain.counters()?.allLoops.value,
			event.counters.allLoops.value,
		);
		completions.push(event.messageEntryId);
	});
	await domain.refreshBranch(instance);
	assert.equal(domain.counters()?.rootLoops.value, 0n);
	await domain.rebaseBranch(instance, { adoptHistory: true });
	assert.equal(domain.counters()?.rootLoops.value, 1n);
	assert.deepEqual(completions, []);
	const entry = session.appendMessage(ordinaryReply());
	await domain.refreshBranch(instance);
	assert.equal(domain.counters()?.rootLoops.value, 2n);
	await domain.completeTurn(instance, entry);
	await domain.completeTurn(instance, entry);
	await domain.refreshBranch(instance);
	assert.deepEqual(completions, [entry]);
	assert.equal(domain.counters()?.rootLoops.value, 2n);
	await domain.detach(instance);
});

test("local child excludes fork ancestry and child boundaries; departed contribution survives; missing anchors fence", async () => {
	const domain = createReflectDomainCoordinator({
		open: async () => new FakeNode("host"),
	});
	const main = {},
		child = {};
	await domain.attach(main, { getBusy: () => false, onFatal() {} });
	const session = SessionManager.inMemory();
	const inherited = session.appendMessage(ordinaryReply());
	await domain.attach(child, {
		getBusy: () => true,
		onFatal() {},
		source: branchSource(session),
	});
	const first = session.appendMessage(ordinaryReply());
	session.appendCustomEntry(ACCOUNTING_BOUNDARY_ENTRY, {
		version: 1,
		window: "full",
	});
	const second = session.appendMessage(ordinaryReply());
	await domain.refreshBranch(child);
	assert.equal(domain.counters()?.activeLoops.value, 2n);
	assert.equal(domain.counters()?.rootLoops.value, 0n);
	await assert.rejects(
		domain.rebaseBranch(child, { adoptHistory: true }),
		/Only current main/,
	);
	const completions: string[] = [];
	domain.subscribeCompletions((event) =>
		completions.push(event.messageEntryId),
	);
	await domain.completeTurn(child, second);
	await domain.completeTurn(child, first);
	assert.deepEqual(completions, [second]);
	session.branch(inherited);
	await domain.refreshBranch(child);
	const own = session.appendMessage(ordinaryReply());
	await domain.completeTurn(child, own);
	assert.equal(domain.counters()?.allLoops.value, 3n);
	assert.equal(domain.counters()?.rootLoops.value, 0n);
	await domain.detach(child);
	assert.equal(domain.counters()?.allLoops.value, 3n);
	assert.equal(domain.counters()?.anyBusy, false);
	await domain.resetCycleOnUserTakeover();
	assert.equal(domain.counters()?.allLoops.value, 0n);
	await domain.detach(main);
});

test("full/reminder baselines precede synchronous reset observers and retain busy clocks", async () => {
	const time = fakeClock();
	let nowMs = 0;
	const domain = createReflectDomainCoordinator({
		open: async () => new FakeNode("host"),
		clock: time.clock,
		now: () => nowMs,
	});
	const instance = {},
		session = SessionManager.inMemory();
	await domain.attach(instance, {
		getBusy: () => true,
		onFatal() {},
		source: branchSource(session, true),
	});
	const old = session.appendMessage(ordinaryReply());
	await domain.refreshBranch(instance);
	let fired = false;
	const completions: string[] = [];
	domain.subscribeCompletions((event) =>
		completions.push(event.messageEntryId),
	);
	const unsubscribe = domain.subscribe((counters) => {
		if (!fired && counters.allLoops.value === 0n) {
			fired = true;
			void domain.completeTurn(instance, old);
			void domain.refreshBranch(instance);
		}
	});
	nowMs = 3200;
	await domain.resetReminderCycle();
	await flush();
	assert.equal(domain.counters()?.activeLoops.value, 1n);
	assert.equal(domain.counters()?.allLoops.value, 0n);
	assert.equal(domain.counters()?.activeMs.value, 3200n);
	assert.equal(domain.counters()?.taskMs.value, 0n);
	assert.deepEqual(completions, []);
	unsubscribe();
	const next = session.appendMessage(ordinaryReply());
	await domain.completeTurn(instance, next);
	assert.equal(domain.counters()?.activeLoops.value, 2n);
	assert.equal(domain.counters()?.rootLoops.value, 1n);
	nowMs = 3450;
	await domain.resetCycleOnUserTakeover();
	await domain.completeTurn(instance, next);
	assert.equal(domain.counters()?.activeLoops.value, 0n);
	assert.equal(domain.counters()?.anyBusy, true);
	nowMs = 3650;
	time.fireNext();
	await flush();
	assert.equal(domain.counters()?.activeMs.value, 200n);
	assert.deepEqual(completions, [next]);
	await domain.detach(instance);
});

async function connectedBranchDomains() {
	const hostNode = new FakeNode("host"),
		clientNode = new FakeNode("client", "child");
	const host = createReflectDomainCoordinator({ open: async () => hostNode });
	const client = createReflectDomainCoordinator({
		open: async () => clientNode,
	});
	const main = {},
		child = {},
		session = SessionManager.inMemory();
	session.appendMessage(ordinaryReply());
	await host.attach(main, { getBusy: () => false, onFatal() {} });
	hostNode.emitPeer("child", "online", "transport", {
		role: "pi-continue-watchdog",
	});
	hostNode.send = async (target, channel, value) => {
		hostNode.sent.push({ targetNodeId: target, channel, value });
		clientNode.emitChannel(channel, value);
	};
	clientNode.send = async (target, channel, value) => {
		clientNode.sent.push({ targetNodeId: target, channel, value });
		hostNode.emitChannel(channel, value, "child");
	};
	await client.attach(child, {
		getBusy: () => true,
		onFatal() {},
		source: branchSource(session),
	});
	await flush();
	return {
		hostNode,
		clientNode,
		host,
		client,
		main,
		child,
		session,
		close: async () => {
			await client.detach(child);
			await host.detach(main);
		},
	};
}

test("authenticated remote fresh completion follows snapshot; replay/reconnect never notifies; duplicate identity bounded", async () => {
	const pair = await connectedBranchDomains();
	const { host, client, hostNode, clientNode, session, child } = pair;
	const entries: string[] = [];
	host.subscribeCompletions((event) => {
		assert.equal(host.counters()?.allLoops.value, 1n);
		entries.push(event.messageEntryId);
	});
	const entry = session.appendMessage(ordinaryReply());
	await client.refreshBranch(child);
	assert.equal(host.counters()?.allLoops.value, 1n);
	assert.deepEqual(entries, []);
	await client.completeTurn(child, entry);
	await flush();
	assert.deepEqual(entries, [entry]);
	const fresh = latest(clientNode, "pi-reflect-watchdog.completion.v4").value;
	hostNode.emitChannel("pi-reflect-watchdog.completion.v4", fresh, "unbound");
	hostNode.emitChannel("pi-reflect-watchdog.completion.v4", fresh, "child");
	await client.completeTurn(child, entry);
	await client.refreshBranch(child);
	hostNode.emitPeer("child", "offline");
	hostNode.emitPeer("child", "online");
	clientNode.emitPeer("host", "offline");
	clientNode.emitPeer("host", "online");
	await flush();
	assert.deepEqual(entries, [entry]);
	assert.equal(host.counters()?.allLoops.value, 1n);
	assert.equal(host.counters()?.rootLoops.value, 0n);
	await pair.close();
	assert.equal(hostNode.closed, true);
});

test("remote reset fences delayed snapshots/completions, keeps child busy and active/reminder windows distinct", async () => {
	const pair = await connectedBranchDomains();
	const { host, client, hostNode, clientNode, session, child } = pair;
	const entries: string[] = [];
	host.subscribeCompletions((event) => entries.push(event.messageEntryId));
	const old = session.appendMessage(ordinaryReply());
	await client.completeTurn(child, old);
	const oldCheckpoint = latest(
		clientNode,
		"pi-reflect-watchdog.checkpoint.v4",
	).value;
	const oldCompletion = latest(
		clientNode,
		"pi-reflect-watchdog.completion.v4",
	).value;
	await host.resetReminderCycle();
	await flush();
	hostNode.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		oldCheckpoint,
		"child",
	);
	hostNode.emitChannel(
		"pi-reflect-watchdog.completion.v4",
		oldCompletion,
		"child",
	);
	await flush();
	assert.equal(host.counters()?.anyBusy, true);
	assert.equal(host.counters()?.activeLoops.value, 1n);
	assert.equal(host.counters()?.allLoops.value, 0n);
	const next = session.appendMessage(ordinaryReply());
	await client.completeTurn(child, next);
	await flush();
	assert.equal(host.counters()?.activeLoops.value, 2n);
	assert.equal(host.counters()?.allLoops.value, 1n);
	await host.resetCycleOnUserTakeover();
	await flush();
	await client.refreshBranch(child);
	hostNode.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		oldCheckpoint,
		"child",
	);
	hostNode.emitChannel(
		"pi-reflect-watchdog.completion.v4",
		oldCompletion,
		"child",
	);
	await flush();
	assert.equal(host.counters()?.activeLoops.value, 0n);
	assert.equal(host.counters()?.allLoops.value, 0n);
	const last = session.appendMessage(ordinaryReply());
	await client.completeTurn(child, last);
	assert.deepEqual(entries, [old, next, last]);
	assert.equal(host.counters()?.allLoops.value, 1n);
	await pair.close();
});

test("private v4 rejects child root loops and completion without accepted live snapshot", async () => {
	const node = new FakeNode("host"),
		domain = createReflectDomainCoordinator({ open: async () => node });
	const instance = {};
	await domain.attach(instance, { getBusy: () => false, onFatal() {} });
	node.emitPeer("child", "online");
	const completions: unknown[] = [];
	domain.subscribeCompletions((event) => completions.push(event));
	const identity = {
		attachmentId: "attachment-1",
		scope: "0",
		entryId: "entry",
		position: "1",
	};
	node.emitChannel(
		"pi-reflect-watchdog.completion.v4",
		{ ...checkpoint("i", "c"), ...identity },
		"child",
	);
	node.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		{
			...checkpoint("i", "c", { rootLoops: "1", allLoops: "1" }),
			activeLoops: "1",
			completion: identity,
		},
		"child",
	);
	await flush();
	assert.equal(domain.counters()?.rootLoops.value, 0n);
	assert.equal(domain.counters()?.allLoops.value, 0n);
	assert.deepEqual(completions, []);
	await domain.detach(instance);
});

test("fresh completion suppressed when publication observer synchronously rebases attachment", async () => {
	const domain = createReflectDomainCoordinator({
		open: async () => new FakeNode("host"),
	});
	const instance = {},
		session = SessionManager.inMemory();
	await domain.attach(instance, {
		getBusy: () => false,
		onFatal() {},
		source: branchSource(session, true),
	});
	const completions: unknown[] = [];
	domain.subscribeCompletions((event) => completions.push(event));
	let rebased = false;
	domain.subscribe((counters) => {
		if (!rebased && counters.allLoops.value === 1n) {
			rebased = true;
			void domain.rebaseBranch(instance, { adoptHistory: true });
		}
	});
	await domain.completeTurn(instance, session.appendMessage(ordinaryReply()));
	assert.deepEqual(completions, []);
	await domain.detach(instance);
});

test("offline fresh turn repairs on reconnect but no completion retained for later", async () => {
	const pair = await connectedBranchDomains();
	const { host, client, hostNode, clientNode, child, session } = pair;
	const completions: unknown[] = [];
	host.subscribeCompletions((event) => completions.push(event));
	hostNode.emitPeer("child", "offline");
	clientNode.emitPeer("host", "offline");
	clientNode.sendError = new Error("process-domain host is offline");
	const originalSend = clientNode.send;
	clientNode.send = async () => {
		throw clientNode.sendError;
	};
	await client.completeTurn(child, session.appendMessage(ordinaryReply()));
	clientNode.send = originalSend;
	clientNode.sendError = undefined;
	hostNode.emitPeer("child", "online");
	clientNode.emitPeer("host", "online");
	await flush();
	assert.equal(host.counters()?.allLoops.value, 1n);
	assert.deepEqual(completions, []);
	assert.equal(
		clientNode.sent.some(
			(message) => message.channel === "pi-reflect-watchdog.completion.v4",
		),
		false,
	);
	await pair.close();
});

test("remote completion rejects out-of-order snapshot, wrong identity and changed scope replay", async () => {
	const pair = await connectedBranchDomains();
	const { host, client, hostNode, clientNode, child, session } = pair;
	const completions: unknown[] = [];
	host.subscribeCompletions((event) => completions.push(event));
	await client.completeTurn(child, session.appendMessage(ordinaryReply()));
	const checkpointWire = latest(clientNode, "pi-reflect-watchdog.checkpoint.v4")
		.value as Record<string, string>;
	const completionWire = latest(clientNode, "pi-reflect-watchdog.completion.v4")
		.value as Record<string, string>;
	hostNode.emitChannel(
		"pi-reflect-watchdog.completion.v4",
		{ ...completionWire, contributorId: "wrong" },
		"child",
	);
	hostNode.emitChannel(
		"pi-reflect-watchdog.completion.v4",
		{ ...completionWire, entryId: "wrong" },
		"child",
	);
	hostNode.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		{ ...checkpointWire, seq: String(BigInt(checkpointWire.seq) + 1n) },
		"child",
	);
	hostNode.emitChannel(
		"pi-reflect-watchdog.completion.v4",
		{ ...completionWire, seq: String(BigInt(completionWire.seq) + 1n) },
		"child",
	);
	await flush();
	assert.equal(completions.length, 1);
	assert.equal(host.counters()?.allLoops.value, 1n);
	await client.refreshBranch(child);
	hostNode.emitChannel(
		"pi-reflect-watchdog.completion.v4",
		completionWire,
		"child",
	);
	assert.equal(completions.length, 1);
	await client.rebaseBranch(child);
	const currentWire = latest(clientNode, "pi-reflect-watchdog.checkpoint.v4")
		.value as Record<string, unknown> & { seq: string };
	hostNode.emitChannel(
		"pi-reflect-watchdog.checkpoint.v4",
		{ ...checkpointWire, seq: String(BigInt(currentWire.seq) + 1n) },
		"child",
	);
	hostNode.emitChannel(
		"pi-reflect-watchdog.completion.v4",
		{ ...completionWire, seq: String(BigInt(currentWire.seq) + 1n) },
		"child",
	);
	assert.equal(completions.length, 1);
	assert.equal(host.counters()?.allLoops.value, 1n);
	await pair.close();
});

test("Pi finalized identity excludes invalid/inquiry replies and counts whole multi-tool batch once", async () => {
	const domain = createReflectDomainCoordinator({
		open: async () => new FakeNode("host"),
	});
	const session = SessionManager.inMemory(),
		instance = {};
	await domain.attach(instance, {
		getBusy: () => true,
		onFatal() {},
		source: branchSource(session, true),
	});
	const completions: string[] = [];
	domain.subscribeCompletions((event) =>
		completions.push(event.messageEntryId),
	);
	const aborted = session.appendMessage({
		...ordinaryReply(),
		stopReason: "aborted",
	});
	const inquiry = session.appendMessage({
		...ordinaryReply(),
		details: { piInquiry: { version: 1 } },
	} as AssistantMessage);
	await domain.completeTurn(instance, aborted);
	await domain.completeTurn(instance, inquiry);
	await domain.completeTurn(instance, "missing-persisted-id");
	assert.equal(domain.counters()?.allLoops.value, 0n);
	assert.deepEqual(completions, []);
	const tools = session.appendMessage({
		...ordinaryReply(),
		stopReason: "toolUse",
		content: [
			{ type: "toolCall", id: "one", name: "read", arguments: {} },
			{ type: "toolCall", id: "two", name: "read", arguments: {} },
		],
	});
	await domain.refreshBranch(instance);
	session.appendMessage({
		role: "toolResult",
		toolCallId: "one",
		toolName: "read",
		content: [{ type: "text", text: "one" }],
		isError: false,
		timestamp: 0,
	});
	session.appendMessage({
		role: "toolResult",
		toolCallId: "two",
		toolName: "read",
		content: [{ type: "text", text: "two" }],
		isError: false,
		timestamp: 0,
	});
	await domain.completeTurn(instance, tools);
	assert.equal(domain.counters()?.allLoops.value, 1n);
	assert.deepEqual(completions, [tools]);
	await domain.detach(instance);
});

test("two local attachments keep separate contribution and completion coordinates", async () => {
	const domain = createReflectDomainCoordinator({
		open: async () => new FakeNode("host"),
	});
	const main = {},
		child = {},
		mainHistory = SessionManager.inMemory(),
		childHistory = SessionManager.inMemory();
	await domain.attach(main, {
		getBusy: () => true,
		onFatal() {},
		source: branchSource(mainHistory, true),
	});
	await domain.attach(child, {
		getBusy: () => true,
		onFatal() {},
		source: branchSource(childHistory),
	});
	const seen: object[] = [];
	domain.subscribeCompletions((event) => {
		if (event.attachmentInstance !== undefined)
			seen.push(event.attachmentInstance);
	});
	await domain.completeTurn(main, mainHistory.appendMessage(ordinaryReply()));
	await domain.completeTurn(child, childHistory.appendMessage(ordinaryReply()));
	assert.equal(domain.counters()?.rootLoops.value, 1n);
	assert.equal(domain.counters()?.allLoops.value, 2n);
	assert.deepEqual(seen, [main, child]);
	await domain.detach(child);
	await domain.rebaseBranch(main, { adoptHistory: true });
	assert.equal(domain.counters()?.rootLoops.value, 1n);
	assert.equal(domain.counters()?.allLoops.value, 2n);
	await domain.resetReminderCycle();
	await domain.completeTurn(main, mainHistory.appendMessage(ordinaryReply()));
	assert.equal(domain.counters()?.activeLoops.value, 3n);
	assert.equal(domain.counters()?.allLoops.value, 1n);
	await domain.detach(main);
});

test("main historical adoption respects explicit anchors; missing adoption anchor fences", async () => {
	const domain = createReflectDomainCoordinator({
		open: async () => new FakeNode("host"),
	});
	const session = SessionManager.inMemory(),
		instance = {};
	const earlier = session.appendMessage(ordinaryReply());
	const later = session.appendMessage(ordinaryReply());
	await domain.attach(instance, {
		getBusy: () => false,
		onFatal() {},
		source: branchSource(session, true),
	});
	await domain.rebaseBranch(instance, {
		adoptHistory: true,
		fullAfterEntryId: earlier,
		reminderAfterEntryId: later,
	});
	assert.equal(domain.counters()?.activeLoops.value, 1n);
	assert.equal(domain.counters()?.rootLoops.value, 0n);
	await domain.completeTurn(instance, later);
	assert.equal(domain.counters()?.activeLoops.value, 1n);
	await domain.rebaseBranch(instance, {
		adoptHistory: true,
		fullAfterEntryId: "missing-anchor",
	});
	assert.equal(domain.counters()?.activeLoops.value, 0n);
	const fresh = session.appendMessage(ordinaryReply());
	await domain.completeTurn(instance, fresh);
	assert.equal(domain.counters()?.rootLoops.value, 1n);
	await domain.detach(instance);
});

for (const gap of [60_000, 60_001])
	test(`implicit idle reset records current-main full boundary only at strict overflow ${gap}`, async () => {
		let now = 0;
		const domain = createReflectDomainCoordinator({
			open: async () => new FakeNode("host"),
			now: () => now,
		});
		const mainSession = SessionManager.inMemory(),
			childSession = SessionManager.inMemory();
		const main = {},
			child = {};
		const markers: string[] = [];
		const source = {
			...branchSource(mainSession, true),
			recordFullBoundary: () => {
				markers.push(
					mainSession.appendCustomEntry(ACCOUNTING_BOUNDARY_ENTRY, {
						version: 1,
						window: "full",
					}),
				);
				void domain.refreshBranch(main); // Reentry sees already claimed reset.
			},
		};
		await domain.attach(main, { getBusy: () => true, onFatal() {}, source });
		await domain.attach(child, {
			getBusy: () => false,
			onFatal() {},
			source: branchSource(childSession),
		});
		const old = mainSession.appendMessage(ordinaryReply());
		await domain.completeTurn(main, old);
		now = 1000;
		await domain.setBusy(main, false);
		now += gap;
		await domain.setBusy(child, true); // Child-first resume still records owner's branch.
		await flush();
		assert.equal(markers.length, gap > 60_000 ? 1 : 0);
		assert.equal(domain.counters()?.activeLoops.value, gap > 60_000 ? 0n : 1n);
		assert.equal(
			childSession.getBranch().length,
			0,
			"no marker in child's branch",
		);
		await domain.rebaseBranch(main, { adoptHistory: true });
		assert.equal(
			domain.counters()?.rootLoops.value,
			gap > 60_000 ? 0n : 1n,
			"adoption cannot resurrect pre-idle work",
		);
		const id = mainSession.appendMessage(ordinaryReply());
		await domain.completeTurn(main, id);
		await domain.resetCycleOnUserTakeover();
		assert.equal(
			markers.length,
			gap > 60_000 ? 1 : 0,
			"explicit resets do not duplicate recorder",
		);
		await domain.detach(child);
		await domain.detach(main);
	});
