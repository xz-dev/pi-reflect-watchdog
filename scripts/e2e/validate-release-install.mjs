#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	assertAllowlist,
	createReleaseTree,
	RELEASE_ALLOWLIST,
} from "../distribution.mjs";
import {
	createCompleteSourceFixture,
	createGitFixture,
	installGitPackage,
	managedGitPath,
} from "./git-fixture.mjs";
import {
	assertSingleWatchdogCommand,
	assertStockPi,
	createIsolatedEnvironment,
	createTestResources,
	ROOT,
	RpcPi,
} from "./harness.mjs";

function git(args) {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

export async function validateReleaseCandidate({
	sourceCommit = git(["rev-parse", "HEAD^{commit}"]),
} = {}) {
	assertStockPi();
	const resources = await createTestResources(
		undefined,
		"pi-watchdog-release-validation-",
	);
	const { base } = resources;
	const candidate = path.join(base, "candidate-release-tree");
	try {
		const source = await createCompleteSourceFixture(base, "candidate-source");
		await createReleaseTree({
			root: source,
			outputDirectory: candidate,
			sourceCommit,
		});
		await assertAllowlist(candidate, RELEASE_ALLOWLIST);
		const fixture = await createGitFixture(base, { releaseTree: candidate });
		resources.add(() => fixture.stop());
		const isolated = await createIsolatedEnvironment(
			path.join(base, "release-validation"),
		);
		await installGitPackage({
			source: fixture.releaseSource,
			cwd: isolated.workspace,
			env: isolated.env,
		});
		const managed = managedGitPath(isolated.agentDir);
		const rpc = new RpcPi({ cwd: isolated.workspace, env: isolated.env });
		resources.add(() => rpc.close());
		await assertSingleWatchdogCommand(
			rpc,
			path.join(managed, "dist", "extension.js"),
		);
		return { sourceCommit, releaseOid: fixture.releaseOid };
	} finally {
		await resources.cleanup();
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const result = await validateReleaseCandidate();
	console.log(
		`Validated newly generated local candidate ${result.sourceCommit} through stock Pi Git install.`,
	);
}
