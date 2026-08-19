import { DEFAULT_REFLECTION_PROMPT } from "./prompts.js";
export const BUILT_IN_CONFIG = Object.freeze({
    rootLoopLimit: 100,
    allLoopLimit: 500,
    taskMinutes: 30,
    idleResetGapSeconds: 60,
    reflectionPrompt: DEFAULT_REFLECTION_PROMPT,
});
const MAX_DIAGNOSTIC_LENGTH = 240;
const MAX_REFLECTION_PROMPT_CHARACTERS = 16_384;
function diagnostic(source, message) {
    return { source, message: message.slice(0, MAX_DIAGNOSTIC_LENGTH) };
}
function positiveSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function template(value) {
    return typeof value === "string" && value.length > 0;
}
function boundedPrompt(value) {
    return (template(value) &&
        value.trim().length > 0 &&
        Array.from(value).length <= MAX_REFLECTION_PROMPT_CHARACTERS);
}
export function validateConfig(source, value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return {
            config: {},
            diagnostics: [diagnostic(source, "configuration must be an object")],
        };
    }
    const input = value;
    const config = {};
    const diagnostics = [];
    if (input.reflectionPrompt !== undefined) {
        if (boundedPrompt(input.reflectionPrompt)) {
            config.reflectionPrompt = input.reflectionPrompt;
        }
        else {
            diagnostics.push(diagnostic(source, `reflectionPrompt must be a non-empty string of at most ${MAX_REFLECTION_PROMPT_CHARACTERS} Unicode characters`));
        }
    }
    for (const key of [
        "rootLoopLimit",
        "allLoopLimit",
        "taskMinutes",
        "idleResetGapSeconds",
    ]) {
        if (input[key] === undefined)
            continue;
        if (positiveSafeInteger(input[key]))
            config[key] = input[key];
        else
            diagnostics.push(diagnostic(source, `${key} must be a positive safe integer`));
    }
    return { config, diagnostics };
}
export function loadConfigText(source, text) {
    try {
        return validateConfig(source, JSON.parse(text));
    }
    catch {
        return {
            config: {},
            diagnostics: [
                diagnostic(source, "configuration contains malformed JSON"),
            ],
        };
    }
}
export function mergeConfig(global, project) {
    const layers = [
        validateConfig("global", global ?? {}),
        validateConfig("project", project ?? {}),
    ];
    const config = { ...BUILT_IN_CONFIG };
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
    }
    return { config, diagnostics: layers.flatMap((layer) => layer.diagnostics) };
}
