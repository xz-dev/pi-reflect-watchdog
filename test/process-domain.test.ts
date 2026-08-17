import assert from "node:assert/strict";
import test from "node:test";
import type {
	CycleCounterSnapshot,
	DomainSnapshot,
	ProcessDomain,
} from "pi-process-domain";
import {
	createReflectDomainCoordinator,
	type ReflectDomainClock,
	type ReflectDomainCounters,
} from "../src/process-domain.js";

function counter(
	name: string,
	value = 0n,
	paused = false,
): CycleCounterSnapshot {
	return {
		name,
		value,
		paused,
		generation: 1n,
		ownerParticipantId: "owner",
	};
}

function snapshot(busyParticipants = 0): DomainSnapshot {
	return {
		domainId: "domain",
		brokerEpoch: "epoch",
		revision: 1n,
		activityGeneration: 1n,
		participants: 1,
		busyParticipants,
		pendingSpawns: 0,
		allIdle: busyParticipants === 0,
		certain: true,
		fence: { brokerEpoch: "epoch", activityGeneration: 1n },
	};
}

function fakeDomain() {
	const values = new Map<string, CycleCounterSnapshot>();
	const counterListeners = new Map<
		string,
		Set<(value: CycleCounterSnapshot) => void>
	>();
	let busyParticipants = 0;
	const claims: string[] = [];
	const increments: Array<[string, bigint, bigint | undefined]> = [];
	const pauses: Array<[string, boolean, bigint]> = [];
	const resets: Array<[string, bigint]> = [];
	const emitCounter = (next: CycleCounterSnapshot): void => {
		values.set(next.name, next);
		for (const listener of counterListeners.get(next.name) ?? [])
			listener(next);
	};
	const domain: ProcessDomain = {
		snapshot: () => snapshot(busyParticipants),
		async setActivity(activity) {
			busyParticipants = activity === "busy" ? 1 : 0;
			return snapshot(busyParticipants);
		},
		async reserveSpawn() {
			return { env: {}, async cancel() {} };
		},
		subscribe: () => () => {},
		async publish() {},
		subscribeSignals: () => () => {},
		async claimCycleCounter(name) {
			claims.push(name);
			const current = values.get(name);
			const claimed = {
				...(current ?? counter(name)),
				generation:
					current?.ownerParticipantId === null
						? current.generation + 1n
						: (current?.generation ?? 1n),
				ownerParticipantId: "owner",
			};
			emitCounter(claimed);
			return claimed;
		},
		async getCycleCounter(name) {
			return values.get(name) ?? counter(name);
		},
		subscribeCycleCounter(name, listener) {
			const listeners = counterListeners.get(name) ?? new Set();
			listeners.add(listener);
			counterListeners.set(name, listeners);
			return () => listeners.delete(listener);
		},
		async incrementCycleCounter(name, delta = 1n, generation) {
			increments.push([name, delta, generation]);
			const current = values.get(name) ?? counter(name);
			const next = current.paused
				? current
				: { ...current, value: current.value + delta };
			values.set(name, next);
			return next;
		},
		async resetCycleCounter(name, generation) {
			resets.push([name, generation]);
			const next = { ...(values.get(name) ?? counter(name)), value: 0n };
			values.set(name, next);
			return next;
		},
		async setCycleCounterPaused(name, paused, generation) {
			pauses.push([name, paused, generation]);
			const next = { ...(values.get(name) ?? counter(name)), paused };
			values.set(name, next);
			return next;
		},
		async confirm() {
			return true;
		},
		async close() {},
	};
	return { domain, claims, emitCounter, increments, pauses, resets };
}

function fakeClock() {
	const callbacks: Array<() => void> = [];
	const delays: number[] = [];
	const clock: ReflectDomainClock = {
		setTimeout(callback, delayMs) {
			callbacks.push(callback);
			delays.push(delayMs);
			return { unref() {} } as ReturnType<typeof setTimeout>;
		},
		clearTimeout() {},
	};
	return { clock, callbacks, delays };
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("root and aggregate loops commit exact named counters", async () => {
	const fake = fakeDomain();
	const coordinator = createReflectDomainCoordinator({
		open: async () => ({ domain: fake.domain, created: true, hosted: true }),
	});
	const instance = {};
	await coordinator.attach(instance, () => {});
	const afterRoot = await coordinator.recordRootLoop();
	assert.equal(afterRoot.rootLoops.value, 1n);
	assert.equal(afterRoot.domainLoops.value, 1n);
	const afterChild = await coordinator.recordDomainLoop();
	assert.equal(afterChild.rootLoops.value, 1n);
	assert.equal(afterChild.domainLoops.value, 2n);
	assert.deepEqual(
		fake.increments.map(([name, delta]) => [name, delta]),
		[
			["pi-reflect-watchdog.root-loops", 1n],
			["pi-reflect-watchdog.domain-loops", 1n],
			["pi-reflect-watchdog.domain-loops", 1n],
		],
	);
	await coordinator.detach(instance);
});

test("hosted existing broker owns counters even when this open did not create it", async () => {
	const fake = fakeDomain();
	const coordinator = createReflectDomainCoordinator({
		open: async () => ({ domain: fake.domain, created: false, hosted: true }),
	});
	const instance = {};
	await coordinator.attach(instance, () => {});
	assert.equal(coordinator.rootProcess, true);
	assert.deepEqual(fake.claims, [
		"pi-reflect-watchdog.root-loops",
		"pi-reflect-watchdog.domain-loops",
		"pi-reflect-watchdog.active-ms",
	]);
	const afterRoot = await coordinator.recordRootLoop();
	assert.equal(afterRoot.rootLoops.value, 1n);
	assert.equal(afterRoot.domainLoops.value, 1n);
	await coordinator.detach(instance);
});

test("released counter owner is reclaimed with a fenced generation", async () => {
	const fake = fakeDomain();
	const coordinator = createReflectDomainCoordinator({
		open: async () => ({ domain: fake.domain, created: false, hosted: true }),
	});
	const instance = {};
	await coordinator.attach(instance, () => {});
	const observed: ReflectDomainCounters[] = [];
	const unsubscribe = coordinator.subscribe((value) => observed.push(value));
	fake.emitCounter({
		...counter("pi-reflect-watchdog.domain-loops", 7n),
		ownerParticipantId: null,
	});
	await flush();
	assert.equal(
		fake.claims.filter((name) => name === "pi-reflect-watchdog.domain-loops")
			.length,
		2,
	);
	assert.equal(coordinator.counters()?.domainLoops.value, 7n);
	assert.equal(coordinator.counters()?.domainLoops.generation, 2n);
	assert.equal(coordinator.counters()?.domainLoops.ownerParticipantId, "owner");
	assert.equal(
		observed.filter((value) => value.domainLoops.generation === 2n).length,
		1,
	);
	unsubscribe();
	await coordinator.detach(instance);
});

test("recursive active tick adds one quantum and never backfills sleep", async () => {
	const fake = fakeDomain();
	const time = fakeClock();
	const coordinator = createReflectDomainCoordinator({
		open: async () => ({ domain: fake.domain, created: true, hosted: true }),
		clock: time.clock,
		activeTickMs: 250,
		idleGraceMs: 10_000,
	});
	const instance = {};
	await coordinator.attach(instance, () => {});
	await coordinator.setBusy(instance, true);
	assert.deepEqual(time.delays, [250]);
	time.callbacks.shift()?.();
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 250n);
	assert.deepEqual(time.delays, [250, 250]);
	// Even if the host fires late after sleep, one callback adds one fixed quantum.
	time.callbacks.shift()?.();
	await flush();
	assert.equal(coordinator.counters()?.activeMs.value, 500n);
	await coordinator.detach(instance);
});

test("reflection pause/reset preserves pause until explicit resume", async () => {
	const fake = fakeDomain();
	const coordinator = createReflectDomainCoordinator({
		open: async () => ({ domain: fake.domain, created: true, hosted: true }),
	});
	const instance = {};
	await coordinator.attach(instance, () => {});
	await coordinator.recordRootLoop();
	const reset = await coordinator.pauseAndReset();
	assert.equal(reset?.rootLoops.value, 0n);
	assert.equal(reset?.domainLoops.value, 0n);
	assert.equal(reset?.activeMs.value, 0n);
	assert.ok(reset?.rootLoops.paused);
	assert.equal(fake.resets.length, 3);
	await coordinator.resume();
	assert.equal(coordinator.counters()?.rootLoops.paused, false);
	assert.equal(fake.pauses.filter(([, paused]) => paused).length, 3);
	assert.equal(fake.pauses.filter(([, paused]) => !paused).length, 3);
	await coordinator.detach(instance);
});
