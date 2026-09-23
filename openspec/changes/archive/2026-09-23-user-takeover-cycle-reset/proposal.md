## Why

Reflect Watchdog currently resets counters only after a long idle gap or partially when a reflection is accepted. When the user takes over by sending a new message or aborting the current run, old activity can still influence the next reflection even though a new work cycle has clearly begun.

## What Changes

- Add an authoritative user-takeover reset for real user `message_start` events on the current main attachment.
- Add abort detection using the same branch-boundary semantics proven by pi-continue-watchdog, resetting only when the terminal new assistant outcome is `aborted`.
- Reset the full activity cycle counters (`activeMs`, `activeLoops`, `taskMs`, `rootLoops`, and `allLoops`) after a confirmed takeover.
- Drop stale automatic reflection intent (`latched` reasons and `pendingAutomatic`) when takeover resets the cycle, while preserving queued manual `/reflect` requests and active reflection completion handling.

## Capabilities

### New Capabilities

- `user-takeover-cycle-reset`: Defines how real user messages and terminal abort outcomes reset Reflect Watchdog activity accounting and stale automatic intent.

### Modified Capabilities

- `conversation-grounded-reflection`: Automatic reflection timing now starts from a fresh cycle after user takeover instead of inheriting counters from the interrupted cycle.

## Impact

- `src/extension.ts`: user-message and abort-boundary lifecycle detection.
- `src/process-domain.ts`: coordinator API for an authoritative full-cycle reset.
- `src/collection-state.ts`: reducer event for full-cycle counter reset.
- `test/collection-state.test.ts` and `test/runtime.test.ts`: reducer and lifecycle regression coverage.
- `README.md` and `docs/programming-thinking/*.idea.lean`: lifecycle documentation and formal model synchronization.
