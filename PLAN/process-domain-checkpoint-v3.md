# Process-domain checkpoint v3 integration

## Goal

Replace runtime `peers + uncertainPeers + fixed ticks` authority with the existing collection reducer so abrupt peer loss cannot freeze active/task accounting or automatic Reflect while loop counters continue.

## Confirmed protocol and API decisions

- Replace private activity/root-loop/all-loop v2 traffic with one ordered `checkpoint.v3` message.
- A checkpoint carries process incarnation/replay identity, live contributor identity, accounting generation, independent sequence, busy state, cumulative root/all loop totals, and the latest host resume receipt.
- Old v2 watchdog messages are not interpreted as v3 facts; mixed versions fail closed.
- Remove `ReflectDomainCounters.certain` from public types and the counters wire entirely.
- No timer or automatic Reflect gate may depend on transport-wide certainty.

## Required lifecycle semantics

- Online peers are pending and contribute no busy state until a valid v3 checkpoint is accepted.
- Offline immediately removes the current live contributor; no retirement timer or authoritative tombstone.
- A fresh live contributor ID fences stale offline/leave facts from a replacement.
- Same-incarnation reconnect within the 10-second ledger window restores only exact cumulative loop delta.
- After ledger expiry, a host resume receipt identifies reconnect and accepts zero delta while seeding the current checkpoint as baseline.
- A true first join without a resume receipt may count its current cumulative totals from zero.
- Pause/resume changes accounting generation and clears live contributors/ledger; old-generation checkpoints are rejected.
- Active/task time is projected from reducer time and live busy contributors; it is never backfilled for offline time.

## Implementation slices

1. Introduce and validate checkpoint-v3 and counters-v3 wire shapes plus adapter session/receipt state.
2. Replace host accounting mutations with `reduceCollectionState()` and `snapshotCollectionState()` projection while preserving the existing coordinator interface.
3. Replace child writes/reconnect replay with one ordered checkpoint path and remove v2 subscriptions.
4. Remove `certain` from `ReflectDomainCounters`, counters parsing, tests, and `safeToDispatch()`.
5. Update distribution and Git-fixture allowlists for the internal collection-state build artifacts/source.
6. Add deterministic unit regression for abrupt old peer death, replacement, stale events, loop continuity, and resumed time.
7. Add packed cross-process SIGKILL/replacement E2E.

## Verification

- Focused unit regression fails on the old certainty/tombstone runtime.
- `npm run check` passes.
- `npm run test:e2e:fast` passes, including packed abrupt child death/replacement.
- `git diff --check` and final fresh-context review pass.
