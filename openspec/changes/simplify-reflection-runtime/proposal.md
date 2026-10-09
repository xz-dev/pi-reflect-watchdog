## Why

Reflection accounting currently mixes Pi activity with counting pause hooks, timer-driven threshold latching, and event-incremented loop totals. Use Pi's live state and branch APIs as the accounting sources of truth, and make an ordinary completed turn the single automatic decision boundary, while preserving the separate user-abort protection policy.

## What Changes

- Refresh displayed time and loop values once per second. Keep time in memory, use monotonic elapsed time rather than counting timer callbacks, and retain a bounded long-gap approximation for process suspension.
- Set the counting switch to `1` when any participating Pi agent is working and `0` when all are idle. This switch is not an initial elapsed second. Reflection, retry, and other host-owned work use the same official busy signal; valid ordinary loop filtering remains separate.
- Derive valid loop counts from Pi-managed current-branch entries, never by opening, parsing, watching, or rewriting JSONL files directly. Reuse the existing agent-produced-message allowlist and existing process-domain aggregation for participating children.
- When no native-abort hold applies, each new valid ordinary `turn_end` from any participating main or child agent checks fresh root-loop, all-loop, and task-time limits with OR semantics. Only the current main submits reflection. Apply existing cooldown and inquiry serialization, then submit through native `steer` with `triggerTurn: true`, without aborting or overtaking earlier steering messages. A final ordinary turn, including a child's turn while the main is normally idle, may consequently schedule reflection. Replayed checkpoints and ordinary synchronization are not new triggers; child turns during abort hold cannot wake reflection.
- Stop automatic threshold evaluation from timer ticks, generic counter publications, ownership notifications, and settlement. Do not retain automatic requests or threshold reasons for later dispatch when the current turn cannot dispatch.
- Preserve ordinary-user-message resets and existing reminder/idle-gap cycle boundaries. Clear memory-only clocks on session replacement or actual tree navigation; rebuild branch-sensitive loop views through Pi APIs. Ordinary leaf advancement and compaction are not navigation.
- **BREAKING**: Remove plugin-owned counting pause/resume control and `hookPauses`. Keep manual `/reflect`, its single coalescing waiting slot, withdrawal-only `/cancel-reflect` and `cancelShortcut`, their queued-state hints, native Pi Stop, and necessary inquiry cleanup.
- Preserve true main-abort reset and the explicit-input hold specified by `yield-reflection-on-user-abort`: cancel old inquiry authority, unsubmitted pending work, and staged results; only new interactive/RPC input or a new `/reflect` releases the hold after a fresh-cycle reset. Children remain observable but cannot cause new reflection submissions during hold. This is dispatch inhibition, not a counting pause.
- Keep immediate native steering rather than busy-time plugin custody. Explicitly narrow cancellation guarantees for already-submitted native work: residual queue slots can cause ordinary requests, charges, or ordinary tool calls after re-entry. They cannot restore old `ref` authority, correction, successful finalization, or completion hooks.
- Coordinate with, rather than supersede, the abort protection change. Preserve unrelated result-schema, provider-retry, transport, and completed-report behavior; this planning pass does not edit the other change or its implementation.

## Capabilities

### New Capabilities

- `reflection-runtime-accounting`: Pi-derived branch loop counts, aggregate-working memory clocks, one-second display refresh, and removal of plugin counting pauses.
- `turn-end-reflection`: Fresh automatic threshold evaluation at valid ordinary turn completion and non-aborting native steering submission.

### Modified Capabilities

- `manual-reflect-queue`: Keep immediate manual steering, serialization, and withdrawal-only controls; remove counting-pause exceptions and retain explicit `/reflect` re-entry.
- `user-takeover-cycle-reset`: Add memory-clock reset and branch-view reconstruction on navigation without replacing the separately owned user-abort contract.
- `conversation-grounded-reflection`: Reconcile lifecycle preservation with working-only time accounting, non-latched scheduling, and retained abort protection.
- `reflection-response-contract`: Scope bounded invalid-submission correction to non-aborted attempts; the companion change owns abort precedence and revoked inquiry authority.

## Impact

**Coordinated decision:** The user's 2026-10-08T13:04:57.734Z decision retains true-abort protection and selects immediate native steering with the stated residual-request risk. `yield-reflection-on-user-abort` owns that public cancellation contract; this change owns accounting and live main/child completion triggering. Their shared lifecycle/result deltas must be reconciled before integration or spec synchronization so neither archive overwrites the other's final contract. Removing withdrawal-only controls was not independently authorized and is not in scope.

- Expected implementation areas: `src/extension.ts`, `src/collection-state.ts`, `src/process-domain.ts`, `src/config.ts`, `src/index.ts`, and `src/widget.ts`; corresponding existing runtime, reducer, coordinator, configuration, widget, and controlled-provider integration tests.
- Implementation must update README and affected `docs/programming-thinking/*.idea.lean` models. This proposal changes only files under its own change directory and claims no implementation or formal proof.
- No new timer dependency, Pi core modification, private queue access, custom transcript parser, history rewrite, deployment, global configuration edit, or change to `ref`'s public result schema.
- Child scope remains Reflect-loaded participants in the existing process domain. This does not add observation of unrelated sessions, external CLI agents, or recovery of historical child sessions absent from that domain.
- Preserve transport authentication, replay/identity validation, and the load-order-independent enrollment work in `fix-shared-domain-reflect-accounting`; supersede only incompatible pause/time/scheduling rules in overlapping plans. Mixed-version private protocol compatibility is not assumed and must be assessed before rollout.
