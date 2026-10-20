import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
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

test("the installed packed tarball loads src with only the reflect commands", async (t) => {
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
		path.join(artifact.packagePath, "src", "extension.ts"),
	);
	const commands = await rpc.request({ type: "get_commands" });
	assert.deepEqual(
		commands.data.commands
			.filter((command) =>
				command.sourceInfo?.path?.includes("pi-reflect-watchdog"),
			)
			.map((command) => command.name)
			.sort(),
		["cancel-reflect", "reflect"],
	);
});

test("stock Pi loads global and trusted-project watchdog configuration", async (t) => {
	const resources = await createTestResources(t);
	const isolated = await createIsolatedEnvironment(resources.base);
	const artifact = await installPackedArtifact({
		base: resources.base,
		agentDir: isolated.agentDir,
	});
	await writeJson(path.join(isolated.agentDir, "pi-reflect-watchdog.json"), {
		rootLoopLimit: 17,
		allLoopLimit: 19,
		taskMinutes: 23,
	});
	await writeJson(
		path.join(isolated.workspace, ".pi", "pi-reflect-watchdog.json"),
		{
			rootLoopLimit: 29,
		},
	);

	const rpc = new RpcPi({
		cwd: isolated.workspace,
		env: isolated.env,
		args: ["--approve"],
	});
	resources.add(() => rpc.close());
	await assertSingleWatchdogCommand(
		rpc,
		path.join(artifact.packagePath, "src", "extension.ts"),
	);
	const accepted = await rpc.request({
		type: "prompt",
		message: "/reflect verify layered configuration",
	});
	assert.equal(accepted.success, true);
});

test("stock Pi installs master from an actual local Git remote with the exact source path", async (t) => {
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-git-e2e-",
	);
	const fixture = await createGitFixture(resources.base);
	resources.add(() => fixture.stop());
	const isolated = await createIsolatedEnvironment(resources.base, "master");
	await installGitPackage({
		source: fixture.masterSource,
		cwd: isolated.workspace,
		env: isolated.env,
	});
	const managed = managedGitPath(isolated.agentDir);
	const rpc = new RpcPi({ cwd: isolated.workspace, env: isolated.env });
	resources.add(() => rpc.close());
	const entry = path.join(managed, "src", "extension.ts");
	await assertSingleWatchdogCommand(rpc, entry);
	const commands = await rpc.request({ type: "get_commands" });
	const watchdog = commands.data.commands.find(
		(command) => command.name === "reflect",
	);
	assert.equal(watchdog.sourceInfo.path, entry);
	const tracked = execFileSync(
		"git",
		["ls-tree", "-r", "--name-only", "HEAD"],
		{ cwd: managed, encoding: "utf8" },
	)
		.trim()
		.split("\n")
		.filter(Boolean)
		.sort();
	assert.deepEqual(tracked, MASTER_FIXTURE_ALLOWLIST);
});

test("failed stock Git installation is bounded and resource cleanup removes its checkout and daemon", async (t) => {
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-git-failure-",
	);
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
		/pi-reflect-watchdog-e2e-not-a-real-package|E404|install failed/i,
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
