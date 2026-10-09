## REMOVED Requirements

### Requirement: Entire response is the reflection XML document

**Reason**: Reflection results now arrive through a function call instead of assistant text.
**Migration**: Follow the reflection prompt and submit the five fields as arguments to `ref`.

### Requirement: Lenient parser acceptance is unchanged

**Reason**: XML parsing, including trailing-XML acceptance, is no longer a result-submission path.
**Migration**: Submit an argument object through `ref`; keep the existing field names and result types.

## MODIFIED Requirements

### Requirement: Persona voice lives inside the fields

The default reflection perspective SHALL direct its speaking-style guidance to the content of the five result argument fields. It SHALL NOT instruct the model to produce a separate spoken-style text response instead of calling the result function.

#### Scenario: Oracle persona redirects its voice

- **WHEN** the default perspective prompt is rendered
- **THEN** its communication guidance applies to the field values (for example, the reason field)
- **AND** it does not conflict with the function-call submission requirement

### Requirement: Reask prompt states the same response shape

A reask after a non-aborted invalid reflection response SHALL require a call to `ref` with the same five non-empty string fields and valid result type, rather than XML or a text reply. Initial and correction attempts SHALL share at most three total attempts and one ten-lookup-call budget. Submitting a result SHALL NOT consume the lookup budget. Plugin-generated correction instructions and errors SHALL be in English.

Cancellation SHALL take precedence over correction. An aborted response, including partial or malformed result arguments, SHALL NOT cause a new plugin-issued correction prompt, an invalid-response retry warning, or a new plugin-issued ordinary continuation. A cancelled attempt's late validation or tool result SHALL NOT consume another attempt or a fresh inquiry's budget. A correction already accepted by the host before cancellation may retain ordinary request effects under the native-residue limit in `user-takeover-cycle-reset`; those effects SHALL NOT restore reflection authority or budgets.

#### Scenario: Reask wording matches the initial contract
- **WHEN** a correction prompt is rendered for a non-cancelled inquiry
- **THEN** it requires a call to `ref` alone with `type`, `reason`, `done`, `current_step`, and `next_step`, with type `NO_ISSUE` or `ROUTE_CORRECTION`
- **AND** it repeats the shared tool-call budget constraint

#### Scenario: Invalid arguments are corrected
- **GIVEN** a confirmed non-cancelled reflection submits an invalid result object
- **WHEN** the invalid attempt settles without abort and fewer than three attempts have been used
- **THEN** the plugin issues a correlated correction prompt without an ordinary continuation or completion hook
- **AND** exhausted validation ends through the existing failure cleanup path without granting a new lookup budget

#### Scenario: Aborted partial result is not corrected
- **GIVEN** an initial or correction response contains no result call or incomplete invalid arguments
- **WHEN** the response ends as aborted
- **THEN** the inquiry is cancelled without requesting another response or warning that the user-caused truncation needs correction
- **AND** the authoritative aborted outcome is preserved

### Requirement: Result execution requires confirmed reflection

The function SHALL reject execution unless the current main attachment owns an active, non-cancelled reflection whose prompt has been consumed and confirmed for the current attempt. A queued or provisional inquiry alone SHALL NOT authorize execution, and structural validity SHALL never establish that authority. Outside that state, a schema-admissible call SHALL fail with exactly `This function is reserved for the plugin. Please try another function.` without disclosing result fields; a schema-invalid call can instead receive the host's native validation error before plugin execution. Neither rejection SHALL record a reflection result, count a reflection attempt, publish a completion hook, trigger a reflection continuation, or terminate unrelated ordinary work.

Abort SHALL revoke the cancelled inquiry's submission and finalization authority. A valid staged submission SHALL NOT bypass cancellation, and a later explicit user action SHALL NOT authorize a call correlated with a cancelled inquiry. This requirement changes runtime authority, not the function declaration or accepted argument format.

#### Scenario: Ordinary or provisional call is rejected
- **GIVEN** no reflection is confirmed, including a native-queued inquiry whose prompt has not yet been consumed
- **WHEN** the function is called with schema-admissible arguments
- **THEN** it fails with the English reserved-function error
- **AND** it does not validate or describe the result fields

#### Scenario: Ordinary malformed call stays inert
- **GIVEN** no reflection is confirmed
- **WHEN** ordinary work calls the function with arguments that fail the declared schema
- **THEN** native validation can reject the call before plugin execution
- **AND** no reflection attempt, result, completion hook, or continuation is created, and ordinary work can continue

#### Scenario: Confirmed current attempt accepts submission
- **GIVEN** the current main attachment has consumed the active, non-cancelled reflection prompt for the current attempt
- **WHEN** `ref` receives valid result arguments
- **THEN** the result is accepted for normal finalization unless that inquiry is cancelled before completion

#### Scenario: Execution is disabled again after reflection
- **WHEN** the function is called after reflection finishes, is cancelled, loses ownership, or shuts down
- **THEN** it fails with the reserved-function error or, for schema-invalid arguments, the native validation error
- **AND** the declaration is not expanded to explain its use

#### Scenario: Late cancelled submission cannot act in a new inquiry
- **GIVEN** the user cancelled one reflection and subsequently requested a fresh one
- **WHEN** a result call from the cancelled inquiry reaches the plugin
- **THEN** it is rejected without staging or completing a result for either inquiry
- **AND** it does not change the fresh inquiry's attempt or lookup budget

### Requirement: Reflection prompts teach function submission

Only reflection and correction prompts SHALL explain how to use `ref`. The reflection prompt SHALL direct the model to call it alone after any lookups, expressing observations and reasoning inside the five result fields rather than in a text response. The prompt's field list and JSON example SHALL be guidance that agrees with the declared schema; they SHALL NOT be the sole representation of required fields, string types, or the `type` enum. Assistant text, including a valid reflection XML document with or without preceding prose, SHALL NOT submit a result.

#### Scenario: Prompt requires a function call

- **WHEN** a reflection prompt is constructed
- **THEN** it identifies `ref`, describes the five result fields and accepted types, and gives a JSON argument example
- **AND** it requires function submission instead of an XML document

#### Scenario: Fields framed as the reasoning space

- **WHEN** the prompt describes how to express the reflection
- **THEN** it directs analysis, observations, and any persona voice into the five fields rather than into surrounding text

#### Scenario: Legacy XML does not submit a result

- **WHEN** a confirmed reflection ends with assistant text containing a valid reflection XML document but no result function call
- **THEN** it follows the invalid-response correction path rather than recording a valid result

### Requirement: Submitted arguments preserve the result data contract

Accepted arguments SHALL contain exactly five unique, non-empty string fields: `type`, `reason`, `done`, `current_step`, and `next_step`. Field names and the type value SHALL be case-insensitive; duplicate names after case normalization, missing fields, extra fields, non-string values, and empty trimmed values SHALL be rejected. The type SHALL be `NO_ISSUE` or `ROUTE_CORRECTION`. Serialized JSON arguments SHALL not exceed 16,384 Unicode code points. Accepted string values SHALL be trimmed but SHALL NOT undergo XML entity decoding. These constraints SHALL be taught in reflection prompts, declared structurally where the schema can express them, and enforced on submission; the serialized size limit and duplicate-name detection SHALL remain runtime checks.

Before native schema validation, compatible arguments SHALL be normalized to the declared form: unique case-insensitive field names lowercased, string values trimmed, and a recognized `type` uppercased. Normalization SHALL preserve the raw arguments when names collide after case folding, and SHALL NOT fill missing fields, drop or rename unknown fields, coerce non-string values, repair an unrecognized `type`, truncate text, or grant execution authority.

#### Scenario: Valid case-insensitive arguments

- **WHEN** a confirmed reflection submits all five non-empty string fields using mixed-case names and type, with surrounding whitespace
- **THEN** native schema validation receives lowercase names, an uppercase type, and trimmed values
- **AND** the result is accepted with normalized names and type and trimmed values
- **AND** literal ampersands and angle brackets remain ordinary text

#### Scenario: Invalid or oversized arguments

- **WHEN** a confirmed reflection submits duplicate, missing, extra, empty, non-string, invalid-type, or oversized fields
- **THEN** normalization does not repair them
- **AND** the result is rejected and follows the bounded correction flow

#### Scenario: Lookup budget is exhausted before submission

- **GIVEN** the reflection has already used ten lookup tool calls across its attempts
- **WHEN** it calls `ref` with valid arguments
- **THEN** submission remains possible even though another lookup call would be blocked
