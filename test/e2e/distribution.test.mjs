import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
	assertSafeOutputPath,
	createPackStage,
	listTree,
	PACK_ALLOWLIST,
} from "../../scripts/distribution.mjs";
import { createCompleteSourceFixture } from "../../scripts/e2e/git-fixture.mjs";
import { createTestResources } from "../../scripts/e2e/harness.mjs";

async function createSourceFixture(t) {
	const { base } = await createTestResources(
		t,
		"pi-reflect-watchdog-distribution-",
	);
	const root = await createCompleteSourceFixture(base);
	return { base, root };
}

test("master metadata targets the exact stock Pi Node floor and TypeScript source", async (t) => {
	const fixture = await createSourceFixture(t);
	const manifest = JSON.parse(
		await readFile(path.join(fixture.root, "package.json"), "utf8"),
	);
	assert.equal(manifest.engines?.node, ">=22.19.0");
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
	assert.equal(
		await readFile(path.join(stage, "dist", "fatal-exit.js"), "utf8"),
		await readFile(path.join(fixture.root, "dist", "fatal-exit.js"), "utf8"),
	);
	assert.equal(
		await readFile(path.join(stage, "dist", "fatal-exit.d.ts"), "utf8"),
		await readFile(path.join(fixture.root, "dist", "fatal-exit.d.ts"), "utf8"),
	);
	const sourceManifest = JSON.parse(
		await readFile(path.join(fixture.root, "package.json"), "utf8"),
	);
	assert.deepEqual(sourceManifest.pi?.extensions, ["./src/extension.ts"]);
});

test("pack output rejects source root and ancestor without mutation", async (t) => {
	const fixture = await createSourceFixture(t);
	for (const outputDirectory of [fixture.root, fixture.base]) {
		await assert.rejects(
			() =>
				createPackStage({
					root: fixture.root,
					outputDirectory,
				}),
			/unsafe|output/i,
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

test("pack output rejects a symbolic link at every path component without touching targets", async (t) => {
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
		path.join(directAncestor, "pack"),
		path.join(nestedAncestor, "pack"),
		outputLink,
	]) {
		await assert.rejects(
			() =>
				createPackStage({
					root: fixture.root,
					outputDirectory,
				}),
			/symbolic link|unsafe/i,
		);
	}
	assert.equal(await readFile(path.join(target, "keep.txt"), "utf8"), "keep\n");
});
