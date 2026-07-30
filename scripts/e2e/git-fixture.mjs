import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { createReleaseTree } from "../distribution.mjs";
import { PI_BIN, ROOT, runBoundedProcess, terminateChild } from "./harness.mjs";

export const MASTER_FIXTURE_ALLOWLIST = [
	"LICENSE",
	"README.md",
	"package-lock.json",
	"package.json",
	"src/activity.ts",
	"src/config-loader.ts",
	"src/config.ts",
	"src/controller.ts",
	"src/controls.ts",
	"src/extension.ts",
	"src/hub.ts",
	"src/index.ts",
	"src/prompts.ts",
	"src/widget.ts",
	"tsconfig.check.json",
	"tsconfig.json",
].sort();

export function assertStockPiDependencyShape(manifest) {
	const piPeers = [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
	];
	if (
		manifest.dependencies?.typebox ||
		manifest.devDependencies?.typebox ||
		manifest.peerDependencies?.typebox
	)
		throw new Error("fixture must not declare typebox as a direct dependency");
	for (const name of piPeers) {
		if (manifest.peerDependencies?.[name] !== "*")
			throw new Error(`fixture must peer-depend on ${name}`);
	}
	return true;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.status !== 0)
		throw new Error(
			`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
		);
	return result.stdout.trim();
}

export async function createCompleteSourceFixture(
	base,
	name = "source-fixture",
) {
	const destination = path.join(base, name);
	await mkdir(destination, { recursive: true });
	await copyMasterTree(destination);
	return destination;
}

async function copyMasterTree(destination) {
	const manifest = JSON.parse(
		await readFile(path.join(ROOT, "package.json"), "utf8"),
	);
	assertStockPiDependencyShape(manifest);
	for (const name of [
		"LICENSE",
		"README.md",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		"tsconfig.check.json",
	]) {
		await cp(path.join(ROOT, name), path.join(destination, name));
	}
	for (const directory of ["dist", "src"])
		await cp(path.join(ROOT, directory), path.join(destination, directory), {
			recursive: true,
		});
}

function commitAll(repository, message) {
	run("git", ["add", "--", ...MASTER_FIXTURE_ALLOWLIST], { cwd: repository });
	return run(
		"git",
		[
			"-c",
			"user.name=E2E",
			"-c",
			"user.email=e2e@example.invalid",
			"commit",
			"-m",
			message,
		],
		{
			cwd: repository,
		},
	);
}

async function freePort() {
	const server = net.createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

async function addInvalidInstallBranch(source) {
	run("git", ["checkout", "-b", "invalid-install", "master"], { cwd: source });
	const manifestPath = path.join(source, "package.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	manifest.dependencies = {
		...manifest.dependencies,
		"pi-watchdog-e2e-not-a-real-package": "9999.9999.9999",
	};
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	run("git", ["add", "package.json"], { cwd: source });
	run(
		"git",
		[
			"-c",
			"user.name=E2E",
			"-c",
			"user.email=e2e@example.invalid",
			"commit",
			"-m",
			"invalid install fixture",
		],
		{ cwd: source },
	);
	run("git", ["checkout", "master"], { cwd: source });
}

export async function createGitFixture(
	base,
	{ releaseTree: candidateReleaseTree } = {},
) {
	const source = path.join(base, "source");
	const releaseTree = candidateReleaseTree ?? path.join(base, "release-tree");
	const remoteParent = path.join(base, "remotes", "xz-dev");
	const bare = path.join(remoteParent, "pi-watchdog.git");
	let daemon;
	try {
		await mkdir(remoteParent, { recursive: true });
		await createCompleteSourceFixture(base, "source");
		run("git", ["init", "-b", "master"], { cwd: source });
		commitAll(source, "master fixture");
		const masterOid = run("git", ["rev-parse", "HEAD"], { cwd: source });
		if (!candidateReleaseTree)
			await createReleaseTree({
				root: source,
				outputDirectory: releaseTree,
				sourceCommit: masterOid,
			});
		run("git", ["checkout", "--orphan", "release"], { cwd: source });
		run("git", ["rm", "-rf", "."], { cwd: source });
		for (const name of await readdir(releaseTree))
			await cp(path.join(releaseTree, name), path.join(source, name), {
				recursive: true,
			});
		run("git", ["add", "-A"], { cwd: source });
		run(
			"git",
			[
				"-c",
				"user.name=E2E",
				"-c",
				"user.email=e2e@example.invalid",
				"commit",
				"-m",
				"release fixture",
			],
			{ cwd: source },
		);
		const releaseOid = run("git", ["rev-parse", "HEAD"], { cwd: source });
		run("git", ["checkout", "master"], { cwd: source });
		await addInvalidInstallBranch(source);
		run("git", ["clone", "--bare", source, bare]);
		run("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: bare });
		const port = await freePort();
		daemon = spawn(
			"git",
			[
				"daemon",
				"--reuseaddr",
				"--export-all",
				`--base-path=${path.join(base, "remotes")}`,
				`--port=${port}`,
				path.join(base, "remotes"),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let stderr = "";
		daemon.stderr.setEncoding("utf8");
		daemon.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		if (daemon.exitCode !== null)
			throw new Error(`git daemon exited: ${stderr}`);
		const baseSource = `git:git://127.0.0.1:${port}/xz-dev/pi-watchdog.git`;
		return {
			masterSource: `${baseSource}@master`,
			releaseSource: `${baseSource}@release`,
			invalidInstallSource: `${baseSource}@invalid-install`,
			masterOid,
			releaseOid,
			daemonPid: daemon.pid,
			stop: () =>
				terminateChild(daemon, { termTimeoutMs: 2_000, killTimeoutMs: 2_000 }),
		};
	} catch (error) {
		await daemon?.kill?.("SIGTERM");
		if (daemon) await terminateChild(daemon).catch(() => {});
		throw error;
	}
}

export async function tryInstallGitPackage({
	source,
	cwd,
	env,
	timeoutMs = 60_000,
}) {
	return runBoundedProcess(PI_BIN, ["install", source], {
		cwd,
		env,
		timeoutMs,
	});
}

export async function installGitPackage(options) {
	const result = await tryInstallGitPackage(options);
	if (result.status !== 0 || result.timedOut || result.error)
		throw new Error(
			`pi install failed${result.timedOut ? " after timeout" : result.error ? `: ${result.error.message}` : ""}:\n${result.stdout}\n${result.stderr}`,
		);
	return `${result.stdout}\n${result.stderr}`;
}

export function managedGitPath(agentDir) {
	return path.join(agentDir, "git", "127.0.0.1", "xz-dev", "pi-watchdog");
}
