## Why

When the main model settles, the watchdog treated the whole aggregate as idle and stopped active-time accounting — even while subagents (local or cross-process) were still busy. The root cause was that `withLive` settled the active interval the instant the last *observed* busy contributor went idle, with no grace fence between "main settled" and "a subagent checkpoint lands". This mirrors the bug class pi-continue-watchdog already solves with a `blocked → grace → ready` state machine.

Additionally, a suspended host (sleep/hibernate) was indistinguishable from genuine activity: the wall-clock gap during sleep was counted as active time.

## What Changes

- All contributors (main + subagents, local + cross-process) are now one equal aggregate busy signal; there is no primary/secondary distinction in phase behavior. The `rootLoops`/`allLoops` wire distinction is preserved for accounting only.
- The collection state is now a three-phase machine `idle → collecting → grace → idle`:
  - The last busy contributor stopping opens a **grace** phase (10s fence, `GRACE_FENCE_MS`) instead of settling immediately; the active interval is cut at the true all-idle instant.
  - A contributor rejoining inside the fence resumes collecting with no active-time loss (the grace gap itself is not counted as active).
  - Only a fence-expired observation with zero contributors settles to idle, pinning `idleSinceMs` at the true all-idle instant.
- A new side-effect-free `tick` event (host heartbeat) drives the phase machine and the **sleep freeze**: when an open active interval observes a gap `> SLEEP_GAP_MS` since the last proof-of-life, the open timestamps are shifted forward by `gap - HEARTBEAT_MS` so slept wall time is never counted.
- The host busy tick in `process-domain.ts` now reduces a `tick` event each beat, so the freeze is applied while collecting.
- The snapshot exposes `phase: "idle" | "collecting" | "grace"` for observability; `anyBusy` semantics are unchanged (checkpoint v3 wire protocol intact).

## Formal model

The state machine, its invariant, and the key theorems are formally verified in Lean 4:
`docs/programming-thinking/reflect-activity-state-machine.idea.lean`
(typecheck exit 0, execution semantics via `#eval`, axioms only `propext`/`Classical.choice`/`Quot.sound`). Proven: `main_stop_not_all_stop`, `last_busy_enters_grace`, `grace_expires_to_idle`, `sleep_freeze_exact`, `busy_tick_continuity`, `no_active_loss_in_grace`.

## Capabilities

### Modified Capabilities

- Activity accounting: aggregate phase machine replaces the instant-settle edge; grace fence and sleep freeze are new observable behavior covered by the updated tests.

## Impact

- `src/collection-state.ts`: `graceSinceMs` accounting field, `phase` snapshot field, `tick` event + reducer case, four-branch `withLive` phase machine, `GRACE_FENCE_MS`/`HEARTBEAT_MS`/`SLEEP_GAP_MS` constants.
- `src/process-domain.ts`: host busy tick reduces a `tick` event before publishing.
- `test/collection-state.test.ts`: three new grace-phase tests mapping the Lean theorems; two existing tests updated for grace semantics (retained-reconnect keeps `activeMs=2000n` + `phase` field; idle-reset drives settle via `tick`).
- No dependency, packaging, or wire-protocol changes.
- Not done here: the 5s idle-side heartbeat that would settle grace with zero events is deferred (grace→idle already settles on the next observation); the independent semantic round-trip review of the Lean file remains blocked by CLI/subagent infrastructure (Codex quota, grok fallback, missing claude binary) and is recorded as outstanding.

## Known ceiling

- With zero events during grace, `phase` stays `"grace"` until the next observation (the host heartbeat only ticks while `anyBusy`). This is a deliberate semantic compromise, not a bug: `anyBusy` is already `false` during grace and `phase` has no production consumer yet. If a future consumer needs idle to truly settle on a clock, wire an idle-side `tick`.
- Semantic round-trip blocked root cause: the subagent model resolver appends the thinking suffix (`:high`/`:max`) to the model id before registry lookup, so every grok-4.6 / glm-5.3-flash / kimi variant resolves to a non-existent id and is exclusion-cached until 2026-09-11. Fix the resolver or supply a working model/auth to unblock.
