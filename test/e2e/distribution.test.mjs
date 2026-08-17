import assert from "node:assert/strict";
import {
	mkdir,
	readFile,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	releaseBuildUsage,
	releaseOutputFromArgs,
	runReleaseBuild,
} from "../../scripts/build-release.mjs";
import {
	assertSafeOutputPath,
	createPackStage,
	createReleaseTree,
	listTree,
	PACK_ALLOWLIST,
	RELEASE_ALLOWLIST,
} from "../../scripts/distribution.mjs";
import { createCompleteSourceFixture } from "../../scripts/e2e/git-fixture.mjs";
import { createTestResources } from "../../scripts/e2e/harness.mjs";

const thisFile = fileURLToPath(import.meta.url);
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";

async function createSourceFixture(t) {
	const { base } = await createTestResources(
		t,
		"pi-reflect-watchdog-distribution-",
	);
	const root = await createCompleteSourceFixture(base);
	return { base, root };
}

test("distribution tests never pass a real-project-derived output to createReleaseTree", async () => {
	const source = await readFile(thisFile, "utf8");
	const calls = source.match(/createReleaseTree\(\{[^}]+\}\)/gs) ?? [];
	assert.ok(calls.length > 0, "test file contains release-tree coverage");
	for (const call of calls) {
		assert.match(call, /\broot:\s*fixture\.root\b/);
		assert.doesNotMatch(
			call,
			/\boutputDirectory:\s*(?:projectRoot|path\.(?:dirname|parse)\(projectRoot\))/,
		);
	}
});

test("release build requires an explicit absolute output directory", () => {
	assert.match(releaseBuildUsage(), /--output <absolute-directory>/);
	assert.throws(
		() => releaseOutputFromArgs([]),
		/A release output directory is required/,
	);
	assert.throws(
		() => releaseOutputFromArgs(["--output", "relative-release"]),
		/absolute directory/,
	);
});

test("release build writes only an explicit external destination", async (t) => {
	const fixture = await createSourceFixture(t);
	const outputDirectory = path.join(fixture.base, "release-output");
	const sourceManifest = await readFile(
		path.join(fixture.root, "package.json"),
		"utf8",
	);
	const generated = await runReleaseBuild(["--output", outputDirectory], {
		root: fixture.root,
		sourceCommit,
	});
	assert.equal(generated, outputDirectory);
	assert.deepEqual(await listTree(outputDirectory), RELEASE_ALLOWLIST);
	assert.equal(
		await readFile(path.join(fixture.root, "package.json"), "utf8"),
		sourceManifest,
		"the source fixture is untouched by generation",
	);
});

test("master metadata targets the exact stock Pi Node floor and TypeScript source", async (t) => {
	const fixture = await createSourceFixture(t);
	const manifest = JSON.parse(
		await readFile(path.join(fixture.root, "package.json"), "utf8"),
	);
	assert.equal(manifest.engines?.node, ">=22.14.0");
	assert.deepEqual(manifest.pi?.extensions, ["./src/extension.ts"]);
});

test("pack staging rewrites only the staged manifest to dist", async (t) => {
	const fixture = await createSourceFixture(t);
	const stage = path.join(fixture.base, "pack");
	await createPackStage({ root: fixture.root, outputDirectory: stage });
	const manifest = JSON.parse(
		await readFile(path.join(stage, "package.json"), "utf8"),
	);
	assert.deepEqual(manifest.pi?.extensions, ["./dist/extension.js"]);
	assert.deepEqual(await listTree(stage), PACK_ALLOWLIST);
	const sourceManifest = JSON.parse(
		await readFile(path.join(fixture.root, "package.json"), "utf8"),
	);
	assert.deepEqual(sourceManifest.pi?.extensions, ["./src/extension.ts"]);
});

test("release validation rejects fixture root and ancestor without mutation", async (t) => {
	const fixture = await createSourceFixture(t);
	for (const outputDirectory of [fixture.root, fixture.base]) {
		await assert.rejects(
			() =>
				createReleaseTree({
					root: fixture.root,
					outputDirectory,
					sourceCommit,
				}),
			/unsafe|owned|output/i,
		);
	}
	assert.equal(
		JSON.parse(await readFile(path.join(fixture.root, "package.json"), "utf8"))
			.name,
		"pi-reflect-watchdog",
	);
});

test("side-effect-free path validation rejects the absolute filesystem root", async (t) => {
	const fixture = await createSourceFixture(t);
	const filesystemRoot = path.parse(fixture.root).root;
	await assert.rejects(
		() => assertSafeOutputPath(fixture.root, filesystemRoot),
		/unsafe|repository-root/i,
	);
	assert.equal(
		JSON.parse(await readFile(path.join(fixture.root, "package.json"), "utf8"))
			.name,
		"pi-reflect-watchdog",
	);
});

test("release validation rejects a symbolic link at every output-path component without touching targets", async (t) => {
	const fixture = await createSourceFixture(t);
	const target = path.join(fixture.base, "target");
	await mkdir(target, { recursive: true });
	await writeFile(path.join(target, "keep.txt"), "keep\n");

	const directAncestor = path.join(fixture.base, "direct-link");
	const nestedParent = path.join(fixture.base, "nested");
	const nestedAncestor = path.join(nestedParent, "inner-link");
	const outputLink = path.join(fixture.base, "output-link");
	await mkdir(nestedParent);
	await symlink(target, directAncestor);
	await symlink(target, nestedAncestor);
	await symlink(target, outputLink);

	for (const outputDirectory of [
		path.join(directAncestor, "release"),
		path.join(nestedAncestor, "release"),
		outputLink,
	]) {
		await assert.rejects(
			() =>
				createReleaseTree({
					root: fixture.root,
					outputDirectory,
					sourceCommit,
				}),
			/symbolic link|unsafe/i,
		);
	}
	assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "keep\n");
});

test("release tree is minimal, deterministic, and records source provenance", async (t) => {
	const fixture = await createSourceFixture(t);
	const first = path.join(fixture.base, "first");
	const second = path.join(fixture.base, "second");
	await createReleaseTree({
		root: fixture.root,
		outputDirectory: first,
		sourceCommit,
	});
	await createReleaseTree({
		root: fixture.root,
		outputDirectory: second,
		sourceCommit,
	});
	assert.deepEqual(await listTree(first), RELEASE_ALLOWLIST);
	assert.deepEqual(await listTree(second), RELEASE_ALLOWLIST);
	for (const relative of RELEASE_ALLOWLIST) {
		assert.equal(
			await readFile(path.join(first, relative), "utf8"),
			await readFile(path.join(second, relative), "utf8"),
		);
	}
	const manifest = JSON.parse(
		await readFile(path.join(first, "package.json"), "utf8"),
	);
	assert.deepEqual(manifest.pi?.extensions, ["./dist/extension.js"]);
	assert.equal(manifest.scripts, undefined);
	assert.equal(manifest.devDependencies, undefined);
	assert.equal(manifest.files, undefined);
	assert.deepEqual(
		JSON.parse(await readFile(path.join(first, "provenance.json"), "utf8")),
		{
			owner: "pi-reflect-watchdog-release-tree-v1",
			source: "master",
			commit: sourceCommit,
		},
	);
	assert.equal(await realpath(first), first);
});
