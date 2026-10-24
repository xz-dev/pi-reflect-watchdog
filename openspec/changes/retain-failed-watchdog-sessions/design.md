## Context

See [proposal](proposal.md) and the [canonical joint design](../../../../pi-continue-watchdog/openspec/changes/retain-failed-watchdog-sessions/design.md). This companion records Reflect-specific integration only; shared retention and availability semantics have one owner.

`src/extension.ts` runs the shared private inquiry with native provider retries and a read-only-evidence helper profile. `forkObservedChild` already forwards the child's session file. `runPrivateReflection` currently warns on `decision-failed` and thrown exceptions, but not a returned `execution-error`. Every path releases the reflection slot in `finally`; only successful, current results with an exact private-source match publish a report and continuation.

## Goals / Non-Goals

**Goals:**
- Add consistent final-failure diagnostics at Reflect's existing consumer boundary.
- Preserve its exact child association, native retry behavior and unconditional slot release.

**Non-Goals:**
- A Reflect-owned backup writer or independent file search.
- Additional path warnings during local corrections or native provider retry.
- Changes to successful report/feedback content, helper budgets, scheduling, cancellation or accounting.

## Decisions

### 1. Consume the shared locator without substituting the parent session

Adopt the same compatible `pi-extension-utils` revision as Continue. Preserve the additive session/availability metadata through the observed-child wrapper. Use only the exact private child's retained locator supplied by that operation; `ctx.sessionManager.getSessionFile()` remains a parent-history input, never a fallback diagnostic session path.

Alternative rejected: derive a fork location in Reflect. The runtime already knows it, including when setup fails after file creation.

### 2. Make both terminal failure outcomes visible once

Handle returned `execution-error` and `decision-failed` through one terminal human-notification policy after the existing `isCurrent()` check. Include plugin identity, safe failure summary, and either the verified full absolute JSONL path or explicit evidence-unavailable reason. Do not duplicate the same final notice via both the returned-result branch and the exception handler.

The shared operation owns child teardown and evidence availability. Truly thrown errors without child metadata must not make Reflect invent a locator or claim retention; they retain the existing bounded failure handling with an honest unavailable-evidence statement when applicable.

Keep current intermediate invalid-attempt warnings. A later valid reflection publishes normally, without a new session-path warning. Do not introduce per-transport-retry notices.

Alternative rejected: only decorate `decision-failed`. That leaves provider/setup/filesystem execution failures unexplained.

### 3. Keep notices outside reflection content and execution authority

Use the existing human-notification facility; do not add the JSONL path to reports, feedback/steering, completion hooks or model-bound context. Expected abort/withdrawal, takeover, shutdown and stale outcomes remain silent with respect to this feature. Optional diagnostic errors never bypass currentness or block `finally` slot release.

A failed inquiry still publishes no reflection result, completion entry/hook or continuation. Retention does not reset response/helper allowances or schedule a new reflection. This feature does not alter unrelated post-result publication failure behavior.

## Risks / Trade-offs

- Full private sessions can contain sensitive inherited history -> local retention only, no raw-content preview or automatic upload; documentation explains sharing risk.
- Evidence can be absent before child creation or unavailable after storage failure -> display that state rather than the parent session or an unverified path.
- Late asynchronous outcomes can reach an updated UI -> preserve existing owner/currentness fencing before notices, just as before publication.
- Two plugins share one dependency -> verify both consumers against the same shared revision before joint acceptance.

## Migration Plan

1. Wait for the shared metadata/retention contract from the Continue-owned joint work.
2. Adopt that revision, forward metadata if needed, and add terminal failure notices without touching successful report generation or dispatch policy.
3. Verify retained JSONL and notification content in existing private-reflection/runtime tests, including cancellation, corrected success and slot release; update user documentation and affected process models during implementation.
4. Roll back consumer adoption without deleting existing diagnostic sessions. No persisted reflection-entry migration is required.
