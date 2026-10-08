## Why

The public `ref` declaration uses an open empty-object parameter schema, so the provider receives no machine-readable field, type, or enum constraints. A probe against the installed schema shows `{}`, an invalid `type`, and a numeric `reason` all pass the declared schema and are rejected only later by the plugin parser. Reflection prompts currently compensate with a full field list and JSON example, but prose is not a structural constraint and can be ignored by a model; the contract should be carried by the standard tool schema rather than only by prompt text.

## What Changes

- Declare the reflection result's structural constraints in the public `ref` parameter schema: the five required string fields `type`, `reason`, `done`, `current_step`, and `next_step`; `type` enumerated as `NO_ISSUE` / `ROUTE_CORRECTION`; nonblank text values.
- Keep the declaration otherwise minimal: description stays exactly `don't use unless ask`, with no parameter descriptions, examples, defaults, prompt snippets, or guidelines. "No explanatory text" no longer means "no constraints".
- Preserve existing accepted inputs: case-insensitive field names and type value, trimming, and rejection of duplicate, missing, extra, empty, non-string, and oversized fields. Compatible inputs are normalized before native schema validation; invalid inputs are never repaired, coerced, filled, or truncated.
- Keep the serialized 16,384 code-point limit and other checks the schema cannot express enforced at runtime; the schema is not an authority and does not guarantee provider strict generation or a sound reflection.
- An owned reflection response rejected by the structural contract stays inside the existing bounded correction flow (three total attempts, shared lookup budget, warnings, inquiry folding) and must not trigger an unbudgeted native follow-up or be silently cancelled.
- Reflection prompts keep teaching the fields and example as guidance, no longer as the sole representation of the contract.
- Ordinary-work calls remain inert: authorization still comes only from the current confirmed reflection attempt, and native schema rejection of an ordinary call causes no watchdog effect.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reflection-response-contract`: the public `ref` schema changes from an open object exposing no fields to a structurally constrained schema without explanatory text; argument constraints are both advertised structurally and enforced on submission; schema-invalid owned responses follow the existing correction bound.

## Impact

- `src/extension.ts`: `ref` registration parameters, argument preparation hook, and owned-response handling for schema-invalid calls.
- `src/reflection-protocol.ts`: shared normalization/validation reused for preparation; prompt wording that the schema is no longer absent.
- Tests: schema contract, compatibility (mixed-case names/type), invalid owned responses within three attempts with no extra provider request, and inert ordinary malformed calls through native Pi dispatch.
- Docs and `docs/programming-thinking/*.idea.lean` models that state the declaration exposes no fields.
- No configuration, persisted report format, completion-hook payload, or reflection trigger behavior changes.
