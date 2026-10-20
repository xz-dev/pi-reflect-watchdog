import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
	isPrivateReflectionRequest,
	modelConfig,
	privateReflectionPlan,
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

async function setup(t, { taskMinutes = 30, ...providerOptions } = {}) {
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
		taskMinutes,
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
		launcherArgs: [
			"--mode",
			"rpc",
			// Private reflection forks the persisted parent session.
			"--tools",
			"read",
			"--provider",
			"watchdog-fixture",
			"--model",
			"watchdog-fixture",
		],
	});
	resources.add(() => rpc.close());
	await assertSingleWatchdogCommand(
		rpc,
		path.join(artifact.packagePath, "src", "extension.ts"),
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

// Automatic evaluation happens at fresh valid turn completion (turn-end
// reflection spec); the private child is the reflection request.
test("the real one-minute task limit reflects once at the first completion past it", {
	timeout: 120_000,
}, async (t) => {
	const { rpc, provider } = await setup(t, {
		taskMinutes: 1,
		responsePlan: privateReflectionPlan(
			{
				type: "NO_ISSUE",
				reason: "timing route is sound",
				done: "checked",
				current_step: "finish",
				next_step: "stop",
			},
			(_request, requestIndex) =>
				requestIndex === 0
					? {
							delay: 66_000,
							halfway: 30_000,
							chunks: [{ content: "working " }, { content: "done" }],
						}
					: { delay: 20, chunks: [{ content: "post-threshold completion" }] },
		),
	});
	const attempts = () =>
		provider.requests.filter(
			(request) =>
				isPrivateReflectionRequest(request) &&
				request.body.messages.at(-1)?.role !== "tool",
		);
	const start = performance.now();
	const response = await rpc.request({
		type: "prompt",
		message: "Remain active for the timing fixture.",
	});
	assert.equal(response.success, true);
	await rpc.waitFor((message) => message.type === "agent_start");
	const earlyDeadline = start + 59_000;
	while (performance.now() < earlyDeadline) {
		assert.equal(attempts().length, 0, "no reflection before 59 seconds");
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const reflectionDeadline = start + 80_000;
	while (attempts().length < 1 && performance.now() < reflectionDeadline)
		await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(attempts().length, 1, "reflection request is dispatched");
	const main = provider.requests[0];
	assert.ok(main.finishedAt, "main turn completed");
	assert.ok(
		attempts()[0].startedAt >= main.finishedAt,
		"evaluation waits for the completed turn",
	);
	assert.ok(
		attempts()[0].startedAt - start < 75_000,
		`reflection was late at ${attempts()[0].startedAt - start}ms`,
	);
	const prompt = JSON.stringify(attempts()[0].body.messages.at(-1));
	assert.match(prompt, /Trigger source\(s\): TASK_TIME_LIMIT/);
	assert.match(prompt, /task=\d+[smh](\d+s)?\/1m/i);
	await rpc.waitFor((message) => message.type === "agent_settled", 25_000);
	await new Promise((resolve) => setTimeout(resolve, 1_250));
	assert.equal(attempts().length, 1, "continuous threshold triggers once");
	const state = await rpc.request({ type: "get_state" });
	assert.equal(state.success, true, "RPC remains responsive after threshold");
	await rpc.close();
});
