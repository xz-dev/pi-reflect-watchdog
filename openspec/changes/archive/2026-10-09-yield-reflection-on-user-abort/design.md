## Context

See `proposal.md` for the unified cancellation and immediate-steering contract. The latest decision retains full-cycle abort reset and explicit-user-only re-entry, but replaces the earlier busy-time plugin-custody policy with immediate native steering and an explicit limit on retracting already-submitted host work.

Baseline `1ca9864` includes the separately committed provider-retry fix. Existing dirty implementation, tests, README, and Lean files remain partial candidates. The stock-Pi `0.99.2` trace in `/var/tmp/abort-repair-gpt/no-tool-native-gate.json`, reviewed in `parent-native-queue-finding.md` beside it, shows a cancelled native slot causing a request even after its inquiry text was filtered. Its earlier three-request oracle was wrong; accepting this limitation does not make that oracle valid or prove a newer candidate.

Public host observations remain relevant: interactive/RPC input has provenance that ordinary user-role messages lack; command handling precedes ordinary input handlers; a triggering send may be queued or deferred even when settlement reports idle. Payload/context filtering changes content, not necessarily the host's decision to request the provider.

## Goals / Non-Goals

**Goals:**
- Revoke old reflection authority before reset notifications or finalization can reenter dispatch.
- Keep the abort hold independent of working-state observation and threshold eligibility.
- Preserve immediate native delivery, bounded manual queuing, exact input delivery, and normal non-cancelled completion.
- Verify plugin-controlled guarantees separately from accepted residual native effects.

**Non-Goals:**
- No safe-idle-only scheduler, wait-until-settled policy, or zero-extra-request promise for already-submitted native work.
- No host patch, private native-queue access, whole-queue clear/replay, user-input interception/replay, arbitrary delay, polling scheduler, new command, or setting.
- No cancellation of independent children, rollback of durable reports or external effects, or persistent hold across restart.
- No time/loop/protocol redesign in this change; those changes belong to the coordinated runtime change.
- No implementation, deployment, reload, or restart during this planning revision.

## Decisions

### 1. Distinguish custody, submission, and result authority

Reuse the existing bounded manual queue and inquiry lifecycle. A manual request waiting behind an outstanding inquiry remains plugin-held, visible, coalesced, and withdrawable through the existing command or configured shortcut. Ordinary main busyness alone does not create another waiting barrier. Once eligible under ownership and serialization, submit through native steering without aborting work or overtaking prior messages.

Plugin-held work can be discarded without a host effect. Host-submitted but unconsumed work is no longer guaranteed retractable. Only consumption and confirmation of the exact current, non-cancelled inquiry/attempt grants result authority. Neither native submission nor a structurally valid result establishes that authority.

The user rejected waiting for safe idle in favor of timely delivery. Do not compensate with private queue operations, a host patch, or a hidden fallback scheduler. A successful send or an idle observation is not proof of immediate consumption or of native cancellation.

### 2. Install cancellation before observable reset work

Recognize authoritative current-main abort using public outcome and current-run boundary evidence. Raw Esc, ordinary settlement, child abort, missing boundaries, and historical aborted entries are not sufficient. Preserve the aborted outcome before owned-message cleanup or response validation can turn partial output into a correction attempt. Provider errors remain distinct and retain host-owned retry handling.

Before counter resets, domain notifications, or other reentrant observation, install inhibition, revoke old inquiry authority, discard plugin-pending manual/automatic work, and invalidate staged uncommitted results. Reset the full activity cycle without releasing inhibition. Cancellation is not successful finalization and does not emit an invalid-response warning.

Every path capable of issuing Reflect-owned work must respect cancellation: initial inquiries, correction prompts, waiting manual dispatch, and ordinary continuations. A guard on the initial dispatcher alone is insufficient. Use existing cancellation/correlation mechanisms rather than introducing a second lifecycle or a general scheduling abstraction.

### 3. Release only on explicit user provenance

Accept new interactive/RPC user input or a newly user-invoked `/reflect` as re-entry. Filter source before advancing an explicit-input marker. Reset all activity counters before releasing dispatch so accumulated held counters cannot immediately force reflection. A fresh `/reflect` retains immediate-steering eligibility rather than waiting for idle.

Child turns, counters, timers, pause transitions, synthetic user-role messages, and background-started main runs do not release the hold. They may continue accounting or unrelated work. In the coordinated turn-end design, threshold evaluation happens only at a fresh valid ordinary main/child turn boundary, and abort inhibition still gates submission; neither reset nor release is itself an automatic threshold trigger.

Preserve input submitted while abort settles exactly once, including images. Correlate old inquiry/message/tool events using supported identities so they cannot cancel or re-hold fresh work, publish an old result, or consume a fresh inquiry's attempt or lookup budget. Do not invent unavailable host run IDs or rely on ordinary user-role appearance as provenance.

### 4. Separate native residue from new plugin actions

An inquiry, correction, or continuation accepted by the host before cancellation may retain a native slot or deferred action. Later ordinary work can consume that residue and incur additional requests, costs, or ordinary tool effects. This is the accepted limit, not permission to submit new Reflect work while inhibited.

Apply exact-owned context folding and stale-event rejection so cancelled prompts and tool material are not presented as live reflection and cannot regain result authority. Preserve historical sessions and unrelated text, images, and extension-message order. Do not claim that filtering removes the native slot or all its effects.

A valid staged result remains provisional. Only still-current, non-cancelled authority and durable result plus completion marker authorize normal completion and a new plugin-issued continuation. Cancellation before completion prevents new result/hook/continuation publication. Already durable reports and published hooks remain history; do not repeat them. An already-submitted wake is subject to the native-residue limit, not a rollback guarantee.

Preserve the constrained result declaration, at most three total result attempts, one shared ten-lookup-call budget, provider-owned error retries, and exactly one normal continuation. Complete normal publication/handoff ordering before dispatching another waiting manual request; repeated observations must not duplicate either action. Automatic finalization must not redispatch an old latched threshold decision under the coordinated turn-end design.

### 5. Keep one owner for overlapping specification blocks

`yield-reflection-on-user-abort` owns the abort/reset/re-entry requirements, serialized-manual cancellation and visibility, reask/result authority and abort precedence, reconsideration/handoff cancellation, and silent non-final completion paths.

`simplify-reflection-runtime` owns working-time accounting, Pi-API loop views, fresh main/child turn-end decisions, session-navigation accounting, the immediate-manual-steering requirement, and non-aborted invalid-owned-submission handling. It is also the sole full-text owner of `conversation-grounded-reflection` / `Existing lifecycle and compatibility remain intact`; its coordinated text preserves this change's cancellation, input, budget, and durable-completion contracts. Remove the duplicate block only when this change's specs revision is confirmed.

The manual queue's no-host/protocol-change requirement protects the public inquiry/result format and stock-Pi public APIs. It does not prohibit separately specified, versioned watchdog-private child-accounting messages. This change does not implement that accounting redesign.

Preserve `/cancel-reflect`, the configured cancel shortcut, queued indication, and bounded waiting slot. Removing accounting-pause interfaces is not authority to remove withdrawal controls. Before any separately authorized sync/archive, review the combined requirements so one whole-block replacement cannot restore stale no-hold, busy-custody, or zero-native-residue language. Neither session writes the other's change directory.

### 6. Verify the revised boundary, not a renamed passing oracle

After planning and separate implementation authorization, rebuild/repack the candidate and use the controlled-provider stock-Pi harness. Record plugin submission points, public lifecycle events, actual inputs, and provider requests. Compare equivalent owned/no-owned cases where needed; do not assign one request to each logical message or label every unexpected request as permitted residue.

The first verification gate must establish:
- Confirmed main abort inhibits before reentrant notifications and prevents new plugin submissions, corrections, continuations, or completion publication from cancelled work.
- Any accepted residual request is attributable to host work submitted before cancellation; it does not restore old authority, contaminate a fresh inquiry, or justify new plugin automation.
- Text/images submitted around settlement survive once, unrelated messages keep their order, and old settlement/tool/results cannot damage fresh authority or budgets.
- Busy eligible manual/automatic work retains immediate native delivery; normal valid completion and waiting-manual handling remain exactly once. A non-held child turn can trigger an idle main, but a held child turn cannot.

Then complete initial/correction partial and invalid aborts, staged-result aborts, pending-manual cancellation and withdrawal, pre-submitted continuation residue, source-filtered re-entry, historical completion, provider-error retry, and normal-success regressions. Reuse earlier focused evidence only for its tested candidate and cases. A failing plugin-controlled guarantee remains a blocker even though native-slot retraction is no longer required.

Finish current-candidate runtime/full checks, affected README and Lean synchronization, independent Lean semantic reading, and final code/evidence review only in the authorized implementation phase. Use command-scoped `TMPDIR=/var/tmp` for test/build artifacts. Planning validation and old green totals are not behavior acceptance.

## Risks / Trade-offs

- [Native residue causes cost or ordinary tool execution after stop] -> Document the accepted limit and preserve request attribution; do not describe stop as queue retraction.
- [Reset or settlement reenters dispatch before inhibition] -> Revoke authority and install the hold first; verify public-event ordering.
- [Synthetic input or late events affect a fresh inquiry] -> Filter provenance before re-entry and fence exact old inquiry/tool identities and budgets.
- [A direct retry or continuation send bypasses cancellation] -> Cover all send paths, not only initial dispatch.
- [Overlapping changes overwrite lifecycle guarantees] -> Use explicit requirement ownership and inspect merged full blocks before sync/archive.

## Migration Plan

No configuration or stored-report migration is required by this change. Preserve the provider-retry baseline and partial dirty implementation; do not discard them because the cancellation target changed.

Now revise only this change's existing planning artifacts, one confirmed artifact at a time. Before later implementation, coordinate the sole shared-worktree writer and reconcile the final runtime-change contract; do not silently take over its accounting/protocol tasks. Update tests and acceptance language to match the chosen boundary rather than merely accepting the old request count.

Deployment, reload, restart, sync/archive, and publication need separate authorization. Later operational rollback uses the previous plugin version in a fresh session without rewriting user input or historical reports.
