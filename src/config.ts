import { parseSemanticHook } from "pi-extension-utils/semantic-hook";
import { DEFAULT_REFLECTION_PROMPT } from "./prompts.js";

export interface HookPausePair {
	readonly pause: string;
	readonly resume: string;
}

export interface WatchdogConfig {
	rootLoopLimit: number;
	allLoopLimit: number;
	taskMinutes: number;
	idleResetGapSeconds: number;
	reflectionPrompt: string;
	hookPauses: readonly HookPausePair[];
}

export type ConfigInput = Record<string, unknown>;

export interface ConfigDiagnostic {
	source: string;
	message: string;
}

export interface ConfigResult {
	config: Partial<WatchdogConfig>;
	diagnostics: ConfigDiagnostic[];
}

export interface MergeConfigResult {
	config: WatchdogConfig;
	diagnostics: ConfigDiagnostic[];
}

export const BUILT_IN_CONFIG: Readonly<WatchdogConfig> = Object.freeze({
	rootLoopLimit: 100,
	allLoopLimit: 500,
	taskMinutes: 30,
	idleResetGapSeconds: 60,
	reflectionPrompt: DEFAULT_REFLECTION_PROMPT,
	hookPauses: Object.freeze([]),
});

const MAX_DIAGNOSTIC_LENGTH = 240;
const MAX_REFLECTION_PROMPT_CHARACTERS = 16_384;
const MAX_HOOK_PAUSE_PAIRS = 64;

function diagnostic(source: string, message: string): ConfigDiagnostic {
	return { source, message: message.slice(0, MAX_DIAGNOSTIC_LENGTH) };
}

function positiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function template(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function boundedPrompt(value: unknown): value is string {
	return (
		template(value) &&
		value.trim().length > 0 &&
		Array.from(value).length <= MAX_REFLECTION_PROMPT_CHARACTERS
	);
}

function validHookName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		parseSemanticHook({ version: 1, name: value }).ok
	);
}

function readPairNames(
	value: unknown,
): { readonly pause: unknown; readonly resume: unknown } | undefined {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value))
			return undefined;
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return undefined;
		const pause = Object.getOwnPropertyDescriptor(value, "pause");
		const resume = Object.getOwnPropertyDescriptor(value, "resume");
		if (
			pause === undefined ||
			resume === undefined ||
			!("value" in pause) ||
			!("value" in resume) ||
			"get" in pause ||
			"set" in pause ||
			"get" in resume ||
			"set" in resume
		)
			return undefined;
		return { pause: pause.value, resume: resume.value };
	} catch {
		return undefined;
	}
}

function parseHookPauses(
	source: string,
	value: unknown,
): { pairs?: HookPausePair[]; diagnostics: ConfigDiagnostic[] } {
	if (!Array.isArray(value))
		return {
			diagnostics: [diagnostic(source, "hookPauses must be an array")],
		};
	if (value.length > MAX_HOOK_PAUSE_PAIRS)
		return {
			diagnostics: [
				diagnostic(
					source,
					`hookPauses must contain at most ${MAX_HOOK_PAUSE_PAIRS} pairs`,
				),
			],
		};
	const pairs: HookPausePair[] = [];
	const seen = new Set<string>();
	const diagnostics: ConfigDiagnostic[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const names = readPairNames(value[index]);
		if (names === undefined) {
			diagnostics.push(
				diagnostic(
					source,
					`hookPauses[${index}] must be a plain object with data properties pause and resume`,
				),
			);
			continue;
		}
		const { pause, resume } = names;
		if (!validHookName(pause) || !validHookName(resume)) {
			diagnostics.push(
				diagnostic(
					source,
					`hookPauses[${index}] pause and resume must be lowercase kebab-case hook names`,
				),
			);
			continue;
		}
		if (pause === resume) {
			diagnostics.push(
				diagnostic(source, `hookPauses[${index}] pause and resume must differ`),
			);
			continue;
		}
		const key = `${pause}\u0000${resume}`;
		if (seen.has(key)) continue;
		seen.add(key);
		pairs.push(Object.freeze({ pause, resume }));
	}
	if (diagnostics.length > 0) return { diagnostics };
	return { pairs, diagnostics };
}

export function validateConfig(source: string, value: unknown): ConfigResult {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return {
			config: {},
			diagnostics: [diagnostic(source, "configuration must be an object")],
		};
	}

	const input = value as ConfigInput;
	const config: ConfigResult["config"] = {};
	const diagnostics: ConfigDiagnostic[] = [];
	if (input.reflectionPrompt !== undefined) {
		if (boundedPrompt(input.reflectionPrompt)) {
			config.reflectionPrompt = input.reflectionPrompt;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					`reflectionPrompt must be a non-empty string of at most ${MAX_REFLECTION_PROMPT_CHARACTERS} Unicode characters`,
				),
			);
		}
	}

	for (const key of [
		"rootLoopLimit",
		"allLoopLimit",
		"taskMinutes",
		"idleResetGapSeconds",
	] as const) {
		if (input[key] === undefined) continue;
		if (positiveSafeInteger(input[key])) config[key] = input[key];
		else
			diagnostics.push(
				diagnostic(source, `${key} must be a positive safe integer`),
			);
	}

	if (input.hookPauses !== undefined) {
		const parsed = parseHookPauses(source, input.hookPauses);
		diagnostics.push(...parsed.diagnostics);
		if (parsed.pairs !== undefined) config.hookPauses = parsed.pairs;
	}

	return { config, diagnostics };
}

export function loadConfigText(source: string, text: string): ConfigResult {
	try {
		return validateConfig(source, JSON.parse(text));
	} catch {
		return {
			config: {},
			diagnostics: [
				diagnostic(source, "configuration contains malformed JSON"),
			],
		};
	}
}

export function mergeConfig(
	global?: unknown,
	project?: unknown,
): MergeConfigResult {
	const layers = [
		validateConfig("global", global ?? {}),
		validateConfig("project", project ?? {}),
	];
	const config: WatchdogConfig = { ...BUILT_IN_CONFIG };

	for (const { config: partial } of layers) {
		if (partial.rootLoopLimit !== undefined)
			config.rootLoopLimit = partial.rootLoopLimit;
		if (partial.allLoopLimit !== undefined)
			config.allLoopLimit = partial.allLoopLimit;
		if (partial.taskMinutes !== undefined)
			config.taskMinutes = partial.taskMinutes;
		if (partial.idleResetGapSeconds !== undefined)
			config.idleResetGapSeconds = partial.idleResetGapSeconds;
		if (partial.reflectionPrompt !== undefined)
			config.reflectionPrompt = partial.reflectionPrompt;
		if (partial.hookPauses !== undefined)
			config.hookPauses = partial.hookPauses.slice();
	}

	return { config, diagnostics: layers.flatMap((layer) => layer.diagnostics) };
}
