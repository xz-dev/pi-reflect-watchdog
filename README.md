# pi-watchdog

`pi-watchdog` is a Pi package that helps a long-running **root agent** pause and reassess rather than repeatedly continuing a stalled approach. It counts completed Pi turns, warns at configurable thresholds, and exposes a compact TUI status line.

It is deliberately not a subagent controller. The main/root agent is the only session that receives warnings, steering, or a wall-clock timer. The aggregate counter is explicitly **observable coverage**: it includes the root plus watchdog-enabled child sessions that Pi exposes in the same process. Isolated, disabled, remote, and out-of-process agents may be absent.

## Features and semantics

- A **loop** is one completed Pi `turn_end`: it is not a tool call, a tool result, or a message.
- Built-in limits are **100 root loops**, **500 observable total loops**, and a **30-minute root active task cycle**.
- The wall clock belongs to the root only. It never times, steers, warns, stops, or otherwise controls subagents.
- A root user message begins a new watchdog task cycle. It clears task-cycle counters, warning latches, runtime limits, and temporary prompt overrides. Observer-session user messages only bind that observer to the current root task.
- Threshold warnings are latched once per task cycle. They are delivered as Pi custom messages, not user messages, so they do not start a new task.
- When the root is active, a warning is delivered as `steer` with `triggerTurn: false`: Pi waits for the current turn's tools to finish, then the ordinary continuation turn can reflect on the warning. The watchdog does not cancel or interrupt tools. When the root is idle, the warning is queued as `nextTurn` with `triggerTurn: false`; it does not wake the root.
- The root is normally the UI-bound session. In headless/non-UI execution, the first watchdog-enabled session bound in the process is a best-effort fallback because Pi has no public root/session-kind field.

### Active window versus watchdog task cycle

The TUI displays two different measurements:

- **`active`** is root-only elapsed active time paired with root completed loops for the automatic activity window. It excludes idle time and every child loop.
- **`task`**, **`root`**, and **`observed`** are the current watchdog cycle: task-cycle root-active time, root turn count, and root-plus-observable-child turn count. A manual reset clears these cycle counters and warning latches but leaves `active` unchanged.

An automatic active-window reset happens only when the root settles/stops or an interjecting/new root user message replaces an already active window. It produces exactly one user-only TUI notification; manual `/watchdog reset`, AI `watchdog_control` reset, threshold warnings, and runtime limit changes do not:

```text
Watchdog reset | active 2h14m/137 loops
```

Pi does not expose reliable public abort provenance, so this neutral notification does not claim that work completed or aborted.

## TUI status

In a TUI root session, pi-watchdog installs one restrained below-editor line (not a replacement footer):

```text
Watchdog | active 2h14m/137 loops · task 12m40s/30m · root 37/100 · observed 128/500
```

The line refreshes about once per second while the root is active, truncates to terminal width, and stops ticking when idle. Only the current TUI root receives the widget. RPC, print, JSON, and observer sessions do not render it.

## Install and try locally

This repository names the package `pi-watchdog`, but it is **not published to npm**. Build before either local `pi install` command: local paths are referenced by Pi, not copied, and `pi install` does not build the package for you.

```bash
npm ci
npm run build

# Global package setting: Pi references this local directory.
pi install /absolute/path/to/pi-watchdog

# Or write the package setting for the current trusted project.
pi install -l /absolute/path/to/pi-watchdog
```

For a one-run temporary extension load, without writing Pi settings, build first and pass the built extension file to Pi's documented `-e`/`--extension` flag:

```bash
npm ci
npm run build
pi -e /absolute/path/to/pi-watchdog/dist/extension.js
# equivalent long form
pi --extension /absolute/path/to/pi-watchdog/dist/extension.js
```

A local directory installed with `pi install` is interpreted as a package using its manifest. This package declares `dist/extension.js` under `package.json` → `pi.extensions`; use that package-directory form to verify package-manifest behavior, and the built-file `-e` form for a temporary extension-only check.

After the planned public GitHub publication, install directly from its source repository:

```bash
pi install git:github.com/xz-dev/pi-watchdog
```

This is Git installation guidance, not an npm publication claim. Until the repository is created and made public, use the local path above.

### Build requirements and reloads

Use Node.js **22 or newer**. The locked development setup and build are:

```bash
npm ci
npm run build
```

Pi loads the package's built `dist/extension.js`; edit/build it again before testing a source change. After rebuilding, use `/reload` or restart Pi to reload the configured local package. `/reload` does not build the package, so run `npm run build` first.

## Configuration

pi-watchdog reads two optional JSON files at root-session startup:

1. Global: `getAgentDir()/pi-watchdog.json`, normally `~/.pi/agent/pi-watchdog.json`. Respect `PI_CODING_AGENT_DIR`; it can change Pi's agent directory.
2. Trusted project: `${CONFIG_DIR_NAME}/pi-watchdog.json`, normally `.pi/pi-watchdog.json` below the current working directory.

The project file is ignored unless Pi marks the project trusted. Built-ins are merged first, then valid global fields, then valid trusted-project fields. Fields merge independently, including each prompt key. Missing or invalid higher-precedence values do not erase valid lower-precedence values.

```json
{
  "mainLoopLimit": 100,
  "observedTotalLoopLimit": 500,
  "wallClockMinutes": 30,
  "prompts": {
    "mainLoopLimitReached": "Root has completed {{mainLoops}}/{{mainLoopLimit}} loops.",
    "observedTotalLoopLimitReached": "Observed total: {{observedTotalLoops}}/{{observedTotalLoopLimit}}.",
    "wallClockLimitReached": "Root activity: {{elapsed}}/{{wallClockMinutes}} minutes."
  }
}
```

The accepted top-level limit keys are `mainLoopLimit`, `observedTotalLoopLimit`, and `wallClockMinutes`; each must be a positive JavaScript safe integer. `prompts` must be an object, and only these non-empty-string keys are used:

- `mainLoopLimitReached`
- `observedTotalLoopLimitReached`
- `wallClockLimitReached`

Unknown keys are ignored. Malformed JSON, invalid fields, and read failures are non-fatal: the watchdog retains usable lower-precedence/default values and reports bounded diagnostics (the root reports at most three during startup).

### Reminder templates

The shipped English templates are intentionally detailed reassessment prompts; their exact source is [`src/prompts.ts`](src/prompts.ts). The literal placeholders used by each built-in template are:

| Prompt key | Built-in placeholders |
| --- | --- |
| `mainLoopLimitReached` | `{{mainLoops}}`, `{{mainLoopLimit}}` |
| `observedTotalLoopLimitReached` | `{{observedTotalLoops}}`, `{{observedTotalLoopLimit}}`, `{{mainLoops}}`, `{{observedChildLoops}}`, `{{observedChildSessions}}` |
| `wallClockLimitReached` | `{{elapsed}}`, `{{wallClockMinutes}}` |

The full render context also recognizes:

| Placeholder | Meaning |
| --- | --- |
| `{{mainLoops}}` | Root loops in the current task cycle |
| `{{mainLoopLimit}}` | Effective root-loop limit |
| `{{observedChildLoops}}` | Observable child loops in the current cycle |
| `{{observedChildSessions}}` | Number of currently bound observable child sessions |
| `{{observedTotalLoops}}` | Root plus observable-child loops |
| `{{observedTotalLoopLimit}}` | Effective observable-total limit |
| `{{wallClockMinutes}}` | Effective root task-cycle wall-clock limit |
| `{{elapsed}}` | Human-readable root task-cycle active elapsed time |
| `{{coverage}}` | The observable-coverage caveat |

Placeholders are case-sensitive. An unknown `{{placeholder}}` remains literal rather than being removed. `/watchdog prompt show` displays the effective templates at runtime.

## User command: `/watchdog`

`/watchdog` is dynamically registered only for the current root. It is a user/UI command: it never sends a user or custom model message, never triggers an LLM turn, and never writes configuration files.

```text
/watchdog
/watchdog status
/watchdog reset
/watchdog limits
/watchdog limits <main> <observed> <minutes>
/watchdog limits reset
/watchdog prompt show
/watchdog prompt <main|total|time>
/watchdog prompt reset <main|total|time|all>
```

Examples:

```text
/watchdog limits 150 700 45
/watchdog reset
/watchdog prompt main
/watchdog prompt reset all
```

- Empty `/watchdog` and `status` show current counters, limits, latches, coverage, and the active window.
- `reset` resets only the current watchdog task cycle; current runtime limits and temporary prompts remain, while the automatic `active` window remains unchanged.
- `limits` shows status; three positive safe integers set current-task limits; `limits reset` restores configured limits without resetting counters or elapsed time.
- `prompt main`, `prompt total`, and `prompt time` open a multiline editor with the effective template. Saving applies a temporary override for this task only; an empty value is rejected. `prompt reset` removes one/all temporary overrides.

Prompt editing requires a UI-capable root session. In a non-UI root, status/reset/limits still use command notifications, but prompt editing reports that the editor is unavailable. Observer sessions do not receive the command.

## Model tool: `watchdog_control`

The current root model receives `watchdog_control` with these actions:

- `status`
- `reset`
- `set_limits` (supply at least one of `mainLoopLimit`, `observedTotalLoopLimit`, `wallClockMinutes`, each a positive safe integer)
- `restore_defaults`

All changes are runtime-only for the current task/process and never persist to either JSON configuration file. `reset` clears the task cycle without stopping agents. A threshold warning only latches; it does not reset anything. `set_limits` and `restore_defaults` preserve counters and elapsed time. They selectively rearm a latched threshold only when its current measurement is below the replacement limit, then immediately evaluate the replacement limit (so lowering an already-crossed limit can warn). Invalid, fractional, non-positive, or unsafe `set_limits` values are rejected before any limit mutates. The tool intentionally has no prompt-edit action: only the user command can temporarily override reminder text.

## Lifecycle and coverage limits

The watchdog has no dependency on a subagent plugin. It observes only child sessions that also load pi-watchdog in the same process and that bind to the current root task. Initial observers do not register `/watchdog`. Observer cleanup is best effort because some embedders can dispose child sessions without a `session_shutdown` event; attachment tokens, root generations, and task epochs prevent stale observer turns from contaminating a later task.

On root settle, the root timer and active TUI/RPC refresh stop. On root shutdown, the root attachment, timers, statuses, and widget are cleaned up. Pi has no public command-unregistration API: when a root is demoted, its prior `/watchdog` definition can remain discoverable, but its handler is inert unless its original root generation and context are still current. Reload/new/resume/fork attachments begin fresh task state rather than sharing a previous root's task.

## Development and package contents

```bash
npm run lint       # Biome check for src/ and test/
npm run typecheck  # no-emit TypeScript check
npm test           # Node test runner through tsx
npm run build      # emits dist/
npm run check      # lint + typecheck + test + build
```

Source lives in `src/`; focused behavior tests live in `test/`; TypeScript declarations and JavaScript are emitted to `dist/`. The npm `files` allowlist is `dist`; npm automatically includes `package.json`, this README, and [`LICENSE`](LICENSE) with a package tarball. Use `npm pack --dry-run --json` to inspect the exact publish set: it must contain only `README.md`, `LICENSE`, `package.json`, and `dist/` files.

## License

Licensed under the [BSD 3-Clause License](LICENSE). The intended public source repository is [github.com/xz-dev/pi-watchdog](https://github.com/xz-dev/pi-watchdog); it is not yet available until publication is completed.

## Security and trust

Pi packages and extensions execute with your user permissions. Review the package source before installing it. Project-local Pi configuration and package loading depend on Pi's trust decision; pi-watchdog deliberately ignores its project config when the project is untrusted. Do not put credentials or secrets in watchdog prompt templates or config files.

## Troubleshooting

- **`/watchdog` is missing:** it is registered only after a watchdog-enabled session wins the current root claim. Check that the package was built/loaded, restart or reload the appropriate Pi extension location, and use the root rather than an observer/stale session.
- **Project settings appear ignored:** verify the file is `.pi/pi-watchdog.json` below Pi's current working directory and that Pi trusts the project. The global file may live somewhere other than `~/.pi/agent` when `PI_CODING_AGENT_DIR` changes Pi's agent directory.
- **No status line:** the widget is TUI-root-only. RPC, print, JSON, headless, and observer sessions have no below-editor widget. The root's compact status is available through RPC status updates and through `/watchdog status` in a UI-capable root.
- **A threshold did not reset `active`:** that is intentional. A threshold only latches. Explicit `/watchdog reset`, `watchdog_control reset`, or a new root task reset the watchdog cycle; changing/restoring limits selectively rearms only thresholds whose measurements fall below their replacements. Limits preserve counters and elapsed time; none of these operations resets the automatic active window.
- **Observed total is lower than expected:** it is not a global process tree audit. Only same-process, watchdog-enabled, currently bound child sessions contribute.
