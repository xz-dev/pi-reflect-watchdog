import { type ConfigDiagnostic, type WatchdogConfig } from "./config.js";
export interface ConfigFileIO {
    readFile(path: string, encoding: "utf8"): Promise<string>;
}
export interface LoadedConfig {
    config: WatchdogConfig;
    diagnostics: ConfigDiagnostic[];
}
export declare function loadRuntimeConfig(cwd: string, trusted: boolean, io?: ConfigFileIO, agentDir?: string): Promise<LoadedConfig>;
