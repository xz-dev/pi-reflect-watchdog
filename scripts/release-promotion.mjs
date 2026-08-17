#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	assertAllowlist,
	createReleaseTree,
	RELEASE_ALLOWLIST,
} from "./distribution.mjs";

export function planReleasePromotion({
	expectedRemote,
	actualRemote,
	generatedTree,
	remoteTree,
}) {
	if (expectedRemote !== actualRemote) {
		throw new Error(
			`Remote release changed: expected ${expectedRemote ?? "absent"}, found ${actualRemote ?? "absent"}`,
		);
	}
	if (actualRemote !== null && generatedTree === remoteTree)
		return { action: "noop", parent: actualRemote };
	return { action: "create", parent: actualRemote };
}

function git(args, options = {}) {
	return execFileSync("git", args, {
		encoding: "utf8",
		stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		...options,
	}).trim();
}

function resolveGitDirectory(root) {
	return path.resolve(root, git(["rev-parse", "--git-dir"], { cwd: root }));
}

function remoteHead(root, remote, branch) {
	const text = git(["ls-remote", "--heads", remote, `refs/heads/${branch}`], {
		cwd: root,
	});
	return text ? text.split(/\s+/)[0] : null;
}

function assertSourceHead(root, remote, sourceBranch, intendedSource) {
	const actual = remoteHead(root, remote, sourceBranch);
	if (actual !== intendedSource) {
		throw new Error(
			`Stale source: remote ${remote}/${sourceBranch} does not match intended source HEAD; expected ${intendedSource}, found ${actual ?? "absent"}`,
		);
	}
}

export async function promoteRelease({
	root,
	remote = "origin",
	sourceBranch = "master",
	branch = "release",
	push = true,
	candidateRef,
} = {}) {
	if (!root) throw new Error("root is required");
	const sourceCommit = git(["rev-parse", "HEAD^{commit}"], { cwd: root });
	assertSourceHead(root, remote, sourceBranch, sourceCommit);

	let expectedRemote = null;
	try {
		git(
			[
				"fetch",
				"--no-tags",
				remote,
				`+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
			],
			{ cwd: root },
		);
		expectedRemote = git(
			["rev-parse", `refs/remotes/${remote}/${branch}^{commit}`],
			{ cwd: root },
		);
	} catch {
		if (remoteHead(root, remote, branch))
			throw new Error(`Could not fetch existing remote ${remote}/${branch}`);
	}

	const temporary = await mkdtemp(
		path.join(os.tmpdir(), "pi-reflect-watchdog-release-"),
	);
	const generated = path.join(temporary, "tree");
	const index = path.join(temporary, "index");
	try {
		await createReleaseTree({ root, outputDirectory: generated, sourceCommit });
		await assertAllowlist(generated, RELEASE_ALLOWLIST);
		git(["read-tree", "--empty"], {
			cwd: root,
			env: { ...process.env, GIT_INDEX_FILE: index },
		});
		git(["add", "--all", "--", "."], {
			cwd: generated,
			env: {
				...process.env,
				GIT_DIR: resolveGitDirectory(root),
				GIT_WORK_TREE: generated,
				GIT_INDEX_FILE: index,
			},
		});
		const generatedTree = git(["write-tree"], {
			cwd: root,
			env: { ...process.env, GIT_INDEX_FILE: index },
		});
		const remoteTree = expectedRemote
			? git(["rev-parse", `${expectedRemote}^{tree}`], { cwd: root })
			: null;
		const actualRemote = remoteHead(root, remote, branch);
		const plan = planReleasePromotion({
			expectedRemote,
			actualRemote,
			generatedTree,
			remoteTree,
		});
		assertSourceHead(root, remote, sourceBranch, sourceCommit);
		if (plan.action === "noop")
			return { action: "noop", oid: expectedRemote, sourceCommit };

		const commitArgs = ["commit-tree", generatedTree];
		if (plan.parent) commitArgs.push("-p", plan.parent);
		const oid = git(commitArgs, {
			cwd: root,
			input: `chore(release): generate from ${sourceBranch} ${sourceCommit.slice(0, 12)}\n`,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "github-actions[bot]",
				GIT_AUTHOR_EMAIL:
					"41898282+github-actions[bot]@users.noreply.github.com",
				GIT_COMMITTER_NAME: "github-actions[bot]",
				GIT_COMMITTER_EMAIL:
					"41898282+github-actions[bot]@users.noreply.github.com",
			},
		});
		if (candidateRef) git(["update-ref", candidateRef, oid], { cwd: root });
		if (push) {
			assertSourceHead(root, remote, sourceBranch, sourceCommit);
			const finalRemote = remoteHead(root, remote, branch);
			if (finalRemote !== actualRemote) {
				throw new Error(
					`Remote release changed before push: expected ${actualRemote ?? "absent"}, found ${finalRemote ?? "absent"}`,
				);
			}
			git(["push", remote, `${oid}:refs/heads/${branch}`], { cwd: root });
		}
		return { action: "create", oid, parent: plan.parent, sourceCommit };
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const result = await promoteRelease({
		root,
		remote: process.env.PI_WATCHDOG_REMOTE ?? "origin",
		sourceBranch: process.env.PI_WATCHDOG_SOURCE_BRANCH ?? "master",
		branch: process.env.PI_WATCHDOG_RELEASE_BRANCH ?? "release",
		candidateRef: process.env.PI_WATCHDOG_CANDIDATE_REF,
		push: process.env.PI_WATCHDOG_NO_PUSH !== "1",
	});
	console.log(JSON.stringify(result));
}
