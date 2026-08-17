# pi-reflect-watchdog

`pi-reflect-watchdog` is a Pi extension that monitors long-running multi-agent work and asks the current root agent to reassess its route when exact loop or continuous-active thresholds are reached.

## Runtime contract

- A loop is one completed ordinary Pi `turn_end`, not a tool call, tool result, or message.
- Built-in thresholds are 100 root loops, 500 process-domain loops, and 30 minutes of continuous aggregate active time.
- `pi-process-domain` owns the exact cross-process counters. Every participating process atomically contributes completed turns; the root owns pause/reset/resume and active-time ticking.
- Continuous active time advances by one fixed recursive `setTimeout` quantum while the broker reports any participant busy. Late callbacks add one quantum only, so host sleep is never backfilled.
- Aggregate idle starts one fixed 10-second handoff grace. Activity returning within that generation continues the same active window; uninterrupted idle through the grace resets continuous active time.
- Any threshold queues one reflection. Reasons crossed together are merged as `ROOT_LOOP_LIMIT`, `DOMAIN_LOOP_LIMIT`, and/or `CONTINUOUS_DOMAIN_ACTIVE_TIME`, with one pre-reset threshold snapshot.
- `/reflect [supplement]` queues a manual `USER_REQUEST` reflection. Whitespace-only input means no supplement; nonblank text is persisted with the result.
- All automatic and manual reflections use one serialized queue. While a reflection and its XML corrections run, broker counters and timers are paused; the reflection turns themselves are not counted. Completion resets and resumes the cycle.

The extension is not a subagent controller. It observes only processes that load it and join the inherited authenticated process domain.

## Reflection protocol

The prompt is layered from:

1. Built-in `reflectionPrompt`.
2. Global `getAgentDir()/pi-reflect-watchdog.json`.
3. Trusted project `.pi/pi-reflect-watchdog.json`.

Only the semantic prefix is configurable. The plugin always appends its local RFC3339 timestamp, trigger reasons, threshold snapshot, previous stored reflection, optional user supplement, shared tool budget, and XML contract.

Each reflection may make at most 10 tool calls across all XML attempts; call 11 is blocked before execution. There are at most three total invalid XML attempts. The final non-thinking text is limited to 16,384 Unicode characters and must end with exactly one trailing block:

```xml
<reflection>
  <type>NO_ISSUE</type>
  <reason>why the route is sound</reason>
  <done>completed work</done>
  <current_step>current work</current_step>
  <next_step>correct next step</next_step>
</reflection>
```

Tag names and the `type` value are case-insensitive. `type`, `reason`, `done`, `current_step`, and `next_step` are unique, required, and non-empty. XML entities are decoded; duplicate roots or fields, attributes, malformed nesting, and oversized text are rejected.

`NO_ISSUE` persists and renders one TUI report, then ends without another work turn. `ROUTE_CORRECTION` persists the same report first, sends its readable form to the agent, and starts one ordinary work turn.

## Configuration

Global and trusted-project files merge field-by-field over built-ins:

```json
{
  "mainLoopLimit": 100,
  "observedTotalLoopLimit": 500,
  "wallClockMinutes": 30,
  "reflectionPrompt": "Reassess the current route using verified evidence."
}
```

Limits must be positive JavaScript safe integers. `reflectionPrompt` must be nonblank and within its configured Unicode bound. Unknown or invalid fields preserve the lower-precedence value and produce bounded diagnostics. The extension reads only `pi-reflect-watchdog.json`; it does not read the old `pi-watchdog.json` filename.

## Control plane

Root-only slash commands:

```text
/reflect [optional user supplement]
/reflect-watchdog [status]
/reflect-watchdog reset
/reflect-watchdog limits
/reflect-watchdog limits <root> <domain> <minutes>
/reflect-watchdog limits reset
/reflect-timeline
```

Model tools:

- `reflect_watchdog_control`: `status`, `reset`, `set_limits`, `restore_defaults`.
- `reflect_history_count`: current-branch count of completed valid reflections.
- `reflect_history_get`: exactly one of `latest`, 1-based `index`, or inclusive 1-based `range: { start, end }`.

There are no `/watchdog` or `watchdog_control` aliases.

## History and TUI

Reflection records are context-excluded custom entries on the current session branch. Each stores the plugin timestamp, all trigger reasons, threshold snapshot, optional supplement, validated decision, and formatted report.

`/reflect-timeline` reads that branch. TUI mode opens a scrollable `ctx.ui.custom` view with arrow/j/k/PageUp/PageDown navigation. RPC, print, and JSON modes receive a bounded text notification. The below-editor TUI widget shows current broker-authoritative root loops, domain loops, and continuous active time.

## Install

This repository uses Git source and generated release branches:

```bash
pi install git:github.com/xz-dev/pi-reflect-watchdog@master
pi install git:github.com/xz-dev/pi-reflect-watchdog@release
```

Local development installs can use an absolute checkout path. Source installs load `src/extension.ts`; packed/release artifacts load `dist/extension.js`.

`pi-process-domain` is an exact Git dependency and must be pinned to a revision that exports the named cycle-counter API used by this extension.

## Development

```bash
npm ci
npm run check
npm run test:e2e:fast
npm run test:e2e
```

`npm run check` runs Biome, TypeScript checks, focused unit/runtime tests, and the build. E2E builds a bounded external pack stage and exercises stock Pi RPC/TUI paths. Synthetic Git commits in tests disable inherited `commit.gpgsign` only for those temporary repositories.

## Security

Pi extensions execute with user permissions. Process-domain keys and reservation capabilities are bearer secrets and must not be logged. Project configuration is ignored unless Pi marks the project trusted. Do not put credentials in `reflectionPrompt` or `/reflect` supplements.

Licensed under the [BSD 3-Clause License](LICENSE).
