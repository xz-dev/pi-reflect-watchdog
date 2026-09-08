## Context

See `proposal.md` for motivation and `specs/reflection-completed-hook/spec.md` for required behavior.

The watchdog validates one final reflection decision after up to three XML attempts. Current completion clears active internal state, applies any route correction or TUI notice, appends the validated reflection result, appends a non-context completion marker, and then resumes dispatch. The project already depends on `pi-extension-utils/semantic-hook` for validated pause-hook consumption.

## Goals / Non-Goals

**Goals:**
- Publish one final signal only for a valid durably completed reflection.
- Preserve result recording, completion-marker ordering, route correction, retries, counters, and dispatch.
- Keep consumer absence or failure irrelevant to reflection behavior.

**Non-Goals:**
- Publishing start, retry, validation-failure, cancellation, or progress hooks.
- Sending the full reflection report or raw assistant output through the event bus.
- Adding acknowledgement, replay, buffering, configuration, or pi-notify awareness.

## Decisions

### 1. Publish `reflection-completed` with three notification-relevant fields

Use the existing shared publisher to send a fresh version-1 envelope containing `REFLECTION_TYPE`, `REASON`, and `NEXT_STEP`. `DONE` and `CURRENT_STEP` remain available in the durable report but are omitted from the notification hook. This keeps the external payload concise and avoids copying more model-generated work detail than the reminder requires.

Alternative considered: publish the formatted full report. Rejected because formatting is presentation-specific and increases privacy surface.

### 2. Clip only transport text that exceeds the shared protocol bound

`pi-extension-utils/semantic-hook` rejects a value longer than 4096 JavaScript UTF-16 code units, while a valid reflection can contain a larger individual field. Preserve reflection validity and the full durable result. Before publication only, keep values of length 4096 or less unchanged; for a longer `REASON` or `NEXT_STEP`, take the longest whole-code-point prefix that fits within 4095 code units and append U+2026 `…`.

Keep this as one small local helper rather than changing the shared utility or reflection parser. Boundary tests cover 4096, 4097, and an astral character crossing the truncation boundary.

Alternatives considered: reject and retry the otherwise valid reflection, or complete it without a hook. Rejected respectively because they change the reflection validity contract or violate final-completion publication.

### 3. Emit after both completion appends succeed

Keep the established completion sequence intact and add publication only after the result entry and completion marker return successfully. Do not publish from `finishReflection`, because that helper also handles non-success paths and currently runs before durable recording.

The existing cleared active-reflection state remains the at-most-once guard. XML retry handlers, failure cleanup, cancellation, and ownership recovery receive no emit call.

### 4. Preserve route-correction and dispatch ordering

Publication is an additional best-effort side effect after durable completion. Wrap it so a thrown listener cannot suppress the already-issued route-correction steering, completion state, or later `maybeDispatch`. Do not await listener work or add an acknowledgement path. Because the shared event bus dispatch is synchronous, a slow listener can still consume wall-clock time before returning; the producer makes no latency guarantee beyond not awaiting asynchronous consumer work.

### 5. Verify final-only behavior through public seams

Focused runtime tests cover both reflection types, exact and clipped values, both append requirements, XML retry and exhausted-validation paths, a settled run with no captured decision, ownership loss through `syncOwnership`, shutdown, duplicate finalization, no listener, and throwing listener. Packed stock-Pi acceptance uses an independent consumer through the public event bus and proves no private runtime import is required.

## Risks / Trade-offs

- [Publishing before durable completion creates false reminders] -> Require both append operations to finish first.
- [Retry attempts could duplicate notifications] -> Keep publication out of attempt and re-ask handlers.
- [Consumer execution can take synchronous wall-clock time] -> Document that the producer neither awaits nor acknowledges consumer work, while accepting the shared bus's synchronous call-stack limitation.
- [Model-generated text reaches external consumers] -> Publish only bounded notification fields and omit the full report.
- [Clipping omits the tail from notifications] -> Keep the complete original fields in the durable reflection entry and mark clipped hook text with `…`.

## Migration Plan

1. Add RED acceptance coverage for the missing completion hook.
2. Add the minimal shared publication call at the durable completion seam.
3. Run focused and full checks plus packed stock-Pi acceptance.
4. Update user documentation separately.
5. Obtain provisional independent review of the uncommitted candidate and resolve findings.
6. After explicit local-commit authorization, create separate signed functional and documentation commits.
7. Review the exact commit SHAs or prove tree equivalence to the provisionally reviewed candidate.
8. Integrate and publish only after separate explicit push/integration authorization.

Rollback removes the one publication side effect; existing completion entries and older consumers require no data migration.
