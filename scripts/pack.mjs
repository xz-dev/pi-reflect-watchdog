#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	assertAllowlist,
	createPackStage,
	PACK_ALLOWLIST,
} from "./distribution.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.resolve(process.argv[2] ?? root);
const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-watchdog-pack-"));
try {
	await createPackStage({ root, outputDirectory: temporary });
	await assertAllowlist(temporary, PACK_ALLOWLIST);
	const output = execFileSync(
		"npm",
		["pack", "--json", "--pack-destination", outputDirectory],
		{
			cwd: temporary,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	const parsed = JSON.parse(output);
	const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	if (!result)
		throw new Error(`npm pack returned no artifact metadata: ${output}`);
	const actualFiles = result.files.map((entry) => entry.path).sort();
	if (JSON.stringify(actualFiles) !== JSON.stringify(PACK_ALLOWLIST)) {
		throw new Error(`npm pack allowlist mismatch:\n${actualFiles.join("\n")}`);
	}
	console.log(path.join(outputDirectory, result.filename));
} finally {
	await rm(temporary, { recursive: true, force: true });
}
