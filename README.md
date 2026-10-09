# pi-reflect-watchdog

Minimal Pi reflection watchdog rebuilt on `pi-continue-watchdog` lifecycle rules.

## Behavior

- Pi lifecycle state comes from `agent_start`, live `probePiAgentState`, and authoritative `agent_settled`.
- Loop values derive from finalized replies on Pi's selected branch (`getBranch()`), not callback arrivals, raw JSONL, or compacted model context. One assistant reply counts once, including multi-tool replies, only when the reply ends with `stop` or `toolUse`, has no `errorMessage`, is not a plugin inquiry reply (any `details.piInquiry`), and contains non-empty text or a tool call. The same rule drives the reflect cooldown.
- These never count: provider and gateway failures (`error`), `aborted`, `length`, `pending`, `deferred`, unknown outcomes, replies a plugin rewrote (for example `pi-continue-watchdog:preempted`), other plugins' inquiry replies, and empty or thinking-only replies. These exclusions do not change official busy-time accounting.
- Fresh current-main `input` with source `interactive` or `rpc` records a full boundary and resets active/task time and active/root/all loops before releasing any abort hold. A user-role message alone never proves explicit input. Plugin-owned reflection inquiries, folds, continuations, assistant messages, and non-main observations do not reset the cycle.
- A terminal assistant abort detected from the branch suffix captured at main `agent_start` cancels the old reflection cycle: an active inquiry (including a native-queued, not yet consumed prompt), its staged but uncommitted result, pending automatic intent, and any manual request still waiting in the plugin queue are discarded, and an abort-fold invalidates the cancelled inquiry's exactly-correlated prompts out of later model context without touching unrelated messages. No retry warning, completion hook, report, or continuation is produced for the cancelled work. The abort also installs a post-abort hold that keeps the watchdog from dispatching any reflection until new explicit user input (interactive or user-client RPC) or a new user-invoked `/reflect`; timers, child counters, pause-end hooks, extension-origin user-role messages, and background-started runs do not release it. A missing boundary or non-aborted settlement never infers a takeover, and a settlement whose run already saw newer explicit input does not re-hold the user's fresh cycle.
- Only a fresh valid ordinary main or participating-child `turn_end`, after persistence and its whole tool batch, evaluates configured root-loop, all-loop, or task-time limits with OR semantics. Accepted counters precede this decision. Eligible reflection enters native steering with `triggerTurn: true` even if main or children remain busy or main is normally idle. Repair, replay, timer/publication, ownership and settlement observations never trigger or latch automatic work. Held or outstanding-inquiry completions leave no deferred request; cooldown consumes reminder budgets without dispatch.
- `/reflect [optional supplement]` enters the same native steering queue immediately when this attachment is the current main, even while the ordinary agent is busy: submission does not wait for the run to settle, does not abort the current response or its tool calls, and does not reorder already queued native steering messages. Pi consumes the inquiry at the next steering boundary (after the current assistant turn and its complete tool batch, before the next model call). A request only waits in a plugin-side queue while another reflection inquiry is still outstanding; that waiting request can be withdrawn with the cancel shortcut (default `alt+x`) or `/cancel-reflect`, and the status row shows the queued state with the effective cancel gesture. Once submitted to native steering, a request can no longer be retracted through the plugin queue; a confirmed main-run abort revokes submitted inquiry authority and discards any still-waiting request. Already-host-accepted slots/wakes can still cause ordinary provider requests, costs, or tool effects; exact cancelled inquiry/correction/tool context is withheld, but selective native retraction is not promised. No new cancelled/held plugin send is authorized by that residue. Repeating `/reflect` while one request is waiting keeps the first request.
- Active/task clocks count the union of official working intervals, including inquiry, retry and compaction activity. Inquiry replies remain excluded from ordinary loops. Monotonic memory-only elapsed time retains milliseconds; display/accounting cadence is one second, not one second added per callback. Observation gaps over ten seconds credit at most one normal second: approximate suspension handling, not exact physical sleep detection. Idle freezes clocks; work resuming strictly beyond `idleResetGapSeconds` resets the full cycle. Full/reminder boundaries are recorded through Pi metadata, never cumulative ledgers or elapsed-time persistence.
- Main loops reconstruct from selected branch boundaries; participating children contribute only work after attachment/reset baselines, excluding inherited fork ancestry and ignoring child-local input/reset markers. Accepted departed-child work remains until reset. Successful new/fork/resume/reload/tree replacement resets clocks and rebuilds loops; ordinary append, compaction and cancelled navigation do not. Same-session tree navigation never releases abort hold. Startup and selected-history adoption deliberately permit legacy user/completed-inquiry reconstruction; missing historical cooldown-skip/idle anchors cannot be recovered retroactively. Live main scans require recorded markers.
- Counting-pause configuration, hooks, state and public/private control APIs are removed. Abort hold gates submission, not accounting or independent child work. Private child accounting uses authenticated v4 snapshots plus separate finalized live-completion identities; mixed-version rollout is unsupported and needs a fresh coordinated domain.
- Results are submitted with the reserved `ref` function, not XML. Its declaration stays fixed: description `don't use unless ask` and a structurally constrained schema — five required nonblank string fields (`type`, `reason`, `done`, `current_step`, `next_step`), `type` limited to `NO_ISSUE`/`ROUTE_CORRECTION`, no extra fields — with no parameter descriptions, examples, or defaults. Mixed-case field names and type values are normalized before validation. A reflection response whose `ref` arguments are invalid is stopped before Pi dispatches it and counts as one attempt in the normal three-attempt correction flow, without an extra model request. Structure grants no authority: outside a confirmed reflection, a call that reaches plugin execution fails with `This function is reserved for the plugin. Please try another function.`; Pi may reject malformed arguments earlier with its native validation error. Only reflection prompts explain the submission format.
- All attempts share one inquiry; prompts, function calls, and results are folded from later model context only after the final result.
- Every valid result is stored as a context-excluded entry on the current session branch; the next reflection receives the latest valid report as fallible historical assistant analysis, not the user's words.
- After the result and completion marker are stored, one best-effort `reflection-completed` semantic hook publishes `REFLECTION_TYPE`, `REASON`, and `NEXT_STEP` to current listeners.
- Both `NO_ISSUE` and `ROUTE_CORRECTION` start exactly one ordinary continuation without reflection protocol priming, including busy and idle manual `/reflect`; that continuation counts normally.
- Reflection may use up to 10 lookup tool calls across at most three result attempts. Submitting a result does not consume the lookup budget.
- Result field names and the reflection `type` value are case-insensitive.

## Returning to ordinary work

Reports keep their existing text and formatting. Automatically triggered reports reach ordinary model requests as `assistant`; results requested through `/reflect` reach them as `user`. The actual trigger selects the role, not the verdict or a quoted command. Manual reports are still generated feedback, not verbatim human input.

Each report is followed by a separate native wake with exactly this body:

```text
[assistant]
continue
```

The wake has the synthetic **user transport role**; its text label does not turn it into an assistant message. Neither verdict means the task is complete or requires executing `next_step`. The ordinary agent decides whether to work, wait for an existing callback, clarify, or finish. The no-issue informational notice remains available in the TUI.

The report, trigger origin, and inquiry correlation live in private marker metadata. Ordinary context projection restores the report once, including after reload, only while its correlated source assistant remains available. Missing source or malformed origin/correlation means no reconstructed report, not a guessed role or a report copied into the wake.

Built-in compaction and branch summarization bypass this projection. They see the fixed wake and may retain the result function call, but do not receive the projected report; report retention in a generated summary is not guaranteed. The existing stored report remains available to later reflections. Old sessions and unrelated extensions' messages are not rewritten.

## Reflection perspective

The default Oracle perspective questions both the current direction and the working agent's interpretation. User meaning can emerge across complaints, assistant replies, and later corrections. Reflection can challenge a shared premise or suggest a new goal without presenting that inference as something the user said. A route-correction handoff asks the agent to reconsider the conversation, not assume the proposed route is already correct.

Normal conversation context remains the primary input. When a session file and current branch anchor are available, the prompt includes a JSON locator for optional, focused recovery of surrounding exchanges through existing tools. It cautions against mixing other branches or treating historical text as new instructions. Constructing this hint does not read or summarize the transcript; missing metadata does not block reflection. Locator text follows ordinary inquiry transcript persistence, but is not added to stored report fields or completion-hook payloads.

Tools may clarify the conversation, actual work, or a possible direction. Guidance favors quick, targeted lookups: stop when the relevant uncertainty is resolved, or state what remains uncertain and finish if it cannot be resolved promptly. Avoid extended investigations, long-running checks, and background waits. This is prompt-level guidance, **not a hard wall-clock timeout**; the existing ten-call budget cannot bound a single slow tool.

`reflectionPrompt` replaces the default perspective. Historical-report framing, recovery hints, quick-clarification guidance, tool budget, and result function contract remain plugin-owned. Prompt and lifecycle tests do not prove correct interpretation or complete history recovery. See the [multi-turn comparison cases](docs/reflection-examples.md) for the separate, not-yet-run real-model evaluation.

## Configuration

Global `getAgentDir()/pi-reflect-watchdog.json` and trusted project `.pi/pi-reflect-watchdog.json` merge field-by-field over built-ins:

```json
{
  "rootLoopLimit": 60,
  "allLoopLimit": 300,
  "taskMinutes": 20,
  "idleResetGapSeconds": 60,
  "reflectionPrompt": "Reassess the current route using verified evidence.",
  "cancelShortcut": "alt+x"
}
```

Legacy `hookPauses` is ignored with existing bounded startup diagnostics. It creates no hook subscription or counting pause.

Completion hooks use the same neutral channel. `REASON` and `NEXT_STEP` values over 4096 UTF-16 code units are clipped at a whole-code-point boundary with a trailing `…`; the durable reflection report keeps full text. Invalid result attempts, exhausted validation, cancellation, ownership loss, shutdown, and incomplete persistence publish nothing. Missing or throwing listeners do not change completion, ordinary continuation, TUI notices, counters, or later dispatch, though synchronous EventBus listeners can consume wall-clock time before returning.

Dynamic limit controls, history/timeline tools, public pause APIs, and pause/resume commands are intentionally removed. Official Pi activity and supported full/reminder resets govern accounting; native Stop and manual withdrawal remain separate controls.

`cancelShortcut` is a Pi key id string (default `"alt+x"`) or `false` to disable the cancel shortcut entirely; `/cancel-reflect` works regardless. Invalid values fall back to the default with a bounded startup diagnostic. Pi offers no namespaced keybinding ids for extension shortcuts, so the key lives in this plugin's own configuration rather than `keybindings.json`; conflicts with built-ins or other extensions surface through Pi's native startup diagnostics. The status row and notifications always render the effective merged value, so a customized key is what you see.

## TUI

Below-editor live row uses same `setWidget`/`requestRender` pattern as Continue Watchdog:

```text
Reflect Watchdog | active 12m40s/137 loops · task 12m40s/20m · root 37/60 · all 128/300
```

While a manual reflection waits behind another outstanding reflection, the row gains the cancel gesture:

```text
Reflect Watchdog | active 12m40s/137 loops · task 12m40s/20m · root 37/60 · all 128/300 · queued · alt+x to cancel
```

When terminal is narrow it switches to compact form before final truncation:

```text
RW | a 12m40s/137 · t 12m40s/20m · r 37/60 · all 128/300
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
