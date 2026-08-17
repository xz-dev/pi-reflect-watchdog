import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createFatalExitAdapter,
	sanitizedReflectDomainError,
} from "../src/fatal-exit.js";
import { ReflectDomainFatalError } from "../src/process-domain.js";

function harness(mode: "tui" | "rpc" | "print" | "json") {
	let exitCode: number | undefined;
	let exitListener: ((code: number) => void) | undefined;
	let fallback: (() => void) | undefined;
	const calls: string[] = [];
	const adapter = createFatalExitAdapter({
		process: {
			get exitCode() {
				return exitCode;
			},
			set exitCode(value) {
				exitCode = value;
			},
			once(_event, listener) {
				exitListener = listener;
			},
			exit(code) {
				calls.push(`exit:${code}`);
			},
		},
		clock: {
			setTimeout(callback) {
				fallback = callback;
				return callback;
			},
			clearTimeout() {
				fallback = undefined;
			},
		},
	});
	const ctx = {
		mode,
		abort: () => calls.push("abort"),
		shutdown: () => calls.push("shutdown"),
		ui: { notify: (message: string) => calls.push(message) },
	} as unknown as ExtensionContext;
	return {
		adapter,
		ctx,
		calls,
		get exitCode() {
			return exitCode;
		},
		fireExit: (code = 0) => {
			exitCode = code;
			exitListener?.(code);
		},
		fireFallback: () => fallback?.(),
	};
}

for (const mode of ["tui", "rpc", "print", "json"] as const) {
	test(`fatal process-domain startup failure exits 78 in ${mode} mode`, () => {
		const testHarness = harness(mode);
		testHarness.adapter.fail(
			new ReflectDomainFatalError(
				"AUTHENTICATION_FAILED",
				"secret-capability ipc:///private/path",
			),
			testHarness.ctx,
		);
		assert.equal(testHarness.exitCode, 78);
		assert.ok(testHarness.calls.includes("abort"));
		assert.equal(
			testHarness.calls.includes("shutdown"),
			mode === "tui" || mode === "rpc",
		);
		assert.doesNotMatch(
			testHarness.calls.join(" "),
			/secret-capability|private\/path/,
		);
		testHarness.fireExit();
		assert.equal(testHarness.exitCode, 78);
		testHarness.fireFallback();
		assert.ok(testHarness.calls.includes("exit:78"));
	});
}

test("graceful shutdown cancels fallback but preserves fatal exit status", () => {
	const testHarness = harness("tui");
	testHarness.adapter.fail(
		new ReflectDomainFatalError("INVALID_DECLARATION", "private declaration"),
		testHarness.ctx,
	);
	testHarness.adapter.completeShutdown();
	testHarness.fireFallback();
	assert.equal(testHarness.calls.includes("exit:78"), false);
	testHarness.fireExit();
	assert.equal(testHarness.exitCode, 78);
});

test("sanitized fatal output exposes only the stable code", () => {
	const message = sanitizedReflectDomainError(
		new ReflectDomainFatalError(
			"CONNECTION_UNAVAILABLE",
			"capability=hunter2 tcp://127.0.0.1:9999",
		),
	);
	assert.match(message, /CONNECTION_UNAVAILABLE/);
	assert.doesNotMatch(message, /hunter2|127\.0\.0\.1/);
});
