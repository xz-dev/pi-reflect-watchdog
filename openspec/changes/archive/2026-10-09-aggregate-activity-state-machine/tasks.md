# Tasks: aggregate activity state machine

- [x] Formalize the state machine in Lean 4 (`docs/programming-thinking/reflect-activity-state-machine.idea.lean`)
  - [x] Phase type + ActivityState + transitions (advance/heartbeat/contributorBusy/contributorIdle/graceExpired/loopRecorded)
  - [x] wellFormed invariant preserved across all transitions
  - [x] Prove main_stop_not_all_stop, last_busy_enters_grace, grace_expires_to_idle, sleep_freeze_exact, busy_tick_continuity, no_active_loss_in_grace
  - [x] Executable demo scenario via #eval; axioms clean
  - [x] Pass-2 section comments
- [x] Map to `src/collection-state.ts`
  - [x] `graceSinceMs` accounting field + `phase` snapshot field
  - [x] Four-branch `withLive` phase machine (idle/grace/collecting transitions)
  - [x] `tick` event + reducer (sleep freeze on open active interval only)
  - [x] Constants GRACE_FENCE_MS/HEARTBEAT_MS/SLEEP_GAP_MS
- [x] Wire host heartbeat in `src/process-domain.ts` (busy tick reduces `tick`)
- [x] Tests
  - [x] Three new grace-phase tests (Lean theorem mapping)
  - [x] Update retained-reconnect + idle-reset for grace semantics
  - [x] typecheck + lint + 118/118 unit green
- [x] Independent semantic round-trip review of the Lean file — originally blocked on the subagent model resolver. Closed 2026-10-09: two independent fresh-context Lean readings (hash-pinned, file-only) covered `docs/programming-thinking/reflect-activity-state-machine.idea.lean` as later extended by `simplify-reflection-runtime`; no contradictions; scoping limits (task-clock invariant, monotonic-time assumption, no runtime refinement) recorded in that change's archive.
- [x] Optional: 5s idle-side heartbeat to settle grace with zero events — dropped, not implemented (closed 2026-10-09). Settle-on-next-observation remains correct, and the activity accounting contract is now `reflection-runtime-accounting`.

## Closure (2026-10-09)

This change predates the spec-driven artifact set and has no delta specs (`skip_specs: true`). Its behavior is specified by the main `reflection-runtime-accounting` capability, synced from the archived `simplify-reflection-runtime` change. Closed and archived with the user's approval.
