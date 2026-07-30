import {
	BUILT_IN_PROMPTS,
	PROMPT_KINDS,
	type PromptTemplateOverrides,
	type PromptTemplates,
} from "./prompts.js";

export interface WatchdogConfig {
	mainLoopLimit: number;
	observedTotalLoopLimit: number;
	wallClockMinutes: number;
	prompts: PromptTemplates;
}

export type ConfigInput = Record<string, unknown>;

export interface ConfigDiagnostic {
	source: string;
	message: string;
}

export interface ConfigResult {
	config: Partial<Omit<WatchdogConfig, "prompts">> & {
		prompts?: PromptTemplateOverrides;
	};
	diagnostics: ConfigDiagnostic[];
}

export interface MergeConfigResult {
	config: WatchdogConfig;
	diagnostics: ConfigDiagnostic[];
}

export const BUILT_IN_CONFIG: Readonly<WatchdogConfig> = Object.freeze({
	mainLoopLimit: 100,
	observedTotalLoopLimit: 500,
	wallClockMinutes: 30,
	prompts: BUILT_IN_PROMPTS,
});

const MAX_DIAGNOSTIC_LENGTH = 240;

function diagnostic(source: string, message: string): ConfigDiagnostic {
	return { source, message: message.slice(0, MAX_DIAGNOSTIC_LENGTH) };
}

function positiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function template(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
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
	for (const key of [
		"mainLoopLimit",
		"observedTotalLoopLimit",
		"wallClockMinutes",
	] as const) {
		if (input[key] === undefined) continue;
		if (positiveSafeInteger(input[key])) config[key] = input[key];
		else
			diagnostics.push(
				diagnostic(source, `${key} must be a positive safe integer`),
			);
	}

	if (input.prompts !== undefined) {
		if (
			input.prompts === null ||
			typeof input.prompts !== "object" ||
			Array.isArray(input.prompts)
		) {
			diagnostics.push(diagnostic(source, "prompts must be an object"));
		} else {
			const prompts: PromptTemplateOverrides = {};
			for (const key of PROMPT_KINDS) {
				const candidate = (input.prompts as ConfigInput)[key];
				if (candidate === undefined) continue;
				if (template(candidate)) prompts[key] = candidate;
				else
					diagnostics.push(
						diagnostic(source, `prompts.${key} must be a non-empty string`),
					);
			}
			if (Object.keys(prompts).length > 0) config.prompts = prompts;
		}
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
	const config: WatchdogConfig = {
		...BUILT_IN_CONFIG,
		prompts: { ...BUILT_IN_CONFIG.prompts },
	};

	for (const { config: partial } of layers) {
		if (partial.mainLoopLimit !== undefined)
			config.mainLoopLimit = partial.mainLoopLimit;
		if (partial.observedTotalLoopLimit !== undefined)
			config.observedTotalLoopLimit = partial.observedTotalLoopLimit;
		if (partial.wallClockMinutes !== undefined)
			config.wallClockMinutes = partial.wallClockMinutes;
		if (partial.prompts !== undefined)
			Object.assign(config.prompts, partial.prompts);
	}

	return { config, diagnostics: layers.flatMap((layer) => layer.diagnostics) };
}
