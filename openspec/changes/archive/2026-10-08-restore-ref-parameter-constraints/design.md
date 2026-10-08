## Context

See proposal.md for motivation and `specs/reflection-response-contract/spec.md` for the required behavior.

Apply baseline:

- `ref` is registered once in `createWatchdogExtension` with `Type.Object({}, { additionalProperties: true })`. All result checks happen in `parseReflectionArguments` inside `execute`, after the confirmed-attempt authorization check.
- The owned `message_end` handler (registered `uninterruptible`) captures the current attempt's assistant message, marks a no-call response invalid, and otherwise keeps tool calls and thinking executable. `agent_settled` turns `active.planned` into acceptance, a correction prompt (fewer than three attempts), failure cleanup, or — when nothing was planned — `handle.cancel()`.
- The installed Pi (0.99.2) runs `prepareArguments` before native schema validation, then `beforeToolCall`/`tool_call`, then `execute`. A schema failure becomes a `Validation failed for tool "ref"` tool result, and the agent loop requests another model reply.

That native path is the hazard a constrained schema introduces: today a malformed owned call reaches `execute`, is recorded in `active.planned`, and terminates the batch. With a constrained schema, the same call would fail natively before `execute`, leave `planned` unset, cause an extra provider request, and settle as a cancellation instead of a counted invalid attempt.

## Goals / Non-Goals

**Goals:**

- Publish the result contract as standard tool-schema structure while keeping the declaration free of explanatory text.
- Keep every currently accepted input accepted and every currently rejected input rejected.
- Keep schema-invalid owned responses inside the existing three-attempt correction flow with no extra provider request.

**Non-Goals:**

- Provider-side constrained sampling (`constrainedSampling`) or any claim of strict generation.
- Changing the persisted report format, completion hook, lookup budget, triggers, prompts' semantics, or the `cw` plugin.
- Expressing the 16,384 code-point serialized limit or duplicate-name detection in the schema.

## Decisions

### 1. Schema shape: closed object of five nonblank strings

```ts
Type.Object(
  {
    type: Type.String({ enum: ["NO_ISSUE", "ROUTE_CORRECTION"] }),
    reason: Type.String({ minLength: 1, pattern: "\\S" }),
    done: Type.String({ minLength: 1, pattern: "\\S" }),
    current_step: Type.String({ minLength: 1, pattern: "\\S" }),
    next_step: Type.String({ minLength: 1, pattern: "\\S" }),
  },
  { additionalProperties: false },
)
```

All five are required by default. `additionalProperties: false` matches the existing "exactly five fields" rule, unlike `cw`, whose contract tolerates extras. No `description`, `title`, `examples`, or `default` keywords. `type` uses a string enum rather than a literal union so providers receive a plain `enum` array.

Alternative considered: keep `additionalProperties: true` for symmetry with `cw` — rejected because extras are already invalid for `ref`, and declaring them allowed would contradict the runtime.

Alternative considered: per-field `maxLength` — rejected; the limit applies to the serialized object, so any per-field bound would be either wrong or redundant. The runtime check stays authoritative.

### 2. One parser, two uses

`parseReflectionArguments` remains the single source of truth. A new pure `prepareReflectionArguments(raw)` in `reflection-protocol.ts` produces the declared form only for compatible input:

- Non-object input, or names colliding after lowercase folding: return `raw` unchanged.
- Otherwise rebuild the object with lowercase names, trimming string values; uppercase `type` only when it matches a known value case-insensitively.
- Never add, drop, rename-to-something-else, or coerce. Unknown fields keep their (lowercased) names and fail the closed declared schema; non-string values pass through untouched and fail its string constraint.

It is wired as `prepareArguments` on the `ref` registration. Unit fixtures compare `parseReflectionArguments(raw)` with pure declared-schema checking of prepared input for structurally expressible rules. Serialized size and case-folded duplicate detection remain parser checks; duplicates also fail the closed schema when left unchanged. This is not universal parity with Pi's native validator: Pi 0.99.2 converts primitive values before checking, and fixtures with numeric, boolean, or null `reason` values pass that native conversion path despite failing both the declared string contract and the raw-input parser. Owned pre-dispatch validation and the ordinary authorization gate remain essential.

Alternative considered: duplicating validation logic in a schema-only checker — rejected (two sources of truth).

### 3. Pre-dispatch projection in the owned `message_end`

Extend the existing owned handler instead of adding a hook. For the captured current-attempt message:

- If any `ref` call's raw arguments fail `parseReflectionArguments`, and nothing is planned yet, set `active.planned = { error }` with the parser's safe message and return the neutralized message with `content: []` and `stopReason: "stop"`. No call — including lookup calls in the same response — reaches dispatch, so neither native validation nor an extra request can occur, and suppressed lookups never reach `tool_call` budget accounting.
- Otherwise keep today's behavior (no-call → invalid; valid calls stay executable and `execute` records the plan).

Validating raw arguments with the case-insensitive parser is equivalent to validating prepared arguments, so `message_end` and native dispatch cannot disagree on a valid call. `execute` keeps its authorization check and parser call as defense in depth.

This mirrors the projection the `cw` change already ships and keeps the projection inside the handler that already owns attempt capture. Settlement needs no change: a planned error already yields a correction prompt or failure cleanup.

Alternative considered: letting native validation fail and recording the error from `tool_result`/`turn_end` — rejected; the native loop has already requested the extra reply by then, which is the outcome to prevent.

Alternative considered: suppressing only the invalid `ref` call and keeping lookups — rejected; the attempt is already invalid, so running lookups would spend budget on a response that cannot produce a result.

### 4. Ordinary calls remain native-or-reserved

No change for unowned messages: the handler returns early. If Pi rejects an ordinary `ref` call during native validation, ordinary work receives the native error and can continue. If native validation accepts it, including after host primitive conversion, `execute` rejects it with the reserved-function error. Neither path touches watchdog state. The declared contract does not imply that the host rejects every structurally invalid raw value.

## Risks / Trade-offs

- [Native validator differs from the plugin parser on an edge case, e.g. Unicode whitespace in `pattern: "\\S"`] → Owned responses are judged by the plugin parser before dispatch, so a disagreement only affects which error an ordinary call receives; add a parity fixture for whitespace-only values.
- [`prepareArguments` throws on unexpected input] → Implement as total and pure; fall back to returning `raw`.
- [Provider or Pi version that ignores `prepareArguments`] → Mixed-case inputs could fail native dispatch even after passing the owned parser. Compatibility was verified on Pi 0.99.2 with preparation enabled; support for hosts that omit this hook is not established.
- [Suppressing a whole response hides useful lookups] → Acceptable: the attempt is invalid and is re-asked with the same remaining budget.
- [Schema change alters provider prompt-cache prefixes once] → One-time change; the declaration remains stable thereafter.

## Formal verification scope

The Lean document models the fixed declaration as structural flags, takes raw-argument validity as an input classification, and proves invalid owned results expose zero executable calls. It distinguishes lookup-only work from result submission and bounds result attempts, not all provider requests. Parser/schema equivalence, primitive conversion, native dispatch, and the shared ten-lookup budget remain covered by executable tests rather than this abstraction. Lifecycle and peer-accounting models are not composed into a runtime-refinement or eventual-progress proof.

## Migration Plan

Single release with no data migration. Persisted entries and hooks are unchanged. Rollback is reverting the commit; older sessions remain readable either way.
