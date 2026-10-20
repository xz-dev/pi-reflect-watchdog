## Why

Reflect still executes hidden reflection and the public `ref` result function inside the main agent. Continue has already isolated equivalent execution mechanisms in a private full fork. Use their shared pi-extension-utils module instead of recreating private runtime, file transport and cancellation code.

## What Changes

- Run each logical reflection in one private full-fork child using the main session's selected provider/model/thinking and effective active context. Use only `pi-extension-utils/private-inquiry`; do not copy or independently patch pi-subagents here.
- **BREAKING**: retire watchdog-owned public `ref` registration and all new function/XML/prose result submissions. Receive the existing five-field reflection result from the designated private JSON file. Preserve compatible normalization and existing stored reports.
- Preserve up to ten helper lookup calls across at most three result attempts, in the same child. Intermediate lookup responses are not missing-result failures. Result writes do not spend lookup budget; no hidden unbounded follow-up loop is allowed.
- Start one private child in the background from a frozen qualified source captured when a trigger is admitted. Parent work stays non-blocked; no native steering slot is reserved for the inquiry. Only a current valid durable result is delivered: steer when main is busy, or trigger the one ordinary continuation when idle. Failure, no result, cancellation and staleness inject nothing and create no parent request.
- Restrict helpers to read-only local evidence: SDK `read`, `ls`, `grep`, `find`, including reading the qualified parent session file. No third-party extension helpers, shell commands, writes or delegation; only the designated result writer may write.
- Preserve report bodies and trigger-specific roles, durable completion before hook/handoff, exactly-once plugin continuation, counters/cooldown and abort hold. Observed input/branch/owner revocation immediately aborts the exact private provider/helpers; checkpoint guards are backstops, not delayed discard. Stale cleanup preserves admission's reminder reset and launches no replacement.
- **BREAKING**: raise Reflect's minimum Pi support to >=1.3.0 and pin the project verification SDK accordingly. Do not upgrade global Pi or introduce a compatibility/fresh-context fallback.

## Capabilities

### New Capabilities

- `reflection-private-execution`: shared-runtime use, private lifecycle, full-context qualification, execution/accounting isolation and the approved host baseline.

### Modified Capabilities

- `reflection-response-contract`: file-only five-field result, bounded same-child correction, no public result function and distinct provider/cancellation failures.
- `turn-end-reflection`: preserve native scheduling order while moving execution out of the main model conversation.
- `manual-reflect-queue`: preserve immediate native scheduling and the pending-only withdrawal window without the retired public result protocol.
- `conversation-grounded-reflection`: private parent-context/history guidance, bounded helper use and unchanged final-feedback provenance.
- `reflection-completed-hook`: retain completion silence/durability under private file-result attempts rather than public function calls.

## Impact

- Main integration: `src/extension.ts`, `src/reflection-protocol.ts`, prompts, package inputs and corresponding protocol/lifecycle/native TUI/distribution tests. Existing accounting modules and hook/report formats are compatibility constraints, not targets for redesign.
- Shared Interface authority: `pi-extension-utils/openspec/changes/share-private-inquiry-runtime/`. Establish Reflect's concrete requirements first, extract the shared module, adapt Reflect, then adapt Continue; both consumers must pass coordinated verification before publication.
- Readiness gates include frozen trigger-time source capture, non-blocking child execution, result-only busy/idle delivery, the local read-only helper profile, provider retry classification, SDK identity and dual-watchdog cancellation/accounting. The earlier native-slot and arbitrary extension-helper requirements are superseded by the user's background/local-evidence decisions.
- The user authorized that phased implementation and eventual commits/pushes for all three repositories. Reflect owns only this repository; the coordinator owns dependent pins, final integration and publication. Lane commits/pushes wait for a coordinated frozen tested state. Temporary unsigned commits use command-scoped `git -c commit.gpgsign=false`, never global signing changes, force pushes, tags or releases. Production cutover still requires passing readiness gates and an actual shared candidate.
