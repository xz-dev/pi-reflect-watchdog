# pi-reflect-watchdog acceptance contract

## Identity

- Package/repository/config identity is `pi-reflect-watchdog` / `pi-reflect-watchdog.json`.
- The only user commands are `/reflect`, `/reflect-watchdog`, and `/reflect-timeline`.
- The only model tools are `reflect_watchdog_control`, `reflect_history_count`, and `reflect_history_get`.
- No legacy config read and no `/watchdog` or `watchdog_control` aliases.

## Prompt and protocol

- `reflectionPrompt` layers built-in, global agent-dir JSON, then trusted project JSON.
- Configuration can replace only the semantic prefix. The plugin appends current local RFC3339 time, reasons, thresholds, previous history, optional supplement, tool budget, and XML requirements.
- Trailing reflection XML is case-insensitive for tags/type, entity-aware, and limited to 16,384 Unicode characters.
- `type`, `reason`, `done`, `current_step`, and `next_step` are unique, required, and non-empty.
- Maximum three total invalid XML attempts.
- Maximum 10 tool calls per reflection across all attempts; call 11 is blocked before execution.

## Exact counters

- Broker-authoritative named counters track root loops, domain loops, and continuous aggregate-active milliseconds.
- Each ordinary `turn_end` atomically increments domain loops; root ordinary turns also increment root loops.
- Reflection and correction attempts do not increment counters.
- Root owns pause/reset/resume under a counter generation; stale generations and non-owner control writes fail closed.
- Active time uses recursive fixed-quantum `setTimeout`; delayed callbacks never backfill host sleep.
- Aggregate idle uses one fixed 10-second handoff grace. Busy returning within grace continues the window; idle through grace resets continuous-active time.

## Queue and outcomes

- Automatic and manual triggers share one serialized queue.
- Simultaneous automatic reasons merge while preserving the first pre-reset threshold snapshot.
- Reasons are `ROOT_LOOP_LIMIT`, `DOMAIN_LOOP_LIMIT`, `CONTINUOUS_DOMAIN_ACTIVE_TIME`, and `USER_REQUEST`.
- `/reflect` trailing text is persisted as user supplement; blank means absent.
- Reflection starts by pausing/resetting counters. Queue completion resumes counters/timer.
- `NO_ISSUE` persists and renders one report, then starts no work turn.
- `ROUTE_CORRECTION` persists first, then sends the readable report and starts one ordinary work turn.

## History and timeline

- Each completed valid reflection persists timestamp, reasons, thresholds, supplement, decision, and report as a custom branch entry.
- `reflect_history_count` returns the valid reflection count on the current branch.
- `reflect_history_get` accepts exactly one selector: `latest`, 1-based `index`, or inclusive 1-based `range: {start,end}`.
- `/reflect-timeline` reads current-branch entries. TUI uses scrollable `ctx.ui.custom`; other modes use bounded text.

## Cross-repository acceptance

- `pi-process-domain`: typecheck, lint, build, unit, and real cross-process acceptance covering concurrent increments, subscription, owner pause/reset/resume, stale generation rejection, reconnect replay, and packed import.
- `pi-reflect-watchdog`: lint, typecheck, unit/runtime lifecycle, packed stock-Pi RPC, TUI, and process-domain integration.
- `pi-continue-watchdog`: case-insensitive XML root/fields/function while retaining unique trailing XML, entity decode, duplicate rejection, and three attempts; `/continue-timeline` covers manual lock, continue, AI/human unlock, and decision-failed with TUI/fallback.
- Joint packed installation uses matching `pi-process-domain` counter API and both watchdogs without command/tool collisions.
- Preserve unrelated untracked artifacts; do not commit, push, publish, or clean them.
