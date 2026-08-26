import {
	buildXmlDocument,
	MAX_XML_TEXT_CODE_POINTS,
	parseTrailingXml,
} from "pi-extension-utils/xml";
export type ReflectionTriggerReason =
	| "ROOT_LOOP_LIMIT"
	| "ALL_LOOP_LIMIT"
	| "TASK_TIME_LIMIT"
	| "USER_REQUEST";
export const MAX_REFLECTION_TEXT_CHARACTERS = MAX_XML_TEXT_CODE_POINTS;
export const MAX_REFLECTION_TOOL_CALLS = 10;
/** Maximum total invalid XML attempts, matching the continue-watchdog contract. */
export const MAX_REFLECTION_REASKS = 3;

export type ReflectionType = "NO_ISSUE" | "ROUTE_CORRECTION";
export const REFLECTION_ROOT_TAG = "reflection";

export interface ReflectionDecision {
	readonly type: ReflectionType;
	readonly reason: string;
	readonly done: string;
	readonly currentStep: string;
	readonly nextStep: string;
}

export interface ReflectionThresholdSnapshot {
	readonly activeMs: number;
	readonly activeLoops: number;
	readonly taskMs: number;
	readonly taskMinutes: number;
	readonly rootLoops: number;
	readonly rootLoopLimit: number;
	readonly allLoops: number;
	readonly allLoopLimit: number;
}

export interface ReflectionPromptContext {
	readonly semanticPrefix: string;
	readonly timestamp: string;
	readonly reasons: readonly ReflectionTriggerReason[];
	readonly thresholds: ReflectionThresholdSnapshot;
	readonly userSupplement?: string;
	readonly previousReflection?: {
		readonly timestamp: string;
		readonly report: string;
	};
}

export type ReflectionValidation =
	| { readonly valid: true; readonly decision: ReflectionDecision }
	| { readonly valid: false; readonly error: string };

const REQUIRED_FIELDS = [
	"type",
	"reason",
	"done",
	"current_step",
	"next_step",
] as const;

function normalizeReflectionXmlCase(text: string): string {
	return text.replace(
		/<\/?(reflection|type|reason|done|current_step|next_step)>/gi,
		(tag, name: string) =>
			`${tag.startsWith("</") ? "</" : "<"}${name.toLowerCase()}>`,
	);
}

export function parseReflectionXml(text: string): ReflectionValidation {
	const parsed = parseTrailingXml(
		normalizeReflectionXmlCase(text),
		REFLECTION_ROOT_TAG,
	);
	if (!parsed.valid) return parsed;
	const normalizedFields = new Map<string, string>();
	for (const [name, value] of parsed.value.fields) {
		const normalized = name.toLowerCase();
		if (normalizedFields.has(normalized))
			return {
				valid: false,
				error: `duplicate reflection field ${normalized}`,
			};
		normalizedFields.set(normalized, value);
	}
	if (
		normalizedFields.size !== REQUIRED_FIELDS.length ||
		REQUIRED_FIELDS.some((name) => !normalizedFields.has(name))
	)
		return {
			valid: false,
			error: "reflection XML must contain exactly the five required fields",
		};
	const values = new Map<string, string>();
	for (const name of REQUIRED_FIELDS) {
		const value = normalizedFields.get(name)?.trim();
		if (!value)
			return {
				valid: false,
				error: `reflection field ${name} must be non-empty`,
			};
		values.set(name, value);
	}
	const type = values.get("type")?.toUpperCase();
	if (type !== "NO_ISSUE" && type !== "ROUTE_CORRECTION")
		return {
			valid: false,
			error: "reflection type must be NO_ISSUE or ROUTE_CORRECTION",
		};
	return {
		valid: true,
		decision: {
			type,
			reason: values.get("reason") as string,
			done: values.get("done") as string,
			currentStep: values.get("current_step") as string,
			nextStep: values.get("next_step") as string,
		},
	};
}

/** Append all non-customizable facts and parser constraints to the semantic prefix. */
export function buildReflectionPrompt(
	context: ReflectionPromptContext,
): string {
	const supplement = context.userSupplement?.trim();
	const previous = context.previousReflection;
	const example = buildXmlDocument(REFLECTION_ROOT_TAG, [
		{ name: "type", value: "NO_ISSUE" },
		{ name: "reason", value: "why the route is sound" },
		{ name: "done", value: "completed work" },
		{ name: "current_step", value: "current work" },
		{ name: "next_step", value: "correct next step" },
	]);
	return `${context.semanticPrefix.trim()}\n\n[Plugin-generated reflection context]\nCurrent local RFC3339 time: ${context.timestamp}\nTrigger source(s): ${context.reasons.join(", ")}\nThreshold snapshot: active=${context.thresholds.activeMs}ms/${context.thresholds.activeLoops} loops; task=${context.thresholds.taskMs}ms/${context.thresholds.taskMinutes}m; root=${context.thresholds.rootLoops}/${context.thresholds.rootLoopLimit}; all=${context.thresholds.allLoops}/${context.thresholds.allLoopLimit}\nUser supplement: ${supplement ? supplement : "(none)"}\nPrevious completed reflection: ${previous ? `${previous.timestamp}\n${previous.report}` : "(none)"}\n\nYou may use tools only when needed to verify the current route. This reflection and all XML correction attempts share one budget of ${MAX_REFLECTION_TOOL_CALLS} tool calls. The plugin blocks call ${MAX_REFLECTION_TOOL_CALLS + 1} before execution.\n\nEnd the response with exactly one trailing <reflection>...</reflection> XML block. XML names and the type value are case-insensitive. The block must contain exactly these five unique, non-empty fields in any order: type, reason, done, current_step, next_step. The type must be NO_ISSUE or ROUTE_CORRECTION. Total non-thinking assistant text must not exceed ${MAX_REFLECTION_TEXT_CHARACTERS} Unicode characters. Example:\n${example}\n\nDo not copy untrusted text into XML without escaping it. Example escaped supplement:\n${buildXmlDocument("supplement", [{ name: "text", value: supplement ?? "none" }])}`;
}

export function buildReflectionReaskPrompt(error: string): string {
	return `Your previous reflection response was invalid: ${error}\nCorrect it now. The same tool-call budget remains in force. End with one valid trailing reflection XML block containing exactly the unique non-empty type, reason, done, current_step, and next_step fields.`;
}
