## 1. Completed implementation

These items record implementation and verification completed before this retrospective OpenSpec synchronization; they do not claim a spec-first workflow.

- [x] 1.1 Replace XML submission with the fixed minimal `ref` declaration and confirmed-reflection guard; verify declaration shape, English non-reflection rejection, and lifecycle gating in `test/runtime.test.ts`.
- [x] 1.2 Validate the original five fields through function arguments and teach usage only in reflection prompts; verify case normalization, malformed arguments, JSON character limits, and prompt behavior in `test/reflection-protocol.test.ts`.
- [x] 1.3 Preserve shared lookup budgeting, bounded retries, report delivery, hooks, folding, and one continuation; verify runtime tests and packed stock-Pi cases in `test/e2e/stock-pi-fast.test.mjs`.

## 2. Completed implementation verification

- [x] 2.1 Run `npm run check`; confirm lint, typecheck, 129 unit tests, and build pass on the implemented change.
- [x] 2.2 Run the full `npm run test:e2e`; confirm all 35 integration tests pass, including the real one-minute reflection lifecycle.
- [x] 2.3 Document native summary retention in `README.md` and the confirmed-main-inquiry gate in the existing Lean lifecycle model; confirm the model typechecks and runs.

## 3. OpenSpec synchronization

- [x] 3.1 Merge the four delta specifications into the corresponding main specs, revise the obsolete XML-only Purpose, and verify unrelated requirements and active changes remain unchanged.
- [x] 3.2 Run strict validation for this change and all main specs; verify every added/modified requirement matches its main-spec counterpart and both removed XML requirements are absent.
