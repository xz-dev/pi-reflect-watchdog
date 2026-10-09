## Context

See `proposal.md` for motivation and `specs/shared-domain-accounting/spec.md` for the behavior contract. This design is warranted by protocol identity, recovery, and security-sensitive validation changes.

At the investigated revisions, `openSharedProcessDomain` shares one transport node per JS realm. Only its first opener supplies effective metadata. Continue provides `role/pid`; Reflect additionally requests `protocol/incarnation`. Reflect checks the latter fields when admitting checkpoints, selecting control recipients, and constructing acknowledgements. These checks silently exclude a node first opened by Continue.

Installed pi-subagents 0.67.0 runs foreground native sessions in the parent process with ambient extensions disabled, and background native sessions in a detached runner with ambient discovery enabled by default. This design covers sessions that actually load Reflect; sharing a process does not itself register a watchdog attachment.

Two no-file probes exercised current coordinator source with a virtual clock and in-memory transport. With the main idle and a child active for two seconds/three loops, Continue-first yielded zero Reflect time/loops and no acknowledged child counters; Reflect-first yielded 2000 ms/three loops. Continue saw one busy child in both. Main-local accounting still worked in the failing case. Real Pi startup, real TCP, and deployed-session memory were not probed.

## Goals / Non-Goals

**Goals:**
- Move Reflect enrollment authority from shared node metadata to validated Reflect-channel messages from authenticated online senders.
- Separate control-plane synchronization from accounting admission so a new or resumed client can learn the current generation without being counted prematurely.
- Preserve the existing reducer, native steering behavior, and recovery fences.

**Non-Goals:**
- No transport metadata mutation, new generic registry, separate watchdog socket, dependency upgrade, or Pi/subagents patch.
- No automatic foreground extension injection, remote/external CLI support, timer redesign, global pause redesign, or load-order workaround.
- No edits to the existing aggregate-state-machine change during this capture.

## Decisions

### 1. Use the existing checkpoint as the private enrollment message

Use the authenticated `message.senderId` and online transport peer as the transport boundary. Parse the existing version-3 checkpoint before admitting its claimed Reflect incarnation/contributor identity. Transport metadata remains informational, not proof of Reflect participation.

Bind accepted identity to the sender in Reflect-owned state. An established live identity cannot be silently overwritten by an inconsistent checkpoint; retirement/reconnect must follow the existing fenced lifecycle. Preserve field validation, generation checks, sequence/cumulative-counter monotonicity, and replay receipt validation. Incarnation is a private protocol identity, not a substitute for transport authentication.

Alternative rejected: simply deleting metadata checks at one call site. Enrollment, control recipients, and ACK construction all depend on the same assumption and must be changed coherently. Reordering packages only hides the dependency on the first opener. A new shared-metadata registration API would enlarge scope unnecessarily.

### 2. Enroll for control synchronization before accounting acceptance

A structurally valid supported checkpoint from an authenticated online sender can identify a Reflect control participant even if its accounting generation is stale. Reply with the authoritative generation/pause state; do not count its work or issue a false accepted-checkpoint ACK. The client then submits a checkpoint for the current generation through existing recovery behavior.

This ordering is essential when the child first starts during a pause or after a generation change. Requiring a fully accepted checkpoint before sending any counters creates a bootstrap deadlock. A transport-online event alone never creates an accounting contributor.

Derive counter recipients and ACK identities from private enrollment/accepted checkpoint state, not `peer.metadata`. ACKs remain bound to the exact accepted sender, incarnation, contributor, generation, and sequence. Remove live participation immediately on offline/leave while retaining only the bounded replay information already required by the protocol.

Alternative rejected: broadcasting all accounting snapshots to every connected extension. It is unnecessary when valid private messages can identify control participants.

### 3. Retain the existing wire shape and scope the rollout

Keep checkpoint/counter/leave version 3 and the existing payload fields: they already carry private identity and synchronization data. The change concerns admission and routing authority, not a new transport or counter format.

A corrected root is required for the load-order-independent guarantee. An old root still rejects Continue-first children, even if a child is updated. Do not claim transparent mixed-root-version repair or migration of live in-memory counters. Validate a consistent installation on fresh parent/runner sessions; restarting an active user session requires separate permission.

### 4. Verify at three boundaries

1. **Coordinator regression:** virtual time, both installed-watchdog behaviors, both load orders, idle root, two active seconds, three child loops, no root increments. Verify an unrelated online node contributes nothing and main-local counting remains intact.
2. **Recovery regression:** duplicate/stale/malformed checkpoints, invalid identity/receipt, offline/reconnect, pause/resume, and a child enrolling after generation advancement. Confirm unrelated valid work is not frozen. Update affected Lean authority during implementation, without treating model proofs as transport evidence.
3. **Acceptance integration:** use existing isolated E2E infrastructure with actual shared transport and both extensions. Then exercise an actual native background child with pinned pi-subagents/Pi/Continue revisions and a controlled provider; verify child extensions really loaded, the parent is settled, aggregate time/all loops increase, and Continue remains functional. Keep exact 2000-ms assertions in virtual-time tests; real-clock checks use bounded tolerances and exact loop deltas. No external model credentials or production sessions are needed.

Also verify accepted child work can cross an automatic-reflection threshold and reach the existing native steering seam. Keep the root idle until threshold submission so root work cannot mask lost child activity.

## Risks / Trade-offs

- [Replacing metadata validation with permissive acceptance] -> Bind private enrollment to authenticated sender identity; retain all message/replay validation and test negative cases.
- [Generation bootstrap stalls] -> Distinguish control enrollment from accepted accounting; test a new child during and after pause.
- [Previously passing tests bypass shared-node behavior] -> Add actual shared-transport coexistence coverage, not only Reflect-only fake peers with ideal metadata.
- [Shared realm reload changes private incarnation] -> Test offline/reconnect and reject inconsistent live identities; do not assume every new session creates a new transport node.
- [Foreground children remain unobserved when Reflect is absent] -> Explicitly document this scope; do not promise universal child aggregation.
- [Existing aggregate-state-machine work overlaps the coordinator] -> Preserve its current reducer semantics and synchronize affected formal models only during authorized implementation.

## Migration Plan

Implement and review the scoped coordinator change with regression and acceptance evidence. No global package reordering or settings migration is required. Deploy only after separate authorization; use fresh parent and background sessions for validation. Rollback restores the previous Reflect revision and fresh-session startup, with the known Continue-first child-accounting defect returning. Do not restart active agents or rewrite session history as part of proposal creation.
