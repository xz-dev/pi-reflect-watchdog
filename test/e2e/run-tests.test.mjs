import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
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

test("forced E2E failure uses the standardized environment name and cleans its suite root", {
	timeout: 15_000,
}, async () => {
	const before = new Set(
		(await readdir(os.tmpdir())).filter((name) =>
			name.startsWith("pi-watchdog-e2e-suite-"),
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
		name.startsWith("pi-watchdog-e2e-suite-"),
	);
	for (const name of after.filter((name) => !before.has(name)))
		assert.equal(
			await missing(path.join("/tmp", name)),
			true,
			"forced failure leaves no new suite directory",
		);
});
