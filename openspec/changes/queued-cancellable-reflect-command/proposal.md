## Why

Typing `/reflect` while the agent is busy starts the reflection immediately: Pi dispatches extension commands before its normal input queue, and the plugin's `manualQueue` is shifted into dispatch in the same tick. The user gets no visible queued state and no way to withdraw the request before the reflection turn begins. The desired behavior is a queued, cancellable manual reflection that works on stock upstream Pi, without fork-specific host changes.

## What Changes

- When the agent is busy, `/reflect` now enqueues a plugin-side pending request and shows a visible queued status instead of dispatching immediately; dispatch happens when the agent settles.
- When the agent is idle, `/reflect` keeps today's immediate behavior.
- A queued manual reflection can be withdrawn before dispatch via a configurable keyboard shortcut and a `/cancel-reflect` command; withdrawing never touches an already-active reflection.
- The cancel shortcut key is user-configurable through the plugin's own config file (Pi does not expose namespaced keybinding ids for extension shortcuts), can be disabled, and keeps Pi's native conflict diagnostics.
- Duplicate `/reflect` presses while one request is already queued are coalesced with a notification instead of piling up.
- No Pi core changes; the reflection protocol, XML contract, folding, and continuation semantics are untouched.

## Capabilities

### New Capabilities

- `manual-reflect-queue`: Queued lifecycle for user-invoked reflections while the agent is busy — visible pending state, settle-driven dispatch, and pre-dispatch withdrawal via configurable shortcut or cancel command.

### Modified Capabilities

None. Existing specs never required immediate dispatch for a busy manual `/reflect`, and post-completion continuation semantics are unchanged; the queue is entirely new behavior covered by the new capability.

## Impact

- `src/extension.ts`: command handler, `queueManualReflection`, `maybeDispatch`, `agent_settled` wiring, new cancel command and shortcut registration, queued-status surface.
- `src/config.ts` / `src/config-loader.ts`: new optional cancel-shortcut config field with validation and merge.
- Tests: command lifecycle, queue/coalesce, cancel-before-dispatch, cancel-never-cancels-active, config parsing, shortcut registration.
- README: documented queue/cancel behavior and configuration.
- No dependency, packaging, or protocol changes; no host/Pi version floor change.
