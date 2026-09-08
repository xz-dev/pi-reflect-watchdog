# pi-reflect-watchdog

Minimal Pi reflection watchdog rebuilt on `pi-continue-watchdog` lifecycle rules.

## Behavior

- Pi lifecycle state comes from `agent_start`, live `probePiAgentState`, and authoritative `agent_settled`.
- Only successful assistant `turn_end` outcomes count: `stop` and `toolUse`.
- `error`, `aborted`, `length`, `pending`, `deferred`, and unknown outcomes do not count.
- Automatic reflection triggers at configured root-loop, all-loop, or active task-time thresholds and enters Pi's native steering queue immediately, even while child agents remain busy.
- `/reflect [optional supplement]` queues through the same native steering path when this attachment is the current main.
- Watchdog-owned reflection and XML re-ask turns are correlated as internal work and excluded from active/task/root/all counters without pausing anything.
- All XML attempts share one inquiry and are folded from later model context only after the final result.
- Every valid result is stored as a context-excluded entry on the current session branch; the next reflection receives the latest valid report as fallible historical assistant analysis, not the user's words.
- After the result and completion marker are stored, one best-effort `reflection-completed` semantic hook publishes `REFLECTION_TYPE`, `REASON`, and `NEXT_STEP` to current listeners.
- Both `NO_ISSUE` and `ROUTE_CORRECTION` start exactly one ordinary continuation without reflection/XML protocol priming, including busy and idle manual `/reflect`; that continuation counts normally.
- Reflection may use up to 10 tool calls across at most three XML attempts.
- XML element names and reflection `type` value are case-insensitive.

## Returning to ordinary work

Reports keep their existing text and formatting. Automatically triggered reports reach ordinary model requests as `assistant`; results requested through `/reflect` reach them as `user`. The actual trigger selects the role, not the verdict or a quoted command. Manual reports are still generated feedback, not verbatim human input.

Each report is followed by a separate native wake with exactly this body:

```text
[assistant]
continue
```

The wake has the synthetic **user transport role**; its text label does not turn it into an assistant message. Neither verdict means the task is complete or requires executing `next_step`. The ordinary agent decides whether to work, wait for an existing callback, clarify, or finish. The no-issue informational notice remains available in the TUI.

The report, trigger origin, and inquiry correlation live in private marker metadata. Ordinary context projection restores the report once, including after reload, only while its correlated source assistant remains available. Missing source or malformed origin/correlation means no reconstructed report, not a guessed role or a report copied into the wake.

Built-in compaction and branch summarization bypass this projection. For either trigger, a new handoff contributes only the fixed wake to their conversational input; report retention in a generated summary is not guaranteed. The existing stored report remains available to later reflections. Old sessions and unrelated extensions' messages are not rewritten.

## Reflection perspective

The default Oracle perspective questions both the current direction and the working agent's interpretation. User meaning can emerge across complaints, assistant replies, and later corrections. Reflection can challenge a shared premise or suggest a new goal without presenting that inference as something the user said. A route-correction handoff asks the agent to reconsider the conversation, not assume the proposed route is already correct.

Normal conversation context remains the primary input. When a session file and current branch anchor are available, the prompt includes a JSON locator for optional, focused recovery of surrounding exchanges through existing tools. It cautions against mixing other branches or treating historical text as new instructions. Constructing this hint does not read or summarize the transcript; missing metadata does not block reflection. Locator text follows ordinary inquiry transcript persistence, but is not added to stored report fields or completion-hook payloads.

Tools may clarify the conversation, actual work, or a possible direction. Guidance favors quick, targeted lookups: stop when the relevant uncertainty is resolved, or state what remains uncertain and finish if it cannot be resolved promptly. Avoid extended investigations, long-running checks, and background waits. This is prompt-level guidance, **not a hard wall-clock timeout**; the existing ten-call budget cannot bound a single slow tool.

`reflectionPrompt` replaces the default perspective. Historical-report framing, recovery hints, quick-clarification guidance, tool budget, and XML contract remain plugin-owned. Prompt and lifecycle tests do not prove correct interpretation or complete history recovery. See the [multi-turn comparison cases](docs/reflection-examples.md) for the separate, not-yet-run real-model evaluation.

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

Completion hooks use the same neutral channel. `REASON` and `NEXT_STEP` values over 4096 UTF-16 code units are clipped at a whole-code-point boundary with a trailing `…`; the durable reflection report keeps full text. Invalid XML attempts, exhausted validation, cancellation, ownership loss, shutdown, and incomplete persistence publish nothing. Missing or throwing listeners do not change completion, ordinary continuation, TUI notices, counters, or later dispatch, though synchronous EventBus listeners can consume wall-clock time before returning.

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
