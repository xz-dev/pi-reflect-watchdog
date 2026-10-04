## Context

See `proposal.md` for motivation and scope. This is a retrospective record of the implemented XML-to-function transition. The existing inquiry lifecycle already owns confirmation, retries, result persistence, context folding, and one ordinary continuation. The change replaces the result transport rather than introducing another lifecycle.

## Goals / Non-Goals

**Goals:**
- Keep model-facing tool metadata stable and uninformative about result arguments until a reflection prompt provides usage instructions.
- Gate execution on current ownership and the consumed prompt for the active attempt, not merely on a queued request.
- Reuse existing result fields, finalization, counters, hooks, and continuation behavior.

**Non-Goals:**
- No dynamic tool-list activation, new configuration, dependency, host patch, or custom compaction pipeline.
- No changes to other active OpenSpec changes or historical archived records.
- No guarantee that a model will never attempt the function or that a provider will always hit its cache.

## Decisions

### Fixed declaration, runtime authorization

Register `ref` once with `don't use unless ask` and an open object schema containing no named fields or required arguments. Do not add prompt snippets or guidelines. Unlike activating a hidden tool on demand, this avoids tool-list transitions; the user explicitly selected this cache-first trade-off. Reject execution before argument validation unless the active attempt is confirmed and owned by the current main. Non-reflection calls receive only the English reserved-function error.

### Validate arguments instead of parsing assistant text

`parseReflectionArguments` replaces `parseReflectionXml`. Validate the original five string fields, normalized names/type, duplicates, non-empty trimmed values, and a 16,384-code-point serialized JSON limit. Reflection and reask prompts teach this shape; the public tool schema does not. Plain assistant text, including legacy XML, cannot submit a result.

### Keep finalization at the existing boundary

The function records a valid decision or validation error and terminates its tool batch. Existing settlement handling performs retries, folding, persistence, hook publication, and continuation. Result submission is excluded from the ten-lookup budget so exhausting research does not prevent completion. Tool-call messages remain executable until Pi dispatches them; thinking blocks needed by provider tool loops survive until the inquiry is folded. Ordinary report projection emits report text rather than replaying the submission call.

### Preserve ordinary folding without promising transcript erasure

The ordinary context path folds the inquiry's prompts, calls, and tool results, then delivers the existing trigger-specific report and separate wake. Native compaction and branch summarization bypass that path. They can see persisted function-call arguments, but the wake still contains no report copied from private extension data. This consequence is documented rather than adding a new compaction mechanism.

## Risks / Trade-offs

- A minimal declaration does not prevent unsolicited calls → reject them at execution without disclosing argument requirements.
- Fixed declarations do not guarantee cache hits → claim only that this plugin does not switch its tool declaration during reflection.
- Tools disabled explicitly by the host cannot be invoked → integration fixtures enable `ref` instead of using `--no-tools`; the plugin does not override the user's active-tool selection.
- Native summaries can retain result arguments → document the retention boundary; do not describe ordinary folding as deletion from history.
- Old XML-producing integrations no longer submit results → migrate to the function-call contract and update imports of the removed parser export.

## Migration Plan

Reload the updated extension so the new function is registered. Existing stored reports remain readable without a schema migration. Adapt protocol clients and fixtures to function arguments; no historical session rewrite is needed. Restoring the previous extension version restores its XML contract, but does not erase already persisted function calls.

## Verification

Before this documentation synchronization, `npm run check` passed with 129 unit tests and the full `npm run test:e2e` passed with 35 integration tests. Packed stock-Pi tests exercise non-reflection rejection, an unchanged declaration across ordinary/reflection requests, invalid-argument correction, folding, completion hooks, and one continuation. The existing lifecycle Lean model checks the confirmed-main-inquiry gate; it is not a proof of every runtime or provider behavior.
