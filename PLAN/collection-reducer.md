# Collection reducer slice

## Goal

Replace implicit global certainty with one pure state transition module whose three independent domains are live contributors, checkpoint replay ledger, and accounting.

## Confirmed behavior

- Transport offline removes peer activity immediately.
- Replay ledger remains usable for 10 seconds without retirement timers.
- Adapter emits only verified `peer-synchronized` facts with an opaque live contributor ID, an incarnation-scoped replay key, and the exact accepted loop delta.
- JOIN parsing, identity/incarnation checks, resume-receipt validation, and first/returning classification remain outside the reducer.
- Retained same-incarnation reconnect restores exact loop delta only; active/task time is never backfilled.
- Ledger-expired reconnect seeds current totals as baseline with an accepted zero delta.
- True first synchronization counts current cumulative totals by accepting that total as the delta from zero.
- Pause/resume changes accounting generation; cross-generation delta is discarded.
- Peer state never gates automatic Reflect.

## Slice

1. Add pure reducer and snapshot projection; no runtime integration.
2. Lock replay, fencing, pause, idle-gap, and accounting behavior with focused unit tests.
3. Run focused tests, TypeScript checks, and diff inspection before Lean.
4. Extend the Lean lifecycle model with stabilized collection invariants.
5. Leave exports, runtime adapter, wire protocol, and E2E integration to separately reviewed slices.
