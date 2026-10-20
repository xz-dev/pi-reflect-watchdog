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
Previous reflection included in a private prompt SHALL remain labelled as fallible historical assistant analysis, not user expression or a conclusion to preserve. The private JSON example SHALL describe next step as a suggestion, not an already established correct route.

#### Scenario: An earlier reflection misunderstood the subject
- **GIVEN** earlier reflection discusses approval machinery and subsequent dialogue clarifies third-party perspective and intent fidelity
- **WHEN** the earlier report is included privately
- **THEN** it is framed as historical assistant analysis the observer can reject

### Requirement: Optional branch-scoped history recovery hint
A private reflection prompt SHALL provide an optional locator for the original parent session file and qualified trigger-time branch anchor when both exist. It SHALL refer to the frozen source captured at admission, not the new child transcript. Locator values SHALL be data, and guidance SHALL limit recovery to relevant surrounding exchanges on that branch, treating historical text as material rather than new instructions. It SHALL not replace the inherited full effective context with a user-only transcript or authoritative intent summary.

Constructing the hint SHALL not read/copy the transcript, request another model or create a history ledger. Missing optional locator information SHALL not block an otherwise available full fork or claim unavailable history is recoverable. An unavailable full fork SHALL still follow the typed execution-failure contract, never fresh-context fallback.

#### Scenario: File contains multiple branches
- **GIVEN** the qualified parent has a transcript file and active branch anchor
- **WHEN** the private prompt is constructed
- **THEN** the hint identifies the parent file/anchor and focused surrounding exchanges
- **AND** sibling branches are not presented as current conversation

#### Scenario: No usable history locator
- **GIVEN** optional locator data is missing but the full effective fork can otherwise be established
- **WHEN** reflection is prompted
- **THEN** the hint states recovery is unavailable
- **AND** reflection uses inherited context without inventing a recovery file

#### Scenario: No historical ambiguity needs investigation
- **GIVEN** inherited conversation is sufficient
- **WHEN** a locator is provided
- **THEN** it requires no transcript read or duplicate conversation in the prompt

### Requirement: Quick uncertainty-driven tool use
Private tool guidance SHALL permit only quick read-only local evidence through SDK `read`, `ls`, `grep`, `find`, including reading the qualified parent session file. These helpers may clarify conversation meaning, actual work or a possible direction; no third-party/extension lookup, shell execution, external network research or delegation is admitted. It SHALL stop research once the uncertainty is resolved and direct the observer to state remaining uncertainty and finish when evidence is not promptly available. Extended research, long-running checks and waiting for background work SHALL remain discouraged. This guidance SHALL not claim a new wall-clock timeout.

The reflection SHALL retain one ten-call admitted-helper allowance across at most three terminal result attempts in the same child. Helper-only progress SHALL not count as missing result submission. The final designated result write SHALL spend no helper budget and SHALL remain executable after the tenth helper. Admitted execution SHALL follow the shared local read-only profile; inherited declarations SHALL grant no additional effects or permission to reload extensions. Only the designated result writer may write. Tool denial/text-only output SHALL not create an unlimited uncounted response loop.

#### Scenario: A quick lookup answers the question
- **GIVEN** one admitted lookup resolves the relevant uncertainty
- **WHEN** private guidance is rendered
- **THEN** it directs conclusion rather than further research to use remaining allowance

#### Scenario: Evidence would require long-running work
- **GIVEN** useful evidence requires broad investigation or a long-running check
- **WHEN** private guidance is rendered
- **THEN** it directs completion with uncertainty stated rather than waiting
- **AND** it claims no new program-enforced deadline

#### Scenario: Custom reflection perspective
- **GIVEN** a user configured a custom reflection prompt
- **WHEN** the private request is constructed
- **THEN** that perspective remains in use
- **AND** source framing, quick-clarification guidance and the shared tool allowance remain present

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
Private file results SHALL retain five unique non-empty string fields `type`, `reason`, `done`, `current_step`, `next_step` and the two types `NO_ISSUE`/`ROUTE_CORRECTION`. Existing stored reports SHALL remain readable without migration. Locators SHALL not be added to durable report text or hook payloads. Free-text fields SHALL not become completion-state selectors. New public result-function registration is retired; historical function/inquiry records remain read-only compatible.

Bounded result correction, provider-failure classification/native retry eligibility, ordinary-loop exclusions, thresholds, cooldown, ownership and hook timing/values SHALL retain their contracts under the shared private profile. Actual inquiry activity SHALL follow supported official aggregate working observations; automatic decisions SHALL occur only on fresh valid ordinary completions without an abort hold or latched automatic request. Existing reset-before-release and fresh explicit-input rules SHALL remain intact, without stopping ordinary child observation.

New private prompts/corrections/helper/result traffic SHALL never enter main ordinary/summary context. User/branch/ownership changes SHALL synchronously revoke authority and request immediate exact-child abort; checkpoint guards are backstops, not permission to run stale work to completion. Cleanup SHALL preserve accounting as specified: admission's reminder reset is not rolled back, stale drops add no cooldown/completion or automatic intent, and only a later fresh ordinary threshold crossing can launch another inquiry. No main scheduling slot is created at admission; only already-submitted successful feedback retains native residual-work limits. Only a current non-cancelled result and completion marker both durably recorded SHALL authorize one plugin continuation. Staged files/parameters alone SHALL not suffice. Ordinary resumed work SHALL count as ordinary work; later abort SHALL neither undo historical completed reports/hooks nor publish them again. Cancelled events SHALL not pollute new identities or budgets.

No task-completion type, Continue-style second semantic inquiry, new user option or changed ordinary-loop classification SHALL be introduced.

#### Scenario: Completion and subsequent reflection
- **WHEN** a valid private reflection is durably completed and another occurs later
- **THEN** private exchanges remain absent from main context, historical reports remain readable and the hook retains its payload
- **AND** the later prompt can use the report as fallible analysis without a new report version

#### Scenario: No-issue completion does not retrigger reflection during cooldown
- **GIVEN** thresholds were reached while reflection was outstanding
- **WHEN** a valid non-cancelled `NO_ISSUE` completes durably
- **THEN** one ordinary continuation is initiated
- **AND** finalization does not replay a stored threshold decision
- **AND** the next fresh valid ordinary completion evaluates current cooldown/counters

#### Scenario: Repeated finalization does not duplicate the handoff
- **GIVEN** a valid result already completed durably
- **WHEN** another settlement arrives without a new result
- **THEN** no second continuation, completion record or hook is created

#### Scenario: No issue or invalid XML
- **WHEN** a non-aborted terminal attempt writes a valid `NO_ISSUE` file or prints legacy XML instead of writing its file
- **THEN** only the durably completed valid file authorizes one ordinary continuation; XML follows correction without continuation
- **AND** correction retains three terminal attempts and one shared ten-helper allowance

#### Scenario: A run ends without a valid decision
- **WHEN** validation exhausts or private execution authoritatively ends without a valid result
- **THEN** no new plugin continuation or hook is authorized
- **AND** non-aborted format failure retains bounded warning/cleanup
- **AND** native abort remains cancellation without invalid-response warning/reask or unrelated main cleanup

#### Scenario: User takeover restarts threshold accounting
- **GIVEN** current thresholds are near or above limits
- **WHEN** fresh explicit user input qualifies under existing takeover rules
- **THEN** the full cycle resets before the next automatic decision
- **AND** reset invalidates and immediately cancels the old private inquiry without clearing unrelated native work

#### Scenario: Native residual work cannot revive a cancelled reflection
- **GIVEN** feedback from a durably completed reflection was submitted before a later abort
- **WHEN** native feedback work occurs after re-entry
- **THEN** it restores no private execution or result authority and republishes no hook
- **AND** no zero-cost/request/effect guarantee is added for that already-submitted successful feedback

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
