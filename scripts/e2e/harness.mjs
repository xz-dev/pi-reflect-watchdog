import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const PI_BIN = path.join(ROOT, "node_modules", ".bin", "pi");
const MANIFEST = JSON.parse(
	readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
export const STOCK_PI_VERSION =
	MANIFEST.devDependencies["@earendil-works/pi-coding-agent"];
const SUPPORTS_PROCESS_GROUPS = process.platform !== "win32";

/**
 * Starts a disposable subprocess in its own POSIX process group. The group is
 * addressed only through this exact child PID, never by executable name.
 */
export function spawnIsolated(command, args, options = {}) {
	return spawn(command, args, {
		...options,
		detached: SUPPORTS_PROCESS_GROUPS,
	});
}

export class CleanupManager {
	#closed = false;
	#steps = [];

	add(step) {
		if (this.#closed)
			throw new Error("Cannot register cleanup after cleanup started");
		this.#steps.unshift(step);
		return step;
	}

	async run() {
		if (this.#closed) return;
		this.#closed = true;
		const errors = [];
		for (const step of this.#steps) {
			try {
				await step();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0)
			throw new AggregateError(errors, "E2E cleanup failed");
	}
}

export async function createTestResources(
	t,
	prefix = "pi-reflect-watchdog-e2e-",
) {
	let cleanup;
	try {
		const base = await mkdtemp(path.join("/tmp", prefix));
		cleanup = new CleanupManager();
		cleanup.add(() => rm(base, { recursive: true, force: true }));
		if (t) t.after(() => cleanup.run());
		return {
			base,
			add: (step) => cleanup.add(step),
			cleanup: () => cleanup.run(),
		};
	} catch (error) {
		await cleanup?.run().catch(() => {});
		throw error;
	}
}

export async function writeJson(file, value) {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function createIsolatedEnvironment(
	base,
	workspaceName = "workspace",
) {
	const agentDir = path.join(base, "agent");
	const workspace = path.join(base, workspaceName);
	await mkdir(agentDir, { recursive: true });
	await mkdir(workspace, { recursive: true });
	const env = {
		...process.env,
		HOME: path.join(base, "home"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_SESSION_DIR: path.join(base, "sessions"),
		NO_COLOR: "1",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_prefer_offline: "true",
	};
	delete env.PI_EXTENSION_UTILS_PROCESS_DOMAIN;
	return { agentDir, workspace, env };
}

export function assertStockPi() {
	const result = spawnSync(PI_BIN, ["--version"], { encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || "pi --version failed");
	const match = `${result.stdout}\n${result.stderr}`.match(
		/\b(\d+\.\d+\.\d+)\b/,
	);
	if (match?.[1] !== STOCK_PI_VERSION) {
		throw new Error(
			`Expected stock Pi ${STOCK_PI_VERSION}, got ${match?.[1] ?? "unknown"}`,
		);
	}
}

export async function installPackedArtifact({ base, agentDir }) {
	const tarball = process.env.PI_WATCHDOG_E2E_TARBALL;
	if (!tarball)
		throw new Error(
			"PI_WATCHDOG_E2E_TARBALL is required; run E2E through scripts/e2e/run-tests.mjs",
		);
	const installRoot = path.join(base, "installed-artifact");
	await mkdir(installRoot, { recursive: true });
	const extensionUtilsTarball = process.env.PI_EXTENSION_UTILS_E2E_TARBALL;
	const installTargets = extensionUtilsTarball
		? [`pi-extension-utils@${extensionUtilsTarball}`, tarball]
		: [tarball];
	const install = await runBoundedProcess(
		"npm",
		[
			"install",
			"--prefer-offline",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			// Packed E2E installs the watchdog as a tarball dependency, so its
			// reviewed Git dependency is transitive to this temporary root.
			// Production Git installs use the tracked allow-git=root policy.
			"--allow-git=all",
			"--prefix",
			installRoot,
			...installTargets,
		],
		{ timeoutMs: 120_000 },
	);
	if (install.status !== 0 || install.timedOut || install.error)
		throw new Error(
			`artifact install failed${install.timedOut ? " after timeout" : ""}:\n${install.stdout}\n${install.stderr}`,
		);
	const packagePath = await realpath(
		path.join(installRoot, "node_modules", "pi-reflect-watchdog"),
	);
	if (extensionUtilsTarball) {
		const override = await runBoundedProcess(
			"npm",
			[
				"install",
				"--ignore-scripts",
				"--no-save",
				"--prefix",
				packagePath,
				extensionUtilsTarball,
			],
			{ timeoutMs: 120_000 },
		);
		if (override.status !== 0 || override.timedOut || override.error)
			throw new Error(
				`pi-extension-utils override failed${override.timedOut ? " after timeout" : ""}:\n${override.stdout}\n${override.stderr}`,
			);
	}
	await writeJson(path.join(agentDir, "settings.json"), {
		packages: [packagePath],
		defaultProjectTrust: "never",
	});
	return { tarball, packagePath };
}

async function waitForChildExit(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = () => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", onExit);
	});
}

function processGroupExists(pid) {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		throw error;
	}
}

async function waitForProcessGroupExit(pid, timeoutMs) {
	const deadline = performance.now() + timeoutMs;
	while (processGroupExists(pid)) {
		if (performance.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return true;
}

function signalChild(child, signal, processGroup) {
	if (!Number.isInteger(child.pid)) return false;
	try {
		process.kill(processGroup ? -child.pid : child.pid, signal);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		throw error;
	}
}

/**
 * Terminates only a known child or, for a detached POSIX child, its exact
 * process group. Group cleanup also works after the leader has exited, which
 * is necessary when it left descendants holding inherited stdio open.
 */
export async function terminateChild(
	child,
	{ termTimeoutMs = 3_000, killTimeoutMs = 2_000, processGroup = false } = {},
) {
	const terminateGroup = processGroup && SUPPORTS_PROCESS_GROUPS;
	if (!terminateGroup && (child.exitCode !== null || child.signalCode !== null))
		return;
	if (!Number.isInteger(child.pid)) return;
	const waitForExit = (timeoutMs) =>
		terminateGroup
			? waitForProcessGroupExit(child.pid, timeoutMs)
			: waitForChildExit(child, timeoutMs);
	if (!signalChild(child, "SIGTERM", terminateGroup)) return;
	if (await waitForExit(termTimeoutMs)) return;
	signalChild(child, "SIGKILL", terminateGroup);
	if (!(await waitForExit(killTimeoutMs))) {
		const target = terminateGroup
			? `process group ${child.pid}`
			: `process ${child.pid}`;
		throw new Error(`${target} did not exit after SIGKILL`);
	}
}

/**
 * Runs a bounded disposable command in its own process group. A timeout kills
 * its full descendant tree and waits for that group before returning.
 */
export async function runBoundedProcess(
	command,
	args,
	{
		cwd,
		env,
		stdio = ["ignore", "pipe", "pipe"],
		timeoutMs = 60_000,
		termTimeoutMs = 500,
		killTimeoutMs = 2_000,
	} = {},
) {
	const child = spawnIsolated(command, args, { cwd, env, stdio });
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	let settled = false;
	const completed = new Promise((resolve) => {
		const settle = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		child.once("error", (error) => settle({ error }));
		child.once("close", (status, signal) => settle({ status, signal }));
	});
	let timedOut = false;
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			resolve({ timedOut: true });
		}, timeoutMs);
	});
	const result = await Promise.race([completed, timeout]);
	clearTimeout(timer);
	// A test runner may leave descendants holding inherited stdio handles.
	// Sweep the exact detached group in all outcomes before returning.
	await terminateChild(child, {
		termTimeoutMs,
		killTimeoutMs,
		processGroup: true,
	});
	return { ...result, stdout, stderr, timedOut };
}

export class RpcPi {
	#closePromise;

	constructor({ cwd, env, args = [], executable = PI_BIN, launcherArgs }) {
		this.child = spawnIsolated(
			executable,
			launcherArgs ?? ["--mode", "rpc", "--no-session", "--no-tools", ...args],
			{
				cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.pending = new Map();
		this.events = [];
		this.stderr = "";
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk;
		});
		this.child.once("exit", () => {
			for (const [id, pending] of this.pending) {
				clearTimeout(pending.timer);
				pending.reject(
					new Error(
						`Pi RPC process exited before ${id}; stderr=${this.stderr}`,
					),
				);
			}
			this.pending.clear();
		});
		this.output = readline.createInterface({ input: this.child.stdout });
		this.output.on("line", (line) => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			this.events.push({ at: performance.now(), message });
			if (message.id && this.pending.has(message.id)) {
				const pending = this.pending.get(message.id);
				clearTimeout(pending.timer);
				pending.resolve(message);
				this.pending.delete(message.id);
			}
		});
	}

	request(command, timeoutMs = 10_000) {
		const id = command.id ?? crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`RPC timeout for ${command.type}; stderr=${this.stderr}`),
				);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	async waitFor(predicate, timeoutMs = 10_000) {
		const start = performance.now();
		while (performance.now() - start < timeoutMs) {
			const found = this.events.find((entry) =>
				predicate(entry.message, entry.at),
			);
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`RPC event timeout; stderr=${this.stderr}`);
	}

	close() {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = (async () => {
			try {
				if (!this.child.stdin.destroyed) this.child.stdin.end();
				await terminateChild(this.child, {
					termTimeoutMs: 500,
					killTimeoutMs: 1_000,
					processGroup: true,
				});
			} finally {
				this.output.close();
			}
		})();
		return this.#closePromise;
	}
}

export async function assertSingleWatchdogCommand(rpc, expectedPath) {
	// Stock Pi startup can be slow on a loaded CI worker. This is still bounded
	// well below the E2E-runner deadline and keeps a cold process from failing
	// only because the RPC server was not ready within the usual request window.
	const response = await rpc.request({ type: "get_commands" }, 30_000);
	if (!response.success) throw new Error(JSON.stringify(response));
	const commands = response.data.commands.filter(
		(command) => command.name === "reflect",
	);
	if (commands.length !== 1)
		throw new Error(
			`Expected one reflect command, got ${commands.length}; commands=${JSON.stringify(response.data.commands.map((command) => command.name))}; stderr=${rpc.stderr}`,
		);
	const actual = await realpath(commands[0].sourceInfo.path);
	const expected = await realpath(expectedPath);
	if (actual !== expected)
		throw new Error(
			`Watchdog source mismatch: expected ${expected}, got ${actual}`,
		);
	return commands[0];
}

export { rm };
