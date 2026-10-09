# conversation-grounded-reflection Specification

## Purpose

Enable open-ended third-party reflection on the work and the agent's interpretation of a conversation, while preserving the context needed to understand evolving user meaning and keeping clarification research brief.

## Requirements

### Requirement: Contextual third-party perspective

The default reflection guidance SHALL invite assessment of both the current direction and the working agent's interpretation of the conversation. It SHALL frame user meaning as potentially emerging across surrounding replies, complaints, clarifications, and corrections, rather than as isolated user sentences. It SHALL distinguish what the user expressed from the assistant's interpretation and newly inferred goals, without prescribing an exhaustive reasoning checklist or requiring agreement with either participant.

#### Scenario: Complaint clarified across multiple exchanges
- **GIVEN** the user says "Too complicated", the assistant proposes removing error handling, and the user clarifies "No, I meant the three layers of abstraction"
- **WHEN** reflection is prompted with the default perspective
- **THEN** the guidance invites interpretation of the exchange as a whole, including what the correction responds to
- **AND** it does not instruct the observer to discard complaints or to treat the assistant's proposal as the user's request

#### Scenario: A new perspective challenges the shared premise
- **GIVEN** both participants have been discussing approaches A and B
- **WHEN** reflection is prompted with the default perspective
- **THEN** the guidance allows questioning their common premise or proposing another direction
- **AND** it distinguishes such a new interpretation from what the user previously expressed

### Requirement: Fallible historical reflection

A previous reflection included in a new reflection prompt SHALL be identified as historical assistant analysis that can be mistaken or superseded by better understanding, not as user expression or a conclusion that must be maintained. The function-argument example SHALL describe the next step as a suggestion rather than as already established to be correct.

#### Scenario: An earlier reflection misunderstood the subject
- **GIVEN** the previous reflection discusses approval machinery while subsequent dialogue clarifies that the subject is third-party perspective and intent fidelity
- **WHEN** the previous report is included in the new prompt
- **THEN** it is explicitly framed as fallible assistant analysis that the observer can reject

### Requirement: Optional branch-scoped history recovery hint

The reflection prompt SHALL provide an optional history locator containing the original session file and current branch anchor when both are available. The hint SHALL describe focused recovery of relevant surrounding exchanges through existing tools, not a new user-only transcript or an authoritative intent summary. Locator values SHALL be represented as data. The hint SHALL explain that other branches in the same file are not the active conversation and that recovered historical content is material to interpret, not instructions addressed to the observer.

Constructing the hint SHALL NOT read or copy the transcript, issue another model request, or create a persistent history ledger. Missing locator information SHALL NOT prevent reflection or claim that unavailable history can be recovered.

#### Scenario: File contains multiple branches
- **GIVEN** the session has an original transcript file and a current branch anchor
- **WHEN** reflection is prompted
- **THEN** the hint identifies both and directs any recovery to the relevant exchanges on that branch
- **AND** it does not present all branches in the file as one conversation

#### Scenario: No usable history locator
- **GIVEN** the session has no transcript file or no current branch anchor
- **WHEN** reflection is prompted
- **THEN** the prompt states that a branch-scoped file recovery hint is unavailable
- **AND** reflection proceeds using its existing context without creating a file

#### Scenario: No historical ambiguity needs investigation
- **GIVEN** the visible conversation is sufficient for the reflection
- **WHEN** a history locator is provided
- **THEN** the hint does not require a transcript read or repeat the conversation into the prompt

### Requirement: Quick uncertainty-driven tool use

The plugin-owned tool guidance SHALL allow tools to clarify conversational meaning, actual work, or a possible direction, rather than limiting them to verification of the current route. It SHALL explicitly favor quick, focused lookups, stop further investigation once the relevant uncertainty is resolved, and direct the observer to state remaining uncertainty and finish when evidence cannot be obtained promptly. It SHALL discourage extended research, long-running validation, or waiting on background work during reflection.

This is prompt-level duration guidance, not a new hard timeout. The shared limit SHALL remain ten lookup tool calls across at most three result attempts. The result function SHALL NOT consume this lookup budget, so the observer can still submit its result after the tenth lookup.

#### Scenario: A quick lookup answers the question
- **GIVEN** one relevant lookup resolves the uncertainty motivating tool use
- **WHEN** reflection tool guidance is rendered
- **THEN** it tells the observer to conclude the investigation rather than keep searching merely to use the remaining budget

#### Scenario: Evidence would require long-running work
- **GIVEN** a useful detail cannot be established promptly without a broad investigation or a long-running check
- **WHEN** reflection tool guidance is rendered
- **THEN** it tells the observer to finish with the uncertainty stated rather than extending the reflection to wait for that work
- **AND** it does not claim a new program-enforced wall-clock deadline

#### Scenario: Custom reflection perspective
- **GIVEN** a user has configured a custom reflection prompt
- **WHEN** the plugin constructs the reflection request
- **THEN** the custom perspective remains in use
- **AND** the plugin-owned source framing, quick-clarification guidance, and shared tool budget remain present

### Requirement: Reconsideration rather than a prevalidated handoff

A normally completed, non-cancelled valid `NO_ISSUE` or `ROUTE_CORRECTION`, with its result and completion marker durably recorded, SHALL authorize exactly one new plugin-issued ordinary continuation. This behavior SHALL apply to automatic reflection and manual `/reflect`, including manual invocation while the agent is idle. The handoff SHALL return control to ordinary conversation rather than ask for another reflection or result submission. Main-run abort before completion SHALL instead cancel the inquiry without authorizing a new plugin-issued ordinary continuation; a staged valid result SHALL NOT override that cancellation.

An ordinary continuation already submitted to the host before cancellation remains subject to the native-residue limit in `user-takeover-cycle-reset`. Exactly-once handoff refers to plugin submission, not a promise that the host makes exactly one provider request or can retract a submitted wake.

The handoff SHALL return the existing reflection report for assessment in the original conversation, without adding a new instruction to the report body. It SHALL NOT declare the suggested route prevalidated, interpret `NO_ISSUE` as task completion, or require execution of the suggested next step. Report-derived observations and the proposed next step SHALL remain the generated reflection's account, not a claim of verbatim human input; their model-facing role SHALL follow the trigger-specific delivery rule below. Continuing work, waiting for an existing callback, asking a question, and finishing a response SHALL remain decisions of the ordinary agent in the original conversational context.

#### Scenario: Direction is sound but ordinary work remains
- **GIVEN** ordinary work is incomplete and an automatic reflection finds no direction problem
- **WHEN** a valid `NO_ISSUE` completes without cancellation
- **THEN** exactly one ordinary continuation is initiated without another user prompt
- **AND** the feedback does not claim that the task is complete or require another reflection

#### Scenario: A valid reflection proposes a different direction
- **WHEN** a valid `ROUTE_CORRECTION` completes without cancellation
- **THEN** exactly one ordinary continuation receives the reflection as a perspective to assess
- **AND** its handoff does not instruct the agent to follow a route on the premise that the plugin has already established it as correct

#### Scenario: Manual reflection begins while idle
- **GIVEN** the user invokes `/reflect` while the ordinary agent is idle
- **WHEN** the reflection completes normally with either valid result type
- **THEN** exactly one ordinary continuation is initiated without requiring another user message
- **AND** the unchanged report is delivered with the `user` role
- **AND** there is no special no-continuation exception for idle manual reflection

#### Scenario: Manual reflection interrupts ongoing work
- **GIVEN** the user invokes `/reflect` during ongoing ordinary work
- **WHEN** the reflection completes normally with either valid result type
- **THEN** exactly one ordinary continuation returns to the original conversation
- **AND** the unchanged report is delivered with the `user` role
- **AND** the handoff does not substitute the reflection's suggested goal for the user's contextual request

#### Scenario: Waiting is still an appropriate response
- **GIVEN** ordinary work is waiting for an existing background callback
- **WHEN** a valid reflection completes normally
- **THEN** the ordinary continuation is initiated once
- **AND** the handoff does not direct the agent to poll, restart background work, or execute a suggestion merely because control was returned

#### Scenario: User stops reflection before handoff
- **GIVEN** an automatic or manual reflection is still running or has only staged a result
- **WHEN** a main-run abort cancels it before completion
- **THEN** neither result type authorizes a new plugin-issued ordinary continuation
- **AND** the cancelled result is not delivered as completed feedback on later user re-entry

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

### Requirement: Reflection feedback uses trigger-specific model-facing roles

Substantive feedback supplied by a new automatic reflection handoff SHALL enter ordinary model requests with the `assistant` role, not as a `user`, `system`, or `developer` message containing the observer's conclusions. A report generated by a user's manual `/reflect` command SHALL instead enter ordinary model requests with the `user` role. Both rules SHALL apply to `NO_ISSUE` and `ROUTE_CORRECTION`; trigger origin, not the verdict or free-text report fields, SHALL determine the role. Manual user-role delivery SHALL NOT be described as proof that the generated report is verbatim human input or that a model will interpret it as intended.

The existing reflection report text and formatting SHALL remain unchanged in both modes; no new title, disclaimer, or plugin label SHALL be added to that body. Existing historical-reflection framing elsewhere SHALL remain unchanged. Correct session metadata or display styling alone SHALL NOT satisfy the model-facing role requirement.

The continuation signal SHALL be separate from the report and contain exactly this two-line text, with no plugin name, report content, or additional prose:

```text
[assistant]
continue
```

The signal SHALL retain this short assistant-origin marker even though its accepted transport role is `user`. It SHALL NOT be described as actual user input or as a guarantee of model interpretation. The signal SHALL NOT carry the reflection's substantive report, change the user's task, or elevate the observer's suggestion into an instruction. Source handling SHALL preserve original user text, surrounding clarifications, and message order; it SHALL apply only to recognizable watchdog handoff material, not arbitrary user text that resembles it.

#### Scenario: A correction differs from the user's clarified request
- **GIVEN** the user says "Too complicated", the agent proposes removing error handling, and the user clarifies "I meant the three abstraction layers"
- **AND** an automatic reflection suggests another approach
- **WHEN** the ordinary continuation request is delivered to the model
- **THEN** the existing user clarification remains unchanged
- **AND** the unchanged reflection report is delivered with the assistant role rather than as another user statement or a higher-priority instruction

#### Scenario: Automatic no-issue feedback is not a new user instruction
- **GIVEN** an automatically triggered valid `NO_ISSUE` report has `next_step` text suggesting more work
- **WHEN** its ordinary continuation reaches the model
- **THEN** that suggestion is present only as observer analysis
- **AND** no plugin message presents it as a new user command to continue

#### Scenario: Manually requested results use the user role
- **GIVEN** the user invokes `/reflect`
- **WHEN** the reflection completes with either valid result type
- **THEN** the unchanged result report is supplied to the ordinary model request with the `user` role
- **AND** the report is not projected as assistant content merely because a model generated it
- **AND** the separate wake retains exactly `[assistant]\ncontinue`

#### Scenario: The same result type can use different report roles
- **GIVEN** an automatic reflection and a manually requested reflection produce the same valid result type
- **WHEN** their respective ordinary model requests are prepared
- **THEN** the automatic report uses `assistant` and the manual report uses `user`
- **AND** matching report text or verdicts do not erase the trigger distinction

#### Scenario: Session-only provenance is insufficient
- **GIVEN** the runtime records a handoff with reliable trigger origin and plugin-specific correlation
- **WHEN** the handoff is converted into an ordinary model request
- **THEN** the unchanged report is supplied with `assistant` for automatic reflection or `user` for manual `/reflect`
- **AND** correctness does not depend on the model receiving session-only metadata

#### Scenario: The short marker is only a wake signal
- **WHEN** either valid result starts its ordinary continuation
- **THEN** the synthetic user-role control message has exactly the body `[assistant]\ncontinue`
- **AND** the unchanged report is supplied separately with its trigger-specific role, with no additional report title or disclaimer

#### Scenario: User text resembles a plugin handoff
- **GIVEN** an ordinary user message quotes `/reflect`, the plugin name, or a reflection-shaped block
- **WHEN** the next ordinary model context is prepared
- **THEN** that user message is not reclassified, removed, or rewritten by the watchdog's handoff handling
- **AND** quoted command or report text does not reclassify an automatic reflection as manually triggered

### Requirement: Persisted handoffs preserve trigger-specific delivery

New persisted handoff bodies SHALL contain only the agreed wake signal; their substantive reports SHALL remain in extension data rather than in those conversational bodies. Retained, correlated handoffs SHALL preserve reliable manual-versus-automatic trigger origin and receive the corresponding ordinary projection after reload or resume, without changing the persisted reflection report schema. Recognition and role selection SHALL NOT rely on matching visible wake text or report text alone.

Built-in compaction and branch summarization do not run the ordinary context projection and SHALL NOT be claimed to preserve its trigger-specific report delivery or to remove all reflection function arguments. The conversational handoff body SHALL contain only the wake signal, not a user-role copy of the report from its extension data, including for manual reflection. Native summary input can also contain persisted result function calls and their arguments; ordinary-context folding SHALL NOT be described as transcript erasure. Loss of the correlated source or reliable trigger origin at a context boundary SHALL prevent reconstruction from that incomplete handoff; it SHALL NOT cause a guessed role, a fabricated assistant envelope, or report content in the wake. The existing stored report remains available under its existing lookup contract; retaining it in a generated summary is not promised.

Existing session files SHALL NOT be rewritten. Other extensions' messages SHALL NOT be reclassified. Source handling for handoffs SHALL NOT introduce a new transcript store, authorship classifier, or custom compaction pipeline.

#### Scenario: A retained new handoff is restored
- **GIVEN** a new watchdog handoff and its correlated reflection assistant remain in the active branch context
- **WHEN** the session is restored and an ordinary model request is prepared
- **THEN** the unchanged report receives `assistant` for automatic reflection or `user` for manual `/reflect`, according to its retained trigger origin
- **AND** restoration does not trigger another continuation solely because the handoff exists

#### Scenario: Compaction bypasses ordinary source projection
- **GIVEN** a new watchdog handoff is selected as input to Pi's normal compaction or branch summarization
- **WHEN** Pi converts its durable messages without running the ordinary context projection
- **THEN** the conversational handoff contributes only `[assistant]\ncontinue`, not the report stored in extension data
- **AND** persisted result function calls and arguments can remain in the summary input
- **AND** the plugin does not claim that the report was preserved in the generated summary

#### Scenario: The correlated source is missing or malformed
- **GIVEN** a retained marker lacks a usable correlation or reliable trigger origin, or its source assistant is no longer in context
- **WHEN** ordinary model context is prepared
- **THEN** no report is reconstructed from that incomplete handoff
- **AND** the report is never substituted into the user-role wake signal
