export interface WatchdogConfig {
    mainLoopLimit: number;
    observedTotalLoopLimit: number;
    wallClockMinutes: number;
    reflectionPrompt: string;
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
export declare const BUILT_IN_CONFIG: Readonly<WatchdogConfig>;
export declare function validateConfig(source: string, value: unknown): ConfigResult;
export declare function loadConfigText(source: string, text: string): ConfigResult;
export declare function mergeConfig(global?: unknown, project?: unknown): MergeConfigResult;
