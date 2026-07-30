export declare const PROMPT_KINDS: readonly ["mainLoopLimitReached", "observedTotalLoopLimitReached", "wallClockLimitReached"];
export type PromptKind = (typeof PROMPT_KINDS)[number];
export type PromptTemplates = Record<PromptKind, string>;
export type PromptTemplateOverrides = Partial<Record<PromptKind, string>>;
export declare const BUILT_IN_PROMPTS: Readonly<PromptTemplates>;
export declare function renderTemplate(template: string, variables: Readonly<Record<string, string | number>>): string;
