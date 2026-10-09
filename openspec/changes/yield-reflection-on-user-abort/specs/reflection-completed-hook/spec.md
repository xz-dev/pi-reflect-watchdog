## MODIFIED Requirements

### Requirement: Non-final reflection paths remain silent

The watchdog SHALL NOT publish `reflection-completed` for intermediate result attempts or any path that lacks one valid final completed reflection. A main-run abort before completion SHALL cancel that attempt even if valid result arguments have already been staged; it SHALL NOT newly publish a completed report, completion marker, or hook. Results already durably completed before the abort SHALL remain historical completed results, without rollback or repeat publication.

#### Scenario: XML is retried
- **WHEN** a non-cancelled reflection supplies legacy XML text instead of calling the result function and another reflection attempt follows
- **THEN** the invalid attempt publishes no completion hook, and only a later valid final completion can publish one

#### Scenario: Invalid function arguments are retried
- **WHEN** the result function receives invalid arguments during a confirmed non-cancelled reflection and another attempt follows
- **THEN** the invalid attempt publishes no completion hook
- **AND** only a later valid final completion can publish one

#### Scenario: Reflection terminates without a valid result
- **WHEN** result validation exhausts, the settled run has no captured decision and is cancelled, ownership is lost, or shutdown clears the active reflection
- **THEN** no `reflection-completed` hook is published

#### Scenario: Valid staged result is aborted before completion
- **GIVEN** valid arguments were staged but the reflection has not durably completed
- **WHEN** a main-run abort cancels that reflection
- **THEN** no new completed report, completion marker, or completion hook is published for it
- **AND** repeated settlement or late tool completion remains silent

#### Scenario: Abort follows a historical completion
- **GIVEN** a valid reflection was durably completed and its hook already published
- **WHEN** subsequent ordinary work is aborted
- **THEN** that report remains readable
- **AND** its hook is neither retracted nor emitted again
