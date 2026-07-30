# pi-watchdog v1 Acceptance Contract

Status: clean recovered baseline commit 1 is `7eed6ed0e2eea12f4cc0143337b97944e673d097`; the stock-Pi E2E/documentation candidate is pending as the planned second commit. Nothing is accepted, merged, or published after the recovered baseline. Final verification must include checks, tarball install/import, Pi RPC command discovery, trusted/untrusted config smoke, license/package metadata, reviewer TUI proof, bounded process-tree cleanup, and the real one-minute wall-clock warning.
Language: English
Product authority: repository owner

## Story

**Actor:** A user running autonomous Pi agents.

**Need:** The user needs the main agent to notice excessively long or repetitive work, including the observable contribution of child sessions, without interrupting child agents.

**Value:** The agent can deliberately reassess stalled or circular work instead of continuing indefinitely.

## Scope

### In scope

- Count one loop for each completed Pi turn: one assistant response plus all tool calls/results produced by that response.
- Main-agent loop limit: built-in default `100`.
- Observable task loop limit: built-in default `500`, counting main turns plus turns reported by watchdog-enabled sessions in the same process.
- Main-agent continuous-active wall-clock limit: built-in default `30` minutes.
- Main-only warnings; observer/child sessions are never warned, steered, stopped, or timed by the watchdog.
- Layered global and trusted-project configuration.
- Three user-configurable English reminder templates.
- Runtime counter/limit control by the main agent.
- Runtime prompt overrides by a user command only.
- A dedicated below-editor TUI status line for the TUI root, showing the automatic activity window and the current watchdog cycle counters.
- A user-only TUI notification when an automatic transition resets a begun activity window.
- No dependency on any subagent or other Pi plugin.
- Root classification prefers a UI-bound session in interactive mode. In headless/non-UI mode, the first bound watchdog session is the documented best-effort root fallback because Pi exposes no public root/session-kind field.

### Out of scope

- Guaranteeing visibility into isolated, watchdog-disabled, remote, or out-of-process agents.
- Controlling subagent completion or changing another plugin's turn limits.
- Persisting runtime overrides across process restarts.
- Allowing the watched AI to rewrite its reminder prompts.
- Triggering a new model turn solely to deliver a warning.

## Stable acceptance seam

Acceptance tests exercise the exported Pi extension factory through a fake `ExtensionAPI` and public lifecycle/tool/command registrations. They observe custom messages, notifications, statuses, tool results, and editor calls rather than private controller fields.

Pure configuration/template functions may also have focused unit tests because malformed config and placeholder rendering are technical boundaries beneath the public extension seam.

## Agreed examples

### A1 — Main loop boundary

Given a new root task with built-in defaults,
when the root session completes its 99th turn,
then no main-loop warning is delivered.

When it completes its 100th turn,
then the triggering 100-loop status is captured, the whole watchdog cycle resets, and exactly one main-loop warning based on that captured status is delivered to the root model and user.

The warning-triggered continuation is root loop 1 of the fresh cycle; it does not repeat the warning.

### A2 — Observable total boundary

Given a root task with 80 completed root turns,
and watchdog-enabled observer sessions contribute 419 completed turns bound to that task,
when one more observer turn completes,
then the root receives exactly one observable-total warning at 500 turns.

The observer receives no warning or control action.

The warning describes the total as observable rather than complete coverage.

### A3 — Main-only wall clock

Given the root agent becomes active,
when 30 continuous minutes elapse before `agent_settled`,
then the root receives exactly one wall-clock warning.

Given only observer sessions remain active after the root settles,
then the root-only wall-clock timer freezes, no observer is warned, and the automatic active window continues until the final bound-running observer settles.

### A4 — Root user messages define task windows

Given an active task with accumulated counts and runtime overrides,
when a new root `user` message starts, including one inserted by another mechanism,
then counters and warning latches reset and configured defaults become effective.

A custom message does not reset the task.
A user message inside an observer session does not reset the root task; it binds that observer to the current root task.

### A5 — Old observer work does not contaminate a new task

Given an observer is bound to root task A,
when a new root user message starts task B,
and the old observer later completes another turn,
then that turn is not added to task B.

When the observer receives a new child-session user message during task B,
then subsequent observer turns are bound to and counted in task B.

### A6 — Runtime AI control

Given the root agent calls `watchdog_control` with `status`,
then it receives current root, observable-child, observable-total, wall-clock, limit, warning, and coverage information.

Given it calls `reset`,
then counters and warning latches reset without stopping any agent; if the root is active, its wall-clock restarts; the control-call turn subsequently counts as the first root turn in the reset window.

Given it calls `set_limits`,
then supplied limits must each be positive JavaScript safe integers; invalid or unsafe values reject the whole request without changing any limit. Valid limits change only for the current task, preserve counters and elapsed time when no threshold is crossed, selectively rearm a threshold after its measurement is below its replacement limit, immediately evaluate the replacement limit, and never modify a configuration file. If that model-facing evaluation crosses one or more thresholds, one pre-reset status is captured, the full warning cycle resets to configured limits and prompts, and one combined reminder is delivered from the captured status.

Given it calls `restore_defaults`,
then configured limits become effective without resetting counters or elapsed time unless the immediate model-facing evaluation crosses a threshold, in which case the same capture/reset-before-delivery rule applies.

The tool has no prompt-mutation action.

### A7 — Layered configuration and custom prompts

Given built-in defaults, a valid global config, and a trusted-project config,
then fields merge independently in that precedence order.

Given an untrusted project,
then its config is ignored.

Given malformed JSON or invalid field values,
then valid lower-precedence values remain effective and the user receives a bounded warning rather than startup failure.

Configured prompt templates support documented literal placeholders and unknown placeholders remain literal.

### A8 — User-only temporary prompt control

Given the user invokes `/watchdog prompt main`, `/watchdog prompt total`, or `/watchdog prompt time` in a UI-capable root session,
then a multiline editor opens with the effective template and a saved value overrides that prompt for the current task.

`/watchdog prompt show` displays effective templates.
`/watchdog prompt reset <kind|all>` removes temporary overrides.

The next root task restores configured templates. Observer sessions expose no user-control command.

### A8.1 — User command grammar and lifecycle safety

Given the current watchdog root invokes `/watchdog`, `/watchdog status`, `/watchdog reset`, `/watchdog limits`, `/watchdog limits <main> <observed> <minutes>`, `/watchdog limits reset`, or the documented prompt subcommands,
then the command is user-only: it reports through the command UI, never sends a user/custom model message, and never triggers an LLM turn.

`/watchdog reset` resets only the current watchdog task cycle (counts, task wall-clock, and latches), retaining current limits and temporary prompts while leaving the A11 active window untouched and emitting no automatic active-reset notification. Limit changes and restores immediately evaluate current values but remain UI-only: they may notify the user, never send or steer a model message, and do not reset the cycle merely because the user changed a limit. Malformed, incomplete, extra, zero, negative, fractional, unsafe, or unknown arguments report useful English usage and leave state unchanged.

The command is dynamically registered only after a session wins the root claim. Observer attachments expose no command. Pi has no public command unregistration, so a demoted attachment can retain an inert registered definition, whose handler validates current root generation and context before changing anything. A prompt editor is unavailable without a UI-capable root and leaves state unchanged; saving an empty template is rejected, and `/watchdog prompt reset` is the explicit removal path.

### A9 — Warning delivery does not create loops

Given a threshold is reached while the root is active,
then a custom watchdog message is delivered for immediate reflection at Pi's next safe steering boundary with `triggerTurn: false`.
The watchdog never aborts, cancels, or interrupts tool calls already running; Pi first lets the current assistant turn's tool calls finish, then consumes the steering message in a normal continuation assistant turn. Because the model-facing warning reset the cycle before delivery, the continuation counts as loop 1 under the restored configured limits rather than recursively retriggering the old crossing.

Given a threshold is reached while the root is idle because of an observable observer turn,
then the user is notified and the model message is queued for the next turn without waking the root.

Watchdog warnings are custom messages, never user messages, so they do not create a new user task. Before delivery, the watchdog captures the triggering status and resets the full watchdog cycle; the reminder is rendered from the captured values while the live cycle already shows zero. An active steering warning intentionally causes Pi to produce a normal continuation turn as loop 1 of the fresh cycle; an idle `nextTurn` warning does not wake the root.

### A10 — Lifecycle cleanup

On root `agent_settled`, the root-only wall-clock timer stops. The live ticker and automatic active window remain open while any current-epoch bound observer is still running; the final participant settle closes them.
On root `session_shutdown`, root timers, statuses, and the root attachment are cleaned up. Observer cleanup is best-effort because current Pi embedders may directly dispose child sessions without emitting `session_shutdown`; counting correctness therefore relies on observer attachment tokens, root generation, and task-epoch validation rather than cleanup delivery.
On `/reload`, the old context is never reused; the replacement root adapter can safely attach to the process-local hub.
On `/new`, `/resume`, or `/fork`, the replacement root starts a fresh task state rather than joining the previous session's task.

### A11 — Dedicated TUI status line and activity reset

Given the TUI root becomes active at 0 seconds, completes 137 root turns, and reaches 2h14m of paired root activity,
then the dedicated below-editor widget shows the live one-line status, for example:

`Watchdog | active 2h14m/137 loops · task 12m40s/30m · root 37/100 · observed 128/500`

`active` pairs elapsed supervised-work time with completed root turns for the current automatic activity window. It excludes observer turns and fully idle time, but continues while any current-epoch watchdog-observable child runs after the root settles. `task` is the current watchdog/manual-reset cycle's accumulated root-running time against the wall-clock limit; child-only gaps do not increase it. `root` and `observed` are the current-cycle root and root-plus-observable-child turn counts against their limits; `observed` never claims complete coverage.

An automatic activity reset occurs only when the final current-task participant reaches `agent_settled`/stops, or when an interjecting/new root user message replaces a currently active window. Root settle removes only root participation; bound-running observers keep the window open. Active time and active root-loop count clear together, stay zero while fully idle, and start from zero when the next root task actually starts. Session shutdown/demotion clears state and resources without reusing a stale UI context.

When an automatic transition resets a begun window, the pre-reset snapshot is emitted exactly once as a user-only TUI info notification, for example:

`Watchdog reset | active 2h14m/137 loops`

The notification uses neutral wording only: Pi exposes no reliable public user-abort provenance, so the watchdog never labels a window completed or aborted and never displays token speed. The notification never enters the model context (`ctx.ui.notify` only, never `pi.sendMessage`) and never triggers a turn. After it, the widget may silently show the idle zero state until the next root task restores the live format.

Reminder threshold crossings, AI `watchdog_control reset`, user `/watchdog reset`, and limit restore/set operations never reset `active` and never emit the reset notification. A model-facing threshold crossing captures the old status and resets current-cycle `task`, `root`, `observed`, latches, runtime limits, and temporary prompts before delivery; manual resets retain current runtime limits and prompts; slash limit operations remain UI-only. An interjecting root user message that already reset the window causes no duplicate when the later `agent_settled` arrives, and no notification is emitted when no active window existed.

Only the current root in `tui` mode renders the widget; RPC, print, and json modes and observer sessions get no widget and no widget ticker. The widget replaces the watchdog footer status in TUI so the status never appears twice. It renders at most one line, truncates to the terminal width through the real component, uses restrained theme color, refreshes at about one second while active, and stops refreshing while idle.

## Implementation slices

1. **Configuration core:** package baseline, config validation/merge, prompt templates, and task-state rules.
2. **Runtime watchdog:** process-local root/observer hub, lifecycle events, main-only timers, warnings, and model tool.
3. **Dedicated TUI activity status:** the below-editor status line, activity-window reset notification, mode-specific refresh lifecycle, and compact root status fallback for non-TUI root UI modes. **Merged.**
4. **User controls:** `/watchdog` user controls and current-task prompt editing. **Merged.**
5. **Stock-Pi E2E, documentation, and package verification:** English README, BSD 3-Clause `LICENSE` and package metadata, source/release branch install reference, bounded external release-tree generation, full checks, process-tree cleanup proof, and package smoke test. **Candidate pending final approval/publication:** final evidence must cover `npm run check`; packed artifact inspection and isolated install/ESM import; source and release Git install through stock Pi; Pi RPC command discovery; pseudo-TTY idle widget/reviewer proof; trusted/untrusted config-path smoke; no leaked Pi/test descendants; and the real one-minute wall-clock warning.

The recovered baseline is commit 1 (`7eed6ed0e2eea12f4cc0143337b97944e673d097`). Slice 5 is the pending commit-2 candidate and is not accepted, committed, merged, or published. Supersede any prior temporary smoke output with the final factual run before requesting acceptance.
