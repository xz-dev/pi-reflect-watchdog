## MODIFIED Requirements

### Requirement: Reflection inquiries remain serialized

The plugin SHALL keep at most one reflection inquiry outstanding, including its native-queued interval, execution, and result re-asks. A manual request received while an inquiry is outstanding SHALL remain in the existing bounded plugin queue, preserving its supplement and manual origin. Once the outstanding inquiry is finalized and the attachment is still the current main, the plugin SHALL submit the waiting request exactly once without imposing an additional ordinary-agent settlement barrier. Existing completion evidence and continuation ordering SHALL remain intact. Teardown SHALL discard requests still pending in the plugin.

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

### Requirement: No host or protocol changes

The queue, visibility, and cancellation behavior SHALL be implemented entirely inside the plugin using stock upstream Pi public extension APIs. Queue handling SHALL preserve the reflection inquiry message format, the result function contract defined in `reflection-response-contract`, context folding, continuation semantics, and cross-process behavior. It SHALL NOT require a forked or patched Pi.

#### Scenario: Runs on stock Pi

- **GIVEN** a stock upstream Pi installation without downstream patches
- **WHEN** the plugin is loaded and a manual reflection is submitted, queued, and cancelled
- **THEN** all submission, queue, and cancellation behaviors work without any host modification
