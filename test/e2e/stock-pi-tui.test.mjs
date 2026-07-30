import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
	modelConfig,
	startFakeProvider,
} from "../../scripts/e2e/fake-provider.mjs";
import {
	assertStockPi,
	createIsolatedEnvironment,
	createTestResources,
	installPackedArtifact,
	PI_BIN,
	writeJson,
} from "../../scripts/e2e/harness.mjs";
import { assertTmux, TmuxPi } from "../../scripts/e2e/tmux.mjs";

function activeSeconds(capture) {
	const match = capture.match(/Watchdog \| active (\d+)s\/\d+ loops/);
	return match ? Number(match[1]) : undefined;
}

function count(text, pattern) {
	return [...text.matchAll(pattern)].length;
}

test("stock Pi TUI renders, ticks, commands, and automatic reset semantics", {
	timeout: 45_000,
}, async (t) => {
	assertStockPi();
	assert.match(assertTmux(), /^tmux /);
	const resources = await createTestResources(t, "pi-watchdog-tui-");
	const { base } = resources;
	const isolated = await createIsolatedEnvironment(base);
	await installPackedArtifact({ base, agentDir: isolated.agentDir });
	const provider = await startFakeProvider({
		slowMs: 3_200,
		holdAfterThresholdMs: 0,
	});
	resources.add(() => provider.close());
	await writeJson(
		path.join(isolated.agentDir, "models.json"),
		modelConfig(provider.baseUrl),
	);
	const name = `pi-watchdog-${process.pid}-${Date.now()}`;
	const tui = new TmuxPi({
		name,
		cwd: isolated.workspace,
		env: isolated.env,
		width: 120,
		height: 34,
		executable: PI_BIN,
		args: [
			"--no-session",
			"--no-tools",
			"--provider",
			"watchdog-fixture",
			"--model",
			"watchdog-fixture",
			"--approve",
		],
	});
	resources.add(() => tui.close());
	await tui.waitFor(/Watchdog \| idle/);

	tui.send("First real turn");
	const first = await tui.waitFor(/Watchdog \| active \d+s\/0 loops/);
	await new Promise((resolve) => setTimeout(resolve, 1_300));
	const second = tui.capture();
	assert.ok(
		(activeSeconds(second) ?? -1) > (activeSeconds(first) ?? -1),
		"below-editor active time redraws about once per second",
	);
	const settled = await tui.waitFor(
		/Watchdog reset \| active .*\/1 loops/,
		12_000,
	);
	assert.equal(
		count(settled, /Watchdog reset \| active /g),
		1,
		"automatic settle notification appears once",
	);

	tui.send("/watchdog status");
	await tui.waitFor(/Watchdog status/);
	tui.send("/watchdog reset");
	const manual = await tui.waitFor(
		/Watchdog task cycle reset\. Active window is unchanged\./,
	);
	assert.equal(
		count(manual, /Watchdog reset \| active /g),
		0,
		"manual reset emits no automatic reset notification",
	);

	tui.send("Second real turn");
	const twice = await tui.waitFor(
		/Watchdog reset \| active .*\/1 loops/,
		12_000,
	);
	assert.equal(
		count(twice, /Watchdog reset \| active /g),
		1,
		"the next settle emits exactly one automatic notification",
	);

	tui.key("C-d");
	await new Promise((resolve) => setTimeout(resolve, 300));
	if (tui.exists()) tui.key("C-d");
	const start = performance.now();
	while (tui.exists() && performance.now() - start < 5_000)
		await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(tui.exists(), false, "Pi exits cleanly from isolated tmux");
	await provider.close();
});
