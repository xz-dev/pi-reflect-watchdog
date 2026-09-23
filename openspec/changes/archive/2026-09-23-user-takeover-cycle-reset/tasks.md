## 1. Reducer and coordinator reset

- [x] 1.1 Add a full-cycle reset event to `src/collection-state.ts` and verify focused reducer tests show `activeMs`, `activeLoops`, `taskMs`, `rootLoops`, and `allLoops` all return to zero while unrelated accounting invariants remain intact.
- [x] 1.2 Add a coordinator API such as `resetCycleOnUserTakeover()` in `src/process-domain.ts` and verify process-domain tests show root-only reduction plus counter publication after reset.

## 2. User-message takeover detection

- [x] 2.1 Extend the existing `message_start` handling in `src/extension.ts` to reset only for current-main real user-role ordinary messages, and verify runtime tests cover ordinary user reset, non-main ignore, and plugin-owned inquiry/fold/continuation exclusion.
- [x] 2.2 Clear stale automatic intent (`latched` and `pendingAutomatic`) on accepted takeover reset while preserving `manualQueue`, and verify runtime tests prove pre-reset automatic work cannot dispatch afterward while queued `/reflect` remains available.

## 3. Abort takeover detection

- [x] 3.1 Add branch-boundary abort detection around `agent_start`/`agent_settled` using the narrow pi-continue-watchdog semantics, and verify runtime tests cover aborted terminal assistant reset, non-aborted settlement preservation, and missing-boundary no-op behavior.
- [x] 3.2 Preserve existing active reflection completion/cancellation ordering before abort reset effects, and verify runtime tests cover reflection result persistence and continuation behavior when a run ends aborted.

## 4. Documentation, formal model, and validation

- [x] 4.1 Update `README.md` lifecycle/reset behavior and verify the documented reset scope matches the new spec scenarios.
- [x] 4.2 Synchronize affected `docs/programming-thinking/*.idea.lean` models and verify the documented Lean validation commands pass.
- [x] 4.3 Run `npm run check` and the relevant fast/full E2E suites, then verify all new takeover reset tests pass without regressing existing reflection lifecycle tests.
