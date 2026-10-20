# Reflect private inquiry — final consumer contract

## Approved scope and ownership

Human decisions relayed in intercom `c420679e-7309-4487-82d1-09ce42b05059` replace inquiry-time native-slot reservation with non-blocking background work and restrict helpers to **read-only local evidence**. `d5cdf52c-13a8-4556-b973-b4a25dd4b028` requires immediate event-driven cancellation, not eventual stale discard. Coordinator accepted the source/currentness/accounting rules in `5814182e-4161-430e-9363-43964baab80b` and `efe5c6d5-1a11-4fc2-8aa5-180185715686`.

Order: Reflect requirements → utils shared module → Reflect adaptation → Continue adaptation → joint verification/coordinated pushes. Reflect production waits for the shared candidate. No host work, blanket parent-tool proxy, third-party helper, public bridge, duplicate executor or lane commit/push.

## Small shared Interface

Names below describe the contract; utils owns final exported names/types.

```ts
const source = captureQualifiedSource(parent); // freeze before async setup
const inquiry = openPrivateInquiry({
  source,
  profile: "local-readonly", // Continue uses "result-only"
  retryPolicy,
  signal,
  isCurrent,
  onActivity,
});
const outcome = await inquiry.inquire({ prompt, correction, validate });
await inquiry.cancel();  // revoke, abort exact child, drain
await inquiry.dispose(); // idempotent owned-resource cleanup
```

| Boundary | Required behavior |
| --- | --- |
| Frozen source | Native parent/session identity, qualified branch anchor/full ancestry, selected provider/model/thinking, provider registrations, cwd and effective context projection. Capture before any await. Anchor is latest replayable persisted entry; exclude an open tool batch, retaining all eligible ancestry. No replayable source yields typed setup failure; never wait for parent, abort it or use fresh/pruned fallback. |
| Local-readonly profile | Execute only SDK `read`, `ls`, `grep`, `find`, including reading the qualified parent session file. Native search may invoke its fixed rg/fd backend; no model-selected shell/command execution, external network research, third-party helpers or delegation. Inherited declarations grant no effects. Missing required binaries/capabilities fail explicitly; no silent tool installation or fallback. |
| File result | Host-owned designated regular file initialized/reset to `{}` after admitted writes drain; no-follow checks, own-response/write association, only one complete JSON object. A result-write response contains exactly one designated write and no helpers. Only that writer may write. |
| Bounds | Ten executed helper calls over one operation, shared across corrections. Three terminal attempts per inquiry. Helper-only progress is not missing result; terminal denials/text/invalid file are bounded. Entire mixed/unknown/alternate-path/over-budget batch suppressed before effects. Terminal write remains possible after helper exhaustion, without acknowledgement response. |
| Validation/policy | Consumer `validate` preserves Reflect's existing five fields, normalization and 16,384-code-point bound. Shared module chooses no verdict, durable report or continuation. Continue may authorize its own second inquiry in the same child; Reflect does not. |
| Retry | Consumer-selected native session/provider retry policy, not unconditional retry disable. Authoritative error/abort stays outside format correction and consumes no budget merely by occurring. Actual admitted helper executions remain charged. No ambient retry extension. |
| Outcome | Accepted typed candidate; exhausted invalid result; cancelled/stale; or setup/provider/filesystem failure. Temporary files are neither durable completion nor restart authority. |
| Activity | Exact child/operation identity and official idle/pending/working observation across model, tool, retry and settlement. Parent idle alone is insufficient. Observer errors do not mutate candidates or add calls. Reflect aggregates time and excludes owned child turns from ordinary loops. |
| Cancellation | Input signal works during setup and throughout execution. `cancel()` requests exact-child provider/helper abort immediately, drains/quarantines admitted work before reset/removal and is repeat-safe. `isCurrent()` before corrections and terminal acceptance is a backstop; false returns stale and cancels, never another correction. No unrelated parent abort. |

The shared layer does **not** own triggers, pending manual requests, thresholds/cooldown, source-revocation policy, history/report projection, durable receipts, hooks or main result delivery.

## Reflect lifecycle and currentness

1. Admit once; preserve automatic admission's existing reminder reset. Freeze source and launch background work without any main inquiry/wake message or parent wait.
2. Parent ordinary work continues counting. No additional automatic intent is latched while a reflection is outstanding.
3. Captured-source result remains current through ordinary same-ancestry assistant/tool appends, owned context-excluded metadata and native compaction. Do not compare latest leaf for exact equality.
4. Revoke on owner/session/cycle replacement, branch-navigation intent/change, anchor leaving active ancestry, native abort/shutdown, fresh interactive/RPC input, or new non-owned user input queued/delivered after capture. Input accepted before capture is detected at later user-message delivery. User-role alone never releases abort hold or grants human authority.
5. On observation, synchronously retire result/correction authority and abort its operation controller; invoke shared `cancel()` immediately. Do not wait for a model/tool to finish before discarding. Navigation intent conservatively cancels even if another extension later cancels the navigation; never revive the private operation.
6. On valid candidate, recheck currentness immediately before durable result and completion marker. Only after both records exist publish one hook and one feedback/continuation. Busy main: native steer at next eligible whole-turn boundary behind earlier messages. Idle main: deliver with turn triggering for exactly one ordinary request. No-result/failure/cancel/stale: no main message/request.

Already completed reports remain historical. Submitted successful feedback retains normal native residual effects after later abort; no queue clear/replay or retraction guarantee is added. `/cancel-reflect` remains pending-only, not an active-child kill command.

### Earliest cancellation observations on stock Pi 1.3.0

| Revocation | Observation / action |
| --- | --- |
| Fresh or queued main input | `input` before native queue admission. Abort immediately; preserve existing full-cycle reset for explicit interactive/RPC takeover. |
| Input queued before capture, later delivered | Non-owned user `message_start`; `before_agent_start` with user trigger is an additional fallback. |
| Session replacement / branch navigation | `session_before_switch`, `session_before_fork`, `session_before_tree`; confirm via `session_start`/`session_tree`; teardown via `session_shutdown`. |
| Owning native abort | Link current owning main signal where available; observe authoritative aborted main message/run outcome as backstop. Never use parent abort to cancel private work. |
| Owner/cycle transition | Invoke revocation synchronously in Reflect's existing ownership/reset transition callback, before releasing old authority. |
| Anchor no longer in active ancestry | Check on every received main lifecycle/session event and before correction/publication. Silent external tree mutations without a public event are detectable only at next observation/checkpoint; no immediate detection claim for unobservable changes. |

Stock source references: `dist/core/agent-session.js:1565,1749,1942` (input/steer/abort), `dist/core/extensions/types.d.ts:589-671` (session hooks), `:213-280` (context/signal), under `/home/xz/Code/ai/pi-continue-watchdog/node_modules/@earendil-works/pi-coding-agent/`.

### Stale accounting and retrigger limit

Keep admission's reminder marker/reset (`src/extension.ts:631-666`). Immediate cancellation/stale drain never rolls it back, resets subsequent parent progress, fabricates completed-report cooldown, reevaluates thresholds or launches a replacement. Explicit user takeover retains existing full-cycle reset (`:989-997`). Only a later fresh valid ordinary completion reaching current thresholds/cooldown can launch another inquiry. Repeated drop callbacks alone launch zero children. Active users may legitimately reach a future threshold; no promise of never reflecting again is made.

## Current verification scope

`background:` cases in `scripts/e2e/private-inquiry-feasibility.mjs` exercise actual stock1.3.0 SDK sessions, native tool execution/queues and provider/helper signals with synthetic providers. They cover parent progress/frozen source, busy/idle result delivery, failure silence, grep/find, immediate input cancellation with staged file nonacceptance, and existing pure branch accounting under stale cleanup. The delivery controller and valid candidates are fixture-owned; they do not implement or certify the shared executor's file/batch/budget machinery.

Exact command/results/hashes are in `PLAN/isolate-reflections-private-feasibility.md`. Shared candidate integration, all revocation-event combinations, installed distribution, actual TUI/gpt-6-luna behavior and human product acceptance remain pending. Former native-control-slot and generic extension-helper gaps are superseded, not new required host work.
