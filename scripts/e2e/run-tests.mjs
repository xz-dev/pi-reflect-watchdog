#!/usr/bin/env node
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT, runBoundedProcess } from "./harness.mjs";

export const FAST_PATTERNS = [
	"test/e2e/distribution.test.mjs",
	"test/e2e/process-domain-cross-process.test.mjs",
	"test/e2e/tmux-security.test.mjs",
	"test/e2e/cleanup.test.mjs",
	"test/e2e/run-tests.test.mjs",
	"test/e2e/stock-pi-fast.test.mjs",
];

export function forcedFailureDiagnostic(step) {
	return `forced E2E failure: ${step}`;
}

async function runOrThrow(command, args, options, label) {
	const result = await runBoundedProcess(command, args, options);
	if (result.error)
		throw new Error(`${label} failed to start`, { cause: result.error });
	if (result.timedOut)
		throw new Error(`${label} exceeded its ${options.timeoutMs}ms timeout`);
	if (result.status !== 0)
		throw new Error(
			`${label} failed with status ${result.status ?? "unknown"}:\n${result.stderr}`,
		);
	return result;
}

export async function runE2eSuite(
	mode = "all",
	{ failureStep = process.env.PI_WATCHDOG_E2E_FORCE_FAILURE } = {},
) {
	const patterns = mode === "fast" ? FAST_PATTERNS : ["test/e2e/*.test.mjs"];
	const temporary = await mkdtemp(
		path.join("/tmp", "pi-reflect-watchdog-e2e-suite-"),
	);
	const artifactDirectory = path.join(temporary, "artifact");
	try {
		if (failureStep === "build")
			throw new Error(forcedFailureDiagnostic("build"));
		await runOrThrow(
			"npm",
			["run", "build"],
			{ cwd: ROOT, stdio: "inherit", timeoutMs: 60_000 },
			"suite build",
		);
		if (failureStep === "pack")
			throw new Error(forcedFailureDiagnostic("pack"));
		await mkdir(artifactDirectory);
		const pack = await runOrThrow(
			process.execPath,
			[path.join(ROOT, "scripts", "pack.mjs"), artifactDirectory],
			{ cwd: ROOT, timeoutMs: 60_000 },
			"suite pack",
		);
		const tarball = pack.stdout.trim().split(/\r?\n/).at(-1);
		if (!tarball) throw new Error("suite pack did not report a tarball");
		let extensionUtilsTarball = process.env.PI_EXTENSION_UTILS_E2E_TARBALL;
		if (!extensionUtilsTarball) {
			const utilityPack = await runOrThrow(
				"npm",
				[
					"pack",
					"--json",
					"--pack-destination",
					temporary,
					path.join(ROOT, "node_modules", "pi-extension-utils"),
				],
				{ cwd: ROOT, timeoutMs: 60_000 },
				"pi-extension-utils pack",
			);
			const packed = JSON.parse(utilityPack.stdout);
			const metadata = Array.isArray(packed)
				? packed[0]
				: Object.values(packed)[0];
			if (!metadata?.filename)
				throw new Error("pi-extension-utils pack did not report a tarball");
			extensionUtilsTarball = path.join(temporary, metadata.filename);
		}
		if (failureStep === "tests")
			throw new Error(forcedFailureDiagnostic("tests"));
		await runOrThrow(
			process.execPath,
			["--test", "--test-concurrency=1", ...patterns],
			{
				cwd: ROOT,
				env: {
					...process.env,
					PI_WATCHDOG_E2E_TARBALL: tarball,
					PI_EXTENSION_UTILS_E2E_TARBALL: extensionUtilsTarball,
				},
				stdio: "inherit",
				// The full suite includes stock-Pi startup, Git installation, a real
				// one-minute warning, and a pseudo-TTY test. It is bounded but needs
				// headroom for a slow CI worker to finish orderly cleanup.
				timeoutMs: mode === "fast" ? 600_000 : 900_000,
			},
			"E2E tests",
		);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await runE2eSuite(process.argv[2] ?? "all");
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
