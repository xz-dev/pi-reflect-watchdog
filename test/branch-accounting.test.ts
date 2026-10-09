import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ACCOUNTING_BOUNDARY_ENTRY,
	type AccountingBoundary,
	deriveBranchAccounting,
	isAgentLoopMessage,
	REFLECTION_COMPLETED_ENTRY,
	reflectCooldownState,
} from "../src/branch-accounting.js";

function reply(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "test",
		content: [{ type: "text", text: "ordinary" }],
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...overrides,
	};
}

function appendBoundary(
	session: SessionManager,
	window: AccountingBoundary["window"],
): string {
	return session.appendCustomEntry(ACCOUNTING_BOUNDARY_ENTRY, {
		version: 1,
		window,
	} satisfies AccountingBoundary);
}

const correlation = {
	version: 1,
	namespace: "pi-reflect-watchdog",
	inquiryId: "test",
	attempt: 1,
};
type InquiryReply = AssistantMessage & {
	readonly details: { readonly piInquiry: typeof correlation };
};
function complete(session: SessionManager): string {
	const assistant: InquiryReply = {
		...reply({ content: [] }),
		details: { piInquiry: correlation },
	};
	session.appendMessage(assistant);
	return session.appendCustomEntry(REFLECTION_COMPLETED_ENTRY, correlation);
}

function scan(
	session: SessionManager,
	boundaryPolicy: "recorded" | "legacy" = "recorded",
) {
	return deriveBranchAccounting(session.getBranch(), {
		cooldownLoops: 10,
		boundaryPolicy,
	});
}

test("fileless Pi history counts finalized ordinary replies once, not tools or thinking", () => {
	const session = SessionManager.inMemory();
	assert.equal(session.getSessionFile(), undefined);
	const text = session.appendMessage(reply());
	const tools = session.appendMessage(
		reply({
			stopReason: "toolUse",
			content: [1, 2, 3].map((id) => ({
				type: "toolCall",
				id: String(id),
				name: "read",
				arguments: {},
			})),
		}),
	);
	for (const stopReason of [
		"error",
		"aborted",
		"length",
		"pending",
		"deferred",
	] as const)
		session.appendMessage(reply({ stopReason }));
	session.appendMessage(reply({ errorMessage: "preempted" }));
	session.appendMessage(reply({ content: [] }));
	session.appendMessage(reply({ content: [{ type: "text", text: "  " }] }));
	session.appendMessage(
		reply({ content: [{ type: "thinking", thinking: "x" }] }),
	);
	const inquiry: InquiryReply = {
		...reply(),
		details: { piInquiry: correlation },
	};
	session.appendMessage(inquiry);
	const view = scan(session);
	assert.equal(view.activeLoops, 2n);
	assert.equal(view.reminderLoops, 2n);
	assert.deepEqual(view.full.entryIds, [text, tools]);
	for (let index = 0; index < 3; index++) assert.deepEqual(scan(session), view);
	assert.equal(isAgentLoopMessage(reply({ errorMessage: "" })), true);
	assert.equal(
		isAgentLoopMessage({ ...reply(), details: { piInquiry: null } }),
		false,
	);
});

test("full and reminder markers preserve separate windows, including cooldown-consumed resets", () => {
	const session = SessionManager.inMemory();
	session.appendMessage(reply());
	session.appendMessage({
		role: "user",
		content: "new request",
		timestamp: 0,
	});
	const user = appendBoundary(session, "full");
	const first = session.appendMessage(reply());
	assert.equal(scan(session).full.afterEntryId, user);
	complete(session);
	assert.equal(scan(session).cooldown.skipAutomatic, true);
	const consumed = appendBoundary(session, "reminder");
	const second = session.appendMessage(reply());
	complete(session);
	const view = scan(session);
	assert.equal(view.activeLoops, 2n);
	assert.equal(view.reminderLoops, 1n);
	assert.deepEqual(view.full.entryIds, [first, second]);
	assert.equal(view.reminder.afterEntryId, consumed);
	const full = appendBoundary(session, "full");
	assert.equal(scan(session).activeLoops, 0n);
	assert.equal(scan(session).reminderLoops, 0n);
	assert.equal(scan(session).full.afterEntryId, full);
	assert.equal(scan(session).cooldown.remainingLoops, 10);
	session.appendMessage({
		role: "user",
		content: "next",
		timestamp: 0,
	});
	const laterUser = appendBoundary(session, "full");
	session.appendMessage(reply());
	complete(session);
	assert.equal(scan(session).reminder.afterEntryId, laterUser);
});

test("legacy fallback uses correlated completion, then ordinary user, then branch start", () => {
	const session = SessionManager.inMemory();
	const before = session.appendMessage(reply());
	assert.equal(scan(session, "legacy").full.afterEntryId, null);
	assert.deepEqual(scan(session, "legacy").full.entryIds, [before]);
	session.appendCustomEntry(REFLECTION_COMPLETED_ENTRY, {
		...correlation,
		inquiryId: "orphan",
	});
	session.appendCustomEntry(ACCOUNTING_BOUNDARY_ENTRY, {
		version: 2,
		window: "full",
	});
	session.appendCustomEntry(ACCOUNTING_BOUNDARY_ENTRY, {
		version: 1,
		window: "unknown",
	});
	assert.equal(scan(session, "legacy").reminderLoops, 1n);
	const completed = complete(session);
	const after = session.appendMessage(reply());
	assert.equal(scan(session, "legacy").reminder.afterEntryId, completed);
	assert.equal(scan(session, "legacy").activeLoops, 2n);
	assert.deepEqual(scan(session, "legacy").reminder.entryIds, [after]);
	// Prompt-looking text has no reset meaning; only its ordinary user entry does.
	const user = session.appendMessage({
		role: "user",
		content: "[pi-reflect-watchdog:inquiry]",
		timestamp: 0,
	});
	assert.equal(scan(session, "legacy").full.afterEntryId, user);
	assert.equal(scan(session, "legacy").reminder.afterEntryId, user);
	assert.equal(scan(session, "legacy").activeLoops, 0n);
});

test("selected branch and compaction retain raw Pi loop windows without model context", () => {
	const session = SessionManager.inMemory();
	const full = appendBoundary(session, "full");
	const first = session.appendMessage(reply());
	const abandoned = session.appendMessage(reply());
	session.branch(first);
	const selected = session.appendMessage(reply({ stopReason: "toolUse" }));
	session.appendCompaction("old context removed", selected, 100);
	const view = scan(session);
	assert.equal(
		session.buildContextEntries().some((entry) => entry.id === first),
		false,
	);
	assert.equal(view.full.afterEntryId, full);
	assert.deepEqual(view.full.entryIds, [first, selected]);
	assert.equal(view.full.entryIds.includes(abandoned), false);
});

test("child attachment and cycle baselines exclude inherited fork history; rewinds require fencing", () => {
	const session = SessionManager.inMemory();
	for (let index = 0; index < 6; index++) session.appendMessage(reply());
	const attachment = session.getLeafId();
	const first = session.appendMessage(reply());
	const cycle = session.getLeafId();
	const second = session.appendMessage(reply());
	const options = {
		cooldownLoops: 10,
		boundaryPolicy: "baselines" as const,
		fullAfterEntryId: attachment,
	};
	assert.equal(
		deriveBranchAccounting(session.getBranch(), options).activeLoops,
		2n,
	);
	const reminder = deriveBranchAccounting(session.getBranch(), {
		...options,
		reminderAfterEntryId: cycle,
	});
	assert.deepEqual(reminder.full.entryIds, [first, second]);
	assert.deepEqual(reminder.reminder.entryIds, [second]);
	assert.equal(
		deriveBranchAccounting(session.getBranch(), {
			...options,
			fullAfterEntryId: cycle,
		}).activeLoops,
		1n,
	);
	session.branch(session.getBranch()[0]?.id ?? null);
	const missing = deriveBranchAccounting(session.getBranch(), options);
	assert.equal(missing.baselineFound, false);
	assert.equal(missing.activeLoops, 0n);
	assert.equal(missing.reminderLoops, 0n);
	assert.equal(
		deriveBranchAccounting([], {
			cooldownLoops: 10,
			boundaryPolicy: "baselines",
			fullAfterEntryId: null,
		}).baselineFound,
		true,
	);
});

test("cooldown preserves inclusive limit and rejects wrong namespace, attempt, and orphan markers", () => {
	const session = SessionManager.inMemory();
	complete(session);
	for (let index = 0; index < 10; index++) session.appendMessage(reply());
	assert.deepEqual(scan(session).cooldown, {
		skipAutomatic: true,
		remainingLoops: 0,
	});
	session.appendMessage(reply());
	assert.deepEqual(scan(session).cooldown, {
		skipAutomatic: false,
		remainingLoops: 0,
	});
	for (const data of [
		{ ...correlation, namespace: "other" },
		{ ...correlation, attempt: 0 },
		{ ...correlation, inquiryId: "missing" },
	])
		session.appendCustomEntry(REFLECTION_COMPLETED_ENTRY, data);
	assert.deepEqual(
		scan(session).cooldown,
		reflectCooldownState(session.getBranch(), 10),
	);
	assert.deepEqual(scan(session).cooldown, {
		skipAutomatic: false,
		remainingLoops: 0,
	});
});

test("recorded main boundaries distinguish real interactive/RPC input from user-role wakes", () => {
	for (const source of ["interactive", "rpc"] as const) {
		const session = SessionManager.inMemory();
		session.appendMessage({
			role: "user",
			content: "real input",
			timestamp: 0,
		});
		const real = appendBoundary(session, "full"); // C writes only after source qualification.
		const first = session.appendMessage(reply());
		const second = session.appendMessage(reply());
		session.appendMessage({
			role: "user",
			content: "extension background wake",
			timestamp: 1,
		});
		const third = session.appendMessage(reply());
		const options = { cooldownLoops: 10, boundaryPolicy: "recorded" as const };
		const view = deriveBranchAccounting(session.getBranch(), options);
		assert.equal(view.activeLoops, 3n, source);
		assert.equal(view.reminderLoops, 3n, source);
		assert.equal(view.full.afterEntryId, real);
		assert.deepEqual(view.full.entryIds, [first, second, third]);
		const reminder = appendBoundary(session, "reminder");
		session.appendMessage({
			role: "user",
			content: "another synthetic wake",
			timestamp: 2,
		});
		const fourth = session.appendMessage(reply());
		const refreshed = deriveBranchAccounting(session.getBranch(), options);
		assert.equal(refreshed.activeLoops, 4n);
		assert.equal(refreshed.reminderLoops, 1n);
		assert.equal(refreshed.reminder.afterEntryId, reminder);
		assert.deepEqual(refreshed.reminder.entryIds, [fourth]);
		session.appendMessage({
			role: "user",
			content: `new ${source} input`,
			timestamp: 3,
		});
		const fresh = appendBoundary(session, "full");
		const reset = deriveBranchAccounting(session.getBranch(), options);
		assert.equal(reset.activeLoops, 0n);
		assert.equal(reset.reminderLoops, 0n);
		assert.equal(reset.full.afterEntryId, fresh);
	}
	const modern = SessionManager.inMemory();
	modern.appendMessage(reply());
	modern.appendMessage({
		role: "user",
		content: "unqualified wake before any marker",
		timestamp: 0,
	});
	modern.appendMessage(reply());
	assert.equal(
		deriveBranchAccounting(modern.getBranch(), {
			cooldownLoops: 10,
			boundaryPolicy: "recorded",
		}).activeLoops,
		2n,
	);
});

test("legacy role inference ends at first valid recorded boundary", () => {
	for (const window of ["full", "reminder"] as const) {
		const session = SessionManager.inMemory();
		session.appendMessage(reply());
		const user = session.appendMessage({
			role: "user",
			content: "legacy user",
			timestamp: 0,
		});
		const options = { cooldownLoops: 10, boundaryPolicy: "legacy" as const };
		assert.equal(
			deriveBranchAccounting(session.getBranch(), options).full.afterEntryId,
			user,
		);
		appendBoundary(session, window);
		session.appendMessage(reply());
		session.appendMessage({
			role: "user",
			content: "unqualified new wake",
			timestamp: 1,
		});
		session.appendMessage(reply());
		assert.equal(
			deriveBranchAccounting(session.getBranch(), options).activeLoops,
			2n,
		);
		assert.equal(
			deriveBranchAccounting(session.getBranch(), options).reminderLoops,
			2n,
		);
	}
});

test("child scope baselines retain all unpublished work through local input and copied markers", () => {
	for (const sampleEarly of [false, true]) {
		const session = SessionManager.inMemory();
		for (let index = 0; index < 6; index++) session.appendMessage(reply());
		const attachment = session.getLeafId();
		const first = session.appendMessage(reply());
		const second = session.appendMessage(reply());
		const options = {
			cooldownLoops: 10,
			boundaryPolicy: "baselines" as const,
			fullAfterEntryId: attachment,
		};
		const before = sampleEarly
			? deriveBranchAccounting(session.getBranch(), options)
			: undefined;
		session.appendMessage({
			role: "user",
			content: "child-local input",
			timestamp: 0,
		});
		appendBoundary(session, "full");
		appendBoundary(session, "reminder");
		complete(session);
		const third = session.appendMessage(reply());
		const after = deriveBranchAccounting(session.getBranch(), options);
		assert.equal(after.activeLoops, 3n);
		assert.equal(after.reminderLoops, 3n);
		assert.deepEqual(after.full.entryIds, [first, second, third]);
		if (before)
			assert.deepEqual(
				after.full.entryIds.slice(0, before.full.entryIds.length),
				before.full.entryIds,
			);
		const reminderReset = session.getLeafId();
		const fourth = session.appendMessage(reply());
		const reminder = deriveBranchAccounting(session.getBranch(), {
			...options,
			reminderAfterEntryId: reminderReset,
		});
		assert.equal(reminder.activeLoops, 4n);
		assert.deepEqual(reminder.reminder.entryIds, [fourth]);
		const fullReset = session.getLeafId();
		const full = deriveBranchAccounting(session.getBranch(), {
			...options,
			fullAfterEntryId: fullReset,
			reminderAfterEntryId: reminderReset,
		});
		assert.equal(full.activeLoops, 0n);
		assert.equal(full.reminderLoops, 0n);
		const missing = deriveBranchAccounting(session.getBranch(), {
			...options,
			reminderAfterEntryId: "missing-domain-baseline",
		});
		assert.equal(missing.baselineFound, false);
		assert.equal(missing.activeLoops, 0n);
		assert.equal(missing.reminderLoops, 0n);
	}
});
