# reflection-response-contract Specification

## Purpose

Define validated five-field reflection results written to a designated private JSON file, with bounded same-child correction and no public result-function or main-session inquiry transport.

## Requirements

### Requirement: Persona voice lives inside the fields
The default reflection perspective SHALL direct speaking-style guidance to the content of the five result fields written to the designated private JSON file. It SHALL NOT request a separate spoken-style main reply, public result-function call or prose result transport.

#### Scenario: Oracle persona redirects its voice
- **WHEN** the default perspective prompt is rendered
- **THEN** its communication guidance applies to the field values, including the reason
- **AND** it agrees with private file-result submission rather than a separate text response

### Requirement: Reask prompt states the same response shape
A correction after a normally completed invalid terminal result SHALL require the same five non-empty string fields and valid type in the designated JSON file. Initial and correction attempts SHALL share at most three consumed terminal result attempts and one ten-helper-call allowance, within one private child. Admitted helper-only responses SHALL not be classified as missing terminal results. Result writes SHALL spend no helper allowance and SHALL end without a post-write model acknowledgement. Correction instructions and safe diagnostics SHALL be in English.

Cancellation SHALL take precedence over correction. An aborted response, including a partial or malformed file, SHALL not cause a correction prompt, invalid-response warning or new ordinary continuation. A cancelled attempt's late completion SHALL not spend another attempt or a fresh inquiry's allowance. New corrections SHALL remain private rather than native main-session steering messages. Already-submitted successful feedback SHALL retain native residual-work limits; background admission itself SHALL create no scheduling/wake slot.

#### Scenario: Reask wording matches the initial contract
- **WHEN** a correction prompt is rendered for a non-cancelled inquiry
- **THEN** it requires a designated-file object with `type`, `reason`, `done`, `current_step` and `next_step`, with type `NO_ISSUE` or `ROUTE_CORRECTION`
- **AND** it repeats the unchanged shared helper-call constraint without requesting `ref`

#### Scenario: Invalid arguments are corrected
- **GIVEN** a current private reflection writes an invalid result object
- **WHEN** that terminal attempt settles normally and fewer than three attempts have been used
- **THEN** concrete validator feedback and correction remain in the same child without ordinary continuation or completion hook
- **AND** exhaustion uses existing failure cleanup without a new helper allowance

#### Scenario: Aborted partial result is not corrected
- **GIVEN** an initial or correction response contains no result write or leaves partial invalid JSON
- **WHEN** the response ends as aborted
- **THEN** the inquiry is cancelled without another response or invalid-result warning
- **AND** the authoritative aborted outcome is preserved

### Requirement: Provider failures stay outside result correction
An assistant with `stopReason: "error"` SHALL remain a provider failure, not a missing or invalid file result. It SHALL add no ordinary/cooldown loop, terminal result attempt or helper execution charge merely by failing. Supported native retry eligibility, stop reason and error classification SHALL remain intact inside the private profile; failure classification SHALL not depend on error-text matching. Provider retries SHALL not become format correction or public/main-session fallback. Already executed helpers remain charged for their actual execution. Native retry behavior required here SHALL be proved on the supported host before cutover; ambient extensions SHALL not be loaded into the child to synthesize it.

#### Scenario: Native retry succeeds
- **GIVEN** a current private reflection receives repeated provider errors, including an error marked by `pi-retry`
- **WHEN** supported native retry produces a valid file result
- **THEN** that result is accepted in the same terminal attempt
- **AND** failures produce no correction prompt, reflection warning, result or hook of their own

#### Scenario: Native retries exhaust
- **GIVEN** a current private reflection receives only provider errors
- **WHEN** supported native retries exhaust and execution authoritatively settles
- **THEN** the failed operation ends without a plugin format correction, result, completion hook or ordinary continuation
- **AND** neither failure nor settlement adds an ordinary loop

### Requirement: Submitted arguments preserve the result data contract
The designated result file SHALL contain one complete object with exactly five unique non-empty string fields: `type`, `reason`, `done`, `current_step` and `next_step`. Field names and type SHALL remain case-insensitive; duplicate names after case normalization, missing/extra fields, non-string values and empty trimmed values SHALL be rejected. Type SHALL be `NO_ISSUE` or `ROUTE_CORRECTION`. Serialized JSON payload SHALL not exceed 16,384 Unicode code points. Accepted strings SHALL be trimmed without XML entity decoding. These constraints SHALL be taught privately and enforced by the consumer validator, not a public tool schema.

Compatible unique field names SHALL normalize to lowercase and recognized type to uppercase. Validation SHALL not repair collisions, missing/unknown fields, non-string values, invalid types or overlong text and SHALL grant no authority by normalization alone. Reset, no-follow regular-file checks and current own-response association SHALL follow the shared private inquiry contract.

#### Scenario: Valid case-insensitive arguments
- **WHEN** a current private reflection writes five non-empty strings with mixed-case names/type and surrounding whitespace
- **THEN** normalization produces lowercase names, uppercase type and trimmed values
- **AND** the object is accepted under the unchanged data contract
- **AND** literal ampersands and angle brackets remain ordinary text

#### Scenario: Invalid or oversized arguments
- **WHEN** a current attempt writes duplicate, missing, extra, empty, non-string, invalid-type or oversized fields
- **THEN** validation does not repair them
- **AND** the terminal result follows bounded correction

#### Scenario: Lookup budget is exhausted before submission
- **GIVEN** ten admitted helper calls have executed across this reflection's attempts
- **WHEN** the current child requests its valid designated result write alone
- **THEN** submission remains possible even though another helper cannot execute

### Requirement: Invalid owned submissions stay in the bounded correction flow
A normally completed terminal response belonging to the current private attempt SHALL count once as invalid when its designated file fails the data contract or its requested batch is forbidden. Safe diagnostics SHALL not echo raw invalid fields. The entire rejected batch SHALL be suppressed before effects; suppressed helpers SHALL not spend execution budget. Native schema/tool-error follow-ups SHALL not create uncounted responses. A missing, untouched, malformed or non-object terminal file SHALL also be invalid; an admitted helper-only response SHALL not be mistaken for terminal submission.

Correction SHALL retain one child, at most three consumed terminal attempts and the original helper allowance. The result file SHALL be reset between terminal attempts after prior admitted writes settle. A cancelled/stale, setup/filesystem or provider failure SHALL remain distinct. A valid result awaiting durable completion SHALL not return an intermediate handoff to the main model.

#### Scenario: Missing field is corrected inside the reflection
- **GIVEN** a current non-aborted private terminal attempt
- **WHEN** the model writes a result without `next_step`
- **THEN** no native tool-validation follow-up is sent for that response
- **AND** one invalid attempt, the existing bounded warning and concrete same-child correction follow

#### Scenario: Valid correction after a schema-invalid attempt
- **GIVEN** the previous terminal attempt supplied an invalid type and no helper lookups occur
- **WHEN** the next same-child attempt writes valid fields
- **THEN** the result is accepted once through existing durable completion and continuation
- **AND** excluding provider transport retries, result-model requests equal the terminal attempts used, with no acknowledgement request

#### Scenario: Three schema-invalid attempts
- **WHEN** three current normally completed terminal attempts write invalid fields
- **THEN** failure cleanup follows the third attempt
- **AND** no fourth result request, result entry, hook or ordinary continuation is issued

### Requirement: Abort outcome takes precedence over response validation
Invalid-response correction SHALL apply only to normally completed non-cancelled terminal attempts. Authoritative abort SHALL take precedence over file content or a pending validation error. The plugin SHALL not rewrite an aborted child response into normal success, dispatch partial calls, accept a staged file or spend correction allowance on cancellation. No main scheduling/wake is issued for an inquiry or private correction; already-submitted successful feedback SHALL not regain private file authority after cancellation.

#### Scenario: Aborted response contains schema-invalid arguments
- **GIVEN** an owned private response produces invalid result fields
- **WHEN** it ends authoritatively aborted
- **THEN** cancellation wins over invalid-result correction
- **AND** no correction, completed result, hook or ordinary continuation is authorized
- **AND** any previously accepted successful feedback retains its existing native residual-work limit rather than a retraction guarantee

#### Scenario: Invalid response is not aborted
- **GIVEN** a current terminal response contains invalid fields and is not cancelled
- **WHEN** it settles normally
- **THEN** the bounded invalid-response correction contract remains in force

#### Scenario: Queued correction cannot revive cancelled authority
- **GIVEN** a private inquiry is running with a correction allowance remaining
- **WHEN** new queued/delivered user input or another revocation invalidates its captured source
- **THEN** authority is revoked and exact-child cancellation is requested immediately, including provider/helper abort signals
- **AND** no correction or late file is accepted, and a fresh inquiry's budgets remain independent

### Requirement: Reflection registers no decision-result function
The watchdog SHALL register no specialized result function, including `ref` or a replacement structured-output tool, in ordinary or private work. The current designated file SHALL be the only new result transport. Ordinary startup context SHALL contain no result-function declaration or call-to-finish obligation. Historical result records SHALL remain readable without restoring callable authority. A foreign `ref` SHALL remain its owner's tool and SHALL not submit reflection results.

#### Scenario: Ordinary work after watchdog startup
- **WHEN** ordinary provider declarations are constructed before, during or after a reflection
- **THEN** Reflect has added no result function and has not changed unrelated active tool membership

#### Scenario: A foreign extension registers ref
- **WHEN** another extension owns a tool called `ref`
- **THEN** Reflect leaves it unchanged and its calls cannot stage or finalize reflection

### Requirement: Private prompts teach file submission
Only private reflection/correction instructions SHALL teach the result-file path and five-field submission shape. They SHALL direct one designated write after any admitted helpers, with observations/persona voice inside the fields. Inherited declarations SHALL not imply execution permission. Helpers SHALL be limited to SDK `read`, `ls`, `grep`, `find` for local evidence, including the qualified parent session file; no third-party helpers, shell commands, network lookup or delegation SHALL execute. Prose, stdout, XML, public function arguments or another path SHALL not supply a result. A mixed helper/result batch SHALL not execute either effect. Missing/untouched/invalid terminal files SHALL follow the bounded correction contract.

#### Scenario: Prompt requires a file write
- **WHEN** the private reflection prompt is built
- **THEN** it supplies the host-designated path, fields/type/size constraints and a JSON example, not instructions to call `ref`

#### Scenario: Fields framed as the reasoning space
- **WHEN** private instructions describe the reflection
- **THEN** observations and persona voice belong in the five fields rather than surrounding ordinary text

#### Scenario: Legacy XML does not submit a result
- **WHEN** a current terminal response prints valid-looking reflection XML without writing its result file
- **THEN** it follows bounded invalid-result correction rather than recording a valid result
