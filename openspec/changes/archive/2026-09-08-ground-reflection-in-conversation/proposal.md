## Why

A reflection can explore the wrong problem very deeply when it accepts the working agent's interpretation as the user's meaning. User intent often emerges across complaints, assistant responses, and later clarifications, so isolated user quotations and an earlier AI report are not sufficient substitutes for the interaction.

The watchdog should enable open-ended third-party assessment of both the work and the agent's interpretation, with quick access to missing context, without adding a context or decision state machine.

## What Changes

- Preserve the open-ended Oracle perspective while explicitly including the working agent's interpretation of the conversation among the things that may be questioned. Distinguish user expression from newly inferred goals without constraining exploration to a checklist.
- Continue using the normal conversation context. Supply an optional, current-branch history locator for focused recovery of surrounding exchanges; do not construct a user-only transcript, a second summary, or a persistent intent ledger.
- Present the previous reflection as fallible historical assistant analysis, not the user's words or a conclusion that must be maintained.
- Allow tools to clarify the conversation, the actual work, or a possible direction. Explicitly favor quick, targeted research; stop when the relevant uncertainty is resolved, or state the remaining uncertainty and finish if it cannot be resolved promptly. Avoid turning reflection into an extended investigation or waiting on long-running work.
- Reword the ordinary route-correction handoff as an invitation to reconsider the conversation and choose the next response, rather than declaring the proposed route correct in advance.
- Preserve the existing XML fields and result types, shared tool budget and retries, one-continuation behavior, inquiry folding, counters, cooldown, and completion hook.

## Capabilities

### New Capabilities

- `conversation-grounded-reflection`: Open-ended third-party reflection grounded in contextual exchanges, with fallible-report framing, optional branch-aware history recovery, and brief uncertainty-driven tool use.

### Modified Capabilities

None. The repository currently has no main specs under `openspec/specs/`; this change records the behavioral contract in a new capability delta.

## Impact

- Expected implementation surfaces: `src/prompts.ts`, `src/reflection-protocol.ts`, and the reflection prompt construction and handoff in `src/extension.ts`.
- Expected validation/documentation surfaces: existing prompt/runtime tests, the existing host E2E fixture where needed, and `README.md`.
- No new dependency, tool, provider call, cross-plugin API, configuration knob, persistent entry version, result type, timer, or runtime state is proposed.
- The history locator is prompt-local metadata, not an authorization token, a freshness mechanism, or a new stored report field. Existing report and semantic-hook payload shapes remain unchanged.
- This is a perspective and intent-fidelity change, not a permission, approval, or execution-control redesign. It does not promise complete historical recovery, guaranteed model interpretation, or a new hard wall-clock timeout.
- This change contains planning artifacts only. Implementation and any paid real-model comparison require subsequent explicit requests.
