import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createCompleteSourceFixture } from "../../scripts/e2e/git-fixture.mjs";
import { createTestResources, ROOT } from "../../scripts/e2e/harness.mjs";
import { promoteRelease } from "../../scripts/release-promotion.mjs";

function git(args, cwd, options = {}) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		...options,
	}).trim();
}

async function repository(t) {
	const { base } = await createTestResources(t, "pi-watchdog-promotion-");
	const source = await createCompleteSourceFixture(base, "source");
	const remote = path.join(base, "remote.git");
	git(["init", "-b", "master"], source);
	git(["add", "-A"], source);
	git(
		[
			"-c",
			"user.name=E2E",
			"-c",
			"user.email=e2e@example.invalid",
			"commit",
			"-m",
			"source",
		],
		source,
	);
	git(["init", "--bare", remote], base);
	git(["remote", "add", "origin", remote], source);
	git(["push", "-u", "origin", "master"], source);
	return { base, source, remote };
}

test("promotion creates a root release, then a no-op, then a normal fast-forward child", async (t) => {
	const fixture = await repository(t);
	const first = await promoteRelease({ root: fixture.source });
	assert.equal(first.action, "create");
	assert.equal(first.parent, null);
	assert.equal(
		git(["rev-list", "--parents", "release", "-1"], fixture.remote).split(/\s+/)
			.length,
		1,
	);
	const noop = await promoteRelease({ root: fixture.source });
	assert.equal(noop.action, "noop");
	await cp(
		path.join(ROOT, "README.md"),
		path.join(fixture.source, "README.md"),
	);
	await appendFile(
		path.join(fixture.source, "README.md"),
		"\nfixture change\n",
	);
	git(["add", "README.md"], fixture.source);
	git(
		[
			"-c",
			"user.name=E2E",
			"-c",
			"user.email=e2e@example.invalid",
			"commit",
			"-m",
			"source change",
		],
		fixture.source,
	);
	git(["push", "origin", "master"], fixture.source);
	const second = await promoteRelease({ root: fixture.source });
	assert.equal(second.parent, first.oid);
	assert.equal(
		git(["merge-base", "--is-ancestor", first.oid, second.oid], fixture.remote),
		"",
	);
});

test("stale source checkout refuses after newer master and release promotion", async (t) => {
	const fixture = await repository(t);
	const first = await promoteRelease({ root: fixture.source });
	const newer = path.join(fixture.base, "newer");
	git(["clone", fixture.remote, newer], fixture.base);
	await appendFile(path.join(newer, "README.md"), "\nnewer source\n");
	git(["add", "README.md"], newer);
	git(
		[
			"-c",
			"user.name=E2E",
			"-c",
			"user.email=e2e@example.invalid",
			"commit",
			"-m",
			"newer source",
		],
		newer,
	);
	git(["push", "origin", "master"], newer);
	const second = await promoteRelease({ root: newer });
	assert.equal(second.parent, first.oid);
	const releaseBeforeStaleAttempt = git(
		["rev-parse", "release"],
		fixture.remote,
	);
	await assert.rejects(
		() => promoteRelease({ root: fixture.source }),
		/remote master.*does not match|stale source/i,
	);
	assert.equal(
		git(["rev-parse", "release"], fixture.remote),
		releaseBeforeStaleAttempt,
	);
});

test("promotion supports explicit remote and source/release branch names", async (t) => {
	const fixture = await repository(t);
	git(["branch", "-m", "master", "trunk"], fixture.source);
	git(["push", "origin", "trunk"], fixture.source);
	git(["remote", "rename", "origin", "canonical"], fixture.source);
	const result = await promoteRelease({
		root: fixture.source,
		remote: "canonical",
		sourceBranch: "trunk",
		branch: "generated",
	});
	assert.equal(result.action, "create");
	assert.equal(git(["rev-parse", "generated"], fixture.remote), result.oid);
});

test("promotion refuses a changed remote instead of force-pushing", async (t) => {
	const fixture = await repository(t);
	await promoteRelease({ root: fixture.source });
	const originalLsRemote = process.env.PATH;
	const bin = path.join(fixture.base, "bin");
	await mkdir(bin);
	const wrapper = path.join(bin, "git");
	await writeFile(
		wrapper,
		`#!/bin/sh\nif [ "$1" = ls-remote ] && [ "${"$"}4" = refs/heads/release ]; then exec /usr/bin/git "$@" | sed 's/^[0-9a-f]\\{40\\}/0000000000000000000000000000000000000000/'; fi\nexec /usr/bin/git "$@"\n`,
		{ mode: 0o755 },
	);
	process.env.PATH = `${bin}:${originalLsRemote}`;
	try {
		await assert.rejects(
			() => promoteRelease({ root: fixture.source, push: false }),
			/remote release changed/i,
		);
	} finally {
		process.env.PATH = originalLsRemote;
	}
});
