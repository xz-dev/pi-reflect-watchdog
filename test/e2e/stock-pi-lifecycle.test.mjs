import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
	modelConfig,
	startFakeProvider,
} from "../../scripts/e2e/fake-provider.mjs";
import {
	assertSingleWatchdogCommand,
	createIsolatedEnvironment,
	createTestResources,
	installPackedArtifact,
	RpcPi,
	writeJson,
} from "../../scripts/e2e/harness.mjs";

async function setup(t, { wallClockMinutes = 30, ...providerOptions } = {}) {
	const resources = await createTestResources(t, "pi-watchdog-lifecycle-");
	const { base } = resources;
	const isolated = await createIsolatedEnvironment(base);
	const artifact = await installPackedArtifact({
		base,
		agentDir: isolated.agentDir,
	});
	await writeJson(path.join(isolated.agentDir, "pi-watchdog.json"), {
		wallClockMinutes,
	});
	const provider = await startFakeProvider(providerOptions);
	resources.add(() => provider.close());
	await writeJson(
		path.join(isolated.agentDir, "models.json"),
		modelConfig(provider.baseUrl),
	);
	const rpc = new RpcPi({
		cwd: isolated.workspace,
		env: isolated.env,
		args: ["--provider", "watchdog-fixture", "--model", "watchdog-fixture"],
	});
	resources.add(() => rpc.close());
	await assertSingleWatchdogCommand(
		rpc,
		path.join(artifact.packagePath, "dist", "extension.js"),
	);
	return { rpc, provider };
}

test("a real stock Pi model turn completes and settles through the loopback provider", async (t) => {
	const { rpc, provider } = await setup(t);
	const response = await rpc.request({
		type: "prompt",
		message: "Reply normally.",
	});
	assert.equal(response.success, true);
	await rpc.waitFor((message) => message.type === "agent_start");
	await rpc.waitFor((message) => message.type === "turn_end");
	await rpc.waitFor((message) => message.type === "agent_settled");
	const last = await rpc.request({ type: "get_last_assistant_text" });
	assert.match(last.data.text, /working done/);
	assert.equal(provider.requests.length, 1);
	await rpc.close();
});

test("the real one-minute wall warning steers exactly once while active", {
	timeout: 120_000,
}, async (t) => {
	const { rpc, provider } = await setup(t, {
		wallClockMinutes: 1,
		slowMs: 60_000,
		holdAfterThresholdMs: 6_000,
	});
	const startedAt = Date.now();
	const start = performance.now();
	const response = await rpc.request({
		type: "prompt",
		message: "Remain active for the timing fixture.",
	});
	assert.equal(response.success, true);
	await rpc.waitFor((message) => message.type === "agent_start");
	const earlyDeadline = start + 59_000;
	while (performance.now() < earlyDeadline) {
		const early = rpc.events.filter(
			(entry) =>
				entry.message.type === "extension_ui_request" &&
				entry.message.method === "notify" &&
				/wallClockLimitReached/.test(entry.message.message ?? ""),
		);
		assert.equal(early.length, 0, "no wall warning before 59 seconds");
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const warning = await rpc.waitFor(
		(message) =>
			message.type === "extension_ui_request" &&
			message.method === "notify" &&
			/wallClockLimitReached/.test(message.message ?? ""),
		10_000,
	);
	const warningElapsed = warning.at - start;
	const schedulingToleranceMs = 250;
	assert.ok(
		warningElapsed >= 60_000 - schedulingToleranceMs,
		`warning was early at ${warningElapsed}ms`,
	);
	assert.ok(warningElapsed < 66_000, `warning was late at ${warningElapsed}ms`);
	await rpc.waitFor((message) => message.type === "agent_settled", 25_000);
	await new Promise((resolve) => setTimeout(resolve, 5_250));
	const warnings = rpc.events.filter(
		(entry) =>
			entry.message.type === "extension_ui_request" &&
			entry.message.method === "notify" &&
			/wallClockLimitReached/.test(entry.message.message ?? ""),
	);
	assert.equal(
		warnings.length,
		1,
		"wall warning is latched without a timer storm",
	);
	assert.equal(
		provider.requests.length,
		2,
		"exactly one continuation request consumes the steering reminder",
	);
	assert.ok(
		provider.requests[1].startedAt >= warning.at,
		"continuation begins after warning delivery",
	);
	const continuationMessages = JSON.stringify(
		provider.requests[1].body.messages,
	);
	assert.match(
		continuationMessages,
		/main agent has been continuously active for 1 minute/i,
	);
	assert.match(continuationMessages, /wall-clock/i);
	assert.ok(
		provider.requests[1].finishedAt,
		"continuation response was fully consumed",
	);
	const state = await rpc.request({ type: "get_state" });
	assert.equal(state.success, true, "RPC remains responsive after threshold");
	const endedAt = Date.now();
	assert.ok(
		endedAt - startedAt >= 65_000,
		`test observation lasted at least 65 seconds: ${endedAt - startedAt}ms`,
	);
	await rpc.close();
});
