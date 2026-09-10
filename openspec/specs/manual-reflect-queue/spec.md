# manual-reflect-queue Specification

## Purpose

Gives user-invoked `/reflect` a visible queued state while the agent is busy and lets the user withdraw the request before its reflection turn begins, using only stock upstream Pi public extension APIs.

## Requirements

### Requirement: Busy manual reflections queue until the agent settles

When the user invokes `/reflect` while the ordinary agent is busy (a run, automatic retry, compaction, or queued continuation is in flight), the plugin SHALL hold the request in a plugin-side pending queue and SHALL NOT dispatch the reflection inquiry until the agent settles. When the user invokes `/reflect` while the agent is idle, the plugin SHALL dispatch immediately as before. The queued request SHALL preserve the user's supplement and trigger origin for the later dispatch.

#### Scenario: Invocation during a running turn

- **GIVEN** the ordinary agent is mid-run
- **WHEN** the user invokes `/reflect`
- **THEN** no reflection inquiry message is sent
- **AND** the request remains pending until the agent settles
- **AND** after settlement exactly one reflection begins with the original supplement and manual trigger origin

#### Scenario: Invocation while idle

- **GIVEN** the ordinary agent is idle
- **WHEN** the user invokes `/reflect`
- **THEN** the reflection begins immediately, matching prior behavior

#### Scenario: Agent settles with a queued request

- **GIVEN** a manual reflection is pending and the agent settles
- **WHEN** the plugin observes settlement
- **THEN** it dispatches the pending reflection exactly once
- **AND** repeated or stale settlement observations do not start a second reflection for the same request

### Requirement: Visible queued state

While a manual reflection is pending, the plugin's below-editor status bar row SHALL show that the request is queued and how to cancel it, naming the effective configured cancel shortcut key (or the `/cancel-reflect` command when the shortcut is disabled). The row SHALL render the key from effective merged configuration, never a hardcoded default. The indication SHALL clear when the request is dispatched, cancelled, or discarded by session teardown.

#### Scenario: Pending request is shown

- **GIVEN** the agent is busy
- **WHEN** the user invokes `/reflect`
- **THEN** the status bar row reports the reflection as queued and names the effective cancel key (or `/cancel-reflect` when the shortcut is disabled)

#### Scenario: Status cleared on dispatch

- **GIVEN** a queued reflection with visible status
- **WHEN** the reflection is dispatched or cancelled
- **THEN** the queued indication is removed

### Requirement: Withdrawal before dispatch

The user SHALL be able to cancel a pending manual reflection before it dispatches, through both a keyboard shortcut and a `/cancel-reflect` command. Cancelling SHALL remove only the pending request and SHALL NOT abort, invalidate, or alter an already-active reflection, the ordinary agent run, or any other plugin state. Cancelling when nothing is pending SHALL produce a clear no-op notification.

#### Scenario: Cancel a queued request

- **GIVEN** a manual reflection is pending
- **WHEN** the user presses the cancel shortcut or runs `/cancel-reflect`
- **THEN** the pending request is discarded
- **AND** no reflection inquiry is ever sent for it
- **AND** the user receives confirmation of the cancellation

#### Scenario: Cancel does not touch an active reflection

- **GIVEN** a reflection is already active and no manual request is pending
- **WHEN** the user invokes the cancel gesture
- **THEN** the active reflection continues unaffected
- **AND** the user is notified there was nothing queued to cancel

#### Scenario: Cancel with empty queue

- **GIVEN** no manual reflection is pending
- **WHEN** the user invokes the cancel gesture
- **THEN** nothing changes and the user is notified there is nothing to cancel

### Requirement: Duplicate invocations coalesce

While a manual reflection is already pending, further `/reflect` invocations SHALL NOT enqueue additional requests; the plugin SHALL notify the user that a reflection is already queued. Supplements from duplicate invocations are dropped, not merged.

#### Scenario: Second invocation while queued

- **GIVEN** a manual reflection is pending
- **WHEN** the user invokes `/reflect` again with a different supplement
- **THEN** still exactly one request remains pending with the original supplement
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
- **AND** `/cancel-reflect` still cancels a pending request

#### Scenario: Invalid key falls back

- **GIVEN** the user configured an unrecognized cancel shortcut key
- **WHEN** the extension loads
- **THEN** the default key is used and a bounded diagnostic is emitted

### Requirement: No host or protocol changes

The queue, visibility, and cancellation behavior SHALL be implemented entirely inside the plugin using stock upstream Pi public extension APIs. The reflection inquiry message format, XML response contract, context folding, continuation semantics, and cross-process behavior SHALL remain unchanged. The change SHALL NOT require a forked or patched Pi.

#### Scenario: Runs on stock Pi

- **GIVEN** a stock upstream Pi installation without downstream patches
- **WHEN** the plugin is loaded and a manual reflection is queued and cancelled
- **THEN** all queue and cancellation behaviors work without any host modification
