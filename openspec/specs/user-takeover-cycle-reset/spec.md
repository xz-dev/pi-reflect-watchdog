# user-takeover-cycle-reset Specification

## Purpose

Defines how a real user takeover starts a fresh Reflect Watchdog activity cycle, so interrupted work cannot carry old counters or stale automatic reflection intent into the next cycle.

## Requirements

### Requirement: Real user message starts a fresh cycle

When the current main attachment processes a real user message, Reflect Watchdog SHALL reset active time, active loops, task time, root loops, and all loops before automatic threshold evaluation. After an abort has inhibited reflection, only a newly submitted explicit user message or a new user-invoked `/reflect` SHALL authorize re-entry. A user-role message alone SHALL NOT prove explicit user input: synthetic wakes, extension-generated messages, and background completion callbacks SHALL NOT restore reflection eligibility.

Explicit input provenance SHALL be checked before advancing any re-entry marker. Full-cycle reset SHALL complete before dispatch inhibition is released. Reset or release alone SHALL NOT constitute an automatic threshold trigger; the coordinated automatic decision boundary is a fresh valid ordinary main/child turn completion.

#### Scenario: Ordinary user message resets counters
- **GIVEN** the current main attachment has nonzero active/task/root/all counters
- **WHEN** a real user message starts ordinary conversation
- **THEN** active time, active loops, task time, root loops, and all loops become zero
- **AND** subsequent automatic reflection thresholds evaluate from the fresh cycle

#### Scenario: Plugin-owned message does not reset counters
- **GIVEN** a reflection inquiry, fold, continuation, assistant message, or custom message is active
- **WHEN** its corresponding message lifecycle event is observed
- **THEN** that event does not reset the user activity cycle or authorize post-abort re-entry

#### Scenario: Non-main attachment ignores user message
- **GIVEN** this attachment is not the current main
- **WHEN** it observes user input or a user message
- **THEN** it does not reset or re-enable the main attachment's reflection cycle

#### Scenario: New explicit input releases the abort hold
- **GIVEN** reflection is inhibited after a main-run abort
- **WHEN** the user submits a new ordinary message
- **THEN** the message is processed intact and exactly once through normal user-message delivery
- **AND** reflection eligibility resumes from a fresh accounting cycle, without reviving cancelled inquiries or queued requests

#### Scenario: Explicit manual reflection releases the abort hold
- **GIVEN** reflection is inhibited after a main-run abort
- **WHEN** the user invokes `/reflect inspect the new approach`
- **THEN** a fresh manual reflection with that supplement is submitted under the existing immediate-steering rules
- **AND** automatic reflection eligibility is restored from a fresh cycle
- **AND** a later normally completed valid result retains the usual single ordinary continuation

### Requirement: Terminal abort starts a fresh cycle

Reflect Watchdog SHALL recognize a main-run abort from Pi's authoritative aborted assistant outcome for that run, correlated with the current main and the branch boundary captured at run start. It SHALL NOT infer an abort merely from an Esc keystroke, idle observation, settlement, or historical aborted message. It SHALL preserve the aborted outcome during owned-message cleanup.

A confirmed abort SHALL install dispatch inhibition and revoke the cancelled inquiry's authority before counter resets, domain notifications, or other reentrant observation. It SHALL reset the full activity counters without releasing inhibition. An aborted initial inquiry or correction attempt SHALL be cancelled, not classified as an invalid response requiring another attempt. A staged valid result that has not completed SHALL lose its completion authority. Already durably completed reports and effects SHALL NOT be rolled back. Provider failures SHALL remain governed by host-owned error retry behavior rather than being treated as user aborts.

#### Scenario: Aborted terminal assistant resets counters
- **GIVEN** the current main captured a branch boundary at run start
- **AND** the new branch suffix ends with an assistant whose stop reason is `aborted`
- **WHEN** the abort is processed
- **THEN** the full activity counters become zero and reflection becomes inhibited
- **AND** settlement does not issue a new plugin reflection or ordinary-continuation submission

#### Scenario: Ordinary work is aborted near a threshold
- **GIVEN** an automatic reflection threshold was reached while ordinary main work was running
- **WHEN** that run is aborted
- **THEN** Reflect issues no new inquiry, correction, or continuation as a consequence of its terminal callbacks or counter observations
- **AND** old threshold intent is discarded

#### Scenario: Initial inquiry or correction is aborted
- **GIVEN** an initial reflection inquiry or one of its correction attempts is running
- **WHEN** the user aborts that run before completion
- **THEN** Reflect issues no new correction or ordinary continuation and publishes no completion hook for it
- **AND** partial output does not become an invalid-response retry

#### Scenario: Valid result is staged before abort
- **GIVEN** a reflection has supplied valid result arguments but has not completed
- **WHEN** that run is aborted
- **THEN** no completed reflection report, completion marker, completion hook, or continuation is newly published for the cancelled attempt

#### Scenario: Completed history is not erased
- **GIVEN** a reflection was already durably completed before a later run was aborted
- **WHEN** the later abort is processed
- **THEN** the historical completed report remains readable
- **AND** the abort does not replay its completion hook or submit another plugin-issued continuation
- **AND** any already-submitted wake remains subject to the native-residue limit

#### Scenario: Non-aborted settlement preserves counters
- **GIVEN** the current main captured a branch boundary
- **AND** the terminal new assistant stop reason is not `aborted`
- **WHEN** the run settles without another reset event
- **THEN** settlement alone neither resets counters nor changes post-abort eligibility

#### Scenario: Missing boundary does not infer abort
- **GIVEN** no usable run boundary or correlated current-run abort evidence exists
- **WHEN** a settled event or an old aborted branch entry is observed
- **THEN** no abort cancellation is inferred

#### Scenario: Esc does not interrupt an agent run
- **WHEN** Esc closes a dialog or is pressed while no agent run is aborted
- **THEN** the keystroke alone neither cancels reflection state nor installs a post-abort hold

### Requirement: Takeover clears stale automatic intent only

For an ordinary real user message without a main-run abort, the existing cycle reset SHALL discard stale automatic threshold intent while preserving queued manual requests and normal active-reflection handling. A confirmed main-run abort SHALL instead cancel outstanding reflection authority, staged but uncommitted results, pending automatic requests, and all manual requests still pending in plugin custody. The ordinary-message preservation rule SHALL NOT override abort cancellation.

Cancellation SHALL revoke the authority of exact owned inquiry, correction, and not-yet-consumed continuation work from the cancelled cycle. Delayed events SHALL NOT publish results, consume a fresh cycle's budget, re-hold fresh work, or authorize new plugin submissions, including after explicit user re-entry. Host work already accepted before cancellation remains subject to the native-residue limit below. Cleanup SHALL NOT delete, rewrite, replay, or reorder unrelated user or extension messages. It SHALL NOT cancel independent background agents or undo completed tool effects.

#### Scenario: Pending automatic reflection is stale after takeover
- **GIVEN** an automatic threshold was reached in the previous activity cycle
- **WHEN** a real user message resets the cycle
- **THEN** the old threshold decision is not reused or retained for later dispatch
- **AND** only a subsequent fresh valid ordinary turn completion can reevaluate the current counters

#### Scenario: Manual queue survives takeover
- **GIVEN** a manual `/reflect` request is queued in plugin custody
- **WHEN** ordinary user-message processing resets the cycle without an abort
- **THEN** the manual request remains queued under the existing dispatch rules

#### Scenario: Active reflection still completes normally
- **GIVEN** an active reflection is not cancelled
- **WHEN** ordinary user-message processing resets accounting
- **THEN** that reset alone does not replace normal result, retry, persistence, or continuation handling

#### Scenario: Abort cancels the manual waiting slot
- **GIVEN** a manual `/reflect` request waits behind an outstanding inquiry
- **WHEN** a main-run abort is confirmed
- **THEN** the waiting request and its queued indication are discarded
- **AND** explicit re-entry does not resurrect it

#### Scenario: Submitted inquiry has not yet been consumed
- **GIVEN** a reflection inquiry was submitted to native steering but has not been consumed
- **WHEN** its ordinary main run is aborted
- **THEN** that inquiry loses its reflection authority and cannot authorize a new plugin retry, result, or completion hook
- **AND** later explicit user work does not consume it as a live reflection request
- **AND** its already-submitted native slot may still cause an additional ordinary request under the native-residue limit

#### Scenario: Late cancelled result arrives after re-entry
- **GIVEN** an inquiry was cancelled by abort and the user has since started a fresh cycle
- **WHEN** an old result, tool completion, or repeated settlement arrives
- **THEN** it cannot complete the cancelled reflection or change the fresh cycle's reflection authority
- **AND** it cannot re-hold the fresh cycle or change its attempt or lookup budget

#### Scenario: User input is submitted while abort settles
- **GIVEN** a main-run abort is being processed
- **WHEN** the user submits a new message with text and images
- **THEN** cancellation of old owned work neither drops nor duplicates that input
- **AND** the new explicit input can start the fresh cycle without accepting old reflection callbacks

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

### Requirement: Post-abort inhibition requires explicit user re-entry

Within the active session runtime, post-abort inhibition SHALL remain in force until new explicit user input or a new user-invoked `/reflect` occurs. Timers, elapsed time, child activity, counter updates, legacy pause/resume notifications, background callbacks, and new agent runs initiated without user input SHALL NOT release it. Accounting and background tasks MAY continue under their existing rules, but SHALL NOT dispatch reflection while inhibited. Explicit re-entry SHALL reset counters before automatic evaluation so work accumulated during inhibition does not immediately force reflection.

Working-state observation SHALL continue while inhibited. A valid child turn SHALL NOT submit or latch automatic reflection during the hold. `/cancel-reflect` and its shortcut SHALL remain withdrawal-only and SHALL NOT release inhibition.

This hold SHALL apply to Reflect's own automation, not prevent Pi or another extension from running unrelated work. It SHALL NOT introduce a persistent lock setting, a timeout, or a new command; restoration of operational hold state across process restart or extension reload is outside this contract.

#### Scenario: Background work crosses a threshold after stop
- **GIVEN** the user aborted main work and a child remains busy
- **WHEN** child counters cross an automatic reflection threshold
- **THEN** no reflection request is submitted and no elapsed-time delay releases the hold

#### Scenario: Callback wakes ordinary work
- **GIVEN** post-abort inhibition is active
- **WHEN** a background completion callback starts an ordinary main run without new user input
- **THEN** Reflect remains inhibited even if the callback appears as a user-role message
- **AND** Reflect does not cancel that unrelated run

#### Scenario: Legacy pause event cannot release inhibition
- **GIVEN** post-abort inhibition is active
- **WHEN** a legacy pause or resume notification is observed
- **THEN** the hold remains active and removed counting-pause behavior is not restored

#### Scenario: Re-entry does not inherit held counters
- **GIVEN** background work accumulated counters while reflection was inhibited
- **WHEN** the user submits new work
- **THEN** automatic thresholds evaluate from the fresh cycle rather than those held counters

#### Scenario: Normal-idle main can be awakened by a child turn
- **GIVEN** no abort hold applies, main is idle, and an independent child is still working
- **AND** cooldown, current-main ownership, and inquiry serialization permit a new inquiry
- **WHEN** a fresh valid ordinary child turn completes and reaches a reflection threshold
- **THEN** main submits one native-steered inquiry without waiting for the whole process domain to become idle

#### Scenario: Withdrawal does not release the hold
- **GIVEN** post-abort inhibition is active
- **WHEN** the user invokes `/cancel-reflect` or its configured shortcut
- **THEN** only any plugin-pending manual request is withdrawn
- **AND** inhibition remains active and unrelated ordinary work is not aborted

### Requirement: Cancellation distinguishes plugin work from native residue

The watchdog SHALL prevent new plugin-issued reflection, correction, and continuation submissions from cancelled work and SHALL reject its result and completion authority. Work already accepted by the host before cancellation is outside the plugin withdrawal guarantee: native slots or deferred actions can later cause ordinary provider requests, costs, or ordinary tool effects. Cancellation SHALL NOT imply selective native retraction or zero extra provider requests.

Exact owned cancelled inquiry/correction prompts, function calls, and tool results SHALL be folded from subsequent ordinary context without erasing historical sessions or losing, duplicating, or reordering unrelated text, images, or extension messages. Residual native work SHALL NOT restore old reflection authority or release post-abort inhibition. Already durably completed reports and published hooks SHALL remain historical effects without repeat publication.

#### Scenario: Cancelled native slot still drives an ordinary request
- **GIVEN** the host accepted an inquiry before main abort cancelled its authority
- **WHEN** a later ordinary run consumes its residual native slot
- **THEN** an additional ordinary provider request can occur without a guarantee of slot retraction
- **AND** cancelled inquiry instructions are not presented as live reflection and the slot does not authorize a new plugin correction, result, hook, or continuation

#### Scenario: Previously submitted wake survives a later abort
- **GIVEN** a completed reflection submitted its ordinary wake before a later main abort
- **WHEN** the host subsequently acts on that already-submitted wake
- **THEN** its ordinary request effects remain outside the withdrawal guarantee
- **AND** the old completion is neither republished nor used to authorize another plugin-issued continuation

#### Scenario: Inhibited observation attempts a new submission
- **GIVEN** a confirmed main abort installed inhibition and no explicit user re-entry occurred
- **WHEN** child turns, counter updates, or repeated settlement observations occur
- **THEN** Reflect submits no new inquiry, correction, or continuation
- **AND** the native-residue limit is not permission to create another plugin request
