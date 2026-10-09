## MODIFIED Requirements

### Requirement: Invalid owned submissions stay in the bounded correction flow

When a non-aborted assistant response captured for the current confirmed reflection attempt contains a `ref` call whose normalized arguments fail the result data contract, the plugin SHALL record that attempt as invalid with a safe validator error and SHALL prevent the response's calls from reaching native dispatch, so the host does not issue a schema-error follow-up request outside reflection attempt accounting. The response SHALL end the attempt normally; it SHALL NOT be treated as a cancelled reflection. Settlement SHALL follow the existing correction flow: a correlated correction prompt while fewer than three attempts have been used, otherwise existing failure cleanup. Each such response SHALL count as exactly one invalid attempt, SHALL NOT consume lookup budget for its suppressed calls, and SHALL fold out of later context like any other reflection attempt. Diagnostics SHALL NOT echo raw invalid argument values. An aborted outcome SHALL take precedence over this invalid-result path under the coordinated native-abort contract.

#### Scenario: Missing field is corrected inside the reflection
- **GIVEN** a non-aborted confirmed reflection attempt
- **WHEN** the model calls `ref` without `next_step`
- **THEN** no native validation follow-up request is sent for that response
- **AND** the attempt is counted once as invalid, a warning is shown, and a correlated correction prompt is issued

#### Scenario: Valid correction after a schema-invalid attempt
- **GIVEN** the previous non-aborted attempt submitted an invalid `type`
- **WHEN** the correction attempt submits valid arguments
- **THEN** the result is accepted once and finalized through the existing continuation and completion flow
- **AND** excluding host-owned provider retries, total provider requests equal the reflection attempts used

#### Scenario: Three schema-invalid attempts
- **WHEN** three consecutive non-aborted confirmed attempts submit schema-invalid arguments
- **THEN** reflection ends through failure cleanup after the third attempt
- **AND** no fourth provider request, result entry, completion hook, or ordinary continuation is created
