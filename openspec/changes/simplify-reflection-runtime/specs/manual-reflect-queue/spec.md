## MODIFIED Requirements

### Requirement: Manual reflections use immediate native steering

When the user invokes `/reflect` on the current main attachment and no reflection inquiry is outstanding, the plugin SHALL immediately submit exactly one inquiry through the same native steering delivery path as automatic reflection, with turn triggering enabled. It SHALL preserve the manual trigger origin and the user's supplement. Ordinary-agent busyness, busy child agents, and existing native pending messages SHALL NOT impose a plugin-side settlement barrier.

Immediate submission SHALL NOT mean aborting the current response or tool execution. During a running agent turn, the inquiry SHALL follow Pi's native steering order: after the current assistant turn and all its tool calls complete, before a subsequent model call eligible to consume it. The plugin SHALL NOT promote the request ahead of already queued native steering messages. When the agent is idle, submission SHALL trigger a reflection turn without waiting for another user message.

Manual requests SHALL continue to bypass automatic reflection's cooldown and SHALL NOT require an ordinary turn-completion event. A new user-invoked `/reflect` SHALL explicitly release a true-abort hold after resetting the cycle, under the coordinated abort contract. There SHALL be no configurable counting-pause exception. Matching automatic delivery timing SHALL NOT change manual trigger identity, report role, response validation, or normal continuation behavior.

#### Scenario: Request while the agent is generating a response
- **GIVEN** the current main is generating an ordinary response and no reflection inquiry is outstanding
- **WHEN** the user invokes `/reflect check whether this approach still solves the problem`
- **THEN** exactly one manual inquiry with that supplement is submitted without waiting for settlement
- **AND** the current response is not aborted
- **AND** the inquiry is available to Pi's next eligible steering-consumption boundary

#### Scenario: Request during a multi-tool turn
- **GIVEN** an ordinary assistant turn has multiple tool calls still executing and no reflection inquiry is outstanding
- **WHEN** the user invokes `/reflect`
- **THEN** the inquiry is submitted without waiting for those tools to finish
- **AND** none of those tool calls is cancelled or skipped by the request
- **AND** the reflection is consumed only after the complete tool batch, without requiring the entire ordinary run to settle

#### Scenario: Invocation while idle
- **GIVEN** the user invokes `/reflect` on the current main while it is idle and no reflection inquiry is outstanding
- **WHEN** the command is handled
- **THEN** exactly one reflection turn is triggered immediately with manual origin

#### Scenario: Busy children and existing native messages
- **GIVEN** the current main owns the request, child agents remain busy, native steering already contains an earlier message, and no reflection inquiry is outstanding
- **WHEN** the user invokes `/reflect`
- **THEN** the inquiry is submitted without waiting for the children or native queue to become idle
- **AND** native ordering of the earlier message is preserved

#### Scenario: Manual request during an automatic pause or cooldown
- **GIVEN** automatic reflection is in cooldown or an obsolete counting-pause configuration is present, and no reflection inquiry is outstanding
- **WHEN** the user invokes `/reflect` on the current main
- **THEN** the manual inquiry is submitted without waiting for cooldown to end
- **AND** obsolete counting-pause settings do not create a pause or delay submission

#### Scenario: Explicit manual re-entry after abort
- **GIVEN** true main abort established a hold and cancelled its old unsubmitted requests
- **WHEN** the user newly invokes `/reflect`
- **THEN** a fresh cycle and new manual request are established before dispatch
- **AND** the cancelled request is not revived or confused with the new one
