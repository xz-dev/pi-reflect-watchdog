## MODIFIED Requirements

### Requirement: Existing lifecycle and compatibility remain intact

The public reflection XML SHALL retain the five unique non-empty fields `type`, `reason`, `done`, `current_step`, and `next_step`, with only `NO_ISSUE` and `ROUTE_CORRECTION` as result types. Existing stored reports SHALL remain readable without migration. The history locator SHALL NOT be added to the stored report or completion-hook payload. Free-text report fields SHALL NOT become completion-state selectors.

Inquiry folding, retry accounting, internal counter exclusions, automatic thresholds, cooldown, cross-process coordination, and completion-hook timing and values SHALL retain their existing contracts, except that a confirmed user takeover SHALL reset the full automatic-threshold activity cycle before further threshold evaluation. The ordinary continuation for either valid result SHALL count as ordinary work, not another internal inquiry. The change SHALL NOT introduce new configuration options, a task-completion decision type, or a second inquiry lifecycle. Model-facing source projection SHALL NOT change which underlying turns count as ordinary work.

#### Scenario: Completion and subsequent reflection
- **WHEN** a valid reflection is completed and another reflection occurs later
- **THEN** the original inquiry is folded, the report remains available under the existing storage contract, and the completion hook retains its existing payload shape
- **AND** the next reflection can use the report with its historical-analysis label without requiring a new report version

#### Scenario: No-issue completion does not retrigger reflection during cooldown
- **GIVEN** an automatic threshold was latched while a reflection was running
- **WHEN** a valid `NO_ISSUE` completes
- **THEN** one ordinary continuation is initiated
- **AND** the existing cooldown still prevents the latched automatic reflection from immediately redispatching

#### Scenario: Repeated finalization does not duplicate the handoff
- **GIVEN** a valid reflection has already been finalized
- **WHEN** another settled event occurs without a new reflection result
- **THEN** no second continuation is created for that result
- **AND** completion recording and completion-hook publication are not repeated

#### Scenario: No issue or invalid XML
- **WHEN** a reflection returns `NO_ISSUE` or requires XML correction
- **THEN** a valid `NO_ISSUE` initiates exactly one ordinary continuation, while an invalid XML attempt follows the existing bounded retry path without an ordinary continuation
- **AND** retries retain at most three total attempts and one shared ten-tool-call budget, rather than obtaining a fresh budget

#### Scenario: A run ends without a valid decision
- **WHEN** XML validation exhausts or a settled inquiry has no captured decision and is cancelled
- **THEN** this change does not add an ordinary continuation or completion hook for that path
- **AND** existing warnings and cleanup behavior remain intact

#### Scenario: User takeover restarts threshold accounting
- **GIVEN** automatic thresholds were approaching or already crossed in the interrupted cycle
- **WHEN** the user sends a real ordinary message or aborts the terminal assistant
- **THEN** the full activity cycle is reset before automatic thresholds are evaluated again
- **AND** the interrupted cycle's counters cannot trigger the next automatic reflection
