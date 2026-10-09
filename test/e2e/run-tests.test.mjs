import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { forcedFailureDiagnostic } from "../../scripts/e2e/run-tests.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

async function missing(target) {
	try {
		await access(target);
		return false;
	} catch {
		return true;
	}
}

test("E2E runner and fixture roots honor TMPDIR and clean success/failure allocations", {
	timeout: 15_000,
}, async () => {
	const temporary = await mkdtemp(
		path.join(os.tmpdir(), "watchdog-tmpdir-test-"),
	);
	try {
		const env = { ...process.env, TMPDIR: temporary };
		const result = await execFileAsync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
			import { createTestResources } from './scripts/e2e/harness.mjs';
			const resources = await createTestResources(null, 'fixture-tmpdir-');
			console.log(resources.base);
			await resources.cleanup();
		`,
			],
			{ cwd: root, env, timeout: 10_000 },
		);
		assert.equal(path.dirname(result.stdout.trim()), temporary);
		assert.equal(await missing(result.stdout.trim()), true);
		await assert.rejects(
			execFileAsync(process.execPath, ["scripts/e2e/run-tests.mjs", "fast"], {
				cwd: root,
				env: { ...env, PI_WATCHDOG_E2E_FORCE_FAILURE: "build" },
				timeout: 10_000,
			}),
			(error) => {
				assert.match(error.stderr, /forced E2E failure: build/);
				return true;
			},
		);
		assert.deepEqual(await readdir(temporary), []);
		// A missing selected parent must fail before the build branch.
		await assert.rejects(
			execFileAsync(process.execPath, ["scripts/e2e/run-tests.mjs", "fast"], {
				cwd: root,
				env: {
					...env,
					TMPDIR: path.join(temporary, "missing"),
					PI_WATCHDOG_E2E_FORCE_FAILURE: "build",
				},
				timeout: 10_000,
			}),
			(error) => {
				assert.match(error.stderr, /ENOENT/);
				assert.doesNotMatch(error.stderr, /forced E2E failure/);
				return true;
			},
		);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("forced E2E failure uses the standardized environment name and cleans its suite root", {
	timeout: 15_000,
}, async () => {
	const before = new Set(
		(await readdir(os.tmpdir())).filter((name) =>
			name.startsWith("pi-reflect-watchdog-e2e-suite-"),
		),
	);
	let outcome;
	try {
		await execFileAsync(
			process.execPath,
			["scripts/e2e/run-tests.mjs", "fast"],
			{
				cwd: root,
				env: {
					...process.env,
					PI_WATCHDOG_E2E_FORCE_FAILURE: "build",
				},
				timeout: 10_000,
			},
		);
		assert.fail("forced failure unexpectedly exited zero");
	} catch (error) {
		outcome = error;
	}
	assert.notEqual(outcome.code, 0, "forced failure must be nonzero");
	assert.match(
		`${outcome.stdout}\n${outcome.stderr}`,
		new RegExp(forcedFailureDiagnostic("build")),
	);
	const after = (await readdir(os.tmpdir())).filter((name) =>
		name.startsWith("pi-reflect-watchdog-e2e-suite-"),
	);
	for (const name of after.filter((name) => !before.has(name)))
		assert.equal(
			await missing(path.join(os.tmpdir(), name)),
			true,
			"forced failure leaves no new suite directory",
		);
});
