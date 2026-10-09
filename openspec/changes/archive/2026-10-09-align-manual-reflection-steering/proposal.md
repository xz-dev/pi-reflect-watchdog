## Why

A user requesting `/reflect` wants the agent to reconsider its direction before doing more ordinary work, not after the entire run finishes. Automatic reflection already enters Pi's native steering queue while the agent is busy, but the manual-only busy guard delays explicit requests until settlement and can also hold up a pending automatic reflection.

## What Changes

- **BREAKING (timing):** Submit manual reflection through the same native `steer` delivery path as automatic reflection as soon as the current main owns the request and no reflection inquiry is already outstanding. Ordinary-agent busyness, busy child agents, and existing native pending messages do not create a plugin-side settlement barrier.
- Define immediate submission separately from model consumption: Pi consumes steering after the current assistant turn and its complete tool batch, before a subsequent model call, subject to its native queue ordering. This does not abort a response/tool or guarantee delivery within a wall-clock deadline.
- Retain one plugin-pending manual request only while another reflection inquiry is outstanding, including an inquiry already submitted but not yet consumed. Preserve first-request coalescing and dispatch the waiting request once that inquiry is finalized, without adding an ordinary-agent idle requirement.
- **BREAKING (cancellation window):** Queued/cancellable status applies only to requests still held by the plugin. After native submission, `/cancel-reflect` and the configured shortcut do not retract the inquiry or interrupt any run. Keep cancellation, configuration, and teardown behavior for genuinely plugin-pending requests.
- Preserve manual trigger origin, supplement, pause/cooldown bypass, report role, XML/re-ask behavior, and ordinary continuation semantics. Automatic threshold accounting and delivery policy remain unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `manual-reflect-queue`: Replace settlement-delayed manual dispatch with immediate native steering; distinguish plugin-pending requests from submitted inquiries in serialization, cancellation, coalescing, and status behavior.

## Impact

- `src/extension.ts`: remove the manual-only ordinary-busy dispatch barrier; retain the existing shared inquiry path, single outstanding inquiry, and bounded manual queue.
- `test/runtime.test.ts`: replace busy-until-settle expectations with immediate submission checks; move pending/coalescing/cancellation scenarios to the outstanding-reflection case and retain lifecycle regressions.
- Existing integration/e2e fixtures: verify that the actual next eligible ordinary model request sees the manual inquiry at Pi's native turn boundary, rather than relying only on a fake `sendMessage` receipt.
- `README.md` and the existing lifecycle model under `docs/programming-thinking/`: reconcile delivery/cancellation wording and formal dispatch scope during implementation. The main `manual-reflect-queue` specification, including its purpose, must be reconciled when this delta is synced.
- No new dependencies, commands, configuration fields, transport protocols, host patches, or changes to the separate aggregate-activity state-machine work.
