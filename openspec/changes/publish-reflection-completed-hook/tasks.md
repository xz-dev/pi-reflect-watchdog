## 1. Acceptance Baseline

- [x] 1.1 Confirm `master`, remote, and tracked-tree state; create one feature branch and verify no unrelated file enters the change.
- [x] 1.2 Add an independent-consumer acceptance test for a durably completed valid reflection and prove it fails because `reflection-completed` is absent.
- [x] 1.3 Add focused negative acceptance examples for XML retry and exhausted validation, a settled run with no captured decision, ownership loss through `syncOwnership`, shutdown, and incomplete persistence; verify the baseline publishes no valid completion hook.

## 2. Completion Hook Contract

- [x] 2.1 Add one minimal transport-text clip helper: preserve values up to 4096 UTF-16 code units, otherwise append `…` after the longest whole-code-point prefix that fits; verify 4096, 4097, and astral-boundary cases while the durable result retains full text.
- [x] 2.2 Publish `reflection-completed` through the existing shared dependency with exact `REFLECTION_TYPE` and exact-or-clipped `REASON` and `NEXT_STEP` only after both completion entries succeed; verify both reflection types, append failure, duplicate finalization, no listener, and throwing listener paths.
- [x] 2.3 Verify `ROUTE_CORRECTION` steering, `NO_ISSUE` TUI behavior, counter observation, and later dispatch ordering remain unchanged with and without a consumer.

## 3. Verification and Delivery

- [x] 3.1 Update README separately, verifying it describes only final valid completion and does not imply replay, acknowledgement, or notification-consumer dependency.
- [x] 3.2 Run `npm run check`, `npm run test:e2e:fast`, `npm run test:e2e`, a temporary-directory `node scripts/pack.mjs <dir>` pack inventory, `git diff --check`, `git status --short`, and `openspec validate publish-reflection-completed-hook --type change --strict --no-interactive`; verify all pass and generated artifacts remain untracked.
- [x] 3.3 Intentionally disable the new publication once and verify the acceptance test fails, then restore the candidate and rerun the focused test.
- [x] 3.4 Obtain provisional independent review of the uncommitted working-tree candidate, resolve every finding, and rerun affected checks; explicitly record that this review is not approval of an immutable SHA.
- [x] 3.5 After explicit user confirmation for local commits only, create separate GPG-signed Conventional functional and documentation commits and verify their signatures; do not push or integrate under this authorization.
- [ ] 3.6 Independently review the resulting exact commit SHAs or prove tree equivalence to the provisionally reviewed candidate, resolve any finding through separately authorized follow-up commits, rerun affected checks, and retain approval tied to the final exact SHAs.
- [ ] 3.7 After separate explicit user confirmation for push/integration, publish only the exact approved commits, fast-forward them into `master`, remove the feature branch, and confirm local/public SHAs match.
