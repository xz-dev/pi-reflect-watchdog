import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
	CleanupManager,
	createTestResources,
	RpcPi,
	runBoundedProcess,
	spawnIsolated,
	terminateChild,
} from "../../scripts/e2e/harness.mjs";

async function exists(target) {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

function processExists(pid) {
	try {
		execFileSync("kill", ["-0", String(pid)], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function waitForFile(file, timeoutMs = 2_000) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		try {
			return (await readFile(file, "utf8")).trim();
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${file}`);
}

test("cleanup manager preserves explicit process-server-temp order after assertion failure", async () => {
	const temporary = await mkdtemp(
		path.join("/tmp", "pi-reflect-watchdog-cleanup-"),
	);
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
		stdio: "ignore",
	});
	const order = [];
	const cleanup = new CleanupManager();
	// Register in allocation order; cleanup unwinds in reverse dependency order.
	cleanup.add(async () => {
		order.push("temp");
		await rm(temporary, { recursive: true, force: true });
	});
	cleanup.add(async () => {
		order.push("server");
	});
	cleanup.add(async () => {
		order.push("process");
		await terminateChild(child, { termTimeoutMs: 100, killTimeoutMs: 1_000 });
	});
	try {
		assert.fail("forced assertion failure");
	} catch {
		await cleanup.run();
	}
	assert.deepEqual(order, ["process", "server", "temp"]);
	assert.ok(child.exitCode !== null || child.signalCode !== null);
	assert.equal(await exists(temporary), false);
});

test("test resource stack closes child resources before removing its temporary root", async (t) => {
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-resource-stack-",
	);
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
		stdio: "ignore",
	});
	resources.add(() =>
		terminateChild(child, { termTimeoutMs: 100, killTimeoutMs: 1_000 }),
	);
	await resources.cleanup();
	assert.ok(child.exitCode !== null || child.signalCode !== null);
	assert.equal(await exists(resources.base), false);
});

test("SIGKILL cleanup waits for the child exit with a bound", async () => {
	const child = spawn(
		process.execPath,
		[
			"-e",
			"process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	await new Promise((resolve) => child.stdout.once("data", resolve));
	const started = performance.now();
	await terminateChild(child, { termTimeoutMs: 100, killTimeoutMs: 1_000 });
	assert.equal(child.signalCode, "SIGKILL");
	assert.ok(performance.now() - started < 1_500);
});

test("RpcPi.close kills a detached launcher process group and its grandchild", {
	timeout: 5_000,
}, async (t) => {
	if (process.platform === "win32") t.skip("POSIX process groups only");
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-process-tree-",
	);
	const grandchildPidFile = path.join(resources.base, "grandchild.pid");
	const launcher = [
		"const { spawn } = require('node:child_process');",
		"const fs = require('node:fs');",
		`const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000)"], { stdio: 'ignore' });`,
		`fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid));`,
		"setInterval(() => {}, 1000);",
	].join("");
	const rpc = new RpcPi({
		cwd: resources.base,
		env: process.env,
		executable: process.execPath,
		launcherArgs: ["-e", launcher],
	});
	resources.add(() => rpc.close());
	const grandchildPid = Number(await waitForFile(grandchildPidFile));
	assert.equal(
		processExists(grandchildPid),
		true,
		"fixture grandchild started",
	);
	const started = performance.now();
	await rpc.close();
	assert.ok(performance.now() - started < 2_000, "close is bounded");
	assert.equal(processExists(rpc.child.pid), false, "launcher is gone");
	assert.equal(processExists(grandchildPid), false, "grandchild is gone");
});

test("bounded test commands kill their detached descendant tree on timeout", {
	timeout: 5_000,
}, async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX process groups only");
		return;
	}
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-bounded-tree-",
	);
	const grandchildPidFile = path.join(resources.base, "grandchild.pid");
	const launcher = [
		"const { spawn } = require('node:child_process');",
		"const fs = require('node:fs');",
		`const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000)"], { stdio: 'ignore' });`,
		`fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid));`,
		"setInterval(() => {}, 1000);",
	].join("");
	const result = await runBoundedProcess(process.execPath, ["-e", launcher], {
		cwd: resources.base,
		timeoutMs: 100,
		termTimeoutMs: 100,
		killTimeoutMs: 1_000,
	});
	const grandchildPid = Number(await waitForFile(grandchildPidFile));
	assert.equal(result.timedOut, true, "test command is bounded");
	assert.equal(
		processExists(grandchildPid),
		false,
		"timed-out command leaves no grandchild",
	);
});

test("isolated child cleanup does not signal an unrelated process", async (t) => {
	if (process.platform === "win32") {
		t.skip("POSIX process groups only");
		return;
	}
	const unrelated = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)"],
		{
			stdio: "ignore",
		},
	);
	const child = spawnIsolated(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)"],
		{
			stdio: "ignore",
		},
	);
	try {
		await terminateChild(child, {
			termTimeoutMs: 100,
			killTimeoutMs: 1_000,
			processGroup: true,
		});
		assert.equal(processExists(child.pid), false);
		assert.equal(processExists(unrelated.pid), true);
	} finally {
		await terminateChild(unrelated, {
			termTimeoutMs: 100,
			killTimeoutMs: 1_000,
		});
	}
});
