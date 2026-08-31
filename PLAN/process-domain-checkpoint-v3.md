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
- The adapter relies on `pi-extension-utils` synchronously emitting replacement as old `offline` followed by new `online`; raw peer events expose only `nodeId` and cannot fence arbitrary reordered offline facts.
- A fresh live contributor ID plus `(senderId, incarnation, contributorId)` fences stale v3 checkpoint and leave messages after replacement.
- Same-incarnation reconnect within the 10-second ledger window restores only exact cumulative loop delta.
- After ledger expiry, a valid host resume receipt identifies reconnect and accepts zero delta while seeding the current checkpoint as baseline.
- A true first join is accepted as full cumulative delta only when the host has never seen the replay key and no receipt is supplied.
- A host-lifetime seen/receipt registry remains independent of the expiring ledger; a seen replay key with a missing or invalid receipt is never reclassified as a true first join.
- Pause/resume changes accounting generation and clears live contributors/ledger; old-generation checkpoints are rejected.
- Active/task time is projected from reducer time and live busy contributors; it is never backfilled for offline time.

## Application acknowledgement and replay

- Every new local state and every reconnect dispatch receives a strictly increasing checkpoint sequence; a client never resends the same sequence.
- `counters.v3` echoes each accepted `(incarnation, contributorId, accountingGeneration, seq, resumeReceipt)`.
- A client exposes ordinary counters only after the echo covers its latest required sequence.
- The host applies receipt classification in this exact order:
  1. any non-empty invalid receipt: reject;
  2. unseen replay key with no receipt: true first join, accept full cumulative totals;
  3. unseen replay key with any receipt: reject;
  4. seen replay key with retained ledger and valid receipt: accept exact delta;
  5. seen replay key with retained ledger and no receipt: treat as lost acknowledgement, accept exact delta, and echo the existing receipt again;
  6. seen replay key without retained ledger and valid receipt: accept zero delta and seed the current totals;
  7. seen replay key without retained ledger and no receipt: reject.
- Receipt validation binds the host domain and replay key, not the accounting generation.

## Pause control handshake

- The counters wire has a control header (`domainEpoch`, `accountingGeneration`, `paused`) that clients accept independently of checkpoint acknowledgement.
- On generation change the client discards its prior live contributor identity and creates a fresh contributor ID while preserving cumulative loop totals and its valid host receipt.
- While paused the client sends no checkpoint.
- On resume the client re-probes live busy state and sends a checkpoint in the newly accepted generation; ordinary counters remain hidden until that checkpoint is echoed.

## Implementation slices

1. Introduce and validate checkpoint-v3 and counters-v3 wire shapes plus adapter session/receipt state.
2. Replace host accounting mutations with `reduceCollectionState()` and `snapshotCollectionState()` projection while preserving the existing coordinator interface.
3. Replace child writes/reconnect replay with one ordered checkpoint path and remove v2 subscriptions.
4. Remove `certain` from `ReflectDomainCounters`, counters parsing, tests, and `safeToDispatch()`.
5. Update distribution and Git-fixture allowlists for the internal collection-state build artifacts/source.
6. Add deterministic unit regressions for abrupt old peer death/replacement, delayed stale v3 checkpoint/leave, application-ACK loss, pause/resume control headers without checkpoint echoes, loop continuity, and resumed time.
7. Add packed cross-process SIGKILL/replacement E2E that relies on the utility's ordered old-offline/new-online replacement contract.

## Verification

- Focused unit regression fails on the old certainty/tombstone runtime.
- `npm run check` passes.
- `npm run test:e2e:fast` passes, including packed abrupt child death/replacement.
- `git diff --check` and final fresh-context review pass.
