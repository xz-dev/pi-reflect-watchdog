import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { RELEASE_ALLOWLIST } from "../../scripts/distribution.mjs";
import {
	assertStockPiDependencyShape,
	createGitFixture,
	installGitPackage,
	MASTER_FIXTURE_ALLOWLIST,
	managedGitPath,
	tryInstallGitPackage,
} from "../../scripts/e2e/git-fixture.mjs";
import {
	assertSingleWatchdogCommand,
	assertStockPi,
	createIsolatedEnvironment,
	createTestResources,
	installPackedArtifact,
	RpcPi,
	writeJson,
} from "../../scripts/e2e/harness.mjs";

async function commandNotifications(rpc, command) {
	const start = rpc.events.length;
	const response = await rpc.request({
		type: "prompt",
		message: `/watchdog ${command}`,
	});
	assert.equal(response.success, true);
	await new Promise((resolve) => setTimeout(resolve, 100));
	return rpc.events
		.slice(start)
		.map((entry) => entry.message)
		.filter(
			(message) =>
				message.type === "extension_ui_request" && message.method === "notify",
		);
}

async function missing(target) {
	try {
		await access(target);
		return false;
	} catch {
		return true;
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

test("the installed packed tarball loads dist and commands never start a model turn", async (t) => {
	assertStockPi();
	const resources = await createTestResources(t);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	const packagedManifest = await import(
		path.join(artifact.packagePath, "package.json"),
		{ with: { type: "json" } }
	);
	assert.equal(
		assertStockPiDependencyShape(packagedManifest.default),
		true,
		"packed artifact declares only Pi aliases as direct peers",
	);
	const rpc = new RpcPi({ cwd: isolated.workspace, env: isolated.env });
	resources.add(() => rpc.close());
	await assertSingleWatchdogCommand(
		rpc,
		path.join(artifact.packagePath, "dist", "extension.js"),
	);
	for (const command of ["status", "reset", "limits 7 11 13"]) {
		const notifications = await commandNotifications(rpc, command);
		assert.ok(
			notifications.length >= 1,
			`${command} reports through extension UI`,
		);
		assert.equal(
			rpc.events.some((entry) => entry.message.type === "agent_start"),
			false,
		);
	}
});

test("stock Pi honors global and trusted-project watchdog config precedence", async (t) => {
	const resources = await createTestResources(t);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	await writeJson(path.join(isolated.agentDir, "pi-watchdog.json"), {
		mainLoopLimit: 17,
		observedTotalLoopLimit: 19,
		wallClockMinutes: 23,
	});
	await writeJson(path.join(isolated.workspace, ".pi", "pi-watchdog.json"), {
		mainLoopLimit: 29,
	});

	for (const [trustFlag, expected] of [
		["--no-approve", "main=17"],
		["--approve", "main=29"],
	]) {
		const rpc = new RpcPi({
			cwd: isolated.workspace,
			env: isolated.env,
			args: [trustFlag],
		});
		resources.add(() => rpc.close());
		await assertSingleWatchdogCommand(
			rpc,
			path.join(artifact.packagePath, "dist", "extension.js"),
		);
		const notifications = await commandNotifications(rpc, "status");
		assert.match(
			notifications.map((message) => message.message).join("\n"),
			new RegExp(expected),
		);
		assert.match(
			notifications.map((message) => message.message).join("\n"),
			/observed-total=19; wall-clock=23m/,
		);
	}
});

test("stock Pi installs master and release from actual local Git remotes with exact source paths", async (t) => {
	const resources = await createTestResources(t, "pi-watchdog-git-e2e-");
	const fixture = await createGitFixture(resources.base);
	resources.add(() => fixture.stop());
	for (const [name, source, entry] of [
		["master", fixture.masterSource, path.join("src", "extension.ts")],
		["release", fixture.releaseSource, path.join("dist", "extension.js")],
	]) {
		const isolated = await createIsolatedEnvironment(
			path.join(resources.base, name),
		);
		await installGitPackage({
			source,
			cwd: isolated.workspace,
			env: isolated.env,
		});
		const managed = managedGitPath(isolated.agentDir);
		const rpc = new RpcPi({ cwd: isolated.workspace, env: isolated.env });
		resources.add(() => rpc.close());
		await assertSingleWatchdogCommand(rpc, path.join(managed, entry));
		const commands = await rpc.request({ type: "get_commands" });
		const watchdog = commands.data.commands.find(
			(command) => command.name === "watchdog",
		);
		assert.equal(
			await realpath(watchdog.sourceInfo.path),
			await realpath(path.join(managed, entry)),
		);
		const tracked = execFileSync(
			"git",
			["ls-tree", "-r", "--name-only", "HEAD"],
			{ cwd: managed, encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.filter(Boolean)
			.sort();
		assert.deepEqual(
			tracked,
			name === "master" ? MASTER_FIXTURE_ALLOWLIST : RELEASE_ALLOWLIST,
		);
	}
});

test("failed stock Git installation is bounded and resource cleanup removes its checkout and daemon", async (t) => {
	const resources = await createTestResources(t, "pi-watchdog-git-failure-");
	const fixture = await createGitFixture(resources.base);
	resources.add(() => fixture.stop());
	const isolated = await createIsolatedEnvironment(resources.base, "invalid");
	const started = performance.now();
	const result = await tryInstallGitPackage({
		source: fixture.invalidInstallSource,
		cwd: isolated.workspace,
		env: isolated.env,
		timeoutMs: 60_000,
	});
	assert.notEqual(result.status, 0, "invalid Git install must fail");
	assert.ok(
		performance.now() - started < 62_000,
		"invalid Git install remains bounded",
	);
	assert.match(
		`${result.stdout}\n${result.stderr}`,
		/pi-watchdog-e2e-not-a-real-package|E404|install failed/i,
	);
	await resources.cleanup();
	assert.equal(
		await missing(resources.base),
		true,
		"temporary root is removed",
	);
	assert.equal(
		processExists(fixture.daemonPid),
		false,
		"git daemon is stopped",
	);
});
