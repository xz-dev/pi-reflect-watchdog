## Why

A private reflection can fail with a useful provider error such as `400 model_not_found`, while its warning only says that execution failed. Showing the final error beside the existing warning and retained-session path lets the user diagnose the failure without opening a large JSONL file.

## What Changes

- Add the current failed operation's last available error text to its existing human-only terminal warning. Do not accumulate earlier retry errors or replace the text with a category.
- Limit the error preview, including its label, to two display rows at the terminal width when the notice is emitted. Indicate truncation and keep the existing full session path outside this limit.
- Use ordinary error text and existing terminal text-layout utilities; add no custom redaction rules, error classifier, configuration switch, or dependency.
- Explicitly relax the diagnostic specification's blanket ban on provider/exception text for this bounded final-error preview. Keep private conversation content out of model feedback and completion hooks.
- Preserve warning cardinality, cancellation/currentness guards, evidence retention, slot release, native retry behavior, accounting, and continuation behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `watchdog-inquiry-diagnostics`: Include the last error in the existing terminal-failure notice with a two-row, terminal-width-aware preview; retain the full evidence path and all execution-isolation guarantees.

## Impact

- `src/extension.ts`: Pass the final error into the existing best-effort notifier and format its bounded preview using the installed `@earendil-works/pi-tui` utilities.
- `test/runtime.test.ts` and `test/e2e/stock-pi-private.test.mjs`: Update failure-notice expectations and cover last-error selection, display bounds, and unchanged failure cleanup.
- `docs/programming-thinking/private-reflection-manual-identity.idea.lean`: During implementation, update the diagnostic-scope comment that currently excludes all provider/exception text; the model excludes UI rendering and its state transitions do not change.
- No public API, dependency, retry, model-routing, gateway, or sibling-watchdog changes. This is a Reflect-specific diagnostic-display exception, not a change to the Continue-owned shared execution contract.
- Error previews may contain sensitive text supplied by a provider. The user chose ordinary text display without an additional redaction layer; notices remain human-only and the preview is not a sanitization guarantee.
