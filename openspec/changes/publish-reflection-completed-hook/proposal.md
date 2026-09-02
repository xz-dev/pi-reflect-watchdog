## Why

A valid reflection can conclude that the current route is sound or initiate a corrected route, but only the local TUI and session entries observe that completion. Notification consumers have no authoritative final event and cannot safely infer one from retries, generic lifecycle events, or private session state.

## What Changes

- Publish a `reflection-completed` semantic hook exactly once after a valid final reflection result and completion marker are durably recorded.
- Include validated `REFLECTION_TYPE`, `REASON`, and `NEXT_STEP` values suitable for a concise notification; preserve the full durable report while clipping only over-limit hook text to the shared protocol bound.
- Keep XML retries, validation failure, cancellation, preemption, stale ownership, and non-durable completion silent.
- Preserve `ROUTE_CORRECTION` continuation and `NO_ISSUE` behavior independently of listener presence or failure.
- Verify producer independence and final-only timing through focused and packed stock-Pi acceptance tests.

## Capabilities

### New Capabilities
- `reflection-completed-hook`: Publishes an authoritative best-effort semantic signal for each durably completed valid reflection.

### Modified Capabilities

None.

## Impact

- Affects the valid-reflection completion path in `src/extension.ts`, focused runtime tests, packed acceptance coverage, and user documentation.
- Reuses the existing `pi-extension-utils/semantic-hook` runtime dependency and `pi:semantic-hook:v1` channel.
- Introduces no command, configuration field, reflection XML field, acknowledgement, or pi-notify dependency.
