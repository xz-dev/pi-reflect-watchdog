## Purpose

Submit automatic reflection promptly at real ordinary turn-completion boundaries, including participating child turns, without interrupting execution or turning timer observations into scheduled work.

## ADDED Requirements

### Requirement: Live valid turn completion is the automatic decision boundary

When no native-abort hold applies, each new valid ordinary turn completion from a participating main or child agent SHALL allow the current main to evaluate automatic reflection exactly once for that completion. Evaluation SHALL occur after that turn's assistant response and entire tool batch have finished and its finalized reply is available through Pi APIs. It SHALL use fresh current-cycle root loops, all loops, and task time, not the last one-second display sample. Reaching any configured limit SHALL satisfy the threshold test; multiple satisfied limits SHALL produce one request with the applicable reasons.

A duplicate, historical replay, synchronization baseline, invalid assistant reply, or inquiry turn SHALL NOT supply a new automatic decision boundary. A remote completion SHALL be accepted only for its authenticated live contributor and current accounting scope, with its associated count update visible before evaluation. Only the current main SHALL submit reflection.

#### Scenario: Root limit is reached before the next display refresh
- **GIVEN** the root-loop limit is 60, 59 loops are displayed, and no inquiry or cooldown blocks dispatch
- **WHEN** the next valid main turn finishes before the display refresh
- **THEN** the main evaluates 60 loops and submits one automatic reflection

#### Scenario: Multiple conditions are true
- **WHEN** one valid ordinary turn ends with root-loop, all-loop, and task-time limits all reached
- **THEN** one inquiry is submitted containing the applicable trigger reasons rather than three inquiries

#### Scenario: Child completion wakes an idle main
- **GIVEN** the main is normally idle without an abort hold, a participating child is working, and the all-loop limit is 300
- **WHEN** that child finishes the valid turn that brings accepted all loops to 300
- **THEN** the current main evaluates the threshold and submits one automatic reflection through native steering
- **AND** child work is not aborted or required to become idle first

#### Scenario: Duplicate or replayed child completion
- **GIVEN** a live child completion has already been considered
- **WHEN** its delivery is duplicated, or its historical counters are replayed after reconnect
- **THEN** no second decision is created from that completion
- **AND** a subsequent genuinely new valid completion can evaluate the then-current counters

#### Scenario: The assistant failed rather than completing an ordinary loop
- **WHEN** an assistant finishes with an error, abort, excluded result, or inquiry correlation
- **THEN** that reply neither increments ordinary loops nor authorizes automatic reflection

### Requirement: Automatic reflection uses non-aborting native steering

When a live completion satisfies a threshold and dispatch is eligible, the main SHALL immediately submit the reflection using Pi's native steering delivery with turn triggering enabled. Submission SHALL NOT abort, preempt, or truncate any assistant response or tool execution. It SHALL use the same native ordering as user steering, preserving earlier queued steering messages and Pi's configured consumption policy rather than establishing a plugin priority queue.

The main SHALL NOT wait for its entire run to settle, for children to stop, or for all native pending messages to drain. A final valid ordinary turn with no otherwise-required follow-up SHALL still be allowed to schedule reflection. The same rule SHALL apply to a child completion when the main is normally idle without an abort hold. Native Pi cancellation and queue semantics SHALL remain authoritative.

Already-submitted native messages SHALL NOT be represented as retractable by the watchdog. Later abort SHALL revoke old inquiry authority and cancel unsubmitted work under the separate abort contract, but SHALL NOT imply a guarantee of zero residual ordinary provider requests, cost, or tool effects from native queue slots, including previously submitted continuations or wakes. Such residual work SHALL NOT restore old `ref` authority or authorize a new plugin-issued correction, continuation, result, or completion hook for the cancelled inquiry.

#### Scenario: A final answer reaches the limit
- **WHEN** a valid final ordinary answer reaches the limit and no other follow-up exists
- **THEN** reflection is submitted and can initiate the next model request
- **AND** no abort or artificial ordinary turn is required to deliver it

#### Scenario: The current tool batch is not interrupted
- **GIVEN** an ordinary turn contains multiple tool calls
- **WHEN** the automatic boundary is reached after all of them finish
- **THEN** reflection is queued for the next eligible steering-consumption point
- **AND** every tool result and earlier steering message retains its native order

#### Scenario: Child threshold arrives while main work is running
- **WHEN** a child's valid completion satisfies the threshold while the main is still generating a response or executing tools
- **THEN** reflection is submitted promptly to native steering
- **AND** the main's current work is not aborted or skipped to consume it

#### Scenario: A submitted native slot survives a later abort
- **GIVEN** reflection was submitted through native steering before a true main abort
- **WHEN** the retained slot is consumed after explicit re-entry
- **THEN** a residual ordinary request or ordinary tool effect is not misreported as a breached queue-removal guarantee
- **AND** the cancelled inquiry remains unauthorized and cannot authorize a new plugin-issued correction, continuation, result, or completion hook

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
