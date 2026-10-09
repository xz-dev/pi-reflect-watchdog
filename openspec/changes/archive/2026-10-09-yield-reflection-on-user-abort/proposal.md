## Why

Stopping a run must revoke Reflect's old authority and prevent the plugin from initiating further reflection until explicit user re-entry. Immediate native steering remains the delivery policy, so cancellation must distinguish plugin-controlled work from already-submitted host work rather than promise that filtering a cancelled prompt removes its native request effect.

## What Changes

- Make a confirmed current-main abort reset the full activity cycle and revoke cancelled reflection authority before reentrant observation, validation, finalization, or dispatch can revive it. Preserve Pi's authoritative aborted outcome; a raw Esc keystroke, child abort, or historical aborted message is not sufficient evidence.
- **BREAKING**: cancel outstanding reflection authority, staged uncommitted results, pending automatic intent, and plugin-pending manual `/reflect` requests on abort. Cancelled work cannot authorize new plugin-issued corrections, continuations, completed reports, or completion hooks.
- Keep reflection inhibited until new explicit interactive/RPC user input or a newly user-invoked `/reflect`. Reset the full accounting cycle before releasing dispatch. Child turns and counters, timers, synthetic messages, and background-started runs do not release the hold. Independent children and unrelated ordinary work may continue.
- Retain immediate native steering for eligible manual and automatic inquiries, subject to ownership and inquiry serialization. Do not wait for ordinary main work to settle, abort it, or overtake earlier native messages. Coordinate automatic delivery with the fresh valid main/child ordinary-turn boundary defined by `simplify-reflection-runtime`; that boundary never bypasses abort inhibition. When not inhibited, a child turn may trigger reflection while main is idle without waiting for the whole process domain to become idle.
- Explicitly limit cancellation of already-host-submitted inquiries, correction prompts, and continuations: their native slots or deferred actions are not guaranteed retractable and may later cause additional provider requests, costs, or ordinary tool effects. Revoke old Reflect authority and exclude cancelled inquiry instructions from later ordinary context, but do not claim zero extra requests or treat those residual host effects as permission for new Reflect submissions. This replaces the earlier busy-time plugin-custody design and its strict native-slot cancellation target.
- Preserve user text/images exactly once and unrelated message order. Keep the existing bounded manual waiting slot, supplement/coalescing rules, queued indication, `/cancel-reflect`, and configured cancel shortcut. Withdrawal remains plugin-local and ends at native submission; it neither aborts active work nor releases the hold.
- Preserve normal successful result publication and exactly one ordinary continuation. Staged results are not completed results; already durably completed reports, published hooks, and external effects are not rolled back.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `user-takeover-cycle-reset`: authoritative abort cancellation and full reset, explicit-user-only re-entry, stale-event rejection, and the boundary between inhibited plugin dispatch and residual native work.
- `manual-reflect-queue`: retain immediate steering and bounded withdrawal while discarding plugin-pending requests on abort; distinguish native submission from plugin custody.
- `reflection-response-contract`: cancellation precedes correction and revokes result authority without changing argument constraints, shared budgets, or host-owned provider retries.
- `conversation-grounded-reflection`: preserve normal handoff and context folding while preventing cancelled work from regaining authority; acknowledge already-submitted native request effects.
- `reflection-completed-hook`: exclude aborted uncommitted attempts, including staged valid arguments, without rolling back completed history.

## Impact

- Update dispatch inhibition, lifecycle ordering, result authorization, and explicit-input provenance using existing inquiry identities and queue/accounting operations. This change does not redesign the accounting protocol or dependencies.
- Coordinate with `simplify-reflection-runtime`, which owns working-time accounting, Pi-API loop views, and fresh main/child turn-end threshold evaluation. It must retain this change's abort reset and explicit-input hold. Reconcile overlapping requirement blocks before any separately authorized sync or archive so neither change overwrites the other's final behavior.
- Retain the immediate-steering behavior of the implemented and synced but unarchived `align-manual-reflection-steering` change. Do not rewrite its historical artifacts. Preserve constrained `ref` parameters and the separately committed provider-retry behavior at baseline `1ca9864`.
- Replace the safe-idle handoff feasibility gate with verification of the revised cancellation boundary: no new plugin dispatch while inhibited, no revived authority or completion from cancelled work, intact user input, and preserved normal completion. Use stock-Pi request/input and owned-send traces to distinguish accepted native residual effects from forbidden new submissions. Preserve the existing failing native-slot trace as evidence of the limitation, not proof of successful native cancellation; do not assign one request to each logical message.
- During later authorized implementation, synchronize README and affected lifecycle Lean models, run fresh scoped and full checks, and obtain independent semantic and code/evidence review. Existing partial code, earlier passing tests, and complete planning files are not acceptance of this revised contract.
- No host patch, private queue access, whole-queue clear/replay, intercepted or replayed user input, new setting or command, cancellation of independent children, deployment, reload, or restart. Preserve the existing withdrawal controls rather than infer their removal from accounting-pause changes.
- This revision changes only existing planning artifacts in `yield-reflection-on-user-abort`; preserve the partial implementation, main specs, and other change directories. Implementation remains a separate phase requiring authorization.
