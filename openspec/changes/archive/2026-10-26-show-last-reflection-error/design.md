## Context

See `proposal.md` for motivation and `specs/watchdog-inquiry-diagnostics/spec.md` for the behavior contract.

`runPrivateReflection` already receives `error` on terminal `execution-error` and `decision-failed` results. The shared inquiry driver preserves the final assistant error; its scan excludes inherited messages. Reflect currently passes only a fixed summary and session evidence into `notifyReflectionFailure`. That notifier already owns the single best-effort warning and swallows notification failures.

The installed Pi notification renderer prepends `Warning:` and renders text with one column of horizontal padding on each side (`showWarning` in `interactive-mode.js`). The public `notify` API accepts a string, not a width-aware component. The project already depends on `@earendil-works/pi-tui` and uses its display-width helpers in `src/widget.ts`.

## Goals / Non-Goals

**Goals:**
- Add the final error at the existing notification seam, without storing another copy in runtime state.
- Make the error preview fit two rendered rows while leaving the evidence path intact.
- Preserve all failure settlement and model-context isolation behavior.

**Non-Goals:**
- Custom redaction, error-code parsing, retry classification, fallback models, gateway repair, or retry-policy alignment.
- Transcript scanning, error histories, extra UI widgets, interactive dialogs, resize subscriptions, or settings.
- Changes to the shared private-inquiry API or Continue's implementation/specification.

## Decisions

### 1. Use the final failure value, not a reconstructed history

Pass the final `result.error` to the existing notifier for returned execution failures and exhausted corrections. For a setup exception caught at the boundary, use its ordinary `Error.message` or a thrown string; if no nonblank string is available, omit the preview. Do not stringify arbitrary objects, add stack traces, walk nested causes, or fall back to an older error.

This uses the data already selected by the executor. A new `lastError` field, child-event subscriber, or JSONL reader would duplicate ownership and risk showing an error from another attempt or session.

### 2. Keep one warning with three sections

For a failure with error text, keep the existing host-owned summary first, then the bounded error preview, then the existing evidence clause on its own line:

```text
Reflection failed: the private reflection ended in an execution error.
Last error: openai-api-extension API error (400): {"code":"model_not_found", ...}
Private session JSONL retained: <full absolute path>
```

The example is schematic; the ellipsis is only added when actual clipping occurs. The `Last error:` label counts toward the two-row budget. The summary and evidence clause do not. Missing error text preserves the existing notice rather than displaying `undefined` or inventing a replacement.

### 3. Use ordinary terminal layout with a two-row cap

Keep a small formatter beside the notifier and use the installed TUI wrapping/truncation helpers rather than JavaScript character slicing or a new text library. Preserve the text order, account for explicit line breaks and display-width differences such as CJK characters, keep at most two rows, and reserve space for an ellipsis in the last row when text is omitted. Use normal host/TUI handling of terminal text; do not introduce custom secret-detection or replacement rules, and do not undo provider-side redaction that already occurred.

Sample `process.stdout.columns` when the notice is emitted, with 80 columns as the fallback for absent or invalid width. Account for the current host notification's two columns of horizontal padding, with a positive minimum content width. Keep the width argument separable from the formatting logic so existing tests can exercise narrow/wide terminals without changing global terminal state. Verify the padding assumption in the supported host integration test.

A static notice can rewrap after the terminal is later resized. The bound applies at emission time; adding a persistent component or resize handler solely to reformat old warnings is out of scope.

### 4. Change only the display policy

The current diagnostic spec forbids all provider bodies and exception text. The delta explicitly allows the final error preview, including any provider body embedded in that error, without a Reflect-specific redaction layer. This exception is local to Reflect's human notification; it does not grant permission to copy arbitrary private messages, change shared execution semantics, or inject diagnostics into the model.

Retain the existing currentness checks and best-effort notification boundary. Keep formatting within that boundary so a display fault cannot replace the original result, emit another warning, or prevent `finally` from releasing the slot. Do not alter success, cancellation, ordinary-loop accounting, cooldown, helper budgets, result attempts, or evidence cleanup.

## Risks / Trade-offs

- [Provider errors can contain credentials or request text] → The user explicitly chose ordinary error display without another redaction layer. Keep it local and human-only, limit its size, and do not claim that clipping removes sensitive data.
- [Terminal columns differ from JavaScript string length] → Reuse TUI display-width handling and test multiline, wide-character, and long unbroken errors at narrow widths.
- [Notification padding or injected terminal behavior differs across hosts] → Verify actual rendering on the supported Pi host; use a deterministic 80-column fallback when process terminal width is unavailable. Do not access private TUI internals.
- [Resizing after delivery can rewrap a static notice] → State the emission-time width contract; do not introduce live resize lifecycle work.
- [A useful suffix can be clipped] → Indicate truncation; retain the complete original JSONL and its full copyable path.

## Migration Plan

No data migration or dependency change is required. During apply, update the notifier and its existing tests together, then adjust the diagnostic-scope comment in `docs/programming-thinking/private-reflection-manual-identity.idea.lean` and validate that file using the project's programming-thinking workflow. UI rendering remains outside that model; do not add a terminal-rendering state machine.

Run focused tests, the existing repository checks, and the supported stock-Pi notification integration checks before rollout. Rollback restores the previous fixed-summary-only warning; retained session files remain untouched. Main-spec synchronization and archival happen only in their respective later workflows.
