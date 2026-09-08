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

A previous reflection included in a new reflection prompt SHALL be identified as historical assistant analysis that can be mistaken or superseded by better understanding, not as user expression or a conclusion that must be maintained. The XML example SHALL describe the next step as a suggestion rather than as already established to be correct.

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

This is prompt-level duration guidance, not a new hard timeout. The existing shared limit of ten tool calls across at most three XML attempts SHALL remain unchanged.

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

A completed `ROUTE_CORRECTION` SHALL still produce exactly one ordinary continuation. Its visible handoff SHALL invite reconsideration of the current conversation in light of the reflection and selection of an appropriate next response, without declaring that the proposed route is already correct. Report-derived observations and the proposed next step SHALL remain recognizable as the reflection's account and suggestion.

#### Scenario: A valid reflection proposes a different direction
- **WHEN** a valid `ROUTE_CORRECTION` completes
- **THEN** exactly one ordinary continuation receives the reflection as a perspective to assess
- **AND** its handoff does not instruct the agent to follow a route on the premise that the plugin has already established it as correct

### Requirement: Existing lifecycle and compatibility remain intact

The public reflection XML SHALL retain the five unique non-empty fields `type`, `reason`, `done`, `current_step`, and `next_step`, with only `NO_ISSUE` and `ROUTE_CORRECTION` as result types. Existing stored reports SHALL remain readable without migration. The history locator SHALL NOT be added to the stored report or completion-hook payload.

Inquiry folding, retry accounting, counter exclusions, automatic thresholds, cooldown, cross-process coordination, and completion-hook timing and values SHALL retain their existing contracts. The change SHALL NOT introduce new configuration options or a new decision or context lifecycle.

#### Scenario: Completion and subsequent reflection
- **WHEN** a valid reflection is completed and another reflection occurs later
- **THEN** the original inquiry is folded, the report remains available under the existing storage contract, and the completion hook retains its existing payload shape
- **AND** the next reflection can use the report with the new historical-analysis label without requiring a new report version

#### Scenario: No issue or invalid XML
- **WHEN** a reflection returns `NO_ISSUE` or requires XML correction
- **THEN** the existing no-continuation or retry behavior remains unchanged respectively
- **AND** retries do not obtain a fresh tool-call budget
