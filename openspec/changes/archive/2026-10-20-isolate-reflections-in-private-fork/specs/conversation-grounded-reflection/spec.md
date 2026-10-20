## MODIFIED Requirements

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
