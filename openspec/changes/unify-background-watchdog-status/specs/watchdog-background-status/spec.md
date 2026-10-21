## Purpose

Expose private reflection progress in Reflect's existing below-editor status row while preserving ordinary activity accounting and private execution isolation. The canonical joint contract is owned by pi-continue-watchdog capability `watchdog-background-status`, introduced by the matching `unify-background-watchdog-status` change.

## ADDED Requirements

### Requirement: Reflect implements the canonical joint presentation contract
Reflect SHALL implement the shared row placement, theme-aware highlight, textual phase indication, elapsed-time cadence, responsive priorities, privacy and exact-operation cleanup defined by pi-continue-watchdog capability `watchdog-background-status`. The matching Continue change SHALL remain the joint tracking point; this repository SHALL track its own implementation and verification without redefining the shared contract. Reflect SHALL work without Continue installed, and both rows SHALL coexist without either plugin replacing the other.

#### Scenario: Both plugins are installed
- **WHEN** a private reflection and a private Continue decision run simultaneously
- **THEN** Reflect displays its own active phase in its existing row and Continue's row remains independently visible
- **AND** Reflect does not add another panel or require a cross-plugin runtime coordinator

#### Scenario: Reflect runs alone
- **WHEN** Reflect is installed without Continue
- **THEN** its local status row shows the same progress behavior without runtime access to the other plugin

### Requirement: Reflection stages identify actual private work
On reflection admission, Reflect SHALL show preparation, then update to actual observed model, admitted evidence-tool, result-validation, correction, publication or cancellation-drain stages as they occur. The row SHALL show total elapsed operation time from admission and the current result-attempt ordinal and limit when known. Helper-only responses and native provider retry/compaction SHALL NOT consume or advance result-attempt counts. Optional retry/compaction detail SHALL require an official observation. Helper labels SHALL contain only safe admitted tool names, not paths, arguments, output, result locations or private text.

#### Scenario: Reflection waits for the model
- **WHEN** an admitted private reflection waits 18 seconds for a model response
- **THEN** the existing row remains highlighted with a model-waiting phase and increasing operation elapsed time
- **AND** the row does not claim completed steps, an ETA or a percentage

#### Scenario: Reflection runs evidence helpers
- **WHEN** an admitted helper starts, finishes and is followed by another model request
- **THEN** the row changes to the safe helper name and then back to model waiting
- **AND** overlapping helpers keep the tool phase active until all current admitted helpers finish

#### Scenario: Invalid result authorizes correction
- **WHEN** result attempt 1 is invalid and the existing policy authorizes attempt 2
- **THEN** the row identifies correction and attempt 2/3 without resetting the operation elapsed time
- **AND** no raw invalid response is shown

### Requirement: Progress and accounting remain separate
At sufficient width, Reflect SHALL preserve the existing active duration/loops, task duration/limit, root and all loop budgets, cooldown and configured pending-request withdrawal hint alongside progress. Aggregate ordinary activity or a plugin-pending manual request SHALL NOT alone imply that a private reflection is active. Pending withdrawal and admitted execution SHALL remain distinct; an active reflection SHALL NOT be advertised as withdrawable by `/cancel-reflect`. A separately queued pending request SHALL retain its existing withdrawal hint even while another reflection runs. Elapsed operation time SHALL NOT change active/task accounting or ordinary loop counts.

#### Scenario: Ordinary work without reflection
- **WHEN** ordinary main or child work changes accounting and no reflection is admitted
- **THEN** the existing accounting row updates without an active-private-operation highlight

#### Scenario: Another manual request is pending
- **WHEN** one reflection is active and a later manual request is plugin-pending
- **THEN** the row distinguishes current private progress from the pending request and its effective withdrawal hint
- **AND** withdrawal of the pending request does not cancel or hide the active reflection

#### Scenario: Private work becomes the only activity
- **WHEN** ordinary agents are idle and reflection setup, model execution or cancellation drain remains pending
- **THEN** its operation elapsed display remains live at a one-second cadence under a responsive host
- **AND** accounting continues to follow existing official activity rules independently of the display timer

### Requirement: Reflection cleanup cannot affect another operation
Live progress SHALL be fenced by exact reflection identity and visible owner/session scope. Failure or completion SHALL end the old active highlight and private elapsed updates. Revocation SHALL show cancellation only while that same operation drains in the still-visible scope, or clear it when scope is replaced. Late events, review-independent callbacks and disposal SHALL NOT repaint or clear a successor. Cleanup SHALL unsubscribe old observations and release unneeded display timers without aborting unrelated main/Continue work, resetting accounting or submitting a replacement reflection.

#### Scenario: User takeover races a helper event
- **WHEN** user takeover revokes reflection A and a late helper event arrives after reflection B becomes current
- **THEN** B retains its own stage, start time and highlight and A's event cannot publish or schedule work

#### Scenario: Session replacement during preparation
- **WHEN** the visible session changes while an old reflection is preparing its child
- **THEN** the old progress and display timer cannot reappear in the replacement session
- **AND** existing exact-child revocation and cleanup continue without cancelling unrelated parent work

### Requirement: Responsive progress preserves private delivery boundaries
Reflect SHALL apply the canonical compact-layout priorities and safe terminal-column clipping while retaining full existing information when space permits. Render and progress updates SHALL create no transcript entries, private-content leaks, per-tick notifications or extra semantic hooks. Existing bounded diagnostics and durable reflection completion/feedback SHALL remain authoritative. Existing RPC status support SHALL remain safe plain text; terminal components SHALL not be required outside TUI mode.

#### Scenario: Narrow terminal then resize
- **WHEN** a running reflection's terminal narrows and later widens
- **THEN** the single row prioritizes plugin identity and active phase, then elapsed time and attempt, before secondary counters
- **AND** full counters and pending hints reappear when space permits without changing their values

#### Scenario: Reflection completes after many progress updates
- **WHEN** a current reflection completes after repeated phase and elapsed redraws
- **THEN** progress itself has created no conversation or summary content
- **AND** the existing durable result path remains the only authority for completion hook and ordinary feedback

#### Scenario: RPC mode
- **WHEN** reflection runs in RPC mode
- **THEN** supported status updates remain plain text and reflection can finish without a TUI widget
