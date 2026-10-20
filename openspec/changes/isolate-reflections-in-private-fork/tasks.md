## 1. Prove background execution feasibility before production cutover

Authorized order: determine Reflect requirements → extract shared module in utils → adapt Reflect → adapt Continue → verify and push all through the coordinator. Background execution and local-read-only helpers supersede the former native inquiry-slot/extension-helper gates; no checkbox is satisfied by that decision alone.

- [ ] 1.1 Probe stock Pi1.3.0 trigger-time frozen source and non-blocking background execution; verify parent progress, busy result steering after the complete tool batch/earlier messages, idle exactly-one-request result delivery, and zero parent requests for failure/no-result/cancel/stale. Qualify the latest replayable persisted anchor, excluding an open tool batch without waiting or losing full prior ancestry.
- [ ] 1.2 Verify the shared local-read-only profile: SDK read/ls/grep/find and qualified parent session file read, no third-party helpers/commands/delegation; ten-call lifetime budget across three terminal attempts, helper-only progress, result writing after exhaustion, atomic rejected/mixed batches and exact cancellation.
- [ ] 1.3 Verify provider error/native retry classification and official exact-child working observations without ordinary-loop charges; probe immediate user/branch/owner revocation during provider streaming and slow helpers, aborted settlement/no follow-up/file acceptance, parent independence, unchanged stale-drop accounting and no new inquiry until a fresh ordinary threshold crossing.

## 2. Connect private reflection and retire new ref submission

- [ ] 2.1 Raise project SDK/test and minimum support to Pi>=1.3.0 and consume the verified shared subpath; verify installed host identity without global upgrade or old-host/fresh-context fallback.
- [ ] 2.2 Replace main-session inquiry execution with one private frozen full-fork child admitted at trigger time; verify captured model/thinking/context/anchor, compaction/exclusions, open-batch qualification and parent progress without any inquiry scheduling/wake message.
- [ ] 2.3 Reuse five-field validation and custom perspective through local-evidence/file prompts and same-child correction; verify normalization/trim/size, ten-helper/three-terminal bounds, helper-only progress, reset and no post-write acknowledgement request.
- [ ] 2.4 Remove owned public ref/schema preparation and new main inquiry/correction traffic; verify no result function or orchestration surface, foreign ref/cw untouched, and private path/thinking/helper traffic excluded from main and summaries.

## 3. Preserve ownership, accounting and durable result delivery

- [ ] 3.1 Integrate background admission with fresh turn-end OR thresholds/manual queue; preserve admission reminder resets, no timer or latched automatic intent, one active inquiry, pending-only withdrawal, manual coalescing and ordinary parent/child counting.
- [ ] 3.2 Bind source/owner/session/cycle/branch/input epochs to immediate exact-child cancellation; revoke before abort/drain, interrupt provider/helper work, keep checkpoint guards as backstops and document earliest public event coverage. Verify no late acceptance/correction, reset-before-release, post-abort hold, unrelated parent safety and pending-only cancel-reflect.
- [ ] 3.3 Preserve official active-time/root/all/cooldown accounting: include exact private working time but not private loops, preserve other watchdog identities, keep admission reset after stale drops, do not erase later parent progress, and launch no replacement or reevaluation from drop callbacks.
- [ ] 3.4 Publish only current terminal candidates after durable result and completion marker; preserve one hook, report body/type-specific fields, automatic-assistant/manual-user feedback and separate two-line continuation. Verify busy native steering versus idle exactly-one-request delivery, with no parent traffic for unsuccessful outcomes.
- [ ] 3.5 Preserve legacy report/inquiry readers and native summary recovery; historical ref records stay readable without callable authority/transcript rewriting, and temporary files/child transcripts grant no restart or completion authority.

## 4. Verify installed behavior and formal documentation

Evidence boundary: `ControllerOutcomeStub` tests are controller policy units, not shared-runtime integration evidence. Driver-based `an invalid private result is corrected inside the bounded attempt chain`, `private file correction uses …`, source-binding/provider-serialization, manual queue/drain and abort-clock tests execute the actual shared runner with real result files; the stub does not validate, correct or count attempts.

Escape evidence: red `/var/tmp/reflect-check/escape-red.tap`, green `/var/tmp/reflect-check/escape-green.tap` (idle owned abort once + queued retirement, busy pass-through, listener replacement/shutdown). The installed TUI gate found that Pi builds a fresh context per event, so a listener `runtime.ctx === ctx` guard let idle Escape pass through; the guard was removed (scope = listener lifetime): red `/var/tmp/reflect-check/escape-ctx-red.tap`, green `escape-ctx-green.tap`. Installed TUI (real Bun `pi install git:` loopback snapshot, gpt-6-luna, `/var/tmp/reflect-tui/logs/{boot,s3,esc2}.txt`): clean load of `src/extension.ts`, no private text in main session/screen, idle Escape aborted the exact child in ~108 ms with one notice and no continuation.

Formal model: `docs/programming-thinking/private-reflection-manual-identity.idea.lean` (sha256 `9b5c2945…a8fcd`) models manual identity, takeover, idle Escape and slot release against `src/extension.ts` `67730966…`; `lean` and `lean --run` exit 0 (`/var/tmp/reflect-check/lean-manual.log`). Fresh blind reviews: `/var/tmp/reflect-lean-manual.8CoNwq/reader/REVIEW-b413412f.md` (FAIL, 3 P2), `REVIEW-4b5f61e7.md` (FAIL, 1 P2), `REVIEW-9b5c2945.md` (APPROVE within declared scope); all findings were model-correspondence fixes. `pi-reflect-watchdog-lifecycle.idea.lean` is marked historical for its main-session inquiry steps.

Install gates: Pi's xz-dev standalone build installs with embedded Bun, which ignores npm `allowScripts`; `trustedDependencies: ["pi-extension-utils"]` lets the reviewed runtime preparation run. Red/green: `/var/tmp/reflect-pi-install-gate{-red,}/install.log` ("Blocked 1 postinstall" without it). `test/install-policy.test.ts` pins both policies; `scripts/pi-install-smoke.sh` runs the real `pi install` + `pi -p` load under `env -i`.

Private-completion cooldown recognition is covered by branch-accounting tests (correlated result entry, interleaved foreign entry, mismatched id, orphan marker), not by a Lean model.

CI (`.github/workflows/ci.yml`): `npm run check`, full packed/Git `npm run test:e2e`, npm Git-clone production install (fails unless `Prepared private pi-subagents` and `./watchdog-runtime` export), then the released standalone Pi `xz-v1.3.0-xz.339.1.g12ba93b4` (sha256-verified) runs a real `pi install git:` of this commit from a loopback git daemon via `scripts/pi-install-smoke.sh`. A Bun-emulation step was dropped as a non-representative gate. Packed E2E mapping: `PLAN/reflect-private-test-migration.md` ("Packed E2E replacements").

Kept-assertion review b9071717 (`/var/tmp/reflect-frozen-1046/KEPT-REVIEW.md`, CHANGES REQUIRED, F1–F10): each finding is now an executable assertion; mapping rows name the finding. Staged-valid-then-abort is a driver unit over the real shared runner because acceptance coincides with the write in a real child. Gates: `npm run check` 217/217 (`/var/tmp/reflect-check/final-check2.log`), `npm run test:e2e` 38/38, 0 skipped (`final-e2e2.log`).

Known limits: (1) a non-decision private failure (for example provider transport errors after native retries) is silent; only an invalid-decision failure notifies. (2) After an Escape abort, the third-party provider extension may record its own aborted-socket error entry/notice; Reflect adds nothing.

Known liveness limit: liveness depends on host abort settling prompt; a host that never settles leaves the reflection slot held until session shutdown. A nonsettling fake-host characterization checks no overlap and no main-session effects; it does not require forced release or replace real-SDK cooperative abort evidence.

- [ ] 4.1 Update README/behavior docs and affected lifecycle/activity/readiness Lean models; exact files must pass typecheck/run/proof checks and fresh independent semantic reading, without host/provider refinement claims.
- [ ] 4.2 Run complete npm run check, npm run test:e2e and clean production-only Git/packed distribution cases; verify supported-host outcomes beyond checkout imports or synthetic tool results.
- [ ] 4.3 Run actual TUI background busy/idle/manual/automatic/immediate-cancellation cases with gpt-6-luna and co-installed Continue, public subagents and foreign ref/cw; verify no private residue, actual abort outcomes, result-time native order, exact-once hooks/continuation and unchanged ordinary controls.
- [ ] 4.4 Deliver requirement-to-command evidence with dependency identity, compatibility limits and rollback; distinguish fixture/agent-run evidence from human acceptance. Coordinate frozen tested candidates/pins before authorized command-scoped unsigned commits/pushes; no independent lane publication, global signing changes, force push, tag or release.
