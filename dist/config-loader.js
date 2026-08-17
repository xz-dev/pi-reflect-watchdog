import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfigText, mergeConfig, } from "./config.js";
const nodeFileIO = { readFile };
async function readConfig(path, source, io) {
    try {
        return loadConfigText(source, await io.readFile(path, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
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
export async function loadRuntimeConfig(cwd, trusted, io = nodeFileIO, agentDir = getAgentDir()) {
    const global = await readConfig(join(agentDir, "pi-reflect-watchdog.json"), "global", io);
    const project = trusted
        ? await readConfig(join(cwd, CONFIG_DIR_NAME, "pi-reflect-watchdog.json"), "project", io)
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
