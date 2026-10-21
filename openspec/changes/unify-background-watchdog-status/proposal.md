## Why

Private reflection can run for a long time while Reflect's below-editor row continues to show only activity counters. Users need the same live, unobtrusive stage feedback as Continue, without exposing private reflection traffic or blocking ordinary work.

## What Changes

- Implement the Reflect half of the joint `unify-background-watchdog-status` change; Continue is the canonical cross-project specification and tracking point.
- Extend the existing single below-editor row with theme-aware active highlighting, current private stage, elapsed operation time, applicable result-attempt count and safe helper names. Do not create terminal/session tabs or an extra progress panel.
- Show preparation, model waiting, admitted evidence-tool execution, result validation, format correction and actual result handoff from observed events. Do not infer reflection execution from aggregate `anyBusy` or accounting thresholds.
- Preserve the current active/task/root/all values, cooldown text and effective pending-request withdrawal hint. Keep plugin-pending requests distinct from an admitted private operation.
- Apply the shared narrow-width priorities and immediate lifecycle cleanup. Fence late events so a retired reflection cannot repaint a new operation.
- Keep private content hidden and preserve accounting, cancellation, durable completion, hook and native feedback delivery rules.

## Capabilities

### New Capabilities

- `watchdog-background-status`: Reflect-specific realization of the joint live status contract, including evidence activity, queue separation, responsive rendering and stale-operation cleanup.

### Modified Capabilities

None. Existing reflection execution, runtime accounting and manual queue contracts remain authoritative and unchanged.

## Impact

- `src/widget.ts`: state projection, full/compact rendering and theme-aware highlight.
- `src/extension.ts`: admission, exact-child lifecycle observations, result-attempt callbacks, handoff, cancellation and refresh lifecycle.
- Existing widget, private-reflection, queue, accounting and extension tests; integrated TUI verification with Continue.
- Canonical [Continue proposal](../../../../pi-continue-watchdog/openspec/changes/unify-background-watchdog-status/proposal.md), [joint design](../../../../pi-continue-watchdog/openspec/changes/unify-background-watchdog-status/design.md), and [joint tracking tasks](../../../../pi-continue-watchdog/openspec/changes/unify-background-watchdog-status/tasks.md). This repository tracks only its own implementation and verification; joint completion is recorded in Continue.
- Reuse existing Pi APIs and private-inquiry dependency. No new dependency, configuration, public interface, or runtime behavior beyond presentation is planned. This change currently contains documentation only.
