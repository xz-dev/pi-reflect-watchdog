import { spawnSync } from "node:child_process";

function tmux(args, { timeout = 10_000, allowFailure = false } = {}) {
	const result = spawnSync("tmux", args, { encoding: "utf8", timeout });
	if (!allowFailure && result.status !== 0) {
		throw new Error(
			`tmux ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
		);
	}
	return result.stdout;
}

function shellLiteral(value, label) {
	const text = String(value);
	if (text.includes("\0")) throw new Error(`${label} contains NUL`);
	return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function environmentAssignments(env) {
	return Object.entries(env).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
			throw new Error(`Invalid environment key: ${key}`);
		return `${key}=${shellLiteral(value, `Environment value for ${key}`)}`;
	});
}

export function buildTmuxShellCommand({ cwd, env, executable, args }) {
	const command = [
		shellLiteral(executable, "Executable"),
		...args.map((argument) => shellLiteral(argument, "Argument")),
	].join(" ");
	const environment = environmentAssignments(env);
	return `cd ${shellLiteral(cwd, "Working directory")} && exec env ${environment.join(" ")} ${command}`;
}

export function assertTmux() {
	const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
	if (result.status !== 0)
		throw new Error("tmux is required for test:e2e; install tmux and retry");
	return result.stdout.trim();
}

export class TmuxPi {
	constructor({
		name,
		cwd,
		env = {},
		executable,
		args = [],
		width = 120,
		height = 34,
	}) {
		if (typeof executable !== "string" || executable.length === 0) {
			throw new Error(
				"TmuxPi requires an executable and argv; preformatted commands are not accepted",
			);
		}
		if (!Array.isArray(args)) throw new Error("TmuxPi args must be an array");
		this.name = name;
		const shellCommand = buildTmuxShellCommand({ cwd, env, executable, args });
		tmux([
			"new-session",
			"-d",
			"-s",
			name,
			"-x",
			String(width),
			"-y",
			String(height),
			shellCommand,
		]);
	}

	send(text, enter = true) {
		tmux(["send-keys", "-t", this.name, "-l", text]);
		if (enter) tmux(["send-keys", "-t", this.name, "Enter"]);
	}

	key(key) {
		tmux(["send-keys", "-t", this.name, key]);
	}

	capture(history = false) {
		return tmux([
			"capture-pane",
			"-p",
			"-t",
			this.name,
			...(history ? ["-S", "-"] : []),
		]);
	}

	async waitFor(pattern, timeoutMs = 10_000) {
		const start = performance.now();
		while (performance.now() - start < timeoutMs) {
			const capture = this.capture(true);
			if (pattern.test(capture)) return capture;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`tmux timeout for ${pattern}:\n${this.capture(true)}`);
	}

	exists() {
		return spawnSync("tmux", ["has-session", "-t", this.name]).status === 0;
	}

	async waitForExit(timeoutMs = 5_000) {
		const start = performance.now();
		while (this.exists() && performance.now() - start < timeoutMs) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (this.exists())
			throw new Error(
				`tmux session ${this.name} did not exit within ${timeoutMs}ms`,
			);
	}

	close() {
		tmux(["kill-session", "-t", this.name], { allowFailure: true });
	}
}
