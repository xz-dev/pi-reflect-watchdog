# manual-reflect-queue Specification

## Purpose

Submits user-invoked `/reflect` immediately into Pi's native steering queue when this attachment is the current main, so explicit requests reach the agent at the next turn boundary instead of after the whole run settles; retains a cancellable plugin-side waiting slot only behind an outstanding reflection inquiry, using only stock upstream Pi public extension APIs.

## Requirements

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

### Requirement: Reflection inquiries remain serialized

The plugin SHALL keep at most one reflection inquiry outstanding, including its native-queued interval, execution, and result re-asks. A manual request received while an inquiry is outstanding SHALL remain in the existing bounded plugin queue, preserving its supplement and manual origin. After normal non-cancelled finalization, if the attachment is still current main, the waiting request SHALL be submitted exactly once without imposing an additional ordinary-agent settlement barrier. Existing normal completion evidence and continuation ordering SHALL remain intact.

A confirmed main-run abort SHALL cancel the outstanding inquiry's authority and discard every manual request still in plugin custody. Neither cancellation cleanup nor a later explicit re-entry SHALL dispatch those discarded requests. Teardown SHALL also discard plugin-pending requests. A new user-invoked `/reflect` after abort SHALL begin fresh manual work and release post-abort inhibition under `user-takeover-cycle-reset`; it SHALL NOT revive an earlier request. Work submitted to the host before cancellation remains subject to the native-residue limit in `user-takeover-cycle-reset`.

#### Scenario: Manual request waits behind a submitted inquiry
- **GIVEN** a reflection inquiry has been submitted but has not yet been consumed
- **WHEN** the user invokes `/reflect inspect the latest correction`
- **THEN** no overlapping inquiry is submitted
- **AND** one plugin-pending request preserves that supplement and manual origin
- **AND** after normal non-cancelled finalization, the waiting request is submitted once even if ordinary continuation work is busy

#### Scenario: Repeated settlement cannot duplicate submission
- **GIVEN** a manual request has already been submitted
- **WHEN** repeated settlement observations arrive
- **THEN** they do not submit the same request again

#### Scenario: Abort discards a queued manual request
- **GIVEN** one reflection is outstanding and `/reflect check the old approach` is plugin-pending
- **WHEN** a main-run abort is confirmed
- **THEN** both the outstanding reflection authority and the waiting request are cancelled
- **AND** no new plugin-issued correction, continuation, or queued-manual dispatch follows from that cancelled work

#### Scenario: New manual request after stop is independent
- **GIVEN** an earlier manual request was discarded by abort
- **WHEN** the user invokes `/reflect check the new approach`
- **THEN** exactly one new manual inquiry uses `check the new approach`
- **AND** the old request is neither merged nor replayed

### Requirement: Visible queued state

While a manual reflection is pending in the plugin behind an outstanding inquiry, the plugin's below-editor status bar row SHALL show that the request is queued and how to cancel it, naming the effective configured cancel shortcut key (or the `/cancel-reflect` command when the shortcut is disabled). The row SHALL render the key from effective merged configuration, never a hardcoded default. The indication SHALL clear when the request is submitted, cancelled, or discarded by main-run abort or session teardown. A request already submitted to native steering SHALL NOT be presented as plugin-pending or retractable through `/cancel-reflect`, even before the model consumes it. Abort-driven authority invalidation is separate from that command's withdrawal window and SHALL NOT imply that already-submitted native slots can be retracted.

#### Scenario: Pending request is shown
- **GIVEN** a reflection inquiry is already outstanding
- **WHEN** the user invokes `/reflect`
- **THEN** the status bar row reports the waiting manual request as queued and names the effective cancel key or command

#### Scenario: Status cleared on dispatch
- **GIVEN** a plugin-pending reflection with visible status
- **WHEN** the request is submitted, cancelled, or discarded by main-run abort or teardown
- **THEN** the queued indication is removed

#### Scenario: Native-queued inquiry is not advertised as cancellable
- **GIVEN** the ordinary agent is busy and no reflection inquiry is outstanding
- **WHEN** the user invokes `/reflect` and the inquiry is submitted to native steering
- **THEN** neither the status row nor the command notification advertises a `/cancel-reflect` withdrawal window for that submitted inquiry

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

### Requirement: Configurable cancel shortcut

The cancel shortcut key SHALL be configurable through the plugin's existing configuration file, with a documented default. Setting the key to a disabling value SHALL turn the shortcut off while leaving `/cancel-reflect` available. An invalid configured key SHALL fall back to the default with a bounded diagnostic, never crashing extension load. Shortcut registration SHALL rely on Pi's native conflict diagnostics rather than silent overrides.

#### Scenario: Custom key from config

- **GIVEN** the user configured a custom cancel shortcut key
- **WHEN** the extension loads
- **THEN** the cancel shortcut is registered on the configured key
- **AND** the queued-status indication names the configured key

#### Scenario: Shortcut disabled

- **GIVEN** the user configured the cancel shortcut as disabled
- **WHEN** the extension loads
- **THEN** no cancel shortcut is registered
- **AND** `/cancel-reflect` still cancels a plugin-pending request

#### Scenario: Invalid key falls back

- **GIVEN** the user configured an unrecognized cancel shortcut key
- **WHEN** the extension loads
- **THEN** the default key is used and a bounded diagnostic is emitted

### Requirement: No host or protocol changes

The queue, visibility, withdrawal, and abort-cancellation behavior SHALL be implemented entirely inside the plugin using supported stock Pi public extension APIs. Queue handling SHALL preserve the public reflection inquiry format, the result function contract defined in `reflection-response-contract`, exact-owned context folding, normal non-cancelled continuation, and cross-process ownership safeguards. These public-protocol constraints do not freeze separately specified, versioned watchdog-private child-accounting messages. This change SHALL NOT require a forked or patched Pi, private native-queue access, or whole-queue clear/replay. Already-submitted native work SHALL remain subject to the cancellation boundary in `user-takeover-cycle-reset`.

#### Scenario: Runs on stock Pi
- **GIVEN** a supported stock Pi installation without downstream patches
- **WHEN** manual reflection is submitted, queued, withdrawn, or invalidated by main-run abort
- **THEN** those behaviors work without host modification or private-queue mutation

#### Scenario: Unrelated messages remain intact
- **GIVEN** native steering contains a submitted reflection and unrelated user or extension messages
- **WHEN** main-run abort invalidates the reflection
- **THEN** Reflect's cleanup does not clear, replay, or reorder the unrelated messages
- **AND** the cancelled reflection cannot become a live inquiry when explicit user work later starts

#### Scenario: Private accounting evolution preserves the public contract
- **GIVEN** a separately specified accounting change uses versioned watchdog-private child-accounting messages
- **WHEN** those messages update accounting or identify fresh child turns
- **THEN** the public reflection inquiry and result format, transport authentication, and ownership safeguards remain intact
