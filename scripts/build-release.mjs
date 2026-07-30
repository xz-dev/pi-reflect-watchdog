#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	assertAllowlist,
	createReleaseTree,
	RELEASE_ALLOWLIST,
} from "./distribution.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function releaseBuildUsage() {
	return [
		"Usage: node scripts/build-release.mjs --output <absolute-directory>",
		"",
		"The release tree is generated only into an explicit directory outside the repository.",
	].join("\n");
}

export function releaseOutputFromArgs(args) {
	if (args.length !== 2 || args[0] !== "--output" || !args[1])
		throw new Error(
			`A release output directory is required.\n\n${releaseBuildUsage()}`,
		);
	if (!path.isAbsolute(args[1]))
		throw new Error(
			`Release output must be an absolute directory.\n\n${releaseBuildUsage()}`,
		);
	return path.resolve(args[1]);
}

export async function buildRelease({
	root: sourceRoot = root,
	outputDirectory,
	sourceCommit,
}) {
	const commit =
		sourceCommit ??
		process.env.PI_WATCHDOG_SOURCE_COMMIT ??
		execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: sourceRoot,
			encoding: "utf8",
		}).trim();
	const output = await createReleaseTree({
		root: sourceRoot,
		outputDirectory,
		sourceCommit: commit,
	});
	await assertAllowlist(output, RELEASE_ALLOWLIST);
	return output;
}

export async function runReleaseBuild(args, options = {}) {
	return buildRelease({
		...options,
		outputDirectory: releaseOutputFromArgs(args),
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.slice(2).includes("--help")) {
		console.log(releaseBuildUsage());
	} else {
		console.log(await runReleaseBuild(process.argv.slice(2)));
	}
}
