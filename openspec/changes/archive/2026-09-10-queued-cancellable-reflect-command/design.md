## Context

`/reflect` today: handler → `queueManualReflection` → `manualQueue.push` → `maybeDispatch` shifts and calls `beginReflection` in the same tick (`src/extension.ts:862-893`). `beginReflection` sends the inquiry via `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`. The plugin already tracks liveness with `probePiAgentState(ctx).busy` (`runtime.localBusy`, extension.ts:934) and already reacts to `agent_settled` (extension.ts:1250). Extension shortcuts register via `pi.registerShortcut(key, ...)`; Pi emits conflict diagnostics natively but offers no namespaced keybinding ids for extension shortcuts, so user key customization must come from the plugin's own config file.

## Goals / Non-Goals

**Goals:**

- Busy `/reflect` stays in `manualQueue` until settle; idle keeps immediate dispatch.
- Exactly-once dispatch per queued request, safe against repeated settle observations and runtime teardown.
- Cancel (shortcut + `/cancel-reflect`) removes only the pending request; active reflections and the ordinary run are never touched.
- Cancel key configurable via the existing config file, default documented, disable-able, invalid value falls back with a bounded diagnostic.

**Non-Goals:**

- No native host-queue integration (no `Alt+Up` restore-to-editor); that needs upstream Pi queue APIs and is a separate future change.
- No changes to the reflection protocol, folding, or continuation semantics.
- No queueing of automatic reflections; they keep current cooldown/latch behavior.
- No multi-request backlog: one pending manual request at a time.

## Decisions

- **Hold in `manualQueue`, gate `maybeDispatch` on liveness.** `queueManualReflection` keeps pushing to `manualQueue`; `maybeDispatch` only shifts when the plugin observes the agent idle (or when already idle at invocation). The existing `agent_settled` path calls `maybeDispatch` again after settle. Rationale: smallest diff on the current structure; `manualQueue` is already the single intake. Alternative (new separate queue structure) rejected as duplicate state for the same lifecycle.
- **Busy source: live `probePiAgentState(ctx).busy` at dispatch time, not event labels.** Matches the plugin's existing authority rule (`observe` at extension.ts:934) and the sibling plugin's contract: event names never assign busy/idle. Dispatch re-probes rather than trusting a cached flag, so a settle → new run race cannot dispatch into a busy window; if the re-probe shows busy, the request stays queued for the next settle.
- **Visibility via the existing status/widget surface, not a new TUI component.** Reuse the plugin's current footer-status mechanism to show `Reflect queued · <key> to cancel`, cleared on dispatch/cancel/teardown; when the shortcut is disabled the row names `/cancel-reflect` instead of a key. Rationale: no new UI concepts; `keyHint` is not available for extension shortcuts, so the key string is rendered literally from effective merged config — registration and display can never diverge from each other.
- **Cancel identity: the pending queue itself.** Cancelling clears `manualQueue` entries with manual origin (in practice the single queued request) and confirms; if an active reflection exists and queue is empty, notify "nothing queued". No request ids exposed to the user — one pending slot keeps the mental model trivial. Alternative (per-request ids + selective cancel) rejected: YAGNI for a single-slot queue.
- **Config shape: `cancelShortcut: string | false` in the existing config file, default `"alt+x"`.** String passes Pi's key format straight to `registerShortcut`; `false` disables. Validation mirrors existing config-loader diagnostics: non-string/non-false or unparseable key → warn + default. The plugin validates the key minimally (nonempty, parses as modifier+key form) and otherwise trusts Pi's own key handling and conflict diagnostics. Default `alt+x` chosen as mnemonic ("x-out"); final default is verified against built-in bindings in tasks before implementation.
- **Settle-handler identity guard (implementation finding).** `observe()` at the top of the `agent_settled` handler synchronously cascades through hub notification → `syncOwnership` → `maybeDispatch`. With a non-empty manual queue (a state this change introduces), that cascade dispatches the queued reflection *inside* the settle handler, which would then cancel the newborn reflection as a result-less active run. The handler captures `activeReflection` at entry and processes it only when the post-`observe()` value is identical; a reflection dispatched mid-handler is left for its own run/settle cycle. Shortcut registration happens once inside `session_start` after config load (verified: `emit` awaits handlers and Pi collects extension shortcuts after `session_start`, so config-driven keys land in time).
- **Registration timing: shortcut and `/cancel-reflect` registered once per session, always active.** Handler no-ops with a notification when the queue is empty. Registration never depends on queue state, avoiding register/unregister churn.

## Risks / Trade-offs

- Settle observed while another plugin immediately starts a run → dispatch re-probe catches busy and re-queues; worst case the reflection waits one more cycle, never dispatches into a busy turn.
- User reloads/replaces session with a queued request → pending state is runtime-only and discarded with the session, consistent with the plugin's existing lock/latch semantics; the queued status must be cleared on teardown to avoid a stale indicator.
- Shortcut conflict with a built-in or another extension → Pi's native diagnostics decide precedence; the plugin does not detect or rebind on conflict, and the status text may then name a losing key. Accepted: conflicts are loud by default and user-fixable via config.
- Config lives in the plugin file instead of `keybindings.json` → two customization surfaces for the user. Mitigation: README documents why (Pi exposes no namespaced ids for extension shortcuts) and the exact key format Pi accepts.
