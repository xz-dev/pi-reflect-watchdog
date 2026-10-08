## REMOVED Requirements

### Requirement: Result function has a fixed minimal declaration

**Reason**: The open empty-object schema advertised no fields, types, or enum, so the result contract existed only in prompt prose and native validation could not reject malformed arguments.
**Migration**: Replaced by "Result function has a fixed constrained declaration", which keeps the fixed description and stable registration while declaring the five required string fields and the `type` enum without explanatory text. Valid submissions are unchanged.

## MODIFIED Requirements

### Requirement: Result execution requires confirmed reflection

The function SHALL reject execution unless the current main attachment owns an active reflection whose prompt has been consumed and confirmed for the current attempt. A queued or provisional inquiry alone SHALL NOT authorize execution, and structural validity SHALL never establish that authority. Outside that state, a schema-admissible call SHALL fail with exactly `This function is reserved for the plugin. Please try another function.` without disclosing result fields; a call that fails native schema validation MAY instead receive the host's native validation error. Neither kind of rejected call SHALL record a reflection result, count a reflection attempt, publish a completion hook, trigger a reflection continuation, or terminate unrelated ordinary work.

#### Scenario: Ordinary or provisional call is rejected

- **GIVEN** no reflection is confirmed, including a native-queued inquiry whose prompt has not yet been consumed
- **WHEN** the function is called with schema-admissible arguments
- **THEN** it fails with the English reserved-function error
- **AND** it does not validate or describe the result fields

#### Scenario: Ordinary malformed call stays inert

- **GIVEN** no reflection is confirmed
- **WHEN** ordinary work calls the function with arguments that fail the declared schema
- **THEN** the host may return its native validation error before plugin execution
- **AND** no reflection attempt, result, completion hook, or continuation is created, and ordinary work can continue

#### Scenario: Confirmed current attempt accepts submission

- **GIVEN** the current main attachment has consumed the active reflection prompt for the current attempt
- **WHEN** `ref` receives valid result arguments
- **THEN** the result is accepted for the existing reflection finalization flow

#### Scenario: Execution is disabled again after reflection

- **WHEN** the function is called after reflection finishes, ownership is lost, or the attachment shuts down
- **THEN** it fails with the reserved-function error or, for schema-invalid arguments, the native validation error
- **AND** the minimal declaration is not expanded to explain its use

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

## ADDED Requirements

### Requirement: Result function has a fixed constrained declaration

The plugin SHALL register `ref` with description exactly `don't use unless ask`. Its public argument schema SHALL declare exactly the five required string properties `type`, `reason`, `done`, `current_step`, and `next_step`, SHALL enumerate `type` as exactly `NO_ISSUE` and `ROUTE_CORRECTION`, SHALL require every field to be nonblank, and SHALL NOT admit additional properties. The declaration SHALL contain no parameter descriptions, titles, examples, or default values, and SHALL NOT include parameter usage instructions or additional prompt guidelines. Structural constraints are not usage instructions. The plugin SHALL NOT add, remove, or change the declaration when reflection starts or ends; execution authorization SHALL instead be checked at runtime. Neither this stable declaration nor its structural constraints SHALL be described as a guarantee of provider cache hits, provider-side strict generation, model obedience, or a sound reflection.

#### Scenario: Ordinary requests see structure but no usage guidance

- **WHEN** an ordinary model request includes the registered function
- **THEN** its description is exactly `don't use unless ask`
- **AND** its schema declares the five required string fields, the two-value `type` enum, nonblank text, and no additional properties
- **AND** it contains no parameter description, title, example, or default, and the plugin supplies no result-submission usage guidance outside a reflection prompt

#### Scenario: Invalid arguments fail the declared structure

- **WHEN** tool arguments omit a field, add an unknown field, use a non-string or blank value, or use a `type` outside `NO_ISSUE` and `ROUTE_CORRECTION` after compatible normalization
- **THEN** they fail the declared structural contract rather than relying only on prompt text to reject them

#### Scenario: Reflection does not switch the tool declaration

- **WHEN** the session enters reflection, retries a result, and returns to ordinary work
- **THEN** the function declaration remains identical across those requests
- **AND** the plugin does not toggle the active tool list for this transition

### Requirement: Invalid owned submissions stay in the bounded correction flow

When an assistant response captured for the current confirmed reflection attempt contains a `ref` call whose normalized arguments fail the result data contract, the plugin SHALL record that attempt as invalid with a safe validator error and SHALL prevent the response's calls from reaching native dispatch, so the host does not issue a schema-error follow-up request outside the reflection's attempt accounting. The response SHALL end the attempt normally; it SHALL NOT be treated as a cancelled reflection. Settlement SHALL then follow the existing correction flow: a correlated correction prompt while fewer than three attempts have been used, otherwise the existing failure cleanup. Each such response SHALL count as exactly one invalid attempt, SHALL NOT consume lookup budget for its suppressed calls, and SHALL fold out of later context like any other reflection attempt. Diagnostics SHALL NOT echo raw invalid argument values.

#### Scenario: Missing field is corrected inside the reflection

- **GIVEN** a confirmed reflection attempt
- **WHEN** the model calls `ref` without `next_step`
- **THEN** no native validation follow-up request is sent for that response
- **AND** the attempt is counted once as invalid, a warning is shown, and a correlated correction prompt is issued

#### Scenario: Valid correction after a schema-invalid attempt

- **GIVEN** the previous attempt submitted an invalid `type`
- **WHEN** the correction attempt submits valid arguments
- **THEN** the result is accepted once and finalized through the existing continuation and completion flow
- **AND** the total provider requests equal the reflection attempts used

#### Scenario: Three schema-invalid attempts

- **WHEN** three consecutive confirmed attempts each submit schema-invalid arguments
- **THEN** the reflection ends through the existing failure cleanup after the third attempt
- **AND** no fourth provider request, result entry, completion hook, or continuation is created
