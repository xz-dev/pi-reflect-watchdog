# turn-end-reflection Specification

## Purpose
Submit automatic reflection promptly at real ordinary turn-completion boundaries, including participating child turns, without interrupting execution or turning timer observations into scheduled work.

## Requirements

### Requirement: Live valid turn completion is the automatic decision boundary
Without an abort hold, each new valid ordinary main or participating-child turn completion SHALL allow current main to evaluate automatic reflection once after its own complete assistant/tool batch and persisted reply. Evaluation SHALL use accepted current-cycle root/all loops and task time with OR semantics. Multiple reached limits SHALL admit one inquiry with applicable reasons.

Duplicates, historical replay, synchronization baselines, invalid replies and private inquiry turns SHALL not create a new decision boundary. Remote completions SHALL require authenticated live contributor/current scope with the count accepted first. Only current main SHALL launch the background private child. A remote trigger arriving while main is busy SHALL capture main's latest qualified replayable source immediately, not wait for main's current batch.

#### Scenario: Root limit is reached before the next display refresh
- **GIVEN** the root limit is 60 and current count is 59
- **WHEN** a fresh valid main completion raises the count to 60 with no inquiry/cooldown block
- **THEN** one private inquiry is admitted from the qualified current source

#### Scenario: Multiple conditions are true
- **WHEN** one valid completion reaches root/all/task limits together
- **THEN** one background inquiry records all applicable reasons

#### Scenario: Child completion wakes an idle main
- **GIVEN** idle main has no abort hold and a participating child is working
- **WHEN** its accepted fresh completion reaches the all-loop threshold
- **THEN** main starts a background private inquiry without another user turn or parent request
- **AND** ordinary child work is not aborted or required to become idle

#### Scenario: Duplicate or replayed child completion
- **WHEN** a completion is duplicated or historical counters replay
- **THEN** no duplicate inquiry is started
- **AND** a genuinely new valid completion may evaluate current counters

#### Scenario: The assistant failed rather than completing an ordinary loop
- **WHEN** an assistant ends with error, abort, excluded outcome or owned inquiry identity
- **THEN** it adds no ordinary loop and authorizes no automatic reflection

### Requirement: Ineligible decisions do not become deferred automatic intent

The watchdog SHALL retain at most one outstanding inquiry, including its submitted, executing, and correcting states. A completion observed while an inquiry is outstanding or a native-abort hold applies SHALL NOT queue or latch another automatic reflection. Only fresh explicit interactive/RPC input or a new user-invoked `/reflect` SHALL release the abort hold after resetting the cycle; child completions, synthetic callbacks, timer ticks, and ordinary work started by another extension SHALL NOT release it. Automatic decisions SHALL retain the existing cooldown length and valid-loop filtering; a threshold event consumed by cooldown SHALL reset its reminder window as in the existing contract, without scheduling a deferred inquiry. Manual requests SHALL retain their explicit-user path.

Timer ticks, counter publications without a live completion, ownership changes, reattachment, and settlement SHALL NOT independently evaluate automatic thresholds or replay a previously blocked decision. A later valid ordinary completion SHALL evaluate current conditions afresh. Dispatch reservation and cycle reset SHALL prevent simultaneous child completions or synchronous notifications from creating overlapping inquiries.

#### Scenario: Time crosses the limit during a long-running turn
- **WHEN** the one-second clock crosses its time limit while the current ordinary turn is still running
- **THEN** the display advances but no inquiry is submitted or latched
- **AND** the threshold is evaluated when a valid ordinary turn actually finishes

#### Scenario: A child finishes while reflection is active
- **WHEN** a child completion reaches a limit while an inquiry is outstanding
- **THEN** its eligible work is counted but no automatic waiting request is retained
- **AND** finalizing that inquiry does not itself replay the missed decision

#### Scenario: Child reaches its limit during abort hold
- **GIVEN** the main was truly aborted and no fresh explicit user input or `/reflect` has arrived
- **WHEN** a participating child finishes a valid turn reaching the all-loop limit
- **THEN** no new reflection is submitted or retained for later dispatch
- **AND** the hold does not stop the child's ordinary work

#### Scenario: Cooldown consumes a threshold event
- **GIVEN** a new valid turn ends above a limit while automatic cooldown still applies
- **WHEN** the decision is evaluated
- **THEN** its reminder window resets without an inquiry
- **AND** later timer or settlement events do not resurrect that decision

#### Scenario: A reset precedes the next decision
- **GIVEN** an earlier display sample was over a limit but no inquiry was submitted
- **WHEN** a real user message resets the cycle before the next valid completion
- **THEN** the next decision uses the new cycle rather than stale reasons or samples

### Requirement: Automatic reflection runs privately without blocking ordinary work
A qualifying live completion SHALL admit one background operation from a frozen trigger-time source, without inquiry/wake markers, parent abort, host patch or waiting for parent/child/queue settlement. Parent generation, complete tool batches and queued messages SHALL continue under native rules. Private work SHALL not suppress ordinary loop accounting or latch an automatic request while another inquiry is outstanding.

Only a current valid durable result SHALL cause main feedback: native steering if busy, or delivery with one triggered ordinary request if idle. Failure/no-result/cancel/stale SHALL add no main message, request or replacement inquiry. Earlier native work SHALL retain order at result delivery time. No former inquiry-slot ordering guarantee remains.

#### Scenario: A final answer reaches the limit
- **WHEN** a final valid ordinary answer reaches a limit
- **THEN** background reflection begins without artificial parent work
- **AND** a failed private inquiry leaves main settled with no new request

#### Scenario: Child threshold arrives while main tools run
- **WHEN** a participating child's completion crosses a threshold during main tool execution
- **THEN** main source is frozen at its latest replayable anchor and private work begins independently
- **AND** the whole ordinary tool batch proceeds without reflection waiting or interruption

#### Scenario: Parent keeps progressing before private completion
- **WHEN** main produces ordinary responses while its private inquiry is still working
- **THEN** those responses keep counting as ordinary work
- **AND** no additional automatic inquiry is queued or started from private activity

#### Scenario: Successful result arrives during a later parent turn
- **WHEN** current result/completion records become durable while main is busy
- **THEN** feedback steers at the next eligible native boundary after earlier queued messages
- **AND** no private correction or acknowledgement request is sent to main

### Requirement: Stale outcomes cannot retrigger by themselves
Automatic admission SHALL preserve its existing reminder-boundary record/reset. Stale cleanup SHALL not roll it back, reset later ordinary work, add cooldown/report records, reevaluate thresholds or launch replacements. Fresh explicit takeover retains the full-cycle reset. Later automatic admission SHALL require a fresh valid ordinary completion reaching current thresholds under existing cooldown rules.

#### Scenario: Active user makes a result stale
- **WHEN** a new non-owned user message invalidates the captured source
- **THEN** the private result is dropped without completion/hook/continuation
- **AND** repeated stale callbacks launch zero new children until a fresh ordinary threshold crossing

#### Scenario: Later ordinary work reaches a threshold again
- **GIVEN** stale cleanup has completed without rollback of admission's reset
- **WHEN** a fresh ordinary completion reaches a configured limit again
- **THEN** current main may admit one new inquiry if cooldown and ownership permit

#### Scenario: Already submitted feedback survives later abort
- **GIVEN** a valid result was completed and its ordinary feedback was submitted before abort
- **WHEN** retained native feedback later delivers
- **THEN** historical completion is not undone or republished
- **AND** no zero-residual-request or native-slot-retraction guarantee is added
