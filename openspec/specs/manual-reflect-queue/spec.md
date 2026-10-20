# manual-reflect-queue Specification

## Purpose

Admit user-invoked `/reflect` as immediate private background work on the current main, retain one cancellable plugin-pending request behind an outstanding inquiry, and use native steering only for later successful feedback without blocking ordinary work.

## Requirements

### Requirement: Reflection inquiries remain serialized

The plugin SHALL keep at most one current plugin-owned private inquiry outstanding, from background admission through execution, result correction and exact-child cancellation drain. A manual request received while an inquiry is outstanding SHALL remain in the existing bounded plugin queue, preserving its supplement and manual origin. After normal non-cancelled finalization, if the attachment is still current main, the waiting request SHALL be admitted exactly once without imposing an additional ordinary-agent settlement barrier. Admission SHALL create no native inquiry slot. Existing normal completion evidence and continuation ordering SHALL remain intact.

A confirmed main-run abort SHALL cancel the outstanding inquiry's authority and discard every manual request still in plugin custody. Neither cancellation cleanup nor a later explicit re-entry SHALL dispatch those discarded requests. Teardown SHALL also discard plugin-pending requests. A new user-invoked `/reflect` after abort SHALL begin fresh manual work and release post-abort inhibition under `user-takeover-cycle-reset`; it SHALL NOT revive an earlier request. Any successful feedback already submitted to the host, or legacy native inquiry queued before private execution replaced that transport, remains subject to the native-residue limit in `user-takeover-cycle-reset`; neither grants new private-inquiry authority.

#### Scenario: Manual request waits behind a submitted inquiry
- **GIVEN** a private reflection inquiry has been admitted but has not yet settled
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

While a manual reflection is pending in the plugin behind an outstanding inquiry, the plugin's below-editor status bar row SHALL show that the request is queued and how to cancel it, naming the effective configured cancel shortcut key (or the `/cancel-reflect` command when the shortcut is disabled). The row SHALL render the key from effective merged configuration, never a hardcoded default. The indication SHALL clear when the request is submitted, cancelled, or discarded by main-run abort or session teardown. A request already admitted to private execution SHALL NOT be presented as plugin-pending or withdrawable through `/cancel-reflect`, even before its first model request. Exact-child cancellation and abort-driven authority invalidation are separate from that command's pending-only withdrawal window. Neither SHALL imply that already-submitted successful feedback or legacy native slots can be retracted.

#### Scenario: Pending request is shown
- **GIVEN** a reflection inquiry is already outstanding
- **WHEN** the user invokes `/reflect`
- **THEN** the status bar row reports the waiting manual request as queued and names the effective cancel key or command

#### Scenario: Status cleared on dispatch
- **GIVEN** a plugin-pending reflection with visible status
- **WHEN** the request is submitted, cancelled, or discarded by main-run abort or teardown
- **THEN** the queued indication is removed

#### Scenario: Native-queued inquiry is not advertised as cancellable
- **GIVEN** a legacy native inquiry was queued before the private-execution cutover and ordinary work is busy
- **WHEN** the plugin reports pending-withdrawal controls
- **THEN** neither the status row nor the command notification advertises a `/cancel-reflect` withdrawal window for that legacy native work

### Requirement: Withdrawal before dispatch

The user SHALL be able to cancel a manual reflection still pending in the plugin before private-inquiry admission, through both a keyboard shortcut and a `/cancel-reflect` command. Cancelling SHALL remove only that pending request and SHALL NOT withdraw an already-admitted inquiry, abort or alter an active reflection, interrupt the ordinary agent run, or alter unrelated plugin state. Cancelling when nothing is plugin-pending SHALL produce a clear no-op notification. Private admission, not the first model request or native queue submission, SHALL close this pending-only withdrawal window. Already-submitted successful feedback and legacy native work SHALL retain their native-residue limits.

#### Scenario: Cancel a queued request

- **GIVEN** a manual reflection is plugin-pending behind an outstanding inquiry
- **WHEN** the user presses the cancel shortcut or runs `/cancel-reflect`
- **THEN** only the pending request is discarded
- **AND** no inquiry is ever submitted for that cancelled request
- **AND** the outstanding inquiry is unaffected and the user receives confirmation of the cancellation

#### Scenario: Cancel does not touch an active reflection

- **GIVEN** a private reflection is already admitted, whether or not its first model request has started, and no manual request is plugin-pending
- **WHEN** the user invokes the cancel gesture
- **THEN** the active reflection continues unaffected
- **AND** the user is notified there was nothing queued to cancel

#### Scenario: Cancel cannot retract a native-queued inquiry

- **GIVEN** a legacy native inquiry was queued before the private-execution cutover, and no manual request is plugin-pending
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
Background execution and result delivery SHALL use supported stock Pi interfaces without host changes, private queue access or whole-queue clear/replay. No control-only native queue primitive is required. The old public inquiry/result-function transport is replaced by the private full-fork/file contract. Versioned private accounting transport remains independent. Already-submitted successful feedback retains native residual-work limits; cancelling an unaccepted private result creates no new main slot to retract.

#### Scenario: Runs on stock Pi
- **WHEN** background reflection starts, finishes or is withdrawn while still plugin-pending
- **THEN** no host patch, parent abort, bridge/result tool or queue mutation is required

#### Scenario: Unrelated messages remain intact
- **WHEN** the private inquiry fails or becomes stale
- **THEN** no result is injected and unrelated main messages remain unchanged

#### Scenario: Private accounting evolution preserves the public contract
- **WHEN** authenticated versioned child accounting updates counters
- **THEN** it does not become result submission or authorize background feedback by itself

### Requirement: Manual reflections start background inquiries
When `/reflect` is invoked on current main with no outstanding reflection, the plugin SHALL immediately admit one background private inquiry with manual origin and the user's supplement. This explicitly replaces inquiry-time native steering: the plugin SHALL reserve no native slot or wake request. It SHALL freeze the qualified source at admission and SHALL not wait for parent generation, tools, ordinary children, native queues or settlement. Parent work SHALL not be aborted or blocked.

Only a current valid result, after durable result/completion records, SHALL use native delivery: steer when busy; deliver and trigger one ordinary continuation when idle. Failure/no-result/cancel/stale SHALL send nothing to main. Manual requests SHALL bypass automatic cooldown. Fresh `/reflect` after abort SHALL reset the cycle before releasing the hold. Existing pending queue/coalescing and pending-only cancellation SHALL remain; no counting-pause option is added.

#### Scenario: Request while the agent generates
- **GIVEN** main is generating and no reflection is outstanding
- **WHEN** `/reflect check the approach` is invoked
- **THEN** one background inquiry captures qualified source and supplement without stopping main
- **AND** no main prompt, marker or provider request is added at admission

#### Scenario: Request during a multi-tool turn
- **GIVEN** an ordinary tool batch is incomplete
- **WHEN** `/reflect` is invoked
- **THEN** snapshot qualification excludes the open batch and retains full replayable ancestry
- **AND** all parent tools continue without waiting for reflection

#### Scenario: Invocation while idle
- **GIVEN** main is idle and no reflection is outstanding
- **WHEN** `/reflect` is invoked
- **THEN** the private inquiry starts without a parent request or another user input
- **AND** only a later current durable result can trigger one ordinary continuation

#### Scenario: Busy children and earlier native messages
- **GIVEN** ordinary children and main's native queue contain work
- **WHEN** a manual inquiry starts
- **THEN** that work neither delays capture nor is reordered or cancelled
- **AND** any eventual result joins native delivery order at result time, not the former inquiry reservation position

#### Scenario: Manual request during cooldown
- **WHEN** a manual request is admitted while automatic cooldown applies
- **THEN** it starts without waiting for cooldown or an ordinary completion

#### Scenario: Explicit manual re-entry after abort
- **WHEN** the user freshly invokes `/reflect` after the abort hold
- **THEN** a fresh cycle and source identity precede launch and the cancelled operation is not revived

#### Scenario: Request while another reflection is active
- **WHEN** `/reflect` creates plugin-pending manual work behind the active operation
- **THEN** existing coalescing and pending-only withdrawal apply
- **AND** that request gets its own trigger-time snapshot when later admitted
