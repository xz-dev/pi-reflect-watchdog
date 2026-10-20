# reflection-completed-hook Specification

## Purpose

Expose each durably completed valid watchdog reflection as a precise, optional semantic signal without changing reflection retries, reports, or route correction.

## Requirements

### Requirement: Valid final reflections publish a completion hook
The watchdog SHALL publish exactly one `pi:semantic-hook:v1` envelope named `reflection-completed` only after a final valid reflection result and its completion marker have both been durably recorded. Its values SHALL contain `REFLECTION_TYPE`, `REASON`, and `NEXT_STEP`. A text field of at most 4096 UTF-16 code units SHALL be published unchanged. A longer `REASON` or `NEXT_STEP` SHALL be published as the longest whole-code-point prefix that leaves room for one trailing U+2026 ellipsis and keeps the final value at or below 4096 UTF-16 code units; the durable reflection result SHALL retain the full original field.

#### Scenario: No-issue reflection completes
- **WHEN** a valid final reflection of type `NO_ISSUE` is durably completed
- **THEN** one `reflection-completed` hook is published with `REFLECTION_TYPE=NO_ISSUE` and the matching reason and next step

#### Scenario: Route-correction reflection completes
- **WHEN** a valid final reflection of type `ROUTE_CORRECTION` is durably completed
- **THEN** one `reflection-completed` hook is published without awaiting, acknowledging, cancelling, or replacing the route-correction continuation

#### Scenario: Completion is not durable
- **WHEN** either required completion entry cannot be durably recorded
- **THEN** no `reflection-completed` hook is published

#### Scenario: Over-limit reflection text completes
- **WHEN** a valid durable reflection has `REASON` or `NEXT_STEP` longer than 4096 UTF-16 code units
- **THEN** the full field remains in the durable result and the corresponding hook value is a whole-code-point prefix plus `…` whose total length does not exceed 4096 code units

#### Scenario: Protocol-boundary text completes
- **WHEN** a valid durable reflection field is exactly 4096 UTF-16 code units
- **THEN** the hook publishes that field unchanged

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

### Requirement: Notification consumers remain optional
Completion-hook publication SHALL be best-effort to current listeners only and SHALL not make the watchdog depend on, identify, acknowledge, wait for, or import any notification consumer.

#### Scenario: No listener is present
- **WHEN** a valid reflection completes without any semantic-hook listener
- **THEN** completion recording, counter observation, and route-correction behavior proceed normally

#### Scenario: Listener throws
- **WHEN** a semantic-hook listener throws while receiving `reflection-completed`
- **THEN** the completed result, route correction, and later watchdog scheduling remain unchanged
