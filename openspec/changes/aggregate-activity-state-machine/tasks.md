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
- [ ] Independent semantic round-trip review of the Lean file — BLOCKED: subagent model resolver appends thinking suffix (`:high`/`:max`) to the model id before registry lookup, so every grok-4.6 / glm-5.3-flash / kimi variant resolves to a non-existent id and is exclusion-cached until 2026-09-11; `pi -ne` CLI model registry is inconsistent with `--list-models`; claude binary missing. Needs owner: fix resolver or point to a working model/auth.
- [ ] Optional: 5s idle-side heartbeat to settle grace with zero events (deferred; settle-on-next-observation already correct)
