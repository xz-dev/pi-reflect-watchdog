## REMOVED Requirements

### Requirement: Busy manual reflections queue until the agent settles

**Reason**: Waiting for the ordinary agent to settle defeats an explicit request to reconsider work in progress and differs from automatic reflection's native steering behavior.

**Migration**: Manual requests use immediate native steering when no inquiry is outstanding. Only a request waiting behind another reflection remains plugin-pending and cancellable; ordinary-agent busyness no longer creates that waiting state.

## ADDED Requirements

### Requirement: Manual reflections use immediate native steering

When the user invokes `/reflect` on the current main attachment and no reflection inquiry is outstanding, the plugin SHALL immediately submit exactly one inquiry through the same native steering delivery path as automatic reflection, with turn triggering enabled. It SHALL preserve the manual trigger origin and the user's supplement. Ordinary-agent busyness, busy child agents, and existing native pending messages SHALL NOT impose a plugin-side settlement barrier.

Immediate submission SHALL NOT mean aborting the current response or tool execution. During a running agent turn, the inquiry SHALL follow Pi's native steering order: after the current assistant turn and all its tool calls complete, before a subsequent model call eligible to consume it. The plugin SHALL NOT promote the request ahead of already queued native steering messages. When the agent is idle, submission SHALL trigger a reflection turn without waiting for another user message.

Manual requests SHALL continue to bypass automatic reflection's cooldown and configured counting pauses. Matching automatic delivery timing SHALL NOT change manual trigger identity, report role, response validation, or continuation behavior.

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

- **GIVEN** the current main is idle and no reflection inquiry is outstanding
- **WHEN** the user invokes `/reflect`
- **THEN** exactly one reflection turn is triggered immediately with manual origin

#### Scenario: Busy children and existing native messages

- **GIVEN** the current main owns the request, child agents remain busy, native steering already contains an earlier message, and no reflection inquiry is outstanding
- **WHEN** the user invokes `/reflect`
- **THEN** the inquiry is submitted without waiting for the children or native queue to become idle
- **AND** native ordering of the earlier message is preserved

#### Scenario: Manual request during an automatic pause or cooldown

- **GIVEN** automatic reflection is paused or in cooldown and no reflection inquiry is outstanding
- **WHEN** the user invokes `/reflect` on the current main
- **THEN** the manual inquiry is submitted through native steering without waiting for the pause or cooldown to end

### Requirement: Reflection inquiries remain serialized

The plugin SHALL keep at most one reflection inquiry outstanding, including its native-queued interval, execution, and XML re-asks. A manual request received while an inquiry is outstanding SHALL remain in the existing bounded plugin queue, preserving its supplement and manual origin. Once the outstanding inquiry is finalized and the attachment is still the current main, the plugin SHALL submit the waiting request exactly once without imposing an additional ordinary-agent settlement barrier. Existing completion evidence and continuation ordering SHALL remain intact. Teardown SHALL discard requests still pending in the plugin.

#### Scenario: Manual request waits behind a submitted inquiry

- **GIVEN** a reflection inquiry has been submitted but has not yet been consumed
- **WHEN** the user invokes `/reflect inspect the latest correction`
- **THEN** no overlapping inquiry is submitted
- **AND** one plugin-pending request preserves that supplement and manual origin
- **AND** after the outstanding inquiry is finalized, the waiting request is submitted once even if ordinary continuation work is busy

#### Scenario: Repeated settlement cannot duplicate submission

- **GIVEN** a manual request has already been submitted
- **WHEN** repeated settlement observations arrive
- **THEN** they do not submit the same request again

## MODIFIED Requirements

### Requirement: Visible queued state

While a manual reflection is pending in the plugin behind an outstanding inquiry, the plugin's below-editor status bar row SHALL show that the request is queued and how to cancel it, naming the effective configured cancel shortcut key (or the `/cancel-reflect` command when the shortcut is disabled). The row SHALL render the key from effective merged configuration, never a hardcoded default. The indication SHALL clear when the request is submitted, cancelled, or discarded by session teardown. A request already submitted to native steering SHALL NOT be presented as plugin-pending or cancellable, even before the model consumes it.

#### Scenario: Pending request is shown

- **GIVEN** a reflection inquiry is already outstanding
- **WHEN** the user invokes `/reflect`
- **THEN** the status bar row reports the waiting manual request as queued and names the effective cancel key (or `/cancel-reflect` when the shortcut is disabled)

#### Scenario: Status cleared on dispatch

- **GIVEN** a plugin-pending reflection with visible status
- **WHEN** the request is submitted, cancelled, or discarded by session teardown
- **THEN** the queued indication is removed

#### Scenario: Native-queued inquiry is not advertised as cancellable

- **GIVEN** the ordinary agent is busy and no reflection inquiry is outstanding
- **WHEN** the user invokes `/reflect` and the inquiry is submitted to native steering
- **THEN** neither the status row nor the command notification advertises a plugin cancellation window for that submitted inquiry

### Requirement: Withdrawal before dispatch

The user SHALL be able to cancel a manual reflection still pending in the plugin before native submission, through both a keyboard shortcut and a `/cancel-reflect` command. Cancelling SHALL remove only that pending request and SHALL NOT retract an already-submitted inquiry, abort or alter an active reflection, interrupt the ordinary agent run, or alter unrelated plugin state. Cancelling when nothing is plugin-pending SHALL produce a clear no-op notification. Native submission, not model consumption, SHALL close the cancellation window.

#### Scenario: Cancel a queued request

- **GIVEN** a manual reflection is plugin-pending behind an outstanding inquiry
- **WHEN** the user presses the cancel shortcut or runs `/cancel-reflect`
- **THEN** only the pending request is discarded
- **AND** no inquiry is ever submitted for that cancelled request
- **AND** the outstanding inquiry is unaffected and the user receives confirmation of the cancellation

#### Scenario: Cancel does not touch an active reflection

- **GIVEN** a reflection is already executing and no manual request is plugin-pending
- **WHEN** the user invokes the cancel gesture
- **THEN** the active reflection continues unaffected
- **AND** the user is notified there was nothing queued to cancel

#### Scenario: Cancel cannot retract a native-queued inquiry

- **GIVEN** a manual inquiry has been submitted to native steering but has not been consumed, and no manual request is plugin-pending
- **WHEN** the user invokes the cancel gesture
- **THEN** the submitted inquiry remains unaffected
- **AND** the ordinary run is not interrupted
- **AND** the user receives the no-op notification

#### Scenario: Cancel with empty queue

- **GIVEN** no manual reflection is plugin-pending
- **WHEN** the user invokes the cancel gesture
- **THEN** nothing changes and the user is notified there is nothing to cancel

### Requirement: Duplicate invocations coalesce

While a manual reflection is already plugin-pending behind an outstanding inquiry, further `/reflect` invocations SHALL NOT enqueue additional requests; the plugin SHALL notify the user that a reflection is already queued. Supplements from duplicate invocations SHALL be dropped, not merged. An already-submitted inquiry SHALL NOT itself count as the plugin-pending request: the next invocation can occupy the single waiting slot.

#### Scenario: Second invocation while queued

- **GIVEN** one reflection inquiry is outstanding and a manual request with the supplement `first correction` is plugin-pending
- **WHEN** the user invokes `/reflect second correction`
- **THEN** exactly one request remains pending with `first correction`
- **AND** the user is told a reflection is already queued
