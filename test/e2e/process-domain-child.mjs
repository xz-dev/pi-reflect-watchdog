import { openProcessDomain } from "pi-extension-utils/process-domain";

const { createReflectDomainCoordinator } = await import(
	process.env.PI_WATCHDOG_PROCESS_DOMAIN_MODULE ??
		new URL("../../dist/process-domain.js", import.meta.url).href
);

const env = {
	PI_EXTENSION_UTILS_PROCESS_DOMAIN:
		process.env.PI_EXTENSION_UTILS_PROCESS_DOMAIN,
};
const open = (options) =>
	openProcessDomain({
		...options,
		connectTimeoutMs: 2_000,
		heartbeatIntervalMs: 100,
		heartbeatTimeoutMs: 400,
		heartbeatTimeToLiveMs: 300,
	});
const coordinator = createReflectDomainCoordinator({
	env,
	open,
	activeTickMs: 100,
	idleResetGapMs: 300,
});
const instance = {};
let busy = false;

function reply(id, data, error) {
	process.send?.({ id, data, error });
}

try {
	await coordinator.attach(instance, {
		getBusy: () => busy,
		onFatal: (error) => {
			process.send?.({ event: "transport-error", message: error.message });
		},
	});
	process.send?.({ event: "ready", pid: process.pid });
} catch (error) {
	process.send?.({
		event: "startup-error",
		message: error instanceof Error ? error.message : String(error),
	});
	process.exitCode = 78;
}

process.on("message", async (message) => {
	if (typeof message !== "object" || message === null) return;
	const { id, command } = message;
	if (!Number.isSafeInteger(id) || typeof command !== "string") return;
	try {
		switch (command) {
			case "busy":
				busy = true;
				await coordinator.setBusy(instance, true);
				reply(id, true);
				break;
			case "idle":
				busy = false;
				await coordinator.setBusy(instance, false);
				reply(id, true);
				break;
			case "root-loop":
				await coordinator.recordRootLoop();
				reply(id, true);
				break;
			case "all-loop":
				await coordinator.recordAllLoop();
				reply(id, true);
				break;
			case "counters":
				reply(id, coordinator.counters());
				break;
			case "shutdown":
				await coordinator.detach(instance);
				reply(id, true);
				// Give the authenticated leave frame a short, explicit flush window
				// before this helper exits; process shutdown must not make delivery
				// depend on IPC/teardown scheduling races.
				setTimeout(() => process.disconnect?.(), 50);
				break;
			default:
				throw new Error(`unknown command: ${command}`);
		}
	} catch (error) {
		reply(
			id,
			undefined,
			error instanceof Error ? error.message : String(error),
		);
	}
});
