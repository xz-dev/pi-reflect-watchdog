import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import {
	type ConfigDiagnostic,
	loadConfigText,
	mergeConfig,
	type WatchdogConfig,
} from "./config.js";

export interface ConfigFileIO {
	readFile(path: string, encoding: "utf8"): Promise<string>;
}

export interface LoadedConfig {
	config: WatchdogConfig;
	diagnostics: ConfigDiagnostic[];
}

const nodeFileIO: ConfigFileIO = { readFile };

async function readConfig(path: string, source: string, io: ConfigFileIO) {
	try {
		return loadConfigText(source, await io.readFile(path, "utf8"));
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { config: {}, diagnostics: [] };
		return {
			config: {},
			diagnostics: [
				{
					source,
					message: `could not read configuration: ${String(error).slice(0, 180)}`,
				},
			],
		};
	}
}

export async function loadRuntimeConfig(
	cwd: string,
	trusted: boolean,
	io: ConfigFileIO = nodeFileIO,
	agentDir = getAgentDir(),
): Promise<LoadedConfig> {
	const global = await readConfig(
		join(agentDir, "pi-reflect-watchdog.json"),
		"global",
		io,
	);
	const project = trusted
		? await readConfig(
				join(cwd, CONFIG_DIR_NAME, "pi-reflect-watchdog.json"),
				"project",
				io,
			)
		: { config: {}, diagnostics: [] };
	const merged = mergeConfig(global.config, project.config);
	return {
		config: merged.config,
		diagnostics: [
			...global.diagnostics,
			...project.diagnostics,
			...merged.diagnostics,
		],
	};
}
