## Purpose

Ensure Reflect Watchdog accounts for participating background agents over a shared process domain without depending on which extension opened the transport first.

## ADDED Requirements

### Requirement: Extension-independent contributor enrollment
Reflect SHALL accept valid participation from an authenticated online peer running its supported accounting protocol without requiring Reflect-specific fields in shared transport metadata. Transport connection alone SHALL NOT establish a busy contributor.

#### Scenario: Continue opens the shared node first
- **WHEN** Continue opens a background process's shared node before Reflect and that process sends a valid Reflect participation checkpoint
- **THEN** Reflect recognizes that contributor despite shared metadata containing only Continue's identity
- **AND** Continue continues to recognize its own activity reports

#### Scenario: Reflect opens the shared node first
- **WHEN** Reflect opens the shared node before Continue and the same valid work is reported
- **THEN** accounting results equal those from the Continue-first order
- **AND** Continue activity reporting remains functional

#### Scenario: Unrelated peer connects
- **WHEN** an authenticated peer connects without sending valid Reflect participation
- **THEN** the connection contributes neither active time nor loops

### Requirement: Background-only work contributes to aggregate accounting
While an enrolled background contributor performs ordinary work and accounting is not paused, Reflect SHALL advance active and task time and count its successful assistant turns in all loops. Background work SHALL NOT increment root loops. Internal reflection turns and unsuccessful outcomes SHALL retain their existing exclusions.

#### Scenario: Main is idle while background work continues
- **WHEN** the main agent is idle throughout a two-second continuously active background interval with three successful ordinary assistant turns
- **THEN** the interval adds 2000 milliseconds to active and task time and three to all loops
- **AND** root loops remain unchanged
- **AND** this result holds in both watchdog load orders

#### Scenario: Main resumes after background work
- **WHEN** the main agent resumes ordinary work and completes one successful assistant turn
- **THEN** local time accounting resumes normally and root loops and all loops each increase by one
- **AND** previously accepted background loops are not counted again

#### Scenario: Background work crosses a reflection threshold
- **WHEN** accepted background work crosses the configured task-time or all-loop threshold while automatic reflection is otherwise eligible
- **THEN** the main attachment submits the automatic inquiry through the existing native steering path
- **AND** submission does not require background work to finish first

### Requirement: Enrollment preserves accounting fences
Reflect MUST bind participation and acknowledgements to the authenticated sender and its validated accounting identity. It MUST preserve generation checks, monotonically increasing checkpoint sequences, cumulative-counter validation, and replay-receipt checks. Rejected data SHALL NOT add time or loops or erase valid contributors.

#### Scenario: Duplicate or stale checkpoint
- **WHEN** a contributor repeats an accepted checkpoint or sends an older sequence or generation
- **THEN** no loops are added again and stale activity does not replace the current accepted state

#### Scenario: Invalid participation or forged replay
- **WHEN** a report has malformed fields, an unsupported protocol version, decreasing cumulative counters, an invalid replay receipt, or an identity inconsistent with its established contributor
- **THEN** it does not alter accepted accounting
- **AND** other valid contributors continue to be counted

#### Scenario: Offline contributor reconnects
- **WHEN** a busy contributor disconnects
- **THEN** it immediately ceases to contribute live busy state
- **AND** reconnect recovery uses existing bounded replay rules rather than resetting or duplicating previously accepted totals

### Requirement: Pause recovery is independent of transport metadata
Reflect SHALL retain domain-wide pause semantics and permit valid participants to synchronize after a pause-generation change without depending on Reflect-specific transport metadata.

#### Scenario: Contributor starts while paused
- **WHEN** an authenticated Reflect contributor first reports while domain accounting is paused
- **THEN** its work does not add time or loops during the pause
- **AND** after resume and synchronization, subsequent ordinary work is counted in either watchdog load order

#### Scenario: Existing contributor resumes
- **WHEN** a configured pause ends for an already enrolled contributor
- **THEN** it synchronizes to the current accounting generation and reports current activity
- **AND** paused work is neither replayed nor counted as elapsed task time
