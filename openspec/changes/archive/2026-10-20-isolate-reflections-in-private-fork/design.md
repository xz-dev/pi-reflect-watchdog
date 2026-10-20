## Context

Reflect currently executes main-session inquiries and registers `ref`. The shared Interface is owned by `pi-extension-utils/openspec/changes/share-private-inquiry-runtime/`. The project remains on Pi0.99.2 until production adaptation; minimum supported Pi>=1.3.0 is approved, without a global upgrade.

The user replaced the earlier native-slot contract with background execution: capture source when triggered, keep parent work moving, insert only a successful current result as soon as possible. The user also selected read-only local evidence, not arbitrary inherited extension helpers. Earlier candidate blockers remain historical research, not requirements for this design.

## Goals / Non-Goals

**Goals:** one shared executor and one private full-fork child per logical reflection; non-blocking parent; bounded local evidence; unchanged validation, report/provenance, thresholds/cooldown, durability, cancellation and accounting.

**Non-Goals:** native inquiry-slot reservation, a control-only host queue API, parent abort, queue clear/replay, host patches, third-party helper admission, arbitrary parent-tool proxying, public delegation, Continue verdict/review policy or fresh-context/model fallbacks.

## Decisions

### Capture a qualified source at trigger time; run without blocking parent

Manual commands and qualifying fresh ordinary completions admit one operation without queuing an inquiry/wake in main. Freeze parent identity, active branch ancestry, selected provider/model/thinking and context projection before any asynchronous child setup. The snapshot anchor is the latest replayable persisted entry at that moment. Exclude an open assistant tool batch; retain full ancestry to the anchor with native compaction/exclusions and legacy folding. Do not wait for that batch to finish, include later parent work, or substitute a recent-message suffix. No replayable source is a typed setup failure, with no wait, abort or fresh fallback.

The child runs in the background. Parent generation, tools, queued messages and ordinary counting continue normally. No private prompt, correction, helper trace or result path enters main context. The old native steering position is intentionally not preserved for the inquiry.

### Currentness belongs to Reflect, not the shared executor

Capture operation identity, current owner/attachment and cycle identity, native session identity, branch-navigation epoch, source anchor and explicit-input/delivered-user epochs. Revoke authority on owner/session/cycle replacement, branch-navigation intent/change, captured anchor leaving active ancestry, owning native abort/shutdown, fresh interactive/RPC takeover, or a newly queued/delivered non-owned main user message after capture. Delivered-user invalidation covers input queued before capture. User-role alone does not release the abort hold or prove human authorization.

Ordinary assistant/tool appends, context-excluded owned metadata and native compaction on the same ancestry do not invalidate a captured-source report merely because the leaf moved. A manually queued request behind an active inquiry follows existing coalescing/withdrawal rules; admission of that later operation gets a new snapshot/identity.

A manually queued request is fulfilled after the exact child's drain releases the admission slot; automatic intent is never relaunched by any settle path. Fulfillment binds the admission-time session identity, branch owner (main claim, compared structurally by attachmentId+generation since the hub mints a fresh claim object per sync), scope generation AND takeover generation captured in the queued entry: an entry is current only while all four still match — a stale or mismatched entry is silently dropped with no warning, result or launch, and never by leaf equality so ordinary same-ancestry progress keeps it valid. The takeover generation increments synchronously before the boundary append and domain reset inside the full-cycle user-takeover reset, so a request queued before an explicit takeover — even with unchanged session/claim/scope — can never fulfill under the new cycle. Fulfillment happens at most once across command-path and release-drain dispatch; `/cancel-reflect` withdraws only a still-queued entry and never an active private child. An empty queue at failure, stale or drain settles dispatches nothing and changes no counters or thresholds.

Revocation is event-driven: synchronously retire operation authority and abort its controller, then immediately call exact-child `cancel()` to interrupt in-flight provider and helper work. Do not await completion merely to discard a stale result. Reflect checks currentness before child launch, before each correction and before durable publication as backstops. Shared code checks the supplied `isCurrent()` before correction and terminal acceptance and returns typed stale outcomes; it does not implement Reflect's revocation policy.

Earliest public observations: `input` for new/queued main input; `message_start` for a non-owned user message accepted before capture; `before_agent_start` user trigger as a fallback; `session_before_switch`, `session_before_fork`, `session_before_tree` for imminent navigation/replacement, with `session_start`, `session_tree` and `session_shutdown` as completion/teardown backstops. A navigation intent revokes conservatively even if another extension later cancels that navigation; cancelled private authority is never revived. Owner/cycle transitions invoke revocation in their existing transition callbacks. Recheck anchor ancestry at each received main lifecycle/session event. A silent external session-tree mutation with no public event can only be detected at the next such event or `isCurrent()` checkpoint; do not claim synchronous detection of an unobservable mutation.

### Stale drops do not manufacture another reflection

Keep automatic admission's existing reminder-boundary record/reset (`considerFreshCompletion`). A stale drop never rolls that reset back. Fresh explicit user takeover still performs the existing full-cycle reset. Stale cleanup itself changes no counters or historical cooldown records, emits no report/completion/hook/continuation, latches no automatic intent and launches no replacement. Parent ordinary work accrued during the child is not erased.

Only a later fresh valid ordinary completion can evaluate current counters and cooldown. If that new event reaches a threshold after ordinary work accrues, it may start another inquiry; repeated stale/drop callbacks alone cannot do so. Completed historical reports remain cooldown/history authority, not discarded private candidates.

### Shared execution permits only local evidence and the designated result write

Private helper execution is restricted to SDK `read`, `ls`, `grep`, `find`, including reading the qualified parent session file. The source locator and file content are data, not new instructions. No third-party helper factories, shell execution, external lookup, public subagents or arbitrary inherited tool effects are admitted. Existing inherited declarations may remain for full-fork fidelity but confer no execution permission. Missing required local tooling is typed setup/execution failure, not permission to download/install silently or substitute shell commands.

Keep one ten-call helper allowance across at most three terminal result attempts in one child. Helper-only progress spends helper allowance, not a missing-result attempt. The final designated write spends no helper budget and remains available after exhaustion. Mixed, unknown, alternate-path or over-budget batches execute no effects; terminal denials are bounded. Use Reflect's existing five-field validator and custom perspective. No acknowledgement-only model request follows a terminal write, and no Continue-style second semantic inquiry is added.

Provider errors/transport retries are distinct from invalid terminal results and do not spend budgets merely by occurring. Preserve consumer-selected native retry eligibility; do not copy Continue's globally disabled session retry or reload ambient retry extensions.

### Deliver only after current durable completion

A valid file is a candidate. Recheck source/owner/cycle/cancellation, then retain the existing result entry and completion marker before publishing the hook and authorizing exactly one ordinary continuation. Preserve report body, automatic-assistant/manual-user feedback roles and the separate existing two-line continuation signal.

Deliver the completed feedback through native steering as soon as it is valid and durable. If main is busy, delivery waits for the normal next assistant/tool boundary without interrupting current work; earlier queued messages retain native order. If main is idle, delivery with turn triggering starts one ordinary request without another user input. No result, provider/setup/filesystem failure, cancellation or staleness sends any main message or request. No scheduling marker is sent at trigger time. Already-submitted successful feedback retains native residual-work limits after a later abort; no queue retraction guarantee is added.

Recovery reads legacy chain reports and new self-contained private reports; neither restores execution authority; temp files/child transcripts are never receipts. A new private report binds its correlation to validated metadata from the accepted child's own latest terminal assistant, including matching inquiryId/attempt and child session identity. Missing, malformed or mismatched source metadata fails closed; legacy chain correlation rules remain unchanged. Projection respects native compaction boundaries and never recovers a removed report from durable storage alone. Foreign `ref`/`cw` remain untouched; Reflect removes only its own new result registration.

### Observe exact child activity and cancel only owned work

Background child responses/helpers do not become ordinary root/all/cooldown loops or trigger another reflection. Real parent and unrelated-child loops continue counting. Use official idle/working observations from the exact private child for aggregate active time; parent `isIdle()` alone does not observe it. Keep distinct ownership across both watchdogs.

Revoke result/correction authority before exact-child abort and write/helper drain. Preserve full-cycle abort reset, discarded plugin-pending requests and post-abort hold. Only fresh explicit interactive/RPC input or a fresh user `/reflect` releases that hold under existing rules. `/cancel-reflect` still withdraws plugin-pending requests only; it does not kill an active background child. Never abort unrelated parent work.

In TUI, native Escape cannot see a private child while main is idle. Reflect consumes Escape only when this attachment owns unrevoked private work and main is idle; busy-main Escape, other keys and Escape after the work ends pass through. Consumed Escape is a user takeover: revoke the exact child through the existing abort path, retire queued manual requests through the takeover generation, and publish no result, hook, message, continuation or replacement. The slot still frees only on exact-child drain. The listener is disposed on shutdown and session replacement.

## Risks / Trade-offs

- Liveness depends on host abort settling prompt; a host that never settles leaves the reflection slot held until session shutdown. An `agent_settled` event alone does not release a still-pending prompt promise. Never force release and risk overlapping private children; this is a cooperative-host assumption, not a prompt timeout guarantee.

- Background results describe their captured source, not later parent work. Explicit revocation drops obsolete results rather than repairing them in main.
- Trigger-time source may end before an open tool batch; freeze the latest replayable anchor and all preceding eligible context, never wait or capture later state accidentally.
- Local-only evidence intentionally removes third-party research. Prompt guidance must state this limitation rather than imply unavailable tools.
- Helper tool binaries, retries and SDK identity require installed-host validation; passing SDK fixture checks does not validate the shared runtime.
- Parent work can continue while the child runs. Identity-scoped counters and stale cleanup must not erase that work, self-trigger, or suppress the other watchdog.

## Migration Plan

1. Specify Reflect's background/source/currentness/local-evidence needs and run bounded stock-Pi1.3.0 probes.
2. Shared owner extracts the one module in utils; Reflect never copies Continue's executor or writes the sibling repository.
3. Adapt Reflect against the verified shared candidate; retire owned `ref`, update prompts, history handling and affected Lean models.
4. Coordinator adapts Continue, then verifies both consumers, actual TUI/model behavior and clean Git/packed installation.
5. Coordinator freezes tested dependent pins before the authorized commits/pushes. Temporary unsigned commits use command-scoped `git -c commit.gpgsign=false`; no lane publication, global signing change, force push, tag or release.
6. Roll back to a verified consumer/dependency revision, not a runtime fallback or stale temporary file.
