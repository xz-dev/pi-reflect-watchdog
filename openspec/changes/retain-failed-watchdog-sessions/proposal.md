## Why

Reflect's private fork JSONL already contains the evidence needed to investigate failed reflections, but terminal diagnostics do not expose its path. In addition, the returned `execution-error` outcome currently has no dedicated user notification, so some failures release the reflection slot without explaining what happened.

## What Changes

- Adopt the [Continue-owned joint diagnostics contract](../../../../pi-continue-watchdog/openspec/changes/retain-failed-watchdog-sessions/specs/watchdog-inquiry-diagnostics/spec.md).
- Preserve the exact private child's existing session JSONL for terminal execution failures and exhausted invalid-result corrections; show one bounded human-only failure diagnostic with its verified absolute path.
- Handle returned `execution-error` explicitly as well as `decision-failed`; clearly report unavailable evidence when no session was created or retention cannot be confirmed.
- Do not add path notices for successful reflections, corrected-then-successful responses, expected abort/withdrawal, takeover or stale completion. Keep existing per-attempt warnings unchanged.
- Keep reflection report publication, continuation dispatch, helper/response allowances, native retry policy, slot release and cancellation authority unchanged.

## Capabilities

### New Capabilities

- `watchdog-inquiry-diagnostics`: Reflect's companion requirements for the shared final-failure session-retention and human-only path-disclosure contract.

### Modified Capabilities

None. This adds failure diagnostics without changing reflection response validity, accounting, scheduling or successful report publication.

## Impact

- Reflect: `src/extension.ts` private result handling, observed-child metadata forwarding if needed, existing private-reflection tests and user documentation during implementation.
- Shared prerequisite: compatible session-locator metadata from `pi-extension-utils/private-inquiry`, coordinated with Continue rather than duplicated inside Reflect.
- Canonical joint tracking: [Continue proposal](../../../../pi-continue-watchdog/openspec/changes/retain-failed-watchdog-sessions/proposal.md) and [Continue tasks](../../../../pi-continue-watchdog/openspec/changes/retain-failed-watchdog-sessions/tasks.md).
