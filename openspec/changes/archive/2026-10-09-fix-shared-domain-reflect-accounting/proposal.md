## Why

With Continue Watchdog loaded before Reflect Watchdog, background children can connect successfully and report activity to Continue while Reflect silently rejects their checkpoints. Reflect incorrectly requires its private protocol identity in metadata belonging to a shared transport node, so child-only work contributes neither time nor loops.

## What Changes

- Establish Reflect participation through its validated private protocol over authenticated transport, independently of which extension first opened the shared node.
- Preserve checkpoint sequencing, contributor incarnation, generation, replay receipts, offline removal, pause behavior, and local accounting safeguards.
- Verify both watchdog load orders: child-only work advances active/task time and all loops, not root loops; Continue continues to observe child activity.
- Add regression coverage at the coordinator boundary and a real shared-transport/background-session acceptance check. Do not use package reordering as the fix.

## Capabilities

### New Capabilities

- `shared-domain-accounting`: Load-order-independent Reflect contributor enrollment and accounting over an extension-shared process domain.

### Modified Capabilities

None. Existing main specs describe reflection interaction and delivery, not shared transport enrollment. This change complements, rather than replaces, the pending `aggregate-activity-state-machine` change.

## Impact

- Primary implementation area: `src/process-domain.ts`; focused tests in existing process-domain suites.
- Future implementation must synchronize affected lifecycle Lean models and validate existing pause/replay/accounting behavior. No Lean or implementation files are changed during this proposal capture.
- No planned Pi core, pi-subagents, Continue Watchdog, dependency, global configuration, or transport-authentication changes.
- Scope is background/native child sessions that actually load Reflect. Automatically injecting watchdogs into foreground children or supporting external CLI/remote agents is excluded.
- Evidence: installed pi-subagents `fda57bff` (0.67.0), Continue `2203e31`, Reflect `da85039`. In-memory probes against actual installed coordinators reproduced 0 ms/0 child loops with Continue-first versus 2000 ms/3 child loops with Reflect-first; Continue observed one busy child in both. These are coordinator-level results, not a completed real-Pi/TCP acceptance run.
