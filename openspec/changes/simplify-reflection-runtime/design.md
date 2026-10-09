## Context

See `proposal.md` for motivation and the six delta specs for behavior. A design is required because accounting, private child transport, lifecycle dispatch, configuration, and history reconstruction change together.

Current source has useful pieces but mixes their responsibilities:

- `src/extension.ts` already has the agent-produced-message allowlist and branch-derived cooldown. Ordinary `turn_end` increments process-domain counters, while domain subscriptions, ownership synchronization, and settlement can latch or dispatch automatic reflection. The widget has a separate rescheduled timeout; RPC status currently uses a longer interval.
- `src/collection-state.ts` owns elapsed-time accumulation, full/reminder resets, idle grace, explicit pause state, and a long-gap approximation. `src/process-domain.ts` owns aggregate participation, checkpoints, replay protection, and its own heartbeat. Duration accounting currently defaults to wall-clock time.
- `pi-extension-utils/pi-agent-state` probes the public `isIdle()` API. `pi-inquiry` sends through `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`. Keep these existing integration points rather than creating another scheduler or inspecting session files.
- Local stock-Pi development dependency is `0.99.2`. Existing saved native-queue evidence showed a cancelled queue slot driving an extra request even when its text was filtered. That evidence invalidates a zero-extra-request oracle for that earlier mechanism; it is not a test of this proposed implementation.
- The user's coordinated decision at 2026-10-08T13:04:57.734Z retains true-main-abort reset and explicit-input hold while selecting immediate native steering. The companion `yield-reflection-on-user-abort` change owns cancellation authority and re-entry. Its earlier busy-time plugin-custody alternative is not the selected design.

No code, README, formal model, main spec, or other change is modified by this planning workflow.

## Goals / Non-Goals

**Goals:**

- Separate observable activity, accounting windows, rendering, and permission to submit reflection.
- Give local and remote valid turn completions one explicit path to the current main's threshold decision, without treating every publication as a completion.
- Make history-derived values reproducible for the active branch while preserving existing full-cycle/reminder-cycle distinctions and child replay safeguards.
- Keep the abort hold orthogonal to working-state accounting; protect cancelled inquiry authority without promising control of Pi's private queues.

**Non-Goals:**

- No request-preflight host hook, custom compaction path, host patch, queue removal API, generic scheduler, or timer dependency.
- No observation of unrelated sessions, children without Reflect, or external CLI agents; no discovery of absent historical child sessions after domain destruction.
- No deletion of manual withdrawal controls, result schema changes, new user settings, automatic deployment, or editing another session's uncommitted work.

## Decisions

### 1. Keep three independent sources of state

Use live Pi probes for activity, Pi branch entries plus cycle boundaries for local loop values, and the current main's abort/inquiry state for submission authority.

| Concern | Source | Does not imply |
| --- | --- | --- |
| Time is counting | Any participating Pi agent is busy | Reflection is allowed during abort hold |
| A loop exists | A finalized eligible reply on the selected branch | A new live turn just completed |
| Automatic decision is eligible | Fresh valid completion, current main, no hold or outstanding inquiry | Main or children must be idle |
| Inquiry can accept `ref` | Current live, confirmed attempt identity | Any queued or cancelled prompt is authorized |

Remove the internal-reflection exclusion from the activity probe, not from the valid-loop predicate. Reflection, retry, compaction, and tools waiting on input can remain officially busy; this is deliberately not a measure of CPU usage or useful work. Keep native Stop and the companion's canonical main-abort detection, reset, authority revocation, and explicit-input re-entry.

Rejected: using a single `paused` bit for both time and abort permission. It would hide ongoing child activity and allow a clock transition to release a user stop.

### 2. Measure elapsed time; use the one-second pulse only as a wakeup

Use Node's monotonic `process.hrtime.bigint()` behind the existing injectable clock seam. Convert only for the existing millisecond accounting/display boundary and preserve sub-second remainder. Wall-clock timestamps remain appropriate for human-readable report dates, not durations. Never compare monotonic origins from different processes; the domain owner accounts aggregate elapsed time locally.

Retain one stable one-second accounting cadence per process domain and make displayed time/loop views follow that cadence. Do not clear and restart its deadline on every counter notification. At busy/idle edges, reset, and valid completion, settle a fresh snapshot immediately; a final idle/reset render is allowed so the display does not remain stale until work resumes. Publishing or rendering that snapshot does not evaluate reflection.

Before any path charges elapsed time, apply the same gap rule: if the previously counting interval has had no proof-of-life observation for more than the existing ten-second sleep gap, credit at most the normal one-second interval and rebase. Do not replay missed callbacks. This fixes the current mismatch between a one-second production heartbeat and a five-second sleep allowance, and prevents a post-resume child publication from charging the whole gap before the timer notices it. Shorter delays retain measured elapsed time, including their remainder. Idle-gap cycle reset remains its separate existing policy.

Rejected: `seconds += 1` per callback, CPU-time measurement, or a high-frequency precision library. The first drifts, the second excludes model/network/tool waits that Pi still calls work, and the third cannot run JavaScript while the event loop is blocked. [`driftless`](https://github.com/dbkaplun/driftless) repeatedly schedules ahead of a deadline; it does not identify suspension. [Node timers](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args) do not promise exact callback timing; [high-resolution process time](https://nodejs.org/api/process.html#processhrtimebigint) supplies duration measurement. Long stalls can still be classified as suspension; that approximation is accepted, not a real-time guarantee.

### 3. Derive loops through Pi APIs and retain only necessary boundaries

Read `ctx.sessionManager.getBranch()` rather than raw JSONL, all file entries, or compacted model context. Reuse `isAgentLoopMessage()` for root/all/active loops and cooldown. One finalized assistant reply is one loop even with multiple tool calls; a reply can be visible in history before its tool batch finishes, but only the later valid `turn_end` authorizes an automatic decision.

Start with straightforward branch scans on the one-second refresh and fresh completion boundaries. An implementation can reuse an unchanged derived view, but a callback count is never authoritative and no custom parser, watcher, transcript index, or separate transcript store is added.

Use branch entry identities as window anchors. Reuse an existing unambiguous user/reset boundary where available. Some existing resets, notably consuming an automatic threshold during cooldown and an idle-gap reset, have no reconstructible message of their own. Record only the necessary versioned full/reminder boundary metadata through `pi.appendEntry()` for those cases. Do not persist elapsed time or a cumulative loop ledger. Navigation chooses the markers on the selected branch, not a process-global remaining-loop value.

For pre-change sessions lacking such markers, reconstruct from the latest unambiguous structured boundary available, falling back to the ordinary-user boundary or branch start. Do not parse prompt text to invent a lost reset. Exact old in-memory cooldown-skip/idle-reset positions were never persisted and cannot be reconstructed retroactively. Rehydration itself never triggers reflection, and new user input resets the window normally.

Each child derives only its own contribution after its attachment/cycle baseline, excluding inherited fork ancestry. The owner preserves already accepted child work for the current domain lifetime, even after a child exits. Destruction of the entire domain does not create a new obligation to reopen departed children's history files.

Rejected: continuing to increment loop totals from callback arrival, scanning physical transcript lines, or treating every leaf change as navigation. They respectively duplicate/replay counts, mix branches, or clear the clock on ordinary conversation.

### 4. Separate live completions from checkpoint repair

Keep the current shared process domain and its enrollment, authenticated sender binding, incarnation/generation checks, receipts, cumulative sequencing, and bounded replay retention. Replace each attachment's event-only count source with its Pi-derived snapshot and window baseline; retain monotonic transport coordinates within a contribution scope. A branch rewind or scope change rebases under a fresh fenced scope, rather than sending a negative delta through a monotonic protocol.

Carry live turn-completion identity separately from an ordinary state publication, using the existing private transport. Correlate it with the contributing attachment/session incarnation, accounting scope, finalized message entry, and accepted snapshot sequence. Apply its count update before notifying the current main. Duplicate delivery is considered once; a sync/reconnect baseline can repair counts but cannot create a live completion. Do not save an offline automatic-intent queue for later replay.

Reset transactions must advance/fence the relevant window and establish child baselines before reentrant notifications can evaluate it. Delayed pre-reset updates cannot repopulate a new budget. Preserve live busy contributors across accounting reset; this is not a pause generation that empties all participation. Offline membership still removes busy contribution promptly and does not freeze unrelated work.

A wire change is limited to the watchdog's private accounting protocol, not Pi or the inquiry format. Version it if the new completion/scope distinction changes acceptance semantics, and use coordinated fresh-domain rollout rather than silently claiming mixed-version compatibility. Preserve the separate load-order-independent enrollment fix; do not use extension load order as a workaround.

Rejected: deriving a trigger from `allLoops` increasing in a general subscription. A replay or history rebuild can increase that value without a new live turn, which would reintroduce delayed automatic work.

### 5. Evaluate and submit from a fresh completion, without an automatic waiting slot

Route main and child completions to one current-main decision path:

```text
Pi valid turn_end --> validate current scope + deduplicate
                 --> refresh Pi-derived counts + settle clock
                 --> held / outstanding inquiry? --> stop
                 --> any current threshold reached?
                              |
                             yes
                              |
                 consume reminder window + apply cooldown
                              |
                 reserve inquiry synchronously
                              |
                 native steer, triggerTurn: true
```

Check ownership and hold before creating intent. Preserve existing reminder consumption during cooldown, but do not retain a skipped request. Reserve the inquiry before any reset publication or other reentrant effect can create a second one; recheck scope after any necessary asynchronous boundary. A later valid completion evaluates the then-current counters rather than an earlier captured reason.

Remove automatic latching/dispatch calls from timer handlers, generic domain subscriptions, ownership notifications, and `agent_settled`. These paths still do their necessary accounting, display, lifecycle, and manual-queue work. Keep one active inquiry and the existing single coalescing manual waiting slot, including withdrawal-only `/cancel-reflect`, configured shortcut, and queued hint. Do not make the user's manual command wait for a valid ordinary turn.

Do not add `anyBusy` or `mainIdle` as automatic submission guards. A valid final turn may cause a new request, and a child's completion may wake a normally idle main. Conversely, a real main abort retains its explicit-input hold: no child completion, timer, stale result, or background-started main run releases it. New interactive/RPC input or a new `/reflect` resets the cycle before release. Held completions are discarded as decisions, not saved for that release.

Rejected: the earlier request-preflight approach and busy-time plugin custody. The user selected `turn_end` plus immediate native steering, including its cancellation trade-off. `turn_start` is also too early to rely on a newly delivered user-message reset.

### 6. Keep cancellation authority; narrow only native queue guarantees

`yield-reflection-on-user-abort` supplies true-abort ordering and authority cleanup. Preserve it when removing counting-pause machinery. A terminal abort is cancellation without an invalid-response warning or reask. It must not be rewritten into correction or successful completion. Pending manual/automatic work and uncommitted staged results owned by the cancelled work are discarded under that contract. Only a non-cancelled valid result with both result and completion marker durably recorded authorizes a new plugin-issued ordinary continuation. Valid parameters or staged data alone do not. Already completed reports and published hooks remain historical effects and are neither retracted nor repeated by later abort.

Fold the exact owned cancelled inquiry, correction, and tool context so it is not live reflection in subsequent requests. Do not erase historical sessions or lose, duplicate, or reorder unrelated user text, images, or extension messages. Reuse the companion's source-filtered re-entry, reset-before-release, and stale-event fencing rather than defining a second permission state machine.

Immediate `steer` transfers custody to Pi. The watchdog has no selective public queue-removal API. A residual native slot, including an already-submitted continuation or wake, can cause an ordinary provider request, charges, or ordinary tool execution after re-entry even when its reflection instructions are neutralized. Revoking the old inquiry prevents it authorizing a new plugin-issued continuation, correction, result, or completion hook; it does not physically remove an old native continuation or undo unrelated/native work or tool effects already executed.

The saved stock-Pi trace and `/var/tmp/abort-repair-gpt/parent-native-queue-finding.md` show why request totals need attribution: fresh input and an unrelated message shared one request, leaving a later request attributable to the cancelled slot. The old expected-total oracle was false-positive. Future integration checks must inspect actual request contents, delivered inputs, exact inquiry identities, and newly submitted owned messages, not demand zero residual requests or count one request per logical input. Those saved files are diagnostic evidence, not a required repository test dependency.

Rejected: silently restoring zero-extra-request guarantees, treating `isIdle() === true` during settlement as safe queue custody, or removing the abort hold because physical queue removal is unavailable.

### 7. Keep requirement ownership and implementation slices explicit

Coordinate the two changes without editing each other's files. Finalize one owner for each full replacement before synchronization:

| Requirement group | Owner |
| --- | --- |
| Existing user-message/terminal-abort/takeover requirements; abort precedence and reask; manual queued visibility and host/public cancellation constraints | `yield-reflection-on-user-abort` |
| New accounting and live main/child turn boundaries; navigation reset addition; immediate manual steering; non-aborted invalid-owned correction | This change |
| `conversation-grounded-reflection` / `Existing lifecycle and compatibility remain intact` | This change supplies the combined full replacement, incorporating the companion's reviewed abort constraints |

No sync/archive is part of this task. The companion's finalized contract and shared-worktree writer ownership must be checked before implementation. An in-progress partial source tree is evidence to inspect, not a license to overwrite another writer's work.

Deliver in bounded slices: first history/window derivation, then aggregate clock and pause removal, then live completion dispatch with native steering, then coordinated integration/documentation. Use the existing fake-clock, runtime, coordinator, and stock-Pi controlled-provider harnesses. No new framework or live model credentials are needed.

## Risks / Trade-offs

- [Long event-loop stalls look like suspension] -> Document the ten-second heuristic and bounded credit; test normal delay, long gaps, and the first non-timer event after a gap. Do not claim exact suspend detection.
- [Branch scans cost more on very long sessions] -> Keep one-second sampling and fresh-boundary scans; measure before adding an index or incremental parser.
- [Old histories lack exact former reset positions] -> Use only structured Pi evidence and a documented fallback; never rewrite history or fabricate elapsed time.
- [Stale child data or replay becomes a false trigger] -> Separate snapshot repair from live completion, fence scopes, deduplicate entry identity, and test duplicate/reconnect/navigation races.
- [Child work after main abort wakes reflection] -> Check the existing hold at the sole owner submission path and after asynchronous handoffs; keep the normal-idle child wake as the positive control.
- [Counting-pause removal accidentally removes cancellation] -> Keep hold, inquiry identity checks, `/cancel-reflect`, `cancelShortcut`, and queued hints in the acceptance matrix.
- [Native retained messages incur work after abort] -> Explicitly disclose the accepted request/cost/ordinary-tool risk; verify revoked inquiry authority rather than an impossible queue-removal guarantee.
- [Overlapping change deltas revert each other] -> Compare final requirement headings/full replacements before integration and eventual sync; never archive two conflicting versions by order alone.

## Migration Plan

Implementation updates source, the existing tests, README, and the affected Lean lifecycle/activity models only after a separate apply request. Models must distinguish active-time accounting from the abort permission hold and prove their declared scheduling/reset properties; a gap heuristic must not be presented as proof of real-world sleep detection.

Remove the supported `hookPauses` configuration field, exported pause types, semantic-hook subscriptions, and counting-pause bridge/state. Obsolete settings use existing bounded diagnostic behavior; do not edit global or project user configuration automatically. Keep the completion semantic hook and manual cancellation configuration.

If private wire acceptance changes, update all participating watchdogs in a fresh process domain under a separately authorized rollout. Do not hot-reload or restart the user's active session from this planning task. A rollback uses the prior package in a fresh domain; old readers can ignore new non-context boundary entries, and reports/history are not rewritten. Clocks intentionally start at zero after runtime/session replacement.
