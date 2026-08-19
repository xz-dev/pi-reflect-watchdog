# pi-reflect-watchdog

`pi-reflect-watchdog` is a Pi extension that monitors long-running multi-agent work and asks the current root agent to reassess its route when exact active/task/root/all thresholds are reached.

## Runtime contract

- A loop is one completed ordinary Pi `turn_end`, not a tool call, tool result, or message.
- Built-in thresholds are 100 root loops, 500 process-wide loops, and 30 minutes of aggregate active task time. The built-in idle reset gap is 60 seconds.
- `active` time and `active loops` cover ordinary work by the root and every observable agent or subagent. `root` loops count only root turns; `all` loops count every observable ordinary turn.
- `pi-reflect-watchdog` owns exact cross-process counters, activity state, certainty, generation, fences, reflection pause/resume, and active-time ticking. `pi-extension-utils` provides only authenticated transport, peer state, strict XML, and inquiry primitives.
- Active and task time advance by one fixed recursive `setTimeout` quantum while any participant is busy. Late callbacks add one quantum only, so host sleep is never backfilled.
- The all-idle edge has no debounce or grace period. It immediately freezes active/task time and records `the_end_loop_time`. Resuming at exactly the configured gap continues the same counters; only a strictly longer gap resets active time/loops and task/root/all counters before work resumes.
- Any task/root/all threshold queues one reflection. Reasons crossed together are merged as `ROOT_LOOP_LIMIT`, `ALL_LOOP_LIMIT`, and/or `TASK_TIME_LIMIT`, with one pre-reset threshold snapshot. Acknowledging an automatic threshold resets task time plus root/all loops while preserving active time/loops.
- `/reflect [supplement]` queues a manual `USER_REQUEST` reflection. Whitespace-only input means no supplement; nonblank text is persisted with the result. A manual reflection pauses counters but does not reset the task/root/all reminder cycle.
- All automatic and manual reflections use one serialized queue. While a reflection and its XML corrections run, active/task/root/all counters and watchdog timers are paused; the reflection turns themselves are not counted. Completion resumes the appropriate cycle without self-counting.
- Process exit or watchdog shutdown destroys all in-memory timer, counter, timestamp, and pause state. Persisted reflection history remains session data.

The extension is not a subagent controller. It observes only processes that load it and join the inherited authenticated process domain.

## Reflection protocol

The prompt is layered from:

1. Built-in `reflectionPrompt`.
2. Global `getAgentDir()/pi-reflect-watchdog.json`.
3. Trusted project `.pi/pi-reflect-watchdog.json`.

Only the semantic prefix is configurable. The plugin always appends its local RFC3339 timestamp, trigger reasons, active/task/root/all threshold snapshot, previous stored reflection, optional user supplement, shared tool budget, and XML contract.

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

XML tag names and the `type` value are case-sensitive. `type`, `reason`, `done`, `current_step`, and `next_step` are the only fields; each is unique, required, and non-empty. XML 1.0 entities are decoded; duplicate roots or fields, attributes, malformed nesting, invalid characters, trailing prose, and oversized text are rejected.

`NO_ISSUE` persists and renders one TUI report, then ends without another work turn. `ROUTE_CORRECTION` persists the same report first, sends its readable form to the agent, and starts one ordinary work turn.

## Configuration

Global and trusted-project files merge field-by-field over built-ins:

```json
{
  "rootLoopLimit": 100,
  "allLoopLimit": 500,
  "taskMinutes": 30,
  "idleResetGapSeconds": 60,
  "reflectionPrompt": "Reassess the current route using verified evidence."
}
```

Limits and the idle reset gap must be positive JavaScript safe integers. `reflectionPrompt` must be nonblank and within its configured Unicode bound. Unknown or invalid fields preserve the lower-precedence value and produce bounded diagnostics. The extension reads only `pi-reflect-watchdog.json`; it does not read the old `pi-watchdog.json` filename.

## Control plane

Root-only slash commands:

```text
/reflect [optional user supplement]
/reflect-watchdog [status]
/reflect-watchdog reset
/reflect-watchdog limits
/reflect-watchdog limits <root> <all> <minutes> <idle-reset-seconds>
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

`/reflect-timeline` reads that branch. TUI mode opens a scrollable `ctx.ui.custom` view with arrow/j/k/PageUp/PageDown navigation. RPC, print, and JSON modes receive a bounded text notification. The below-editor TUI widget shows:

```text
Reflect Watchdog | active <time>/<all-loops> loops · task <time>/<limit> · root <loops>/<limit> · all <loops>/<limit>
```

## Design documents

Durable project documents live under [`docs/`](docs/README.md):

- [`docs/planning/v1-acceptance.md`](docs/planning/v1-acceptance.md): v1 acceptance contract.
- [`docs/planning/user-controls-red-waiver.md`](docs/planning/user-controls-red-waiver.md): historical user-controls repair waiver.
- [`docs/programming-thinking/pi-reflect-watchdog-lifecycle.idea.lean`](docs/programming-thinking/pi-reflect-watchdog-lifecycle.idea.lean): executable Lean 4 lifecycle and counter-contract authority.

## Install

This repository uses Git source and generated release branches:

```bash
pi install git:github.com/xz-dev/pi-reflect-watchdog@master
pi install git:github.com/xz-dev/pi-reflect-watchdog@release
```

Local development installs can use an absolute checkout path. Source installs load `src/extension.ts`; packed/release artifacts load `dist/extension.js`.

`pi-extension-utils` is an exact Git dependency pinned to a full commit SHA. The extension uses its authenticated loopback TCP transport, strict XML parser, and Pi inquiry correlation/folding APIs. The tracked `.npmrc` uses `allow-git=root` and `legacy-peer-deps=true`: only this package's reviewed direct Git dependency is admitted, while Pi peer packages remain host-provided. The transport is pure TypeScript over `node:net` and has no native install scripts.

## Development

```bash
npm ci
npm run check
npm run test:e2e:fast
npm run test:e2e
```

`npm run check` runs Biome, TypeScript checks, focused unit/runtime tests, and the build. E2E builds a bounded external pack stage and exercises stock Pi RPC/TUI paths. Synthetic Git commits in tests disable inherited `commit.gpgsign` only for those temporary repositories.

## Security

Pi extensions execute with user permissions. Process-domain declarations contain bearer capabilities and must not be logged. Project configuration is ignored unless Pi marks the project trusted. Do not put credentials in `reflectionPrompt` or `/reflect` supplements.

Licensed under the [BSD 3-Clause License](LICENSE).
