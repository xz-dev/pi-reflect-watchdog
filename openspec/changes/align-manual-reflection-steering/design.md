## Context

See `proposal.md` for motivation and `specs/manual-reflect-queue/spec.md` for the behavior contract. A design is warranted because changing submission timing changes the visible cancellation window and requires distinguishing plugin-pending requests from native-queued inquiries before coding.

At the inspected watchdog revision `1c90836`:

- `src/extension.ts` already routes manual and automatic requests through `maybeDispatch`, `beginReflection`, and `sendActiveReflection`.
- `safeToDispatch` checks current-main ownership, context availability, and absence of an outstanding reflection. Only the manual branch adds a live ordinary-agent busy check; it returns before considering pending automatic reflection.
- `pi-extension-utils/pi-inquiry` submits with `{ triggerTurn: true, deliverAs: "steer" }`.
- `activeReflection` exists from submission through finalization, before the inquiry is necessarily consumed. `manualQueue` already supplies one waiting request, duplicate coalescing, and pre-submission cancellation.
- `message_start` correlation confirms inquiry consumption; ordinary replies before that confirmation must not be captured as reflection results. Finalization stores completion evidence and sends the existing ordinary continuation before reconsidering queued work.

Pi's native queue boundary was checked in `packages/coding-agent/src/core/agent-session.ts` (`sendCustomMessage`) and `packages/agent/src/agent-loop.ts` in the local Pi checkout at `6664a075d6d5ea1161afee4edc70965041a46cef`: steering is consumed after the current assistant turn and complete tool batch, before a subsequent model request; follow-up waits until the agent would otherwise stop. Installed bundle `0.85.1-xz.155.3.gb0f728b8` documentation agrees. This source/document inspection is not a test of the installed binary or every supported Pi version; implementation validation must exercise the target Pi dependency/runtime.

## Goals / Non-Goals

**Goals:**

- Remove the manual-only scheduling barrier at the existing shared dispatch point.
- Keep one outstanding inquiry and at most one plugin-pending manual request, without adding states, timers, or a second delivery mechanism.
- Make cancellation/status describe plugin custody of a request, not whether the model has begun reflecting.

**Non-Goals:**

- Abort or preempt token generation, skip tools, reorder native queues, or guarantee a response deadline.
- Change automatic accounting, cooldown, pause handling, report roles, prompts, XML retries, continuation policy, or cross-process coordination.
- Add native-queue retraction, host patches, configuration switches, new dependencies, or an independent reflection worker.
- Modify the separate aggregate-activity change or treat its pending validation as part of this change.

## Decisions

### Reuse native steering; remove only the manual busy barrier

Keep dispatch through the existing shared path, including ownership/context and outstanding-inquiry checks. Ordinary busyness must not delay a manual request in `maybeDispatch`. Existing native pending messages and child activity likewise do not introduce new barriers.

Alternatives rejected: `followUp` retains the unwanted end-of-run delay; abort-and-restart changes host execution and tool safety; a separate dispatcher duplicates already-working automatic delivery.

### Preserve the bounded queue behind an outstanding inquiry

The lifecycle remains:

```text
/reflect + no outstanding inquiry --> native steer --> correlated reflection
/reflect + outstanding inquiry    --> plugin pending --> native steer after finalization
plugin pending + cancel           --> discarded
native queued + cancel            --> unchanged
```

An outstanding inquiry includes the submitted-but-not-consumed interval and all XML attempts. Do not weaken its guard to mean only a currently executing reflection. The first additional manual request occupies the waiting slot; later requests coalesce into that slot without replacing its supplement.

Finalization remains caller-owned. Preserve completion evidence/history visibility and ordinary-continuation ordering before dispatching the waiting request, even if that continuation makes the ordinary agent busy again. Existing stale/repeated-settlement identity protections remain.

Alternative rejected: removing the manual queue entirely would change overlap/coalescing behavior unnecessarily and eliminate useful withdrawal of genuinely waiting requests.

### Limit cancellable status to requests still owned by the plugin

Reuse the current cancel command, configurable shortcut, status indication, and no-op behavior. Update the README and contradictory tests so ordinary busy invocation no longer promises a cancellable waiting period. Do not add a new status lifecycle for native messages or claim that submission means the model already consumed the inquiry.

Alternative rejected: maintaining cancellation after submission would require native queue tracking/retraction beyond this behavior change.

### Verify submission and consumption separately

Use the existing runtime test harness for immediate inquiry submission, delivery options, origin/supplement, outstanding-inquiry serialization, queue cancellation/coalescing, and settlement/idempotency behavior. Move tests that currently use ordinary busyness to create a cancellable queue to the outstanding-reflection case.

Use the existing integration/e2e harness and deterministic provider/tool fixtures for one bounded native-boundary regression: submit `/reflect` during an ordinary multi-tool turn, finish every tool in that turn, and inspect the next eligible model request for the correlated inquiry before ordinary-run settlement. A fake `sendMessage` receipt alone does not prove model consumption. Use no external model request or new test framework.

Reconcile the existing lifecycle Lean model rather than creating another authority. It already contains `local_busy_still_dispatches` and `simultaneous_local_and_other_busy_still_dispatches`; those model native submission, not token-level preemption. During implementation, clarify the affected model's scope and minimally update any declarations needed to express the retained outstanding-inquiry/pending distinction; typecheck and execute the exact revised model and perform the project's independent semantic check.

## Risks / Trade-offs

- **Smaller cancellation window:** ordinary busy requests immediately leave plugin custody. Mitigation: document this compatibility change and ensure neither notifications nor the status row advertises cancellation after submission.
- **Slow response/tool or older queued steer delays consumption:** immediate submission does not guarantee immediate reflection. Mitigation: preserve Pi's native ordering and describe the whole-turn/tool-batch boundary, not a timeout or forced interrupt.
- **Early submission shares a run with ordinary work:** a provisional inquiry could accidentally capture an ordinary reply if correlation guards regress. Mitigation: retain message-start confirmation and its existing regression coverage.
- **Second request overlaps completion bookkeeping:** continuation dispatch can make the agent busy before queued work is reconsidered. Mitigation: retain finalization order, single-inquiry ownership, and exactly-once settlement checks; do not restore a busy check as a workaround.
- **Tests or formal documentation still encode the old behavior:** the main manual-queue spec currently requires settlement, while the lifecycle model already allows busy dispatch. Mitigation: revise the targeted tests/README/model coherently and sync the delta plus main-spec purpose after implementation approval; do not claim planning validation proves runtime correctness.

## Migration Plan

No configuration, persisted report, or wire-format migration is needed. Existing `cancelShortcut` settings and `/cancel-reflect` remain valid for plugin-pending requests.

After explicit implementation approval, deliver the focused dispatch/test/documentation change and validate against the target Pi runtime. Sync this delta into `manual-reflect-queue` and update its existing purpose to describe immediate steering plus pre-submission withdrawal, instead of promising withdrawal throughout ordinary-agent busyness.

If rollback is needed, revert the focused implementation and corresponding behavior documentation together; rollback restores settlement-delayed manual requests. Do not rewrite stored reflections or queued native messages.
