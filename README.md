# pi-reflect-watchdog

Minimal Pi reflection watchdog rebuilt on `pi-continue-watchdog` lifecycle rules.

## Kept behavior

- Pi lifecycle state comes from `agent_start`, live `probePiAgentState`, and authoritative `agent_settled`.
- Only successful assistant `turn_end` outcomes count: `stop` and `toolUse`.
- `error`, `aborted`, `length`, `pending`, `deferred`, and unknown outcomes do not count.
- Automatic reflection triggers at configured root-loop, all-loop, or active task-time thresholds and enters Pi's native steering queue immediately, even while child agents remain busy.
- `/reflect [optional supplement]` queues through the same native steering path when this attachment is the current main.
- Watchdog-owned reflection and XML re-ask turns are correlated as internal work and excluded from active/task/root/all counters without pausing anything.
- All XML attempts share one inquiry and are folded from later model context only after the final result.
- Every valid result is stored as a context-excluded entry on the current session branch; the next reflection receives the latest valid report as reference-only context.
- `ROUTE_CORRECTION` starts one ordinary continuation without reflection/XML protocol priming; that continuation counts normally.
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
  "reflectionPrompt": "Reassess the current route using verified evidence.",
  "hookPauses": [
    { "pause": "inquiry-started", "resume": "inquiry-finished" }
  ]
}
```

`hookPauses` is watchdog-private configuration. Each distinct pair has an independent nesting depth; duplicate identical pairs collapse to one pair, unmatched resume events are harmless, and counting resumes only after every pair reaches zero. Hook names follow the neutral `pi:semantic-hook:v1` lowercase kebab-case protocol from `pi-extension-utils/semantic-hook`.

Delivery is best-effort to current listeners only: no buffer, replay, acknowledgement, retry, or cross-process forwarding. Producers must publish pause before excluded work and a matching resume on every terminal path. While paused, active/task time and loop counters freeze across the watchdog process domain; explicit `/reflect` remains available.

Runtime reset, dynamic limit controls, history/timeline tools, public pause APIs, and pause/resume commands are intentionally removed. Config-driven semantic-hook pauses are the only external counting control.

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
