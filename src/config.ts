import { DEFAULT_REFLECTION_PROMPT } from "./prompts.js";

export interface WatchdogConfig {
	rootLoopLimit: number;
	allLoopLimit: number;
	taskMinutes: number;
	idleResetGapSeconds: number;
	reflectionPrompt: string;
	/** Key binding for cancelling a queued manual reflection, or false to disable. */
	cancelShortcut: string | false;
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
	rootLoopLimit: 60,
	allLoopLimit: 300,
	taskMinutes: 20,
	idleResetGapSeconds: 60,
	reflectionPrompt: DEFAULT_REFLECTION_PROMPT,
	cancelShortcut: "alt+x",
});

const MAX_DIAGNOSTIC_LENGTH = 240;
const MAX_REFLECTION_PROMPT_CHARACTERS = 16_384;

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

	if (input.hookPauses !== undefined)
		diagnostics.push(
			diagnostic(
				source,
				"hookPauses is no longer supported; Pi activity controls accounting",
			),
		);

	if (input.cancelShortcut !== undefined) {
		if (input.cancelShortcut === false || template(input.cancelShortcut))
			config.cancelShortcut = input.cancelShortcut;
		else
			diagnostics.push(
				diagnostic(
					source,
					"cancelShortcut must be a non-empty key id string or false",
				),
			);
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
		if (partial.cancelShortcut !== undefined)
			config.cancelShortcut = partial.cancelShortcut;
	}

	return { config, diagnostics: layers.flatMap((layer) => layer.diagnostics) };
}
