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

export async function startFakeProvider({
	slowMs = 0,
	holdAfterThresholdMs = 3_000,
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
			chunk(response, completionChunk(id, { role: "assistant", content: "" }));
			const watchdogContinuation = JSON.stringify(
				parsed.messages ?? [],
			).includes("Root active work has reached");
			const delay =
				requests.length === 1 && slowMs > 0
					? slowMs + holdAfterThresholdMs
					: 20;
			const halfway =
				requests.length === 1 && slowMs > 0 ? Math.min(30_000, delay - 10) : 5;
			const firstTimer = setTimeout(
				() =>
					chunk(
						response,
						completionChunk(id, {
							content: watchdogContinuation ? "reflected " : "working ",
						}),
					),
				halfway,
			);
			const finalTimer = setTimeout(() => {
				chunk(
					response,
					completionChunk(
						id,
						{ content: watchdogContinuation ? "after watchdog" : "done" },
						"stop",
					),
				);
				response.write("data: [DONE]\n\n");
				response.end();
				record.finishedAt = performance.now();
			}, delay);
			response.on("close", () => {
				if (!response.writableEnded) {
					clearTimeout(firstTimer);
					clearTimeout(finalTimer);
				}
			});
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
