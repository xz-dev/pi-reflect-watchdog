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
// Pi loads the TypeScript entry through its own extension loader, which also
// transpiles the prepared private runtime; a compiled dist cannot.
const SOURCE_FILES = [
	"activity-types.ts",
	"branch-accounting.ts",
	"collection-state.ts",
	"config-loader.ts",
	"config.ts",
	"duration.ts",
	"extension.ts",
	"fatal-exit.ts",
	"hub.ts",
	"index.ts",
	"process-domain.ts",
	"prompts.ts",
	"reflection-protocol.ts",
	"widget.ts",
];

export const PACK_ALLOWLIST = [
	...ROOT_FILES,
	"package.json",
	...SOURCE_FILES.map((name) => `src/${name}`),
].sort();

function stableJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
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

async function copyPayload(root, outputDirectory) {
	await mkdir(path.join(outputDirectory, "src"), { recursive: true });
	for (const name of ROOT_FILES)
		await cp(path.join(root, name), path.join(outputDirectory, name));
	for (const name of SOURCE_FILES)
		await cp(
			path.join(root, "src", name),
			path.join(outputDirectory, "src", name),
		);
}

async function sourceManifest(root) {
	return JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
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
			stableJson(await sourceManifest(root)),
		);
		await rename(stage, safeOutput);
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
