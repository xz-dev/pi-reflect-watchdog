## 1. Pre-flight

- [x] 1.1 Verify `alt+x` has no built-in binding in current Pi keybindings (check upstream `keybindings.md` / defaults) and no conflict among the user's installed extensions; if taken, pick a different mnemonic default and update `design.md` + spec before coding
- [x] 1.2 Re-read `src/extension.ts` command/queue/dispatch/settled sections and `src/config.ts`/`src/config-loader.ts` in full to confirm current shapes match design assumptions (also verified: `emit` awaits handlers, `registerShortcut` from `session_start` lands before `setupExtensionShortcuts`, so config-driven registration is safe)

## 2. Config

- [x] 2.1 Add `cancelShortcut: string | false` to `WatchdogConfig` with built-in default `"alt+x"`; verify `npm run typecheck` passes
- [x] 2.2 Implement config-loader validation and merge (string key, `false` to disable, invalid → bounded diagnostic + default); verify new config unit tests pass alongside existing `test/config-loader.test.ts`

## 3. Queue lifecycle

- [x] 3.1 Gate `maybeDispatch` manual dispatch on live `probePiAgentState(ctx).busy` (re-probe at dispatch, stay queued when busy); verify existing `test/runtime.test.ts` still passes
- [x] 3.2 Dispatch queued manual reflections from the `agent_settled` path exactly once (identity/generation guard against repeated settle observations); verify a new test: busy invocation → no inquiry sent → settle → exactly one inquiry with original supplement and manual origin
- [x] 3.3 Coalesce duplicate `/reflect` while one request is pending with a notification, dropping the new supplement; verify test covers duplicate-while-queued

## 4. Visibility and cancel

- [x] 4.1 Show queued status in the below-editor status bar row naming the effective cancel key (or `/cancel-reflect` when disabled), rendered from effective config; clear on dispatch, cancel, and session teardown; verify widget/status tests updated
- [x] 4.2 Register `/cancel-reflect` command: clears pending manual queue, confirms; no-ops with notification when empty; never affects an active reflection; verify command tests
- [x] 4.3 Register cancel shortcut from effective config (skip registration when `false`); verify registration test and disabled-config test
- [x] 4.4 Ensure teardown/reset paths discard pending queue and clear status (runtime-only semantics); verify shutdown/reset tests

## 5. Docs and verification

- [x] 5.1 Update README with queued/cancel behavior, config key, and why customization lives in the plugin config (no namespaced extension keybinding ids in Pi); verify docs render and examples match defaults
- [x] 5.2 Run `npm run check` and fix all findings before commit
- [x] 5.3 Manual smoke on stock Pi (no downstream patches): busy → `/reflect` queued → cancel shortcut → no inquiry; busy → queued → settle → reflection runs once; verify observed behavior matches spec scenarios
