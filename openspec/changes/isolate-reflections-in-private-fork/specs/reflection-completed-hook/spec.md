## MODIFIED Requirements

### Requirement: Non-final reflection paths remain silent
The watchdog SHALL publish no `reflection-completed` hook for intermediate file attempts or any path without one valid final durable reflection. Cancellation or source revocation before both completion records are durable SHALL synchronously remove the staged file's authority, immediately signal exact-child provider/helper cancellation, and SHALL not newly publish a report, marker or hook. Already completed reports/hooks SHALL remain historical effects without rollback or repeat publication. Temporary file acceptance SHALL not be a substitute completion receipt.

#### Scenario: XML is retried
- **WHEN** a non-cancelled terminal attempt prints legacy XML instead of writing its designated result file and correction follows
- **THEN** it publishes no hook and only a later valid durable completion can publish one

#### Scenario: Invalid function arguments are retried
- **WHEN** invalid reflection fields are written by a current private attempt and another result attempt follows
- **THEN** that intermediate result publishes no completion hook
- **AND** only a later valid durable completion can publish one

#### Scenario: Reflection terminates without a valid result
- **WHEN** validation exhausts, execution ends without a captured result, ownership is lost or shutdown cancels the operation
- **THEN** no completion hook is published

#### Scenario: Valid staged result is aborted before completion
- **GIVEN** a valid file was staged but both completion records are not durable
- **WHEN** the owning cycle or exact private operation is cancelled
- **THEN** no new report, marker or hook is published
- **AND** repeated settlement or late helper/write completion remains silent

#### Scenario: User invalidates a running inquiry
- **WHEN** new non-owned input is queued/delivered while private provider or helper work is running
- **THEN** the exact child is cancelled immediately rather than allowed to finish for later discard
- **AND** no private result, hook, replacement inquiry or parent request follows the stale drop

#### Scenario: Abort follows a historical completion
- **GIVEN** a valid reflection completed durably and published its hook
- **WHEN** subsequent ordinary work is aborted
- **THEN** the report remains readable
- **AND** its hook is neither retracted nor emitted again
