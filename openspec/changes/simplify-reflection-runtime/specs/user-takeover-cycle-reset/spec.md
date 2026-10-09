## ADDED Requirements

### Requirement: Session navigation resets memory time and rebuilds loop views

Actual session replacement, reload, new-session creation, fork, or tree navigation SHALL clear both memory-only clocks. Loop values and cooldown SHALL be rebuilt through Pi APIs for the selected branch and applicable cycle windows. Ordinary entry append, compaction, or a changed leaf identifier caused by normal conversation SHALL NOT alone count as navigation.

A cancelled navigation SHALL leave the existing accounting scope intact. Stale events or inquiries owned by a replaced scope SHALL not gain reflection authority in the new scope. The watchdog SHALL NOT rewrite either branch or persist elapsed clock values for restoration. These accounting resets SHALL NOT redefine the separately specified true-abort hold, its explicit-input re-entry, or the limitations of already-submitted native work.

#### Scenario: Select an earlier branch
- **GIVEN** the current branch has elapsed time and valid loops beyond a fork point
- **WHEN** navigation to another branch succeeds
- **THEN** both clocks display zero
- **AND** loop and cooldown views derive from the selected branch rather than abandoned replies

#### Scenario: New session
- **WHEN** `/new` replaces the active session
- **THEN** clocks and loop views begin empty for that new session
- **AND** old-session callbacks cannot populate its counters or authorize an old reflection

#### Scenario: Ordinary append or compaction
- **WHEN** Pi advances the leaf by appending an assistant reply or a compaction entry without navigation
- **THEN** the clock is not cleared for that reason
- **AND** valid history remains available for the applicable loop window

#### Scenario: Navigation is cancelled
- **WHEN** an attempted tree navigation is cancelled before the active branch changes
- **THEN** the watchdog retains the current clock and accounting scope

#### Scenario: Navigation does not silently release an existing hold
- **GIVEN** an abort hold applies within the current session
- **WHEN** tree navigation only changes its branch without fresh explicit input or a new `/reflect`
- **THEN** the memory clocks reset and the target branch loop view is rebuilt
- **AND** navigation is not treated as an explicit re-entry signal
