## Purpose

Run reflection in a background private fork from a qualified trigger-time source; deliver only a current durable result without blocking or aborting parent work.

## ADDED Requirements

### Requirement: Reflection uses the shared private execution contract
Each logical reflection SHALL use one distinct child through `pi-extension-utils/private-inquiry`, independently of public subagent tooling. It SHALL inherit the captured parent's selected provider/model/thinking and full effective context under native compaction/exclusions and legacy folding. No alternate model or fresh/pruned conversation SHALL replace an unavailable fork. Reflect SHALL require Pi>=1.3.0 without upgrading global Pi.

#### Scenario: Selected model differs from default
- **WHEN** reflection is admitted from a non-default model/thinking selection
- **THEN** the distinct child uses that captured selection and leaves main selection unchanged

#### Scenario: Full fork is unavailable
- **WHEN** no qualified source supports a full effective fork
- **THEN** setup fails without a format charge, fallback, main message or parent request

### Requirement: Trigger-time source capture precedes non-blocking execution
Admission SHALL freeze native session/owner/cycle identity, active ancestry, selected execution state and source anchor before asynchronous child setup. The anchor SHALL be the latest replayable persisted entry at trigger time. An open assistant tool batch SHALL be excluded while full ancestry to the anchor is retained. Capture SHALL not wait for parent settlement/tool completion, observe later parent work, or fabricate a fresh context. The inquiry SHALL reserve no native steering slot and send no main scheduling/wake message. Parent work SHALL continue normally while the private child runs.

#### Scenario: Trigger during parent generation
- **WHEN** a manual or participating-child trigger is admitted while main is generating
- **THEN** the qualified source is frozen and the child starts in the background
- **AND** parent can finish its response and continue ordinary work without waiting for the child

#### Scenario: Trigger during an open multi-tool batch
- **WHEN** some tools of the current assistant batch have not finished
- **THEN** capture uses the latest replayable persisted anchor before that open batch with full preceding ancestry
- **AND** no parent tool is cancelled, skipped or awaited by reflection admission

#### Scenario: Child setup runs after parent progress
- **WHEN** main appends more ordinary work after admission but before child creation finishes
- **THEN** the child still receives the frozen trigger-time source, not the later leaf

### Requirement: Source currentness tolerates ordinary progress but rejects takeover
A candidate SHALL remain associated with its captured point. Same-ancestry ordinary assistant/tool appends, native compaction and owned context-excluded metadata SHALL not alone make it stale. Reflect SHALL revoke authority on owner/session/cycle replacement, branch-navigation intent/change, source anchor leaving active ancestry, owning abort/shutdown, fresh interactive/RPC input, or a newly queued/delivered non-owned main user message after capture. User-role invalidation SHALL not release the abort hold or assert human authorization. Currentness SHALL be checked before correction and before durable publication; shared terminal acceptance SHALL also use the supplied guard. These checks SHALL be backstops: every observed revocation SHALL synchronously retire authority and immediately signal exact-child provider/helper cancellation rather than waiting for stale completion.

#### Scenario: Parent makes ordinary progress
- **WHEN** main finishes another ordinary tool/assistant turn on the captured ancestry without takeover
- **THEN** the captured-source reflection remains eligible and that ordinary work keeps counting

#### Scenario: Already queued user input arrives
- **WHEN** a non-owned main user message is delivered after capture, including input queued earlier
- **THEN** the old result becomes stale, exact-child cancellation starts immediately, and no feedback can publish
- **AND** role alone does not release an abort hold

#### Scenario: Branch changes while child works
- **WHEN** successful navigation replaces the active branch even if it shares older ancestry
- **THEN** the old operation loses authority and late child events remain inert

#### Scenario: Revocation interrupts provider and helper work
- **WHEN** new non-owned input is queued while the private provider is streaming or a private helper is running
- **THEN** the owning operation signal is aborted immediately and the exact child settles as aborted
- **AND** no subsequent private provider request, correction, accepted file or parent feedback is authorized
- **AND** unrelated parent work proceeds normally

#### Scenario: Source mutation has no public observation
- **WHEN** external code silently changes source ancestry without a public event
- **THEN** the next lifecycle/session observation or currentness checkpoint cancels the operation
- **AND** no guarantee of detecting an unobservable mutation before that observation is claimed

### Requirement: Private work is isolated from ordinary delivery and loops
Private prompts, corrections, helper calls/results, result path/raw file and thinking SHALL remain out of main visible/provider/summary context. Owned child turns SHALL not count as ordinary root/all/cooldown loops or trigger another reflection. Exact-child official working observations SHALL still contribute actual active time. Parent and unrelated child work, including Continue, SHALL remain visible under their own identities.

#### Scenario: Both watchdogs have work
- **WHEN** Reflect and Continue own separate operations while main progresses
- **THEN** their activity/cancellation identities remain distinct and parent ordinary loops are not suppressed

### Requirement: Only a current durable result authorizes feedback
Reflect SHALL durably record its existing result and completion marker before one hook and exactly one ordinary continuation. Existing report body, automatic-assistant/manual-user feedback roles and separate two-line continuation signal SHALL remain unchanged. A valid durable result SHALL be steered promptly when main is busy, or delivered with turn triggering when idle. Failed, missing, cancelled or stale outcomes SHALL inject nothing and create no parent request. Recovery SHALL restore history only; temporary files SHALL never be restart authority or receipts.

#### Scenario: Result completes while parent is busy
- **WHEN** a current valid result and completion marker are durable
- **THEN** feedback is queued through native steering after earlier messages and delivered at the next eligible assistant/tool boundary
- **AND** current generation and the whole tool batch finish normally

#### Scenario: Result completes while parent is idle
- **WHEN** the same durable completion occurs on idle main
- **THEN** feedback starts exactly one ordinary request without another user message

#### Scenario: Private operation has no accepted result
- **WHEN** execution fails, exhausts invalid results, is cancelled or becomes stale
- **THEN** no main message, completion hook or parent request is created

### Requirement: Stale cleanup preserves accounting without self-triggering
Automatic admission SHALL retain its existing reminder-boundary reset even if the child later becomes stale. Fresh explicit takeover SHALL retain existing full-cycle reset. A stale drop SHALL not roll back admission, reset accrued parent work, add completion/cooldown records, latch intent, reevaluate thresholds or launch a replacement. Only a later fresh valid ordinary completion reaching current thresholds under existing cooldown rules SHALL admit another automatic inquiry.

#### Scenario: Repeated stale completion callbacks
- **WHEN** a stale child settles repeatedly and no new ordinary threshold crossing occurs
- **THEN** zero new children, reports, hooks or parent requests are created
- **AND** counters and historical cooldown records remain unchanged by the drops

### Requirement: Cancellation remains exact and preserves abort hold
Owning main abort, directed private cancellation, source/ownership replacement and shutdown SHALL revoke authority before exact-child cancellation/drain. Aborted outcomes SHALL not become format correction. Existing abort reset, discarded plugin-pending requests and explicit-input release rules SHALL remain intact. `/cancel-reflect` SHALL withdraw only plugin-pending requests, not an active child. Cleanup SHALL not abort unrelated parent work. Already-submitted successful feedback SHALL retain native residual-work limits, without new retraction guarantees.

#### Scenario: Cancellation races a staged result
- **WHEN** authority is revoked before both completion records are durable
- **THEN** staged content cannot produce correction, report, hook or continuation
- **AND** exact child work drains without cancelling unrelated main work
