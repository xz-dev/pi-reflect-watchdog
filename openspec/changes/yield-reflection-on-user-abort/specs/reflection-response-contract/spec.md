## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Abort outcome takes precedence over response validation

The invalid-response correction contracts, including legacy text/XML rejection and schema-invalid owned submissions, SHALL apply only to non-aborted, non-cancelled attempts. A canonical aborted outcome SHALL take precedence over any response content or pending validation error. The plugin SHALL NOT rewrite an aborted owned response into a normal stop in order to apply correction accounting, dispatch its partial calls, or publish its staged result.

#### Scenario: Aborted response contains schema-invalid arguments
- **GIVEN** an owned response contains a `ref` call whose arguments fail the structural contract
- **WHEN** that response has the authoritative aborted outcome
- **THEN** cancellation wins over the schema-invalid correction flow
- **AND** no new plugin correction, completed result, completion hook, or ordinary continuation is authorized by that output
- **AND** already-accepted host work remains subject to the native-residue limit rather than a native-retraction guarantee

#### Scenario: Invalid response is not aborted
- **GIVEN** an owned response contains invalid result arguments and is not cancelled
- **WHEN** it settles without an aborted outcome
- **THEN** the existing bounded invalid-response correction contract remains in force

#### Scenario: Queued correction cannot revive cancelled authority
- **GIVEN** a correction was accepted by native steering before a main abort cancelled its inquiry
- **WHEN** its residual native slot later causes an ordinary provider request
- **THEN** the old result is not accepted and no new plugin retry is authorized
- **AND** neither the fresh inquiry's attempt budget nor its lookup budget is changed
