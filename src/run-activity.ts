export const PROCESS_DOMAIN_ACTIVITY_KEY = "pi-process-domain";
export const PROCESS_DOMAIN_ACTIVITY_VERSION = 1;

export const PROCESS_DOMAIN_OBSERVATION_DETAILS = {
	[PROCESS_DOMAIN_ACTIVITY_KEY]: {
		version: PROCESS_DOMAIN_ACTIVITY_VERSION,
		activity: "observation",
	},
} as const;

function isObject(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** Only an exact, versioned opt-in is observation; all other messages fail closed to work. */
export function isProcessDomainObservation(details: unknown): boolean {
	if (!isObject(details)) return false;
	const protocol = details[PROCESS_DOMAIN_ACTIVITY_KEY];
	return (
		isObject(protocol) &&
		protocol.version === PROCESS_DOMAIN_ACTIVITY_VERSION &&
		protocol.activity === "observation"
	);
}
