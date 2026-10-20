## ADDED Requirements

### Requirement: Manual reflections start background inquiries
When `/reflect` is invoked on current main with no outstanding reflection, the plugin SHALL immediately admit one background private inquiry with manual origin and the user's supplement. This explicitly replaces inquiry-time native steering: the plugin SHALL reserve no native slot or wake request. It SHALL freeze the qualified source at admission and SHALL not wait for parent generation, tools, ordinary children, native queues or settlement. Parent work SHALL not be aborted or blocked.

Only a current valid result, after durable result/completion records, SHALL use native delivery: steer when busy; deliver and trigger one ordinary continuation when idle. Failure/no-result/cancel/stale SHALL send nothing to main. Manual requests SHALL bypass automatic cooldown. Fresh `/reflect` after abort SHALL reset the cycle before releasing the hold. Existing pending queue/coalescing and pending-only cancellation SHALL remain; no counting-pause option is added.

#### Scenario: Request while the agent generates
- **GIVEN** main is generating and no reflection is outstanding
- **WHEN** `/reflect check the approach` is invoked
- **THEN** one background inquiry captures qualified source and supplement without stopping main
- **AND** no main prompt, marker or provider request is added at admission

#### Scenario: Request during a multi-tool turn
- **GIVEN** an ordinary tool batch is incomplete
- **WHEN** `/reflect` is invoked
- **THEN** snapshot qualification excludes the open batch and retains full replayable ancestry
- **AND** all parent tools continue without waiting for reflection

#### Scenario: Invocation while idle
- **GIVEN** main is idle and no reflection is outstanding
- **WHEN** `/reflect` is invoked
- **THEN** the private inquiry starts without a parent request or another user input
- **AND** only a later current durable result can trigger one ordinary continuation

#### Scenario: Busy children and earlier native messages
- **GIVEN** ordinary children and main's native queue contain work
- **WHEN** a manual inquiry starts
- **THEN** that work neither delays capture nor is reordered or cancelled
- **AND** any eventual result joins native delivery order at result time, not the former inquiry reservation position

#### Scenario: Manual request during cooldown
- **WHEN** a manual request is admitted while automatic cooldown applies
- **THEN** it starts without waiting for cooldown or an ordinary completion

#### Scenario: Explicit manual re-entry after abort
- **WHEN** the user freshly invokes `/reflect` after the abort hold
- **THEN** a fresh cycle and source identity precede launch and the cancelled operation is not revived

#### Scenario: Request while another reflection is active
- **WHEN** `/reflect` creates plugin-pending manual work behind the active operation
- **THEN** existing coalescing and pending-only withdrawal apply
- **AND** that request gets its own trigger-time snapshot when later admitted

## MODIFIED Requirements

### Requirement: No host or protocol changes
Background execution and result delivery SHALL use supported stock Pi interfaces without host changes, private queue access or whole-queue clear/replay. No control-only native queue primitive is required. The old public inquiry/result-function transport is replaced by the private full-fork/file contract. Versioned private accounting transport remains independent. Already-submitted successful feedback retains native residual-work limits; cancelling an unaccepted private result creates no new main slot to retract.

#### Scenario: Runs on stock Pi
- **WHEN** background reflection starts, finishes or is withdrawn while still plugin-pending
- **THEN** no host patch, parent abort, bridge/result tool or queue mutation is required

#### Scenario: Unrelated messages remain intact
- **WHEN** the private inquiry fails or becomes stale
- **THEN** no result is injected and unrelated main messages remain unchanged

#### Scenario: Private accounting evolution preserves the public contract
- **WHEN** authenticated versioned child accounting updates counters
- **THEN** it does not become result submission or authorize background feedback by itself

## REMOVED Requirements

### Requirement: Manual reflections use immediate native steering
**Reason**: The user chose background inquiry admission rather than a native steering reservation.
**Migration**: Freeze qualified source and launch without parent traffic; steer only successful current durable feedback.
