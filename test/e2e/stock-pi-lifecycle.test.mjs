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
	const resources = await createTestResources(
		t,
		"pi-reflect-watchdog-lifecycle-",
	);
	const { base } = resources;
	const isolated = await createIsolatedEnvironment(base);
	const artifact = await installPackedArtifact({
		base,
		agentDir: isolated.agentDir,
	});
	await writeJson(path.join(isolated.agentDir, "pi-reflect-watchdog.json"), {
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
		responsePlan: ({ requestIndex }) => {
			if (requestIndex === 0)
				return {
					delay: 66_000,
					halfway: 30_000,
					chunks: [{ content: "working " }, { content: "done" }],
				};
			if (requestIndex === 1)
				return {
					delay: 20,
					chunks: [
						{
							content:
								"<reflection><type>NO_ISSUE</type><reason>timing route is sound</reason><done>checked</done><current_step>finish</current_step><next_step>stop</next_step></reflection>",
						},
					],
				};
			return {
				delay: 20,
				chunks: [{ content: "post-threshold completion" }],
			};
		},
	});
	const startedAt = Date.now();
	const start = performance.now();
	const response = await rpc.request({
		type: "prompt",
		message: "Remain active for the timing fixture.",
	});
	assert.equal(response.success, true);
	await rpc.waitFor((message) => message.type === "agent_start");
	const initialDeadline = start + 10_000;
	while (provider.requests.length < 1 && performance.now() < initialDeadline)
		await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(provider.requests.length, 1, "initial provider request started");
	const earlyDeadline = start + 59_000;
	while (performance.now() < earlyDeadline) {
		assert.equal(
			provider.requests.length,
			1,
			"no reflection before 59 seconds",
		);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const reflectionDeadline = start + 75_000;
	while (provider.requests.length < 2 && performance.now() < reflectionDeadline)
		await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(provider.requests.length >= 2, "reflection request is dispatched");
	const warningElapsed = provider.requests[1].startedAt - start;
	assert.ok(
		warningElapsed >= 60_000,
		`reflection was early at ${warningElapsed}ms`,
	);
	assert.ok(
		warningElapsed < 70_000,
		`reflection was late at ${warningElapsed}ms`,
	);
	await rpc.waitFor((message) => message.type === "agent_settled", 25_000);
	await new Promise((resolve) => setTimeout(resolve, 1_250));
	const reflectionRequests = provider.requests.filter((request) =>
		JSON.stringify(request.body.messages).includes(
			"Trigger source(s): CONTINUOUS_DOMAIN_ACTIVE_TIME",
		),
	);
	assert.equal(
		reflectionRequests.length,
		1,
		"continuous threshold triggers once",
	);
	const reflectionMessages = JSON.stringify(provider.requests[1].body.messages);
	assert.match(
		reflectionMessages,
		/Trigger source\(s\): CONTINUOUS_DOMAIN_ACTIVE_TIME/,
	);
	assert.match(reflectionMessages, /continuous-domain-active=60000ms\/1m/i);
	assert.ok(
		provider.requests[1].finishedAt,
		"reflection response was fully consumed",
	);
	const state = await rpc.request({ type: "get_state" });
	assert.equal(state.success, true, "RPC remains responsive after threshold");
	const endedAt = Date.now();
	assert.ok(
		endedAt - startedAt >= 60_000,
		`test observation lasted at least 60 seconds: ${endedAt - startedAt}ms`,
	);
	await rpc.close();
});
