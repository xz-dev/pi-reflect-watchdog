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

A reask after an invalid reflection response SHALL require a call to `ref` with the same five non-empty string fields and valid result type, rather than XML or a text reply. Initial and correction attempts SHALL share at most three total attempts and one ten-lookup-call budget. Submitting a result SHALL NOT consume the lookup budget. Plugin-generated correction instructions and errors SHALL be in English.

#### Scenario: Reask wording matches the initial contract

- **WHEN** a correction prompt is rendered
- **THEN** it requires a call to `ref` alone with `type`, `reason`, `done`, `current_step`, and `next_step`, with type `NO_ISSUE` or `ROUTE_CORRECTION`
- **AND** it repeats the shared tool-call budget constraint

#### Scenario: Invalid arguments are corrected

- **GIVEN** a confirmed reflection submits an invalid result object
- **WHEN** the invalid attempt settles and fewer than three attempts have been used
- **THEN** the plugin issues a correlated correction prompt without an ordinary continuation or completion hook
- **AND** exhausted validation ends through the existing failure cleanup path without granting a new lookup budget

## ADDED Requirements

### Requirement: Result function has a fixed minimal declaration

The plugin SHALL register `ref` with description exactly `don't use unless ask`. Its public argument schema SHALL be an open object with no declared fields or required arguments. The declaration SHALL NOT include parameter usage instructions or additional prompt guidelines. The plugin SHALL NOT add, remove, or change the declaration when reflection starts or ends; execution authorization SHALL instead be checked at runtime. This stable declaration SHALL NOT be described as a guarantee of provider cache hits or of model obedience.

#### Scenario: Ordinary requests do not learn result arguments from the declaration

- **WHEN** an ordinary model request includes the registered function
- **THEN** its description is exactly `don't use unless ask`
- **AND** its schema exposes no field names or required arguments
- **AND** the plugin supplies no result-submission usage guidance outside a reflection prompt

#### Scenario: Reflection does not switch the tool declaration

- **WHEN** the session enters reflection, retries a result, and returns to ordinary work
- **THEN** the function declaration remains identical across those requests
- **AND** the plugin does not toggle the active tool list for this transition

### Requirement: Result execution requires confirmed reflection

The function SHALL reject execution unless the current main attachment owns an active reflection whose prompt has been consumed and confirmed for the current attempt. A queued or provisional inquiry alone SHALL NOT authorize execution. Outside that state, the error SHALL be exactly `This function is reserved for the plugin. Please try another function.` and SHALL NOT disclose result fields. Such a rejected call SHALL NOT record a reflection result, publish a completion hook, or trigger a reflection continuation.

#### Scenario: Ordinary or provisional call is rejected

- **GIVEN** no reflection is confirmed, including a native-queued inquiry whose prompt has not yet been consumed
- **WHEN** the function is called
- **THEN** it fails with the English reserved-function error
- **AND** it does not validate or describe the result fields

#### Scenario: Confirmed current attempt accepts submission

- **GIVEN** the current main attachment has consumed the active reflection prompt for the current attempt
- **WHEN** `ref` receives valid result arguments
- **THEN** the result is accepted for the existing reflection finalization flow

#### Scenario: Execution is disabled again after reflection

- **WHEN** the function is called after reflection finishes, ownership is lost, or the attachment shuts down
- **THEN** it fails with the reserved-function error
- **AND** the minimal declaration is not expanded to explain its use

### Requirement: Reflection prompts teach function submission

Only reflection and correction prompts SHALL explain how to use `ref`. The reflection prompt SHALL direct the model to call it alone after any lookups, expressing observations and reasoning inside the five result fields rather than in a text response. Assistant text, including a valid reflection XML document with or without preceding prose, SHALL NOT submit a result.

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

Accepted arguments SHALL contain exactly five unique, non-empty string fields: `type`, `reason`, `done`, `current_step`, and `next_step`. Field names and the type value SHALL be case-insensitive; duplicate names after case normalization, missing fields, extra fields, non-string values, and empty trimmed values SHALL be rejected. The type SHALL be `NO_ISSUE` or `ROUTE_CORRECTION`. Serialized JSON arguments SHALL not exceed 16,384 Unicode code points. Accepted string values SHALL be trimmed but SHALL NOT undergo XML entity decoding. These constraints SHALL be taught in reflection prompts and enforced on submission, not advertised in the public declaration.

#### Scenario: Valid case-insensitive arguments

- **WHEN** a confirmed reflection submits all five non-empty string fields using mixed-case names and type
- **THEN** the result is accepted with normalized names and type and trimmed values
- **AND** literal ampersands and angle brackets remain ordinary text

#### Scenario: Invalid or oversized arguments

- **WHEN** a confirmed reflection submits duplicate, missing, extra, empty, non-string, invalid-type, or oversized fields
- **THEN** the result is rejected and follows the bounded correction flow

#### Scenario: Lookup budget is exhausted before submission

- **GIVEN** the reflection has already used ten lookup tool calls across its attempts
- **WHEN** it calls `ref` with valid arguments
- **THEN** submission remains possible even though another lookup call would be blocked
