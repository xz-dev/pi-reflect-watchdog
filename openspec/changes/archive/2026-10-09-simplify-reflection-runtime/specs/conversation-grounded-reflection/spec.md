## MODIFIED Requirements

### Requirement: Existing lifecycle and compatibility remain intact

The reflection result function SHALL retain the five unique non-empty string fields `type`, `reason`, `done`, `current_step`, and `next_step`, with only `NO_ISSUE` and `ROUTE_CORRECTION` as result types. Existing stored reports SHALL remain readable without migration. The history locator SHALL NOT be added to the stored report or completion-hook payload. Free-text report fields SHALL NOT become completion-state selectors.

Inquiry folding, bounded result correction, host-owned provider retry handling, ordinary-loop inquiry exclusions, threshold values, cooldown, cross-process ownership safeguards, and completion-hook timing and values SHALL retain their existing contracts. Time accounting SHALL instead follow official aggregate working state, including inquiry activity; automatic decisions SHALL occur only at new valid ordinary turn completions when no abort hold applies, with no latched automatic request. User-message and navigation resets SHALL follow `user-takeover-cycle-reset`. True main abort SHALL retain full-cycle reset, revoked inquiry authority, cancelled unsubmitted work, and the hold released only by fresh explicit interactive/RPC input or a new `/reflect`. This hold SHALL not pause observation of otherwise working children.

Reflection prompts, correction prompts, function calls, and tool results SHALL be folded from subsequent ordinary model requests after normal finalization or cancellation of the exact owned inquiry. Cancelled material SHALL NOT be presented as a live reflection. Folding SHALL NOT erase historical sessions or lose, duplicate, or reorder unrelated user text, images, or extension messages, and SHALL NOT be described as eliminating a native queue slot's request effect.

Only a non-cancelled, valid reflection whose result and completion marker have been durably recorded SHALL authorize a new plugin-issued ordinary continuation. Valid parameters or a staged submission alone SHALL NOT suffice. That ordinary continuation SHALL count as ordinary work, not another internal inquiry. Already durably completed reports and already published hooks SHALL remain historical effects; later abort SHALL neither roll them back nor publish them again. Re-entry source filtering, reset-before-release, and rejection of old events that would pollute a fresh inquiry or budget SHALL follow the coordinated `user-takeover-cycle-reset` and `reflection-response-contract` requirements.

No task-completion decision type, second inquiry lifecycle, or new user configuration option SHALL be introduced. Model-facing source projection SHALL NOT change which underlying replies qualify as ordinary loops.

#### Scenario: Completion and subsequent reflection
- **WHEN** a non-cancelled valid reflection is durably completed and another reflection occurs later
- **THEN** the inquiry is folded, the report remains available under the existing storage contract, and the completion hook retains its payload shape
- **AND** the next reflection can use the report with its historical-analysis label without a new report version

#### Scenario: No-issue completion does not retrigger reflection during cooldown
- **GIVEN** thresholds were reached while an inquiry was outstanding
- **WHEN** a non-cancelled valid `NO_ISSUE` is durably completed
- **THEN** one ordinary continuation is initiated
- **AND** no stored threshold decision is redispatched by finalization
- **AND** a subsequent valid ordinary completion evaluates current counters under the existing cooldown

#### Scenario: Repeated finalization does not duplicate the handoff
- **GIVEN** a non-cancelled valid reflection has already been durably finalized
- **WHEN** another settled event occurs without a new result
- **THEN** no second continuation, completion record, or hook is created for that result

#### Scenario: No issue or invalid XML
- **WHEN** a non-aborted reflection submits valid `NO_ISSUE` through the result function or supplies legacy XML instead of calling it
- **THEN** a non-cancelled valid result authorizes exactly one new ordinary continuation only after durable completion, while XML follows bounded correction without an ordinary continuation
- **AND** correction retains at most three total attempts and one shared ten-lookup-call budget

#### Scenario: A run ends without a valid decision
- **WHEN** validation exhausts or an inquiry authoritatively ends without a valid decision
- **THEN** no new plugin-issued ordinary continuation or completion hook is authorized for that path
- **AND** non-aborted validation failure retains its bounded warning and cleanup behavior
- **AND** native abort is cancellation without an invalid-response warning or reask, with exact-owned context cleanup preserved

#### Scenario: User takeover restarts threshold accounting
- **GIVEN** thresholds were approaching or crossed in the current cycle
- **WHEN** a real ordinary user message begins
- **THEN** the full cycle resets before the next automatic evaluation
- **AND** that reset does not claim to retract an inquiry already accepted by native steering

#### Scenario: Native residual work cannot revive a cancelled reflection
- **GIVEN** native steering accepted an inquiry, correction, or continuation before a true main abort revoked its inquiry authority
- **WHEN** a residual native slot later causes ordinary work after re-entry
- **THEN** this does not restore the old inquiry's authority or authorize a new plugin-issued continuation, correction, result, or completion hook
- **AND** an already-submitted continuation or wake remains subject to native residual request effects rather than a zero-extra-request guarantee
- **AND** no promise of retracting that slot or eliminating its ordinary request, cost, or ordinary tool effects is made
