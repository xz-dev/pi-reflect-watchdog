# user-takeover-cycle-reset Specification

## Purpose

Defines how a real user takeover starts a fresh Reflect Watchdog activity cycle, so interrupted work cannot carry old counters or stale automatic reflection intent into the next cycle.

## Requirements

### Requirement: Real user message starts a fresh cycle

When the current main attachment observes a real user-role message start, Reflect Watchdog SHALL reset the full activity cycle counters before further automatic threshold evaluation. The reset SHALL zero active time, active loops, task time, root loops, and all loops. Plugin-owned reflection inquiries, folds, continuations, assistant messages, custom messages, and events for non-main attachments SHALL NOT trigger this reset.

#### Scenario: Ordinary user message resets counters
- **GIVEN** the current main attachment has nonzero active/task/root/all counters
- **WHEN** a user-role `message_start` arrives for ordinary conversation
- **THEN** active time, active loops, task time, root loops, and all loops become zero
- **AND** subsequent automatic reflection thresholds evaluate from the fresh cycle

#### Scenario: Plugin-owned message does not reset counters
- **GIVEN** a reflection inquiry, fold, continuation, assistant message, or custom message is active
- **WHEN** its corresponding message lifecycle event is observed
- **THEN** the activity counters are not reset by that plugin-owned message

#### Scenario: Non-main attachment ignores user message
- **GIVEN** this attachment is not the current main
- **WHEN** a user-role `message_start` is observed
- **THEN** no cycle reset is requested by this attachment

### Requirement: Terminal abort starts a fresh cycle

Reflect Watchdog SHALL identify a user abort only by inspecting the newly appended branch suffix after the boundary captured at main `agent_start`. A reset SHALL occur only when the terminal new assistant entry in that suffix has `stopReason === "aborted"`. A settled run without an aborted terminal assistant SHALL NOT reset the cycle.

#### Scenario: Aborted terminal assistant resets counters
- **GIVEN** the current main captured a branch boundary at `agent_start`
- **AND** the new branch suffix ends with an assistant whose stop reason is `aborted`
- **WHEN** the run settles
- **THEN** the full activity cycle counters become zero

#### Scenario: Non-aborted settlement preserves counters
- **GIVEN** the current main captured a branch boundary at `agent_start`
- **AND** the terminal new assistant stop reason is not `aborted`
- **WHEN** the run settles
- **THEN** the existing activity cycle counters remain unchanged

#### Scenario: Missing boundary does not infer abort
- **GIVEN** no usable branch boundary was captured for the settling run
- **WHEN** the run settles
- **THEN** no abort reset occurs

### Requirement: Takeover clears stale automatic intent only

A confirmed user takeover SHALL discard latched automatic threshold reasons and any pending automatic reflection request. It SHALL preserve queued manual `/reflect` requests and SHALL NOT bypass existing active reflection completion, cancellation, report persistence, or continuation handling.

#### Scenario: Pending automatic reflection is stale after takeover
- **GIVEN** an automatic threshold reason is latched or an automatic reflection is pending
- **WHEN** a confirmed user takeover resets the cycle
- **THEN** the old automatic intent is discarded
- **AND** it cannot dispatch solely from the pre-reset threshold state

#### Scenario: Manual queue survives takeover
- **GIVEN** a manual `/reflect` request is queued in plugin custody
- **WHEN** a confirmed user takeover resets the cycle
- **THEN** the manual request remains queued and follows the existing dispatch rules

#### Scenario: Active reflection still completes normally
- **GIVEN** an active reflection exists when a user takeover occurs
- **WHEN** the run settles
- **THEN** existing reflection result, retry, cancellation, persistence, and continuation handling complete before any stale automatic work is reconsidered
