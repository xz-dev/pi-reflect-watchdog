## Context

See [proposal](proposal.md) for motivation and [local requirements](specs/watchdog-background-status/spec.md) for Reflect behavior. This design is required because live progress crosses private-child, accounting, queue and widget lifecycles.

The [Continue design](../../../../pi-continue-watchdog/openspec/changes/unify-background-watchdog-status/design.md) owns the common visual vocabulary, width priorities, timing and privacy decisions. The canonical capability is `pi-continue-watchdog:watchdog-background-status`; this document maps it onto Reflect rather than duplicating that policy.

Reflect already has a single below-editor widget in `src/widget.ts`, admission and private execution in `src/extension.ts`, an exact-child event facade in `forkObservedChild`, and runtime refresh scheduling. Its current widget is dim and reports accounting; private result corrections currently use bounded warnings. Preserve those independent accounting, diagnostic and outcome contracts.

## Goals / Non-Goals

**Goals:** Add private operation visibility through the current row and existing child observation path; preserve full-width counters, pending-request hints, correct accounting and independent parent progress.

**Non-Goals:** Changing trigger thresholds, cooldown, source capture, execution permission, helper budgets, retry limits, result protocol, cancellation commands or feedback delivery. No shared npm package, terminal tab integration, extra panel, new configuration, progress persistence or raw evidence log.

## Decisions

### 1. Extend active reflection state and the current widget

Attach only current phase, monotonic admission time, known result-attempt metadata and active safe helper names to the existing active operation. Project them through `statusState` into `WidgetState`; do not derive them from aggregate `anyBusy` or copy them into accounting counters.

Keep `formatWidgetText` as the safe plain-text projection used by RPC and extend the component renderer with the canonical theme treatment. `WidgetTheme` will need background support for the active row. Apply colors at render time and retain existing dim style otherwise. Keep the existing key and below-editor placement.

Alternative rejected: another live widget would duplicate information and preserve the current UI mismatch.

### 2. Extend the existing exact-child observation facade

Admission displays preparation before asynchronous runtime acquisition. Extend `forkObservedChild`'s existing bounded subscription with safe phase observations for actual model/helper activity; forward prompt/abort/dispose and live getters unchanged. Track overlapping admitted helpers by their execution identities and display only permitted names.

Bracket the existing validator for validation progress, and use `onResponse` and the next authorized prompt to distinguish correction from result attempts. Helper-only turns and native retries are not result attempts. Preserve `onResponse`'s existing bounded warning behavior without adding progress notifications. Native retry/compaction labels are optional refinements only when official events provide them.

Enter publication only around the existing guarded durable result path; displaying that phase does not authorize feedback. A short synchronous stage need not receive its own terminal frame. Add no delay and no model request for UI purposes. Rendering/observation errors remain presentation failures and cannot mutate execution outcomes.

Alternative rejected: changing the shared private-inquiry package to introduce a new progress protocol expands the two-repository scope unnecessarily; existing callbacks and the local child facade cover this change.

### 3. Keep operation time independent of accounting refresh

Reuse local refresh scheduling, extending its display-needed condition to include active private progress as well as existing accounting activity. Request rendering immediately on phase changes and maintain the one-second elapsed display during preparation or idle-parent waits. Read elapsed time from a monotonic/injected clock, never callback counts.

Stop only unneeded display work on settlement; existing legitimate accounting refresh remains enabled. Unref timers and dispose observers. The private elapsed clock does not reset active/task counters or change their official activity/suspension policies.

### 4. Preserve queue and compact-layout semantics

Retain the existing full-width active/task/root/all/cooldown values and effective cancellation hint. Show a pending hint only for actual `manualQueue` entries; the active operation itself is never represented as withdrawable by `/cancel-reflect`. When both exist, show private progress and the distinct pending request as width permits.

Use the canonical compact priorities: identity and active phase, then elapsed time/attempt, then secondary controls and counters. Measure and clip with Pi's column-aware functions, not string length. Recompute theme formatting on redraw, and restore details when the terminal widens.

### 5. Reuse execution fencing for stale events without conflating authority

All updates must match the current displayed active operation and visible ownership scope. Revocation can leave a `cancelling` projection while its exact child drains, but cannot retain result authority. Session replacement, demotion and shutdown clear the old projection immediately. A delayed `finally` or helper event cannot clear the replacement operation or its timer.

Normal completion/failure restores the ordinary row and existing outcome/diagnostic behavior. Unsubscribe on all cleanup paths, including setup failure and dispose errors. Do not abort parent or Continue work, reevaluate thresholds or submit a replacement as a UI side effect.

## Risks / Trade-offs

- Some providers expose only coarse model activity -> keep a truthful model-wait label rather than guessing a transport phase.
- Accounting and private display have different lifetimes -> share scheduling without sharing clock values or resetting accounting.
- Compact rendering drops secondary details -> stage stays visible, full information returns on resize, stored values remain intact.
- Cancellation and disposal race successor admission -> exact operation/owner checks protect both update and cleanup paths.
- Cross-repository UI drift -> use Continue's canonical capability and leave joint acceptance open until both plugins are demonstrated together.

## Migration Plan

1. Extend existing widget/runtime/private-reflection tests with representative progress, privacy, queue, overlap and cleanup examples; do not add a test framework.
2. Implement Reflect's projection and observation wiring without changing protocol or accounting. Run local checks and contribute evidence to the [Continue joint checklist](../../../../pi-continue-watchdog/openspec/changes/unify-background-watchdog-status/tasks.md).
3. Demonstrate both rows together, including resize, theme changes, correction, long waits and takeover. Local test success alone does not close joint acceptance.
4. No configuration or stored-data migration. Rollback restores the old widget/projection only, preserving reflection results and accounting. At archive, point cross-project references to Continue's promoted `openspec/specs/watchdog-background-status/spec.md` and preserve repository/capability identity.
