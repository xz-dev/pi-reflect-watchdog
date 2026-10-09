## MODIFIED Requirements

### Requirement: Reconsideration rather than a prevalidated handoff

A normally completed, non-cancelled valid `NO_ISSUE` or `ROUTE_CORRECTION`, with its result and completion marker durably recorded, SHALL authorize exactly one new plugin-issued ordinary continuation. This behavior SHALL apply to automatic reflection and manual `/reflect`, including manual invocation while the agent is idle. The handoff SHALL return control to ordinary conversation rather than ask for another reflection or result submission. Main-run abort before completion SHALL instead cancel the inquiry without authorizing a new plugin-issued ordinary continuation; a staged valid result SHALL NOT override that cancellation.

An ordinary continuation already submitted to the host before cancellation remains subject to the native-residue limit in `user-takeover-cycle-reset`. Exactly-once handoff refers to plugin submission, not a promise that the host makes exactly one provider request or can retract a submitted wake.

The handoff SHALL return the existing reflection report for assessment in the original conversation, without adding a new instruction to the report body. It SHALL NOT declare the suggested route prevalidated, interpret `NO_ISSUE` as task completion, or require execution of the suggested next step. Report-derived observations and the proposed next step SHALL remain the generated reflection's account, not a claim of verbatim human input; their model-facing role SHALL follow the trigger-specific delivery rule below. Continuing work, waiting for an existing callback, asking a question, and finishing a response SHALL remain decisions of the ordinary agent in the original conversational context.

#### Scenario: Direction is sound but ordinary work remains
- **GIVEN** ordinary work is incomplete and an automatic reflection finds no direction problem
- **WHEN** a valid `NO_ISSUE` completes without cancellation
- **THEN** exactly one ordinary continuation is initiated without another user prompt
- **AND** the feedback does not claim that the task is complete or require another reflection

#### Scenario: A valid reflection proposes a different direction
- **WHEN** a valid `ROUTE_CORRECTION` completes without cancellation
- **THEN** exactly one ordinary continuation receives the reflection as a perspective to assess
- **AND** its handoff does not instruct the agent to follow a route on the premise that the plugin has already established it as correct

#### Scenario: Manual reflection begins while idle
- **GIVEN** the user invokes `/reflect` while the ordinary agent is idle
- **WHEN** the reflection completes normally with either valid result type
- **THEN** exactly one ordinary continuation is initiated without requiring another user message
- **AND** the unchanged report is delivered with the `user` role
- **AND** there is no special no-continuation exception for idle manual reflection

#### Scenario: Manual reflection interrupts ongoing work
- **GIVEN** the user invokes `/reflect` during ongoing ordinary work
- **WHEN** the reflection completes normally with either valid result type
- **THEN** exactly one ordinary continuation returns to the original conversation
- **AND** the unchanged report is delivered with the `user` role
- **AND** the handoff does not substitute the reflection's suggested goal for the user's contextual request

#### Scenario: Waiting is still an appropriate response
- **GIVEN** ordinary work is waiting for an existing background callback
- **WHEN** a valid reflection completes normally
- **THEN** the ordinary continuation is initiated once
- **AND** the handoff does not direct the agent to poll, restart background work, or execute a suggestion merely because control was returned

#### Scenario: User stops reflection before handoff
- **GIVEN** an automatic or manual reflection is still running or has only staged a result
- **WHEN** a main-run abort cancels it before completion
- **THEN** neither result type authorizes a new plugin-issued ordinary continuation
- **AND** the cancelled result is not delivered as completed feedback on later user re-entry
