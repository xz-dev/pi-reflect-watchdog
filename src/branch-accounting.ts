import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const REFLECTION_INQUIRY_NAMESPACE = "pi-reflect-watchdog";
export const REFLECTION_COMPLETED_ENTRY =
	"pi-reflect-watchdog:reflection-completed";
export const ACCOUNTING_BOUNDARY_ENTRY =
	"pi-reflect-watchdog:accounting-boundary";

/** Trusted Pi metadata, not user role, supplies modern main reset provenance. */
export interface AccountingBoundary {
	readonly version: 1;
	readonly window: "full" | "reminder";
}

export interface BranchAccountingOptions {
	readonly cooldownLoops: number;
	/** Main: recorded markers only. Legacy: role/completion fallback until a marker.
	 * Child: supplied domain baselines only, ignoring all local/copied resets. */
	readonly boundaryPolicy: "recorded" | "legacy" | "baselines";
	/** Capture the leaf at child attachment/full reset; null means branch start. */
	readonly fullAfterEntryId?: string | null;
	/** Capture the leaf at reminder reset, preserving the full-cycle baseline. */
	readonly reminderAfterEntryId?: string | null;
}

export interface BranchLoopWindow {
	readonly afterEntryId: string | null;
	readonly entryIds: readonly string[];
}

export interface BranchAccounting {
	/** Missing baseline means a scope change: fence/rebase before publishing. */
	readonly baselineFound: boolean;
	readonly activeLoops: bigint;
	readonly reminderLoops: bigint;
	readonly full: BranchLoopWindow;
	readonly reminder: BranchLoopWindow;
	readonly cooldown: ReturnType<typeof reflectCooldownState>;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function isAgentLoopMessage(message: unknown): boolean {
	const value = record(message);
	if (value?.role !== "assistant") return false;
	if (value.stopReason !== "stop" && value.stopReason !== "toolUse")
		return false;
	if (value.errorMessage) return false;
	if (record(value.details)?.piInquiry !== undefined) return false;
	return (
		Array.isArray(value.content) &&
		value.content.some((item) => {
			const block = record(item);
			return (
				block?.type === "toolCall" ||
				(block?.type === "text" &&
					typeof block.text === "string" &&
					block.text.trim().length > 0)
			);
		})
	);
}

function watchdogInquiryKey(value: unknown): string | undefined {
	const inquiry = record(record(value)?.piInquiry ?? value);
	return inquiry?.version === 1 &&
		inquiry.namespace === REFLECTION_INQUIRY_NAMESPACE &&
		typeof inquiry.inquiryId === "string" &&
		inquiry.inquiryId.length > 0 &&
		typeof inquiry.attempt === "number" &&
		Number.isSafeInteger(inquiry.attempt) &&
		inquiry.attempt > 0
		? `${inquiry.inquiryId}:${inquiry.attempt}`
		: undefined;
}

function watchdogInquiryAssistant(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "assistant")
		return undefined;
	return watchdogInquiryKey(record(record(entry.message)?.details)?.piInquiry);
}

function completedWatchdogReflection(entry: SessionEntry): string | undefined {
	if (
		entry.type !== "custom" ||
		entry.customType !== REFLECTION_COMPLETED_ENTRY
	)
		return undefined;
	return watchdogInquiryKey(entry.data);
}

export function reflectCooldownState(
	entries: readonly SessionEntry[],
	cooldownLoops: number,
): {
	readonly skipAutomatic: boolean;
	readonly remainingLoops: number;
} {
	let loopsSinceReflect = 0;
	const ordinaryAssistant = (entry: SessionEntry): boolean =>
		entry.type === "message" && isAgentLoopMessage(entry.message);
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry === undefined) continue;
		const completedInquiry = completedWatchdogReflection(entry);
		if (completedInquiry !== undefined) {
			for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
				const assistant = entries[candidate];
				if (
					assistant !== undefined &&
					watchdogInquiryAssistant(assistant) === completedInquiry
				)
					return {
						skipAutomatic:
							cooldownLoops > 0 && loopsSinceReflect <= cooldownLoops,
						remainingLoops: Math.max(0, cooldownLoops - loopsSinceReflect),
					};
			}
			continue;
		}
		if (!ordinaryAssistant(entry)) continue;
		loopsSinceReflect += 1;
	}
	return { skipAutomatic: false, remainingLoops: 0 };
}

/** Pure getBranch() scan; neither history repair nor a boundary authorizes a turn. */
export function deriveBranchAccounting(
	entries: readonly SessionEntry[],
	options: BranchAccountingOptions,
): BranchAccounting {
	let fullIndex = -1;
	let reminderIndex = -1;
	let explicitReminderBoundary = false;
	const inquiryReplies = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		if (options.boundaryPolicy === "baselines") continue;
		const inquiryReply = watchdogInquiryAssistant(entry);
		if (inquiryReply !== undefined) inquiryReplies.add(inquiryReply);
		if (
			options.boundaryPolicy === "legacy" &&
			!explicitReminderBoundary &&
			entry.type === "message" &&
			entry.message.role === "user"
		) {
			fullIndex = index;
			reminderIndex = index;
		} else if (
			entry.type === "custom" &&
			entry.customType === ACCOUNTING_BOUNDARY_ENTRY
		) {
			const data = record(entry.data);
			if (data?.version !== 1) continue;
			if (data.window === "full") {
				fullIndex = index;
				reminderIndex = index;
				explicitReminderBoundary = true;
			} else if (data.window === "reminder") {
				reminderIndex = index;
				explicitReminderBoundary = true;
			}
		} else {
			// Pre-marker histories use correlated completion as reminder fallback.
			const completion = completedWatchdogReflection(entry);
			if (
				options.boundaryPolicy === "legacy" &&
				!explicitReminderBoundary &&
				completion !== undefined &&
				inquiryReplies.has(completion)
			)
				reminderIndex = index;
		}
	}
	const baselineIndex = (id: string | null | undefined): number =>
		id == null ? -1 : entries.findIndex((entry) => entry.id === id);
	const fullBaseline = baselineIndex(options.fullAfterEntryId);
	const reminderBaseline = baselineIndex(options.reminderAfterEntryId);
	const baselineFound =
		(options.fullAfterEntryId == null || fullBaseline >= 0) &&
		(options.reminderAfterEntryId == null || reminderBaseline >= 0);
	fullIndex = Math.max(fullIndex, fullBaseline);
	reminderIndex = Math.max(reminderIndex, reminderBaseline, fullIndex);
	const fullIds: string[] = [];
	const reminderIds: string[] = [];
	if (baselineFound) {
		for (const [index, entry] of entries.entries()) {
			if (entry.type !== "message" || !isAgentLoopMessage(entry.message))
				continue;
			if (index > fullIndex) fullIds.push(entry.id);
			if (index > reminderIndex) reminderIds.push(entry.id);
		}
	}
	return {
		baselineFound,
		activeLoops: BigInt(fullIds.length),
		reminderLoops: BigInt(reminderIds.length),
		full: { afterEntryId: entries[fullIndex]?.id ?? null, entryIds: fullIds },
		reminder: {
			afterEntryId: entries[reminderIndex]?.id ?? null,
			entryIds: reminderIds,
		},
		cooldown: reflectCooldownState(entries, options.cooldownLoops),
	};
}
