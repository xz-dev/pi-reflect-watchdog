import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PrivateForkInput } from "pi-extension-utils/private-inquiry";
import { createReflectionDriver } from "./fixtures/private-reflection-driver.js";

test("driver abort during result-file read settles the pending prompt", async () => {
	const directory = await mkdtemp(
		join(
			process.platform === "win32" ? tmpdir() : "/var/tmp",
			"reflect-driver-abort-",
		),
	);
	try {
		const resultFile = join(directory, "result.json");
		await writeFile(resultFile, "{}");
		const driver = createReflectionDriver();
		const runtime = await driver.service.createRuntime();
		// This fake fork consumes only resultFile; no SDK session is constructed.
		const child = await runtime.fork({ resultFile } as PrivateForkInput);
		const prompt = child.prompt("read then wait");
		const rejected = assert.rejects(prompt, { name: "AbortError" });
		await child.abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				rejected,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("aborted prompt stayed parked")),
						250,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
		assert.equal(driver.waiting.length, 0);
		await child.dispose();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
