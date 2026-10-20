import http from "node:http";

function chunk(response, value) {
	response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function completionChunk(id, delta, finishReason = null) {
	return {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "watchdog-fixture",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function defaultResponsePlan({ requestIndex, slowMs, holdAfterThresholdMs }) {
	const delay =
		requestIndex === 0 && slowMs > 0 ? slowMs + holdAfterThresholdMs : 20;
	return {
		delay,
		halfway:
			requestIndex === 0 && slowMs > 0 ? Math.min(30_000, delay - 10) : 5,
		chunks: [{ content: "working " }, { content: "done" }],
		finishReason: "stop",
	};
}

function streamResponse(response, id, record, plan) {
	const chunks = plan.chunks ?? [{ content: "working " }, { content: "done" }];
	const delay = plan.delay ?? 20;
	const halfway = plan.halfway ?? Math.min(5, Math.max(0, delay - 1));
	const finishReason = plan.finishReason ?? "stop";
	chunk(response, completionChunk(id, { role: "assistant", content: "" }));
	const firstTimer = setTimeout(() => {
		for (const delta of chunks.slice(0, -1))
			chunk(response, completionChunk(id, delta));
	}, halfway);
	const finalTimer = setTimeout(() => {
		const finalDelta = chunks.at(-1) ?? { content: "" };
		chunk(response, completionChunk(id, finalDelta, finishReason));
		response.write("data: [DONE]\n\n");
		response.end();
		record.finishedAt = performance.now();
	}, delay);
	response.on("close", () => {
		if (!response.writableEnded) {
			// The client closed an unfinished stream: an observed abort.
			record.abortedAt = performance.now();
			clearTimeout(firstTimer);
			clearTimeout(finalTimer);
		}
	});
}

export async function startFakeProvider({
	slowMs = 0,
	holdAfterThresholdMs = 3_000,
	responsePlan,
} = {}) {
	const requests = [];
	const sockets = new Set();
	const server = http.createServer((request, response) => {
		if (
			request.method !== "POST" ||
			!request.url?.endsWith("/chat/completions")
		) {
			response.statusCode = 404;
			response.end();
			return;
		}
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (part) => {
			body += part;
		});
		request.on("end", () => {
			const startedAt = performance.now();
			let parsed = {};
			try {
				parsed = JSON.parse(body);
			} catch {}
			requests.push({ startedAt, body: parsed, finishedAt: undefined });
			const record = requests.at(-1);
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const id = `fixture-${requests.length}`;
			const plan =
				responsePlan?.({
					requestIndex: requests.length - 1,
					request: record,
				}) ??
				defaultResponsePlan({
					requestIndex: requests.length - 1,
					slowMs,
					holdAfterThresholdMs,
				});
			streamResponse(response, id, record, plan);
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: async () => {
			server.closeIdleConnections?.();
			const closed = new Promise((resolve) => server.close(resolve));
			for (const socket of sockets) socket.destroy();
			await closed;
		},
	};
}

const RESULT_FILE_PATTERN =
	/<private_inquiry_result_file>(.*?)<\/private_inquiry_result_file>/gs;

export function requestText(request) {
	return (request?.body?.messages ?? [])
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content.map((block) => block?.text ?? "").join("\n")
					: "",
		)
		.join("\n");
}

/** Latest designated private result path in a provider request, if any. */
export function privateResultPath(request) {
	const marker = [...requestText(request).matchAll(RESULT_FILE_PATTERN)].at(
		-1,
	)?.[1];
	return marker === undefined ? undefined : JSON.parse(marker);
}

export function isPrivateReflectionRequest(request) {
	return privateResultPath(request) !== undefined;
}

/** Private child reply: one SDK `write` of the result to its designated file. */
export function reflectionResponse(args, request) {
	const file = privateResultPath(request);
	if (file === undefined)
		throw new Error(
			"reflection response requires a private result-file request",
		);
	return {
		delay: 20,
		chunks: [
			{
				tool_calls: [
					{
						index: 0,
						id: "reflection-result",
						type: "function",
						function: {
							name: "write",
							arguments: JSON.stringify({
								path: file,
								content: typeof args === "string" ? args : JSON.stringify(args),
							}),
						},
					},
				],
			},
		],
		finishReason: "tool_calls",
	};
}

function toolCallResponse(calls, prefix) {
	return {
		delay: 20,
		chunks: [
			{
				tool_calls: calls.map((call, index) => ({
					index,
					id: `${prefix}-${index}`,
					type: "function",
					function: { name: call.name, arguments: JSON.stringify(call.args) },
				})),
			},
		],
		finishReason: "tool_calls",
	};
}

/**
 * Scripted private child. `attempts[n]` is either a result object (written
 * at once) or `{ steps: [[call, ...], ...], result }`: each step is one
 * assistant response of tool calls, then the result write. The n-th attempt
 * is selected by the correction prompts seen so far. A request after the
 * result write is an unsolicited acknowledgement turn: it is recorded on
 * `plan.violations` and answered with plain text so the run still ends.
 */
export function privateReflectionPlan(attempts, ordinary) {
	const listFor = (request) => {
		// A function selects the attempt list per reflection (fresh child).
		const value = typeof attempts === "function" ? attempts(request) : attempts;
		return Array.isArray(value) ? value : [value];
	};
	const violations = [];
	const plan = ({ requestIndex, request }) => {
		if (!isPrivateReflectionRequest(request))
			return ordinary(request, requestIndex);
		const messages = request.body.messages ?? [];
		const text = requestText(request);
		const corrections = (
			text.match(/previous reflection response was invalid/g) ?? []
		).length;
		const lastUser = messages.findLastIndex(
			(message) => message.role === "user",
		);
		const sinceUser = messages.slice(lastUser + 1);
		const resultPath = privateResultPath(request);
		const wroteResult = sinceUser.some(
			(message) =>
				message.role === "assistant" &&
				(message.tool_calls ?? []).some(
					(call) =>
						call.function?.name === "write" &&
						JSON.parse(call.function.arguments || "{}").path === resultPath,
				),
		);
		if (wroteResult) {
			violations.push({ requestIndex, corrections });
			return {
				delay: 20,
				chunks: [{ content: "unsolicited acknowledgement" }],
			};
		}
		const list = listFor(request);
		const attempt = list[Math.min(corrections, list.length - 1)];
		const scripted =
			attempt && typeof attempt === "object" && Array.isArray(attempt.steps)
				? attempt
				: { steps: [], result: attempt };
		const stepsDone = sinceUser.filter(
			(message) => message.role === "assistant",
		).length;
		const step = scripted.steps[stepsDone];
		if (step !== undefined)
			return toolCallResponse(step, `helper-${corrections}-${stepsDone}`);
		return reflectionResponse(scripted.result, request);
	};
	plan.violations = violations;
	return plan;
}

export function modelConfig(baseUrl) {
	return {
		providers: {
			"watchdog-fixture": {
				baseUrl,
				api: "openai-completions",
				apiKey: "local-fixture",
				models: [
					{
						id: "watchdog-fixture",
						name: "Watchdog Fixture",
						reasoning: false,
						input: ["text"],
						contextWindow: 16_384,
						maxTokens: 512,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						compat: {
							supportsUsageInStreaming: false,
							maxTokensField: "max_tokens",
						},
					},
				],
			},
		},
	};
}
