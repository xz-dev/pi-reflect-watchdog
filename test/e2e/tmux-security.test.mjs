import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createTestResources } from "../../scripts/e2e/harness.mjs";
import { assertTmux, TmuxPi } from "../../scripts/e2e/tmux.mjs";

async function missing(file) {
	try {
		await access(file);
		return false;
	} catch {
		return true;
	}
}

test("tmux argv and environment preserve shell metacharacters literally", async (t) => {
	assert.match(assertTmux(), /^tmux /);
	const resources = await createTestResources(t, "pi-watchdog-tmux-security-");
	const { base } = resources;
	const marker = path.join(base, "marker");
	const output = path.join(base, "output.json");
	const values = [
		`$(touch ${marker})`,
		`\`touch ${marker}\``,
		"$HOME",
		"single'quote",
		'double"quote',
		"line one\nline two",
	];
	const name = `pi-watchdog-security-${process.pid}-${Date.now()}`;
	const tui = new TmuxPi({
		name,
		cwd: base,
		env: { WATCHDOG_LITERAL: values.join("|") },
		executable: process.execPath,
		args: [
			"-e",
			`require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({env:process.env.WATCHDOG_LITERAL,args:process.argv.slice(1)}))`,
			...values,
		],
	});
	resources.add(() => tui.close());
	await tui.waitForExit();
	assert.equal(
		await missing(marker),
		true,
		"shell substitutions never execute",
	);
	assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
		env: values.join("|"),
		args: values,
	});
});

test("tmux rejects invalid environment keys and NUL bytes", () => {
	assert.throws(
		() =>
			new TmuxPi({
				name: "invalid-key",
				cwd: "/tmp",
				env: { "BAD-KEY": "x" },
				executable: "true",
				args: [],
			}),
		/invalid environment key/i,
	);
	assert.throws(
		() =>
			new TmuxPi({
				name: "invalid-nul",
				cwd: "/tmp",
				env: { GOOD: "bad\0value" },
				executable: "true",
				args: [],
			}),
		/NUL/i,
	);
});
