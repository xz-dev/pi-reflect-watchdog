## Purpose

Expose each durably completed valid watchdog reflection as a precise, optional semantic signal without changing reflection retries, reports, or route correction.

## ADDED Requirements

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
The watchdog SHALL NOT publish `reflection-completed` for intermediate XML attempts or any path that lacks one valid final completed reflection.

#### Scenario: XML is retried
- **WHEN** an invalid XML attempt is followed by another reflection attempt
- **THEN** the invalid attempt publishes no completion hook, and only a later valid final completion can publish one

#### Scenario: Reflection terminates without a valid result
- **WHEN** XML validation exhausts, the settled run has no captured decision and is cancelled, ownership is lost in `syncOwnership`, or shutdown clears the active reflection
- **THEN** no `reflection-completed` hook is published

### Requirement: Notification consumers remain optional
Completion-hook publication SHALL be best-effort to current listeners only and SHALL not make the watchdog depend on, identify, acknowledge, wait for, or import any notification consumer.

#### Scenario: No listener is present
- **WHEN** a valid reflection completes without any semantic-hook listener
- **THEN** completion recording, counter observation, and route-correction behavior proceed normally

#### Scenario: Listener throws
- **WHEN** a semantic-hook listener throws while receiving `reflection-completed`
- **THEN** the completed result, route correction, and later watchdog scheduling remain unchanged
