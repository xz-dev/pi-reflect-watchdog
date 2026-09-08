## Context

See `proposal.md` for motivation and `specs/conversation-grounded-reflection/spec.md` for the behavior contract. Source baseline: `1fe20d9629c4ffafbf3585c3dc098341bd304280`.

- `src/extension.ts:710-737` only wakes ordinary work for `ROUTE_CORRECTION`. `NO_ISSUE` only notifies. Valid finalization folds the inquiry, calls `finishReflection`, appends the result and completion marker, publishes the hook, and then checks queued reflection work (`:1049-1109`).
- The existing `context` handler calls `foldInquiryContext`. The source reflection assistant is neutralized before persistence but retains its assistant envelope and inquiry correlation. The report is already stored separately through `formatReflectionReport` and `ReflectionResult`.
- Pi source at `367c709a`, matching the installed runtime bundle, converts custom messages into `user` messages and discards `customType` and `details` (`packages/coding-agent/src/core/messages.ts:178-184`). Installed project dependency Pi 0.84.2 does the same.
- Public context transformation runs before message conversion and provider invocation (`packages/agent/src/agent-loop.ts:318-337`). Native `sendCustomMessage` can start a run while idle (`packages/coding-agent/src/core/agent-session.ts:1747-1779`). These permit separate scheduling and model-facing representation without patching Pi.
- Normal compaction bypasses this context hook and directly converts durable messages (`packages/coding-agent/src/core/compaction/compaction.ts`, `generateSummaryWithUsage`). This limits what an extension-local projection can promise.
- The existing Lean theorem `route_correction_queues_continuation` explicitly makes no-issue passive; it must change with the runtime, not remain as a contradictory authority.

A design is required because model-facing roles, restored history, and continuation ordering interact. The source audit and an in-memory fake-provider probe support the selected public seams; they are not packed-host or real-provider acceptance evidence.

## Goals / Non-Goals

**Goals:**

- Use one normal-success handoff path for both verdicts, without extending the reflection decision model.
- Keep scheduling, report representation, and raw accounting distinct.
- Select the report's model-facing role from its manual or automatic trigger, without changing its text or formatting.
- Preserve a provider-compatible final continuation cue and the existing inquiry/report/hook contracts.

**Non-Goals:**

- No zero-synthetic-user-role claim, Pi-core patch, dependency update, or custom compaction.
- No `TASK_COMPLETE`, approval gate, intent extraction, or background-work controller.
- No report rewrite, new report title/disclaimer, transcript migration, or global message normalizer.
- No guarantee that role attribution alone makes a model interpret the user's intent correctly.

## Decisions

### 1. Freeze only the wake body's two-line format

The user accepted the plugin-local scheme and chose exactly:

```text
[assistant]
continue
```

Use a new plugin-private custom type such as `pi-reflect-watchdog:continuation` for machine recognition. Its conversational `content` is only the two-line marker. The plugin name, correlation, and report belong in session metadata, not in that content.

The marker still converts to `role: user`. The bracketed word is a source cue, not a role override. It contains no observer verdict, next-step recommendation, or new task. Retain it after the projected report in both trigger modes. For automatic reflection this avoids an assistant-last continuation shape; for manual reflection both the report and wake use user-role messages, which requires separate serializer coverage.

The report-format clarification supersedes the earlier proposal to add `[assistant]` or a disclaimer to the reflection body. Reuse the existing `formatReflectionReport` output unchanged. The subsequent role clarification requires user-role delivery for manual `/reflect` result reports and assistant-role delivery for automatic reports. It changes neither the report body nor the wake body. Do not edit the default perspective or existing historical-report wording as part of this change.

**Rejected:** adding plugin names, verbose source disclaimers, XML-like wrappers, or a new report title. They add context noise and were not the selected format. Removing the wake entirely is also rejected: an in-memory provider can accept that shape, but it is not sufficient cross-provider evidence.

### 2. Keep one native wake and trigger-specific report projection

Use one native `sendMessage` with `deliverAs: "steer"` and `triggerTurn: true` for either valid verdict. The new message's serializable metadata carries the final inquiry correlation, recorded trigger origin, and unchanged plain-text report; the existing version-1 result entry remains authoritative report storage. Capture origin from the actual scheduled reflection: the existing manual command path records `USER_REQUEST`, while automatic threshold requests do not. Persist the resulting manual/automatic distinction in the handoff's private details, not in report text or the shared inquiry tag that would classify the wake as internal. No result, XML, or hook schema change is required.

Extend the existing `context` handling, preferably with one small pure helper:

1. Inspect the original context for new continuation markers and their corresponding neutralized reflection assistant messages before folding removes the inquiry.
2. Validate the marker's custom type, fixed wake body, metadata shape, trigger origin, and exact namespace/inquiry/attempt association; the body alone is never sufficient. Reuse existing correlation vocabulary. Pair a marker with its nearest preceding completed matching inquiry, rather than assuming inquiry IDs are globally unique across reloads.
3. Apply the unchanged shared inquiry fold.
4. Immediately before each recognized marker, project the unchanged report according to recorded origin. For automatic reflection, use a text-only clone of the actual source assistant envelope; do not invent provider/model identity. For manual `/reflect`, construct a text-only ordinary `user` message using the correlated source timestamp, without assistant-only provider, usage, response-ID, or signature fields. Both paths require the retained correlated source. Neither restores raw XML, tool calls, or signed thinking blocks.
5. Keep the marker in place. Preserve unrelated messages, original user text, tool-call/result ordering, and subsequent ordinary turns. Do not infer manual origin from a quoted `/reflect` or from model-generated report fields.

The projection is recomputed from retained context, not kept in a new memory ledger. It must be idempotent over repeated provider calls and associate each report once with its own marker. It does not append the projected report as another durable conversation turn and must not affect counters or usage accounting. On the automatic path, source response identifiers and text signatures need adapter-level checks when content is replaced; do not treat a changed text block as an unchanged signed response. Manual user-role delivery is an explicit policy for user-requested results, not evidence that a human authored the report verbatim.

**Rejected:** putting reports into the wake's custom content, sending a second native `sendUserMessage(report)` that starts another turn, system/developer injection, a fabricated tool result, and matching only literal `[assistant]` or `/reflect` text. A blanket assistant-role rule rejects the user's manual-report requirement; a blanket user-role rule loses the automatic-report distinction. The shared inquiry replacement API is not a shortcut: it currently produces another custom message, whose report would become durable conversational user text and would not satisfy the automatic path.

### 3. Preserve finalization order rather than adding another scheduler

Keep the existing valid-result order:

```text
one final inquiry fold (no wake)
  --> release active/internal reflection state
  --> schedule one ordinary marker through finishReflection
  --> append unchanged result
  --> append completion marker
  --> publish existing completion hook
  --> maybeDispatch queued reflection work
```

The marker carries the already computed report, trigger origin, and correlation, so its context projection does not depend on a later entry lookup. Native delivery may enter message/context handling immediately; active/internal state is therefore cleared before scheduling. The inspected `AgentSession._runAgentPrompt` awaits the prompt before emitting the next `agent_settled`, while the current valid-result finalizer appends completion evidence synchronously. Preserve that ordering and verify it in the packed host, rather than assuming the test double's scheduling proves it. The cooldown completion marker must be visible before `maybeDispatch`; never dispatch another reflection from inside the finish helper. The ordinary run counts as ordinary work.

Retain the existing no-issue informational notice. If a TUI report view uses the new marker, render from its metadata rather than copying report text into the wire-visible `content`; reuse the existing report body, without new framing. Rendering is not the source-isolation mechanism and must not generate a second message or turn.

Do not change XML retry exhaustion, cancellation, ownership loss, shutdown, persistence-error, or optional-listener behavior. In particular, the existing correction path schedules before persistence; this change does not silently redefine persistence failure as a rollback or add new retry/replay guarantees.

**Rejected:** timer-based restart, replaying the original user message, a second continuation queue, and making completion-hook consumers responsible for resuming the agent.

### 4. Bound persistence and compaction claims

For new retained handoffs, serializable report metadata, recorded trigger origin, and the original correlated assistant allow the same projection after reload/resume: automatic reports remain assistant-role and manual reports remain user-role. Reading a marker is never itself permission to schedule another wake. No branch-wide historical replay or extra persisted state is introduced.

When correlation or trigger origin is malformed/missing, or compaction has removed the source assistant, omit that projection in either mode. Do not guess a role, copy the report into the wake, or manufacture an assistant envelope using the current model. Intentional manual user-role projection with complete evidence is not a fallback. The existing report entry and later-reflection lookup remain unchanged.

Built-in compaction and branch summarization do not see the transient projected report from either trigger mode. They can see the marker as `[User]: [assistant]` followed by `continue`, but the report in metadata is omitted. This also applies to manual reports even though their ordinary projection uses the user role. This is the accepted plugin-local limit, not a guarantee that reports survive summaries. Test the actual compaction conversion separately; do not assume a normal context-hook test covers it.

**Rejected:** silently falling back to a long report in the marker body, a custom summarizer, and rewriting old session entries. Extending source-preserving summarization would require a new scope discussion.

### 5. Verify behavior at the existing external seams

Use the current runtime tests and packed stock-Pi provider fixture, not a new framework. Build the first failing examples around the existing correction path: one wake, unchanged report text with assistant role for automatic reflection or user role for manual `/reflect`, and the exact separate synthetic user-role marker. Then add no-issue resumption through the same path.

Required evidence:

- Both verdicts across automatic, busy-manual, and idle-manual triggers; one plugin wake, trigger-correct report role, no second inquiry, and normal successful-turn accounting.
- The ordinary provider request and its next tool-loop request contain each report once: automatic reports under assistant-equivalent roles, manual reports under user role, neither under system/developer. Original user corrections remain unchanged. Do not use TUI rendering or custom-message metadata as the oracle.
- Cooldown still blocks an already latched automatic reflection after the new no-issue continuation. Update the old three-request expectation without removing its cooldown assertion.
- Repeated finalization, unrelated/quoted marker or `/reflect` text, malformed/missing correlation or trigger origin, multiple retained handoffs including reused inquiry IDs, reload/resume with different trigger modes, and a missing source at a compaction boundary.
- An offline check through supported OpenAI-, Anthropic-, and Google-style serializers for both message sequences, including adjacent assistant messages for automatic reflection, adjacent user-role report/wake messages for manual reflection, and rewritten assistant response metadata. A native role such as Google's `model` is assistant-equivalent. Existing adapters may combine adjacent same-role messages, but must retain each report once with its selected role and unchanged text, plus the exact distinct wake text. Verify native block boundaries where adapters merge messages; do not add report text to the persisted wake body to accommodate a serializer. Use existing adapters' behavior; do not add a speculative coalescing layer or claim universal provider support from a fake provider.
- Existing reports, notifications, hook ordering/payloads, XML/tool budgets, and terminal cleanup regressions remain covered.

Real-model interpretation is separate from mechanical transport evidence. Do not make paid/live calls without approval or claim semantic fidelity from fake responses.

## Risks / Trade-offs

- **[Short marker can still be misinterpreted]** -> The user selected minimal `[assistant]\ncontinue` over verbose attribution. Disclose its synthetic user role; keep all substantive reflection outside it.
- **[Later extensions can rewrite context]** -> Inspect final provider-facing requests in the target integration. Do not patch arbitrary third-party transforms in this change.
- **[Trigger role can be confused with authorship]** -> Manual reports intentionally use user-role delivery because the user requested this policy; they are still generated reports. Keep original human messages unchanged and do not promise semantic interpretation or add report disclaimers.
- **[Provider-specific role ordering and metadata]** -> Test automatic assistant/report and manual user/report sequences through existing serializers before treating the projection as portable. A supported-adapter blocker pauses implementation for a focused design adjustment, not an unapproved core/dependency patch.
- **[Compaction omits projected feedback]** -> Preserve existing report storage and document the boundary for both modes. Missing source or trigger origin omits projection instead of guessing a role.
- **[Duplicate or stale pairing]** -> Scope correlation to each preceding inquiry/marker pair and retain trigger origin with that handoff; test reload reuse and mixed trigger modes. No global transcript scan or new ledger.
- **[New ordinary turns consume tokens and count toward thresholds]** -> This is the selected behavior even for idle manual reflection. Keep the existing cooldown rather than adding a new quota or state machine.

## Migration Plan

1. Implement and verify trigger-specific report delivery on the existing correction path for automatic and manual requests, then enable the same handoff for no-issue results.
2. Update the existing lifecycle model and README, and run the existing unit, packed-host, and formal-model checks.
3. Review the change with the user before deployment. Planning does not authorize implementation, Git publication, package updates, or live-model comparisons.
4. No stored-report migration is needed. Old report entries and old custom messages remain readable and are not retroactively reclassified.
5. Rollback restores correction-only behavior for future reflections. New markers already persisted remain minimal custom messages under old code; their metadata does not spill reports into user text. No session rewrite is required.
