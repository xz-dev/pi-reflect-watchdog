## Context

Reflect Watchdog already has two reset concepts: long-idle `resetCycle()` and reflection-accepted `reminder-accepted`. Neither models a user takeover. `pi-continue-watchdog` already proves the takeover lifecycle: real user `message_start` starts a fresh lock cycle, and terminal abort is detected through a branch boundary captured at `agent_start` and inspected at `agent_settled`.

## Goals / Non-Goals

**Goals:**

- Make user takeover an explicit accounting event in the collection reducer.
- Keep reset authority in the root process coordinator so shared-process counters remain consistent.
- Clear only stale automatic intent in the extension runtime.
- Preserve reflection completion, manual queue, cooldown, report persistence, and continuation semantics.

**Non-Goals:**

- No configuration option.
- No cancellation of queued manual `/reflect` requests.
- No change to XML, prompt, cooldown, report-role, or persistence contracts.
- No inference of abort from `agent_settled` alone.

## Decisions

### 1. Add a distinct full-cycle reducer event

Add a reducer event such as `cycle-reset` rather than reusing `reminder-accepted`.

Rationale: `reminder-accepted` intentionally preserves `activeMs` and `activeLoops`; user takeover means a new work cycle and must zero all five counters. A separate event keeps reminder accounting semantics unchanged and makes the formal model explicit.

Alternative rejected: reuse `resetReminderCycle()`. It is smaller, but only performs a partial reset and does not satisfy the observable “归零” behavior.

### 2. Expose a coordinator-owned takeover reset

Add a process-domain API such as `resetCycleOnUserTakeover()` that reduces the new event on the root process and publishes the resulting counters.

Rationale: the coordinator is already the counter authority. Root-owned publication avoids each attachment attempting independent resets and preserves cross-process consistency.

Alternative rejected: extension-local counter mutation. This plugin's counters are domain state, not attachment-local state.

### 3. Detect new user messages through the existing main `message_start` seam

On `message_start`, reset only when the attachment owns main and `event.message.role === "user"`, excluding recognized reflection inquiry prompts.

Rationale: this mirrors `pi-continue-watchdog/src/auto-lock.ts` and uses Pi's real message lifecycle rather than editor `input`, which may represent queued text rather than processing.

Alternative rejected: listen to `input`. It can fire before a message starts and would reset for input that has not entered the conversation lifecycle.

### 4. Detect abort with branch-boundary inspection

Capture the current leaf at main `agent_start`; at `agent_settled`, inspect only the appended suffix and reset only when the terminal new assistant has `stopReason === "aborted"`.

Rationale: this is the proven narrow detector in `pi-continue-watchdog/src/abort-outcome.ts`. It avoids treating every settle or plugin-owned internal abort as user takeover.

Alternative rejected: inspect turn/message events only. Those paths are shared with reflection internals and cannot establish the terminal branch outcome by themselves.

### 5. Clear stale automatic intent at the extension seam

When takeover reset is accepted, the extension clears `runtime.latched` and `runtime.pendingAutomatic`. It does not clear `manualQueue`, cancel `activeReflection`, or alter reflection finalization order.

Rationale: old threshold intent belongs to the interrupted cycle. Manual requests are explicit user work, and active reflection cleanup already has a separate authoritative lifecycle.

### 6. Preserve event ordering

For abort, existing `agent_settled` reflection completion/cancellation runs first; takeover reset is applied after that path has stabilized. For user message start, reset occurs immediately when the real user message is observed.

Rationale: reflection result persistence and continuations must not be skipped or reordered. Abort reset only removes stale accounting/intent after the settling lifecycle is understood.

## Risks / Trade-offs

- User sends a message while a reflection is active → reflection-owned prompts must be excluded by correlation before treating the event as ordinary user takeover.
- Abort boundary is unavailable after branch/reload edge cases → no reset; this is safer than inferring takeover from incomplete evidence.
- Full-cycle reset changes widget values immediately after takeover → document as intentional fresh-cycle behavior.
- Active changes already touch process-domain accounting → implementation should rebase carefully and keep the new reducer event separate from shared-domain enrollment fixes.

## Migration Plan

No data migration. Existing counters continue until the first confirmed takeover; subsequent behavior follows the new reset rule. Rollback removes the new event/API/hooks and restores previous counter retention semantics.
