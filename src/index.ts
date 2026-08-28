export type {
	ActivitySnapshot,
	ActivityStatus,
} from "./activity-types.js";
export {
	BUILT_IN_CONFIG,
	type ConfigDiagnostic,
	type ConfigInput,
	type ConfigResult,
	type HookPausePair,
	loadConfigText,
	type MergeConfigResult,
	mergeConfig,
	validateConfig,
	type WatchdogConfig,
} from "./config.js";
export {
	type ConfigFileIO,
	type LoadedConfig,
	loadRuntimeConfig,
} from "./config-loader.js";
export {
	createWatchdogExtension,
	type RuntimeServices,
	type WatchdogExtensionOptions,
} from "./extension.js";
export {
	createHubAttachmentInstance,
	createObservableAgentHub,
	getProcessObservableAgentHub,
	HUB_SYMBOL,
	type HubAttachment,
	type HubMainClaim,
	type ObservableAgentHub,
	type ObservableAgentHubSnapshot,
} from "./hub.js";
export {
	FATAL_EXIT_CODE,
	isReflectDomainFatalError,
	type ReflectDomainCoordinator,
	type ReflectDomainCounters,
	ReflectDomainFatalError,
} from "./process-domain.js";
export { DEFAULT_REFLECTION_PROMPT } from "./prompts.js";
export {
	buildReflectionPrompt,
	buildReflectionReaskPrompt,
	MAX_REFLECTION_REASKS,
	MAX_REFLECTION_TEXT_CHARACTERS,
	MAX_REFLECTION_TOOL_CALLS,
	parseReflectionXml,
	type ReflectionDecision,
	type ReflectionPromptContext,
	type ReflectionThresholdSnapshot,
	type ReflectionTriggerReason,
	type ReflectionValidation,
} from "./reflection-protocol.js";
export {
	createWatchdogWidget,
	formatCompactWidgetText,
	formatDuration,
	formatWidgetText,
	WIDGET_KEY,
	type WidgetState,
	type WidgetTheme,
} from "./widget.js";
