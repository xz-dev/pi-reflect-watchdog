# pi-reflect-watchdog acceptance contract

## Identity

- Package/repository/config identity is `pi-reflect-watchdog` / `pi-reflect-watchdog.json`.
- The only user commands are `/reflect`, `/reflect-watchdog`, and `/reflect-timeline`.
- The only model tools are `reflect_watchdog_control`, `reflect_history_count`, and `reflect_history_get`.
- No legacy config read and no `/watchdog` or `watchdog_control` aliases.

## Prompt and protocol

- `reflectionPrompt` layers built-in, global agent-dir JSON, then trusted project JSON.
- Configuration can replace only the semantic prefix. The plugin appends current local RFC3339 time, reasons, thresholds, previous history, optional supplement, tool budget, and XML requirements.
- Trailing reflection XML is case-sensitive for tags/type, XML 1.0 entity-aware, and limited to 16,384 Unicode characters.
- `type`, `reason`, `done`, `current_step`, and `next_step` are unique, required, and non-empty.
- Maximum three total invalid XML attempts.
- Maximum 10 tool calls per reflection across all attempts; call 11 is blocked before execution.

## Exact counters

- `pi-reflect-watchdog` owns active time/loops, task time, root loops, all loops, certainty, generation, and fences.
- Each ordinary `turn_end` contributes one versioned loop message; root ordinary turns increment root/all/active loops, and other observable ordinary turns increment all/active loops.
- Reflection and correction attempts do not increment counters.
- Root owns pause/reset/resume. Fresh activity and loop revisions are acknowledged in snapshots; stale epochs, revisions, or reconnect snapshots fail closed.
- Active/task time uses recursive fixed-quantum `setTimeout`; delayed callbacks never backfill host sleep.
- Aggregate idle has no debounce: it immediately freezes active/task time and records `the_end_loop_time`. Exactly the configured 60-second idle gap resumes the same counters; only a strictly longer gap resets active/task/root/all.

## Queue and outcomes

- Automatic and manual triggers share one serialized queue.
- Simultaneous automatic reasons merge while preserving the first pre-reset threshold snapshot.
- Reasons are `ROOT_LOOP_LIMIT`, `ALL_LOOP_LIMIT`, `TASK_TIME_LIMIT`, and `USER_REQUEST`.
- `/reflect` trailing text is persisted as user supplement; blank means absent.
- Automatic reflection starts by pausing counters and resetting task/root/all while preserving active. Manual reflection pauses without resetting. Queue completion resumes counters/timer.
- `NO_ISSUE` persists and renders one report, then starts no work turn.
- `ROUTE_CORRECTION` persists first, then sends the readable report and starts one ordinary work turn.

## History and timeline

- Each completed valid reflection persists timestamp, reasons, thresholds, supplement, decision, and report as a custom branch entry.
- `reflect_history_count` returns the valid reflection count on the current branch.
- `reflect_history_get` accepts exactly one selector: `latest`, 1-based `index`, or inclusive 1-based `range: {start,end}`.
- `/reflect-timeline` reads current-branch entries. TUI uses scrollable `ctx.ui.custom`; other modes use bounded text.

## Cross-repository acceptance

- `pi-extension-utils`: lint, typecheck, build, unit, pack, production audit, and real cross-process authenticated transport acceptance.
- `pi-reflect-watchdog`: lint, typecheck, unit/runtime lifecycle, strict XML/inquiry folding, packed stock-Pi RPC/TUI, and real process-domain integration.
- `pi-continue-watchdog`: strict XML and inquiry folding, `/continue-timeline`, packed installation, and real process-domain reconnect acceptance.
- Joint packed installation uses both watchdogs pinned to the same full `pi-extension-utils` commit SHA without command/tool collisions.
- Preserve unrelated untracked artifacts; do not commit, push, publish, or clean them.
