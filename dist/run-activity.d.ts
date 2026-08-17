export declare const PROCESS_DOMAIN_ACTIVITY_KEY = "pi-process-domain";
export declare const PROCESS_DOMAIN_ACTIVITY_VERSION = 1;
export declare const PROCESS_DOMAIN_OBSERVATION_DETAILS: {
    readonly "pi-process-domain": {
        readonly version: 1;
        readonly activity: "observation";
    };
};
/** Only an exact, versioned opt-in is observation; all other messages fail closed to work. */
export declare function isProcessDomainObservation(details: unknown): boolean;
