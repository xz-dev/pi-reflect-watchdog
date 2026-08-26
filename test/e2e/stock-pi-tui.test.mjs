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
	const match = capture.match(/Reflect Watchdog \| active (\d+)s\/\d+ loops/);
	return match ? Number(match[1]) : undefined;
}

test("stock Pi TUI renders, ticks, compacts, and freezes at idle", {
	timeout: 45_000,
}, async (t) => {
	assertStockPi();
	assert.match(assertTmux(), /^tmux /);
	const resources = await createTestResources(t, "pi-reflect-watchdog-tui-");
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
	const name = `pi-reflect-watchdog-${process.pid}-${Date.now()}`;
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
	await tui.waitFor(
		/Reflect Watchdog \| active 0s\/0 loops · task 0s\/30m · root 0\/100 · all 0\/500/,
	);

	tui.send("First real turn");
	const first = await tui.waitFor(/Reflect Watchdog \| active \d+s\/0 loops/);
	await new Promise((resolve) => setTimeout(resolve, 1_300));
	const second = tui.capture();
	assert.ok(
		(activeSeconds(second) ?? -1) > (activeSeconds(first) ?? -1),
		"below-editor active time redraws about once per second",
	);
	const settled = await tui.waitFor(
		/Reflect Watchdog \| active \d+s\/1 loops · task \d+s\/30m · root 1\/100 · all 1\/500/,
		12_000,
	);
	const frozen = activeSeconds(settled);
	await new Promise((resolve) => setTimeout(resolve, 1_300));
	assert.equal(
		activeSeconds(tui.capture()),
		frozen,
		"all-idle freezes active time without notification noise",
	);

	tui.send("Second real turn");
	await tui.waitFor(
		/Reflect Watchdog \| active \d+s\/2 loops · task \d+s\/30m · root 2\/100 · all 2\/500/,
		12_000,
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
