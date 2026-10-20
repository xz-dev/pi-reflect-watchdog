# Private reflection test migration evidence

Status: implementation in progress, not release acceptance. Coordinator owns commits and pushes. No checkmark below substitutes for installed-host, formal-model or human acceptance.

## Retired mechanism replacements

IDs refer to the fixed one-pass triage at `/var/tmp/reflect-runtime-triage.md`. Historical readers, including the original malformed/correlation projection test (#50), remain supported.

| Triage ID / old scenario | Retired requirement | Current replacement in `test/runtime.test.ts` |
| --- | --- | --- |
| 39 — public-call neutralization / synthesized aborted stop reason | `specs/reflection-response-contract/spec.md`: removed public result-call neutralization | Private terminal source preserves its actual stop reason; existing true-cancellation/drain cases verify cancellation produces no publication. No new main assistant rewriting. |
| 40 — invalid re-ask folds all main attempts | `specs/reflection-private-execution/spec.md`: no new main inquiry/correction/fold traffic | `private file correction uses 1 invalid attempts without parent residue`: actual shared runner, one child, two file attempts, result reset, no private prompt/path in context. |
| 41 — three attempts emit a final main fold | Same private-execution requirement; response-contract three-terminal bound retained | `private file correction uses 2 invalid attempts without parent residue`: same child, third attempt succeeds, exactly one hook/continuation and two durable entries. |
| 42 — exhausted attempts emit a main fold | Same private-execution requirement; exhaustion remains unsuccessful | `private file correction uses 3 invalid attempts without parent residue`: exactly three prompts, no parent message/hook/result, empty projected context; final UI diagnostic is permitted. |
| 63 — manual admission without complete source | Private-execution qualified full-source requirement; no fresh-context fallback | `manual reflection requires a qualified source but not an optional history locator`: missing anchor gives typed `no-replayable-anchor` and no operation; an available qualified parent/anchor works without optional history-file locator. This fixture does not certify real SDK full-fork availability. |
| 68 — trigger-time busy native inquiry steering | `specs/manual-reflect-queue/spec.md`: removed inquiry-time native slot | `background manual reflection publishes only its result (parent busy)`: no initial main traffic, ordinary assistant untouched, same-ancestry progress current, only durable final feedback steers. |
| 69 — unconsumed native inquiry survives ordinary settlement | Same removed native-slot requirement | `background manual reflection publishes only its result (parent settled)`: repeated ordinary settlement neither cancels nor duplicates the private run; one final continuation. |

## Kept-assertion audit findings repaired by parent

- Abort-clock migration omitted the parent `agent_start` abort boundary and removed exact busy/clock checks. Restored the real parent start, waited for the actual private child to start/drain, and restored exact `anyBusy`, `activeMs` and `taskMs` checks (0 or 3000), including post-idle freeze.
- Held-child migration replaced its count assertion with a no-change assertion and tolerated an already-admitted run while held. Preserved a user anchor through the abort ancestry; restored count 1, zero held admissions, zero admission on explicit reset, and exactly one admission on the next fresh child completion.
- Native-provider-retry cases had become file-format-correction cases. Restored native lifecycle inside one prompt: error assistant, retry start/end, held retry, terminal success/error. Assert one child and one prompt, no intermediate publication, exact final outcomes and no ordinary-loop charges. The fixture models host events; actual SDK retry behavior still needs installed-host evidence.
- Invalid terminal completion check accessed nonexistent `entry.details`, making it vacuous. Checks now inspect actual completed entry count with the correct terminal-success condition.

The full kept-assertion audit remains open. The duplicated `FakePrivateInquiry` validator/correction/attempt executor has been removed. `ControllerOutcomeStub` injects outcomes for policy-only tests; it does not prove shared execution. The last invalid-result/correction test now uses the real-file driver. Coordinator a96c5ca9 explicitly approved this unit/integration split.

## Fixture abort repair and cooperative liveness

`test/private-reflection-driver.test.ts` reproduced abort during asynchronous result-file read: abort happened before a waiter existed, then the fake parked forever. A pre-park aborted check fixes this race; abort also releases a held reply. The prompt settles with `AbortError`, rather than merely stopping the test's wait.

- Red: `/var/tmp/reflect-check/driver-abort-red.tap`.
- Exact restored abort-clock matrix plus regression: `/var/tmp/reflect-check/driver-abort-boundaries.tap` (9/9).
- Nonsettling-host characterization: `non-settling host prompt keeps the revoked slot held without overlap`. Even `agent_settled` cannot finish a pending prompt promise. No replacement child or main-session effect is allowed. Cooperative host liveness is an explicit limitation, not a forced-release requirement.

## Gate receipts and open gates

- `/var/tmp/reflect-check/parent-check.log`: first full check passed, 210/210 unit cases, lint/typecheck/build exit 0. Later edits require a new receipt.
- E2E log: `/var/tmp/reflect-check/parent-e2e.log`; do not infer success until a completed exit receipt exists.
- Still open: complete kept-test audit/shared-runner migration, full E2E/packed and final clean install, isolated startup/privacy/Escape TUI gates, documentation/model synchronization and fresh blind Lean review.
- Isolated-home successful gpt-6-luna reflection is environment-blocked, not a push gate. Real user Pi remains the acceptance host.

## Packed E2E replacements (2026-10-20)

Packed E2E installs `npm pack` output into a production root (`--omit=dev`, tracked `.npmrc`, exact-commit `allowScripts`) and Pi loads `./src/extension.ts`; dist is no longer shipped. Main-session inquiry, owned `ref`, main correction and inquiry steering slots are retired by `specs/reflection-private-execution`, `specs/reflection-response-contract` (no decision-result function, private file submission) and `specs/manual-reflect-queue` (no inquiry-time native slot). Replacements live in `test/e2e/stock-pi-private.test.mjs` unless noted.

Kept (K) vs retired (R) split follows kept-assertion review b9071717 (findings F1–F10). Every private scenario asserts exact private provider request totals and records any request after the result write as a violation (`privateReflectionPlan.violations`, must be empty).

| Old packed test | K / R | Replacement / evidence |
| --- | --- | --- |
| raw EventBus final hook (with reserved `ref` rejection) | R reserved `ref`; K exact hook values and order | `packed private manual reflection: one request, durable pair, hook, then one wake`: exact hook envelope, 1 private request, `assertDeliveryOrder` (result → marker with same correlation → hook → continuation → wake with hook count 1) (F2, F6) |
| legacy counting-pause hooks ignored | K | automatic scenario (pause hook emitted at startup; reflection still runs) |
| each invalid retry shown / three schema-invalid / corrects schema-invalid | R main correction traffic; K three-attempt bound, same-child correction, exact per-attempt warnings | `packed private correction: exact requests and warnings…` (exactly 2 private requests, warning `Reflection attempt 1/3 invalid: …; retrying.`); `packed private three invalid results: exactly three requests, two warnings…` (exact notice list, 0 hooks, no main traffic) (F2, F10) |
| ordinary malformed `ref` gets native error | R (no owned `ref`) | unit `reflection registers no decision-result function`; foreign `ref` untouched |
| root-loop reflection without redispatch during cooldown, later same-cycle re-arm | K | `packed private automatic reflection: assistant report, cooldown expires and re-arms…`: snapshot `root=2/2; all=2/300`, cooldown inhibits a crossing, floor of ten loops, re-armed second reflection with exact counters, delivery order for both (F6, F8). Cooldown defect found and fixed in `branch-accounting.ts` (red `cooldown-private-red.tap`, green `cooldown-interleave-green.tap`) |
| manual mid-tool-turn steering / busy-manual report-before-wake / child-limit busy steering | R inquiry-time native slot; K result-time steering after the whole tool batch and earlier native messages | `packed private busy manual reflection: child runs during a held tool batch…`: result completes while a two-call batch is held; both tool results intact; under Pi's default `steeringMode: one-at-a-time` the earlier steer is delivered after the batch, the report + `[assistant]\ncontinue` in the next request; no aborted main response (F5) |
| automatic ROUTE_CORRECTION report-before-wake | K | automatic scenario (`wakeAfterReport`, assistant role) |
| hides result after correction; next reflection; parent-file locator | R main fold/result calls; K prior report, locator, second continuation | correction scenario part 2: second reflection prompt carries `Earlier assistant reflection …` with the prior `Reflection · NO_ISSUE`, the supplement, and a locator whose `sessionFile` is the real parent file and whose `branchLeafId` exists in it; one wake per reflection (F7) |
| tool-budget/history shared across attempts | K | `packed private evidence budget…`: helpers 1–10 execute across attempts (exact lines read from a seeded file), a mixed read+bash batch executes nothing (forbidden marker absent), the 11th helper is refused without execution, the result write after exhaustion is accepted; exact correction texts, exact warnings, 5 private requests (F1) |
| child limit steers idle main (child RPC) | R inquiry steering | cross-process `packed abrupt loss…`; unit `real B-to-runtime fresh child completion steers busy/idle main` |
| cancelled/unconsumed native inquiry residue, consumed correction abort, hold callbacks | R native slot, main inquiry | — |
| abort while streaming / inquiry-abort hold | K exact-child cancellation, no retry/hook/wake, hold until input | `packed private main abort closes the exact child stream…`: provider observes the child's own stream closed (`abortedAt`), no retry, no hook/attempt notice/continuation, explicit input releases the hold and a fresh cycle reflects (F4) |
| abort during lookup | K helper cancellation without touching unrelated work | `packed private abort during a running helper…`: helper blocked on a FIFO read, abort, no follow-up request, late helper output never reaches any provider request, unrelated work continues (F4) |
| abort after staged valid result | K staged-result precedence | Not packable: the real child's result write and the acceptance of its settled turn are one provider response, so no external window exists. Unit `abort after a valid result is staged but before acceptance publishes nothing` uses the real shared `runPrivateInquiry` with a driver child that writes the valid file, then holds; result `cancelled`, exact child aborted, no hook/entries/continuation/retry. Ablation of all runner cancellation checks turns it red; it does not isolate which layer acts (F4) |
| stale outcome after revocation | K late valid write commits nothing | unit stale-outcome test with `suspendAbort` (F3) |
| exact trigger reasons and counters | K | units: exact `Trigger source(s): ROOT_LOOP_LIMIT, ALL_LOOP_LIMIT, TASK_TIME_LIMIT`, `all=2/1`, no self-reset with ablation (F9) |
| inquiry-abort clocks | K ordinary-abort clocks | units unchanged |
| text+image input during settlement, fresh /reflect | K | same test, ordinary aborted run, private fresh reflection |
| one-minute wall warning (mid-stream steering) | K at the spec boundary | `the real one-minute task limit reflects once at the first completion past it` |

Receipts: `npm run check` 217/217 (`/var/tmp/reflect-check/final-check2.log`); `npm run test:e2e` 38/38, 0 skipped (`/var/tmp/reflect-check/final-e2e2.log`); private file 8/8 three consecutive runs (`e2e-pall{1,2,3}.log`).
