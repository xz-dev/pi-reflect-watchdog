## Purpose

Define reflection time and loop accounting from Pi-managed activity and current-branch history, independently of rendering and automatic reflection dispatch.

## ADDED Requirements

### Requirement: Official aggregate activity controls memory clocks

The watchdog SHALL count elapsed time whenever at least one participating Pi agent is officially working and SHALL freeze elapsed time when all participating agents are idle. The initial counting switch SHALL be zero and the working switch SHALL be one; enabling it SHALL NOT add an initial second. Parallel agents SHALL contribute the union of their working intervals, not a sum of per-agent durations. Reflection and native retry or compaction activity SHALL follow the same Pi activity signal, even though their messages do not necessarily qualify as ordinary loops.

Elapsed active and task time SHALL remain memory-only. A real ordinary user message SHALL reset the full cycle. Accepting an automatic threshold event, including an event consumed by existing cooldown, SHALL reset task time and reminder-loop budgets while preserving active-cycle time and loops. The existing configured long-idle reset policy SHALL remain: a gap strictly exceeding its limit resets the full cycle when work resumes; a shorter or equal gap resumes the frozen cycle. True main abort SHALL retain its separate full-cycle reset and explicit-input hold contract. The hold SHALL inhibit reflection submission, not observation of continuing child work; explicit re-entry SHALL reset the cycle before releasing that hold.

#### Scenario: Idle freezes rather than adding a second on resume
- **GIVEN** the aggregate has accumulated 12 seconds and its configured idle-reset gap has not expired
- **WHEN** all agents become idle and later one resumes work
- **THEN** the clock remains at 12 seconds through idle and resumes counting from that value
- **AND** neither the idle interval nor an artificial starting second is added

#### Scenario: Main stops while a child works
- **WHEN** the main becomes idle but a participating child continues working for five seconds
- **THEN** both applicable clocks advance by five seconds
- **AND** another simultaneously working child does not double that duration

#### Scenario: Reflection counts time but not ordinary loops
- **WHEN** only the reflection inquiry is working
- **THEN** elapsed time advances according to Pi's official activity
- **AND** inquiry replies do not advance ordinary loop counts or cooldown

#### Scenario: Existing long-idle reset remains distinct from pausing
- **GIVEN** the idle-reset gap is 60 seconds
- **WHEN** work resumes after exactly 60 seconds of aggregate idle
- **THEN** the existing cycle resumes
- **WHEN** work instead resumes after more than 60 seconds of aggregate idle
- **THEN** the full cycle is reset before new work is accounted

#### Scenario: Abort hold does not hide continuing child activity
- **GIVEN** a true main abort has reset the cycle and established its explicit-input hold
- **WHEN** a participating child continues working and completes valid turns
- **THEN** its post-reset activity can be counted and displayed
- **AND** those counters and turns do not release hold or submit reflection
- **AND** explicit re-entry resets the held cycle before automatic eligibility resumes

### Requirement: Delayed refresh does not accumulate timer drift

Under a responsive host, the watchdog SHALL update displayed time and loop values at a one-second cadence. Elapsed time SHALL be measured independently of the number of timer callbacks, retaining sub-second remainder across observations. Ordinary callback delay SHALL NOT accumulate permanent undercount. Runtime state changes SHALL be observed promptly rather than waiting for the next display sample, and threshold evaluation SHALL use fresh accounting rather than the previous rendered sample.

A proof-of-life observation gap exceeding ten seconds SHALL be treated as a suspended interval: at most one normal second of that gap SHALL be counted, and missed ticks SHALL NOT be replayed. This is an explicit approximation, not a guarantee of distinguishing process suspension from a long event-loop stall. It SHALL apply before charging elapsed time regardless of which observation first arrives after the gap.

#### Scenario: A late callback catches up without permanent drift
- **GIVEN** an agent remains working and no suspension-sized gap occurs
- **WHEN** three expected refreshes have been serviced only twice after 3.2 seconds of elapsed time
- **THEN** measured time is approximately 3.2 seconds rather than two seconds
- **AND** the display shows three whole seconds with the remainder preserved

#### Scenario: A suspended process resumes through a child update
- **GIVEN** the last proof-of-life observation was five minutes ago and the clock was counting
- **WHEN** a child update arrives before the next timer callback
- **THEN** at most one second of that gap is charged
- **AND** no burst of missed timer ticks or automatic reflection requests is produced

#### Scenario: Counter publication is not an automatic trigger
- **WHEN** a one-second refresh, busy-state change, or ordinary counter synchronization reports a crossed threshold
- **THEN** the display can reflect the current values
- **AND** no automatic reflection is submitted or retained for later dispatch by that observation alone

### Requirement: Loop values derive from Pi branch history

The watchdog SHALL obtain finalized history through supported Pi session APIs and derive loop counts from the active branch and applicable cycle boundary. It SHALL NOT directly open, parse, watch, or rewrite session JSONL, count every file entry across abandoned branches, or use compacted model context as a substitute for branch history. An in-memory Pi session SHALL support the same counting behavior.

A valid loop SHALL be a finalized assistant reply with stop reason `stop` or `toolUse`, no nonempty error annotation, no plugin-inquiry correlation, and at least one nonblank text block or tool-call block. Error, aborted, length-limited, empty, thinking-only, and plugin-inquiry replies SHALL NOT count. Multiple tool calls in one assistant reply SHALL count as one loop, not one loop per tool. Repeated observation of the same finalized entry SHALL NOT increment counts again.

#### Scenario: Valid and invalid replies coexist
- **WHEN** the active branch contains a nonblank ordinary stop reply, an ordinary tool-use reply with three calls, a provider error, an aborted reply, a length-limited reply, a thinking-only reply, and an inquiry reply
- **THEN** exactly two ordinary loops are counted

#### Scenario: Compaction leaves branch accounting intact
- **GIVEN** ten valid replies precede a compaction entry on the active branch
- **WHEN** the model-visible context no longer contains those ten replies
- **THEN** those replies still count if they lie within the applicable cycle window returned by Pi history APIs

#### Scenario: A fileless session and repeated refreshes
- **WHEN** a Pi session with no transcript file exposes four valid in-window replies and is refreshed repeatedly
- **THEN** the loop count remains four without filesystem access or event-based double counting

### Requirement: Children contribute through the existing process domain

Each participating attachment SHALL derive its own loop contribution through Pi APIs. The aggregate SHALL combine the main's current-window loops with accepted child contributions without counting inherited fork history twice. Root loops SHALL include main work only; all loops and active-cycle loops SHALL include eligible participating child work in their respective windows. Accepted child work SHALL remain counted after that child becomes idle or leaves, until the applicable cycle resets.

The existing transport identity, authentication, sequencing, generation, and reconnect/replay safeguards SHALL remain effective. Synchronization or restored history can repair counts but SHALL NOT impersonate a new live turn-completion event. A branch or cycle reset SHALL prevent stale contributions from an earlier scope being applied to the new window. This capability SHALL NOT promise reconstruction of absent historical child sessions after the whole process domain has been destroyed.

#### Scenario: Fork ancestry is not child work
- **GIVEN** a child starts from copied parent history containing six valid replies
- **WHEN** that child produces two new valid replies in its contribution scope
- **THEN** the child adds two all-loops contributions and no root-loop contribution

#### Scenario: A finished child and duplicate replay
- **GIVEN** a child's three loops have been accepted
- **WHEN** it leaves or its same checkpoint is received again
- **THEN** those three loops remain counted exactly once
- **AND** neither event independently triggers automatic reflection

#### Scenario: An old update arrives after reset
- **WHEN** a delayed child update belongs to a superseded branch or accounting generation
- **THEN** it cannot restore old loop budget or authorize reflection in the new scope

### Requirement: Plugin pause controls are absent

The watchdog SHALL expose no plugin-owned counting pause/resume interface, paired pause-hook subscription, or alternative counting-pause state. Legacy `hookPauses` configuration SHALL NOT alter activity, counters, rendering, or reflection eligibility. Unsupported legacy settings SHALL follow the existing bounded configuration diagnostic behavior without preventing startup. Native Pi activity, the separate abort dispatch hold, withdrawal-only manual cancellation, and normal session cleanup SHALL remain available; removing counting pause controls SHALL NOT remove those contracts, result validation, or transport safeguards.

#### Scenario: An old pause hook is emitted
- **GIVEN** Pi reports a participating agent as working
- **WHEN** another extension emits a hook formerly configured to pause the watchdog
- **THEN** the watchdog continues accounting according to Pi activity
- **AND** startup with the obsolete setting does not recreate a pause subscription
