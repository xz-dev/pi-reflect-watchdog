import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

const ROOT_FILES = ["LICENSE", "README.md"];
const DIST_FILES = [
	"activity.d.ts",
	"activity.js",
	"config-loader.d.ts",
	"config-loader.js",
	"config.d.ts",
	"config.js",
	"controller.d.ts",
	"controller.js",
	"controls.d.ts",
	"controls.js",
	"extension.d.ts",
	"extension.js",
	"hub.d.ts",
	"hub.js",
	"process-domain.d.ts",
	"process-domain.js",
	"reflection-history.d.ts",
	"reflection-history.js",
	"reflection-protocol.d.ts",
	"reflection-protocol.js",
	"reflection-timeline.d.ts",
	"reflection-timeline.js",
	"fatal-exit.d.ts",
	"fatal-exit.js",
	"index.d.ts",
	"index.js",
	"prompts.d.ts",
	"prompts.js",
	"widget.d.ts",
	"widget.js",
];

const RELEASE_OWNER = "pi-reflect-watchdog-release-tree-v1";

export const PACK_ALLOWLIST = [
	...ROOT_FILES,
	"package.json",
	...DIST_FILES.map((name) => `dist/${name}`),
].sort();
export const RELEASE_ALLOWLIST = [
	...PACK_ALLOWLIST,
	".npmrc",
	"package-lock.json",
	"provenance.json",
].sort();

function stableJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function distManifest(source) {
	const manifest = structuredClone(source);
	manifest.pi = { ...manifest.pi, extensions: ["./dist/extension.js"] };
	return manifest;
}

function releaseManifest(source) {
	const manifest = distManifest(source);
	delete manifest.scripts;
	delete manifest.devDependencies;
	delete manifest.files;
	return manifest;
}

function releaseLock(source, manifest) {
	const lock = structuredClone(source);
	lock.packages[""] = {
		name: manifest.name,
		version: manifest.version,
		license: manifest.license,
		dependencies: manifest.dependencies,
		engines: manifest.engines,
		peerDependencies: manifest.peerDependencies,
	};
	return lock;
}

function contains(parent, child) {
	const relative = path.relative(parent, child);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== "..")
	);
}

async function pathExists(target) {
	try {
		await lstat(target);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

function lexicalPathComponents(target) {
	const resolved = path.resolve(target);
	const { root } = path.parse(resolved);
	const relative = path.relative(root, resolved);
	const components = [root];
	let current = root;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		components.push(current);
	}
	return components;
}

/**
 * Verifies an output path without creating, deleting, or renaming anything.
 * Every existing lexical component is inspected with lstat so a symlink cannot
 * hide beneath an already-existing output directory.
 */
export async function assertSafeOutputPath(root, outputDirectory) {
	const canonicalRoot = await realpath(root);
	const resolvedOutput = path.resolve(outputDirectory);
	let outputMetadata;
	for (const component of lexicalPathComponents(resolvedOutput)) {
		const metadata = await lstat(component).catch((error) => {
			if (error?.code === "ENOENT") return undefined;
			throw error;
		});
		if (metadata?.isSymbolicLink())
			throw new Error(
				`Unsafe output path contains a symbolic link: ${component}`,
			);
		if (component === resolvedOutput) outputMetadata = metadata;
	}

	let existing = resolvedOutput;
	while (!(await pathExists(existing))) {
		const parent = path.dirname(existing);
		if (parent === existing)
			throw new Error(
				`Unsafe output path has no existing parent: ${resolvedOutput}`,
			);
		existing = parent;
	}
	const canonicalParent = await realpath(existing);
	const canonicalOutput = outputMetadata
		? await realpath(resolvedOutput)
		: path.resolve(canonicalParent, path.relative(existing, resolvedOutput));
	if (
		contains(canonicalRoot, canonicalOutput) ||
		contains(canonicalOutput, canonicalRoot)
	) {
		throw new Error(
			`Unsafe output path has a repository-root relationship: ${resolvedOutput}`,
		);
	}
	if (outputMetadata && !outputMetadata.isDirectory())
		throw new Error(`Output path is not a directory: ${resolvedOutput}`);
	return resolvedOutput;
}

async function assertReplaceableReleaseOutput(outputDirectory) {
	if (!(await pathExists(outputDirectory))) return;
	const entries = await readdir(outputDirectory);
	if (entries.length === 0) return;
	let provenance;
	try {
		provenance = JSON.parse(
			await readFile(path.join(outputDirectory, "provenance.json"), "utf8"),
		);
	} catch {
		throw new Error(
			`Refusing to replace nonempty output without the pi-reflect-watchdog ownership sentinel: ${outputDirectory}`,
		);
	}
	if (provenance?.owner !== RELEASE_OWNER) {
		throw new Error(
			`Refusing to replace nonempty output without the pi-reflect-watchdog ownership sentinel: ${outputDirectory}`,
		);
	}
}

async function copyPayload(root, outputDirectory) {
	await mkdir(path.join(outputDirectory, "dist"), { recursive: true });
	for (const name of ROOT_FILES)
		await cp(path.join(root, name), path.join(outputDirectory, name));
	for (const name of DIST_FILES)
		await cp(
			path.join(root, "dist", name),
			path.join(outputDirectory, "dist", name),
		);
}

async function sourceManifest(root) {
	return JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
}

async function replaceWithStagedDirectory(outputDirectory, stage) {
	const existed = await pathExists(outputDirectory);
	if (!existed) {
		await rename(stage, outputDirectory);
		return;
	}
	const backup = `${outputDirectory}.previous-${crypto.randomUUID()}`;
	await rename(outputDirectory, backup);
	try {
		await rename(stage, outputDirectory);
	} catch (error) {
		await rename(backup, outputDirectory);
		throw error;
	}
	await rm(backup, { recursive: true, force: true });
}

export async function createPackStage({ root, outputDirectory }) {
	const safeOutput = await assertSafeOutputPath(root, outputDirectory);
	if (await pathExists(safeOutput)) {
		if ((await readdir(safeOutput)).length > 0)
			throw new Error(
				`Pack output must be an absent or empty staging directory: ${safeOutput}`,
			);
		await rm(safeOutput, { recursive: true });
	}
	const stage = await mkdtemp(
		path.join(path.dirname(safeOutput), `.${path.basename(safeOutput)}.tmp-`),
	);
	try {
		await copyPayload(root, stage);
		await writeFile(
			path.join(stage, "package.json"),
			stableJson(distManifest(await sourceManifest(root))),
		);
		await rename(stage, safeOutput);
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
	return safeOutput;
}

export async function createReleaseTree({
	root,
	outputDirectory,
	sourceCommit,
}) {
	if (!/^[0-9a-f]{40}$/.test(sourceCommit))
		throw new Error("sourceCommit must be a full 40-character Git OID");
	const safeOutput = await assertSafeOutputPath(root, outputDirectory);
	await assertReplaceableReleaseOutput(safeOutput);
	await mkdir(path.dirname(safeOutput), { recursive: true });
	const stage = await mkdtemp(
		path.join(path.dirname(safeOutput), `.${path.basename(safeOutput)}.tmp-`),
	);
	try {
		await copyPayload(root, stage);
		await cp(path.join(root, ".npmrc"), path.join(stage, ".npmrc"));
		const manifest = releaseManifest(await sourceManifest(root));
		const sourceLock = JSON.parse(
			await readFile(path.join(root, "package-lock.json"), "utf8"),
		);
		await writeFile(
			path.join(stage, "package-lock.json"),
			stableJson(releaseLock(sourceLock, manifest)),
		);
		await writeFile(path.join(stage, "package.json"), stableJson(manifest));
		await writeFile(
			path.join(stage, "provenance.json"),
			stableJson({
				owner: RELEASE_OWNER,
				source: "master",
				commit: sourceCommit,
			}),
		);
		await replaceWithStagedDirectory(safeOutput, stage);
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
	return safeOutput;
}

export async function listTree(directory) {
	const files = [];
	async function visit(current, prefix = "") {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory())
				await visit(path.join(current, entry.name), relative);
			else if (entry.isFile()) files.push(relative);
		}
	}
	await visit(directory);
	return files.sort();
}

export async function assertAllowlist(directory, expected) {
	const actual = await listTree(directory);
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`Unexpected distribution tree:\n${actual.join("\n")}`);
	}
	for (const relative of actual) {
		const metadata = await stat(path.join(directory, relative));
		if (!metadata.isFile())
			throw new Error(`Distribution entry is not a file: ${relative}`);
	}
}
