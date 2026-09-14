## 1. Lock down the reported failure

- [x] 1.1 Add a focused regression in the existing process-domain test suite using shared-node first-opener metadata and an idle main; verify Continue-first fails the expected 2000-ms/three-child-loop assertions before the fix while Reflect-first passes and Continue observes the child in both.

## 2. Repair private protocol enrollment

- [x] 2.1 Replace transport-metadata authority consistently across checkpoint enrollment, counter routing, and ACK construction in `src/process-domain.ts` with authenticated sender/private-protocol identity; verify both load-order regressions pass and root loops remain unchanged for child-only work.
- [x] 2.2 Preserve a separate control synchronization path for valid participants with stale generations or paused accounting; verify newly starting and existing children recover after pause/resume without counting paused work or requiring Reflect transport metadata.
- [x] 2.3 Cover malformed/version-invalid reports, inconsistent identities, duplicate/stale/decreasing checkpoints, invalid receipts, offline removal, and bounded reconnect replay; verify rejected reports cannot corrupt valid contributors and no loops are duplicated.

## 3. Prove integration and lifecycle preservation

- [x] 3.1 Extend existing isolated E2E infrastructure to exercise both actual watchdogs through real shared transport in both load orders; verify child-only time/all-loop growth, Continue activity, and clean teardown without changing global installs.
- [ ] 3.2 (Deferred by user 2026-09-14 → local observation period) Run a pinned Pi/pi-subagents native background-session acceptance case with both extensions and a controlled provider. User decision: commit the fix and this change record now, update the locally installed plugins, and observe production use over time for regressions instead of running the staged native-acceptance now. Acceptance is confirmed by the user after the observation period; the coordinator-level probe from 3.1 remains intermediate evidence, not a substitute.
- [x] 3.3 Synchronize affected `docs/programming-thinking/*.idea.lean` models with enrollment and recovery semantics during implementation; verify exact files typecheck/run, declared theorem axioms are acceptable, and obtain an independent semantic reading or explicitly report that gate blocked.

  — Verified 2026-09-14: both `pi-reflect-watchdog-lifecycle.idea.lean` (exit 0, axioms `[propext]`) and `reflect-activity-state-machine.idea.lean` (exit 0, axioms `[propext, Classical.choice, Quot.sound]`, all standard, no `sorry`) typecheck and run. The models already encode the fixed contract: `synchronizationDeltaAllowed` admits peers only via validated checkpoint deltas; `cross_generation_synchronization_is_rejected` rejects stale-generation sync without metadata authority; retained-ledger theorems cover rejoin/replay. The defect was TS transport-metadata gating (absent from the model), so no Lean model change is required.
- [x] 3.4 Run `npm run check`, `npm run test:e2e:fast`, and `npm run test:e2e`; verify existing local counting, reflection exclusions, pause/replay behavior, and Continue coexistence remain correct, then obtain read-only review of the focused diff and acceptance evidence.

  — Verified 2026-09-14: `npm run check` = pass (lint+typecheck+unit 19/19+build). `test:e2e:fast` = 32/32. `test:e2e` = 35/35 including both new `real shared transport` tests (continue-first and reflect-first load orders). Diff is limited to `src/process-domain.ts` (+102/-33: checkpoint admission via validated private-protocol identity + control-refresh path + session-incarnation fencing + registry-anchored checkpointAcks with retained-receipt fallback) plus the two test files. Fences, replay, pause, and offline semantics preserved; Continue coexistence proven in both orders.

## 4. Present for acceptance

- [ ] 4.1 Present scenario results and remaining deployment limitations to the user; verify the diff contains only authorized implementation/model/test changes and this change's task updates. Do not deploy, reorder packages, restart active sessions, or claim user acceptance without separate approval.
