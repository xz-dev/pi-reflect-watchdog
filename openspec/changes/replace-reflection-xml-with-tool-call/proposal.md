## Why

Reflection results should arrive through a function call rather than XML parsing, without teaching the ordinary agent how to submit them. A fixed minimal declaration avoids repeated tool-list changes; a runtime guard keeps the function unavailable outside confirmed reflection.

This change records the implementation already completed and tested before its OpenSpec artifacts were written. It is retrospective synchronization, not a new implementation request.

## What Changes

- **BREAKING**: Replace XML result submission and the exported `parseReflectionXml` parser with the `ref` function and `parseReflectionArguments` validation. Assistant text, including valid XML, no longer submits a result.
- Keep the function declaration fixed, with description exactly `don't use unless ask` and no advertised parameter fields or required arguments. Reject non-reflection execution with the English reserved-function error.
- Explain the existing five result fields only inside reflection and correction prompts. Keep bounded correction attempts and ten shared lookup calls; result submission does not consume that lookup budget.
- Preserve trigger selection, counters, reports, completion hooks, and ordinary continuation. Fold reflection calls and results from ordinary requests. Document that native compaction and branch summaries can retain function-call arguments because they bypass that projection.
- Use English for new code comments, prompts, and errors.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reflection-response-contract`: Replace the XML contract with a fixed minimal function declaration, confirmed-reflection execution gate, argument validation, and function-based correction.
- `conversation-grounded-reflection`: Update submission terminology, lookup budgeting, and native-summary retention boundaries while preserving report and continuation semantics.
- `reflection-completed-hook`: Express intermediate and invalid-result behavior without requiring XML.
- `manual-reflect-queue`: Preserve native steering and serialization while referring to the function-based response contract.

## Impact

- Runtime: `src/extension.ts`, `src/reflection-protocol.ts`, and exports in `src/index.ts`.
- Evidence: existing protocol/runtime tests and packed stock-Pi integration fixtures; the lifecycle Lean model includes the confirmed-main-inquiry submission guard.
- Documentation: these four main specifications and the existing README. No dependency, configuration, host, cross-process accounting, or historical session migration is introduced.
