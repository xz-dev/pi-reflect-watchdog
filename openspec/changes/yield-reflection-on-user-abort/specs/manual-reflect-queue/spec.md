## MODIFIED Requirements

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
