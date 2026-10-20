# Private reflection — approved background path evidence

## Status and authority

- **Work:** current planning/Interface/probe assignment complete; production adaptation waits for coordinator's shared candidate.
- **Verification:** coordinator independently reproduced background8/8 and full probe21/21, checked all five candidate hashes, strict validation and zero production diff (intercom `3330312d-3989-45c8-9ce5-93b5e04950ba`). Repaired Lean model independently approved within its declared abstract scope; review details below. Earlier 8/13-check research was independently verified but its former native-slot/helper requirements are superseded.
- **Acceptance:** coordinator relayed human decisions; shared-runtime/product acceptance pending. OpenSpec remains **0/16**, not automatically completed by SDK fixtures.
- Baseline: `bc4dfe3bad9b276d61a7dfc8a69b8c4307f3f96f`. `src`, `package.json`, `package-lock.json`, README and Pi0.99.2 project dependency baseline have zero diff. No sibling writes, host changes, global changes, commit or push.

Authority: Reflect change `openspec/changes/isolate-reflections-in-private-fork/`; shared planning in `pi-extension-utils/openspec/changes/share-private-inquiry-runtime/`. Coordinator relayed human selection of background trigger-time capture and read-only local evidence in intercom `c420679e-7309-4487-82d1-09ce42b05059`, then immediate event-driven cancellation in `d5cdf52c-13a8-4556-b973-b4a25dd4b028`. Coordinator accepted currentness/source and stale accounting in `5814182e-4161-430e-9363-43964baab80b` / `efe5c6d5-1a11-4fc2-8aa5-180185715686`.

Order remains Reflect requirements → utils extraction → Reflect adaptation → Continue adaptation → joint verification/coordinated pushes. No lane commit/push until frozen tested state and pins are coordinated.

## Final shared contract

`PLAN/reflect-private-inquiry-interface.md` is the current consumer contract. It requires frozen qualified full ancestry, local SDK read/ls/grep/find, bounded same-child file results, explicit native retry policy, exact-child official activity and immediate signal/cancel/drain. The shared layer does not own Reflect's triggers, stale-event policy, counters/cooldown or publication.

Snapshot anchor: latest replayable persisted entry at trigger time; exclude an open assistant tool batch, keep full ancestry. Freeze before async setup. No valid anchor is typed setup failure, not parent waiting/abort or a fresh fallback.

Currentness tolerates ordinary parent progress/native compaction. New non-owned input queued/delivered, branch navigation, source loss, owner/session/cycle replacement or abort/shutdown immediately revokes authority and signals exact-child cancellation. Checkpoint guards remain backstops. Only a current result plus durable completion marker authorizes hook/feedback: busy native steer, idle exactly one triggered ordinary request. Other outcomes insert nothing.

Stale cleanup preserves admission's reminder reset and historical cooldown, changes no accrued ordinary counters, and launches no replacement. Only another fresh ordinary threshold crossing can launch again. Explicit user takeover retains the existing full-cycle reset. `/cancel-reflect` remains pending-only.

## Exact candidate and environment

| Artifact | SHA256 |
| --- | --- |
| `scripts/e2e/private-inquiry-feasibility.mjs` | `241858d26f4a4d3098ed6b960e71ec780a047dfe823a2187339f921c045ab1b7` |
| `.pi/verification/private-inquiry-background/probe.tap` | `3f26788d72e52cb8b589b1bafd3ac642969527740195848be61efb7b9faae67e` |
| `PLAN/reflect-private-inquiry-interface.md` | `a23064164d9859e49f01358a7752d71e3fd770795fd6ebabbc3bfd03f4da8549` |
| `docs/programming-thinking/private-reflection-readiness.idea.lean` | `c0e277692d3f21f5b9b68c21a59ad0b49c526e420155f266d7fa848c84c6985c` |
| SDK `dist/core/agent-session.js` | `d0b4545a5da7fe97aa699269e64e27b37ee2fb5b7985efb1c0a66fc3d1883b52` |

SDK root, read-only: `/home/xz/Code/ai/pi-continue-watchdog/node_modules/@earendil-works/pi-coding-agent`, stock1.3.0. Probe explicitly imports that SDK and sibling pi-ai; no global Pi change. Node26.12.0 runs the fixture and existing pure TypeScript branch-accounting module. Temporary resources are isolated under `/var/tmp`. `/usr/bin/rg` and `/usr/bin/fd` were present before grep/find execution; no tools were installed. Providers are in-process synthetic streams, not remote models.

## Reproduce current checks

```sh
PI_REFLECT_PROBE_SDK_ROOT="/home/xz/Code/ai/pi-continue-watchdog/node_modules/@earendil-works/pi-coding-agent" \
TMPDIR="/var/tmp" node --test --test-reporter=tap --test-concurrency=1 \
  --test-name-pattern="background:" "scripts/e2e/private-inquiry-feasibility.mjs"
"./node_modules/.bin/biome" check "scripts/e2e/private-inquiry-feasibility.mjs"
openspec validate "isolate-reflections-in-private-fork" --strict
lean "docs/programming-thinking/private-reflection-readiness.idea.lean"
lean --run "docs/programming-thinking/private-reflection-readiness.idea.lean"
```

All final commands exit0. TAP: **8 tests, 8 pass, 0 fail/cancelled/skipped**, 6322.976627ms. The name filter selects the eight approved-background cases, not prior superseded candidate tests. Adjacent `biome.txt`, `openspec.txt`, `lean-check.txt`, `lean-run.txt` retain output. Initial OpenSpec scenario-name compatibility and Lean record-layout errors were corrected before this final revision; they are not runtime findings.

## Eight tested cases and scope

1. **Background independence/source/busy delivery.** Real parent parallel tools progress while private response is parked. Native branch snapshot ends before the open batch; later parent work/queued input is absent from child input. A fixture-supplied current candidate is recorded before hook/feedback. Feedback arrives only after whole batch and earlier steering: parent requests = original work + earlier user + one result continuation. Private prompt stays out of parent requests. Earlier input is queued before capture and is not delivered until after durable completion in this delivery case.
2. **Idle delivery.** Private operation adds no request at trigger. One successful feedback delivery with `triggerTurn` causes exactly one parent request.
3. **No result.** Private normal response without candidate creates zero parent requests and no custom entry/message in parent.
4. **Provider failure.** Private error creates zero parent requests/messages. Native retry policy characterization remains in earlier cases; this case deliberately settles one failure.
5. **Local grep/find.** Isolated child executes native grep/find over fixture evidence successfully with only read/ls/grep/find active. Read/ls were exercised in prior checks.
6. **Immediate provider cancellation.** Queued user input synchronously retires authority and requests child abort while the synthetic provider stream is in flight. Trace: `authority-revoked → provider-signal-aborted → child-settled`. Signal observed before input dispatch returns; settlement is aborted, child provider calls=1, staged valid file accepted=0. Parent remains busy and later serves only its actual user steering, no reflection request.
7. **Immediate helper cancellation.** Same assertion through a slow signal-aware fixture helper: `authority-revoked → helper-signal-aborted → child-settled`. No helper follow-up/provider retry/correction, staged file accepted=0, unrelated parent work continues. This synthetic slow helper tests cancellation wiring, not admission of third-party helpers.
8. **No stale-trigger loop.** Fixture controller uses production `deriveBranchAccounting` against native session entries. Admission records the existing reminder reset. Repeated stale drops change no counters/cooldown or launch count. One new ordinary loop stays below threshold; only the second fresh ordinary loop reaches threshold and admits another inquiry.

These are **SDK and candidate-controller checks**. Success publication uses a fixture candidate and fixture result/completion records; it does not certify shared file validation, atomic batch admission, ten-helper/three-terminal budgets or full Reflect integration. The staged-file cancellation assertion verifies that revoked authority does not read/accept an available valid file; the actual shared reader awaits its own tests.

## Event coverage and remaining checks

Currentness/cancellation map is explicit in the Interface/design: `input` for queued/fresh user input; user `message_start` for input accepted before capture; user `before_agent_start` fallback; before-switch/fork/tree and session teardown/backstops; owning main signal/aborted outcomes; direct ownership/cycle transition callbacks. Anchor ancestry is checked at received lifecycle/session events and checkpoints. Silent external mutation without an event is detected only on next observation. This run exercises `input` cancellation; other revocations still need integrated runtime tests.

### Repaired Lean model — independently reviewed

Initial semantic review found missing admission guards and cancellation effect/progress coverage. Model-only repair adds inactive/fresh-ordinary-threshold admission, guarded provider/helper/correction/publication effects, abstract operation identity, stale-only trace history preservation and conditional cancellation progress. “Crossing” means a fresh ordinary completion at or above threshold; progress while active does not latch a later admission. Cooperative cancellation explicitly assumes an eventual matching settlement event. Without that assumption, drain need not occur.

Fresh blind reader `d0b9ac20` approved the exact SHA above within its declared abstract scope (coordinator intercom `ea4ba52a-e30d-42e0-a7ca-1d3376985f77`). This lane read the full report and rechecked the source SHA. Reviewer independently ran Lean4.35.0 typecheck and execution: both exit0; `process_is_correct` trusts only standard `propext`; no forbidden tokens. All15 named theorems inspected, none vacuous. Six false witnesses rejected: duplicate launch without fresh crossing, post-revoke effect, old-operation publication, wrong-operation settlement, launch while pending and latched-progress relaunch. Valid fresh relaunch and a non-cooperative schedule that never drains were also checked.

- Report: `/home/xz/.pi/agent/sessions/--home-xz-Code-ai-pi-continue-watchdog--/subagent-artifacts/d0b9ac20-4d84-46ab-b61a-5ed405e777a2_reviewer_output.md`.
- Repaired-model producer logs: `.pi/verification/readiness-model-repair/check.log`, `run.log`; prior source: `before.idea.lean`. Earlier background-folder Lean logs describe the superseded model.
- Proved scope: abstract admission/effect safety, stale-only traces without ordinary turns, and eventual inactive state under cooperative settlement. Fixed planning order is data, not execution enforcement. Four readiness evidence fields remain unverified.
- Explicitly unmodeled/pending: frozen full-fork source/open batches/model selection; concurrent parent progress; busy/idle delivery and failure/no-result request silence; helper whitelist/budgets/same-child correction; file validation/durability before hooks; native retry/native identity/private-loop exclusion; abort hold/manual pending queue/takeover resets; SDK/transport refinement, real interruption and wall-clock bounds. Abstract publication is one effect, not a durability-order proof.

Still pending: shared candidate, production adaptation, full check/E2E, clean Git/packed distribution, actual TUI and gpt-6-luna tests, dual-watchdog interactions, all revocation combinations, integrated-candidate review and human product acceptance. No host timing/helper capability decision remains open under the coordinator-relayed requirements. Production remains on hold; shared candidate is being prepared by moving Continue's proven private-decision core and porting its conformance tests, not by rewriting it.

## Historical evidence retained

- Round one: `.pi/verification/private-inquiry-feasibility/round1-probe.mjs` SHA `ec7222cc7065b3971e0a115969261fe7a3131920ec688e1ce435f3a3d9e36347`; original TAP remains alongside it. Coordinator independently verified8/8.
- Round two: `.pi/verification/private-inquiry-feasibility-round2/probe-source.mjs` SHA `fbb1d38d3a4842a7e9f22c8c4070cf80a80526983bea4574e6fe0d79dc1014d9`; TAP/old ledger in same directory. Coordinator independently verified13/13.
- Those rounds rejected particular native-slot/extension-helper candidates, not every public API composition. The `all`-mode parent request can serve earlier user input; only isolated one-at-a-time/idle cases showed slot-only requests. Their proposed host scope is now superseded and not authorized work.
