## 1. Last-error notification

- [x] 1.1 Add focused cases in the existing runtime test suite for a final error after a different earlier retry error, an exhausted validation failure, a setup exception, and missing error text; verify the new preview assertions fail against the current fixed-summary-only implementation before changing behavior.
- [x] 1.2 Pass the final available error through the existing best-effort notifier in `src/extension.ts`, and add the small two-row formatter using installed TUI display-width utilities, notification-time terminal width, and the 80-column fallback; verify short, long, multiline, long-unbroken, and CJK error previews fit the available width with the label and truncation indicator counted, while the full evidence path remains unchanged.
- [x] 1.3 Update existing failure-notice assertions to the explicit final-error display policy without adding a classifier, custom redaction, history scan, or settings; verify one terminal notice, no notice after successful recovery/cancellation/staleness, no parent model messages or completion hooks, and slot release even if notification throws.

## 2. Host integration and documentation

- [x] 2.1 Update `test/e2e/stock-pi-private.test.mjs` and, where actual rendering is needed, the existing stock-Pi TUI harness for the new notice; verify a terminal provider failure shows its last error, preserves the complete retained-session path, and renders the error section in at most two rows at controlled narrow and wide terminal widths. Use local fixtures, not production model calls.
- [x] 2.2 Update the diagnostic-scope comment in `docs/programming-thinking/private-reflection-manual-identity.idea.lean` to describe the bounded final-error exception without changing the UI-excluding model; verify the exact updated file typechecks, runs, and completes the required programming-thinking semantic check.

## 3. Acceptance checks

- [x] 3.1 Run `npm run check`, `npm run test:e2e:fast`, and the targeted existing TUI checks used for task 2.1; verify all pass and review the diff for unchanged dependencies, retry/model selection, counters, cancellation, and evidence retention.
- [x] 3.2 Present the short-error, truncated two-row error, and missing-error examples with check results for user acceptance; verify the delivered behavior matches `specs/watchdog-inquiry-diagnostics/spec.md` and state that width is sampled at notification time and no extra redaction is applied.
