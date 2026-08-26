# pi-reflect-watchdog

Minimal Pi reflection watchdog rebuilt on `pi-continue-watchdog` lifecycle rules.

## Kept behavior

- Pi lifecycle state comes from `agent_start`, live `probePiAgentState`, and authoritative `agent_settled`.
- Only successful assistant `turn_end` outcomes count: `stop` and `toolUse`.
- `error`, `aborted`, `length`, `pending`, `deferred`, and unknown outcomes do not count.
- Automatic reflection triggers at configured root-loop, all-loop, or active task-time thresholds and may steer the current ordinary run between turns.
- `/reflect [optional supplement]` dispatches when this attachment is the current main and the aggregate lifecycle is safe; otherwise it stays queued.
- Watchdog-owned reflection and XML re-ask turns are correlated as internal work and excluded from active/task/root/all counters without pausing anything.
- `ROUTE_CORRECTION` starts one ordinary continuation; that continuation counts normally.
- Reflection may use up to 10 tool calls across at most three XML attempts.
- XML element names and reflection `type` value are case-insensitive.

## Configuration

Global `getAgentDir()/pi-reflect-watchdog.json` and trusted project `.pi/pi-reflect-watchdog.json` merge field-by-field over built-ins:

```json
{
  "rootLoopLimit": 100,
  "allLoopLimit": 500,
  "taskMinutes": 30,
  "idleResetGapSeconds": 60,
  "reflectionPrompt": "Reassess the current route using verified evidence."
}
```

Runtime reset, dynamic limit controls, history/timeline tools, and pause/resume controls are intentionally removed. Change static configuration and reload instead.

## TUI

Below-editor live row uses same `setWidget`/`requestRender` pattern as Continue Watchdog:

```text
Reflect Watchdog | active 12m40s/137 loops · task 12m40s/30m · root 37/100 · all 128/500
```

When terminal is narrow it switches to compact form before final truncation:

```text
RW | a 12m40s/137 · t 12m40s/30m · r 37/100 · all 128/500
```

## Install

```bash
pi install git:github.com/xz-dev/pi-reflect-watchdog@master
pi install git:github.com/xz-dev/pi-reflect-watchdog@release
```

## Development

```bash
npm ci
npm run check
npm run test:e2e:fast
npm run test:e2e
lean docs/programming-thinking/pi-reflect-watchdog-lifecycle.idea.lean
lean --run docs/programming-thinking/pi-reflect-watchdog-lifecycle.idea.lean
```

Formal lifecycle authority: [`docs/programming-thinking/pi-reflect-watchdog-lifecycle.idea.lean`](docs/programming-thinking/pi-reflect-watchdog-lifecycle.idea.lean).

Licensed under BSD-3-Clause. See [LICENSE](LICENSE).
