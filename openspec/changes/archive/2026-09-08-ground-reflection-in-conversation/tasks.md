## 1. Reflection perspective and source framing

- [x] 1.1 Add the concise multi-turn third-party perspective to `src/prompts.ts`, preserving the existing open-ended Oracle framing; verify the default-prompt coverage checks that the agent's interpretation can be questioned without adding a mandatory reasoning checklist.
- [x] 1.2 Update the previous-report label and the XML example's suggested-next-step wording in `src/reflection-protocol.ts`; verify prompt tests identify the report as fallible assistant analysis and the existing five-field/two-type parser tests remain unchanged and pass.
- [x] 1.3 Replace route-verification-only tool guidance with quick, targeted clarification guidance, including stopping when sufficient and finishing with uncertainty instead of long investigations or background waits; verify this guidance remains present with a custom semantic prefix and still states the existing shared ten-call budget.

## 2. Optional history locator without new state

- [x] 2.1 Add an optional session-file/branch-anchor input to `ReflectionPromptContext` and render it as JSON data with focused, branch-aware recovery guidance; verify prompt tests cover both values present, missing file, missing anchor, quoting/newlines, and the absence of any mandatory transcript read.
- [x] 2.2 Populate the locator through the public session metadata getters immediately before the initial inquiry in `beginReflection()` and update the existing runtime fixture; verify tests use the current dispatch context, handle an in-memory/empty session, and do not require transcript I/O or branch reconstruction in the plugin.
- [x] 2.3 Keep the locator out of pending/active lifecycle records, persisted reflection results, and semantic-hook values; verify result/hook shape assertions and XML re-ask tests demonstrate no new report version, locator store, or refreshed tool budget.

## 3. Ordinary continuation remains ordinary

- [x] 3.1 Reword only the route-correction handoff content in `finishReflection()` to invite reconsideration and present the report as observations/suggestions; verify the runtime test asserts exactly one native steer continuation and preserves the first-line no-reflection/no-XML-priming assertion.
- [x] 3.2 Run the existing focused lifecycle tests after the prompt/handoff changes; verify no-issue handling, fold order, counter exclusions, invalid-XML retries, cooldown, cross-process coordination, and completion-hook timing remain intact without changing their contracts.

## 4. Documentation and validation

- [x] 4.1 Update `README.md` to describe contextual third-party assessment, optional history recovery, fallible-report framing, and brief clarification tools; verify it distinguishes prompt-level duration guidance from a hard timeout and notes that locator text follows ordinary inquiry transcript persistence.
- [x] 4.2 Prepare the three full multi-turn dialogue cases from `design.md` using the existing fixture/documentation conventions, without a new framework or a model call; verify each retains the assistant replies and later corrections needed to interpret the user and has separate fidelity/new-perspective expectations.
- [x] 4.3 Run `npm run check`, `npm run test:e2e:fast`, and `npm run test:e2e` after implementation, extending only relevant existing host fixtures if necessary; verify the actual inquiry receives the locator/guidance, the handoff remains ordinary, and failures are reported rather than bypassed by relaxing lifecycle assertions.
- [x] 4.4 Record behavioral validation separately from mechanical results: after explicit model/data/cost approval, compare baseline and candidate on the three dialogues with the same model/settings and record observations, tool calls, and elapsed time; otherwise deliver an explicit not-run limitation without claiming semantic fidelity or timeout prevention.
- [x] 4.5 Inspect the final diff and validation summary; verify no new state transition, result type, dependency, configuration knob, retrieval service, extra model request, or cross-plugin interface was added, and preserve unrelated existing changes.
