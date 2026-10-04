## MODIFIED Requirements

### Requirement: Non-final reflection paths remain silent
The watchdog SHALL NOT publish `reflection-completed` for intermediate result attempts or any path that lacks one valid final completed reflection.

#### Scenario: XML is retried
- **WHEN** a reflection supplies legacy XML text instead of calling the result function and another reflection attempt follows
- **THEN** the invalid attempt publishes no completion hook, and only a later valid final completion can publish one

#### Scenario: Invalid function arguments are retried
- **WHEN** the result function receives invalid arguments during a confirmed reflection and another attempt follows
- **THEN** the invalid attempt publishes no completion hook
- **AND** only a later valid final completion can publish one

#### Scenario: Reflection terminates without a valid result
- **WHEN** result validation exhausts, the settled run has no captured decision and is cancelled, ownership is lost in `syncOwnership`, or shutdown clears the active reflection
- **THEN** no `reflection-completed` hook is published
