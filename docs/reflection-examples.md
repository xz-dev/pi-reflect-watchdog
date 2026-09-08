# Conversation-grounded reflection examples

These are self-contained, synthetic regression dialogues derived from the approved `ground-reflection-in-conversation` design, not verbatim customer transcripts. Keep each exchange intact when evaluating: assistant replies explain what the later user correction refers to.

## 1. The agent changes the subject

**User:** I want the watchdog to offer a third-party perspective, question how the task is understood, and notice directions neither of us has considered.

**Assistant:** We could track approvals and distinguish proposed actions from authorized actions with a new decision state machine.

**User:** This has nothing to do with permissions or actual execution. It is about the thinking perspective. I do not want the observer to miss what I said and replace my meaning with the agent's interpretation.

**Assistant:** Then we could extract a list of user quotations as the definitive goal before each review.

**User:** Complaints can be clarified by later replies; several turns together may carry the meaning. Keep the context state machine simple and leave the agent free to explore goals and directions.

- **Fidelity:** Notice the shift from thinking perspective to approval machinery; do not present the assistant's proposals as user requirements.
- **New perspective:** Question how the observer forms its understanding without assuming a new ledger, checklist, or state machine is necessary. A different useful insight is allowed if grounded in these exchanges.
- **Failure to watch for:** Improving the approval system or treating isolated quotations as a complete interpretation despite the corrections.

## 2. A complaint has a clarified referent

**User:** The importer must report invalid rows. We only need to import CSV files in this project.

**Assistant:** I propose three abstraction layers: a format registry, a parser factory, and an import strategy interface.

**User:** Too complicated.

**Assistant:** We can make it shorter by removing invalid-row handling.

**User:** No, I meant the three layers of abstraction. Invalid rows still need to be reported.

- **Fidelity:** Keep invalid-row reporting; connect the complaint to its clarified referent rather than treating it as meaningless or as permission to remove error handling.
- **New perspective:** Explore a smaller importer design without inventing an additional user requirement or assuming every abstraction is always wrong.
- **Failure to watch for:** Reporting that the user asked for fewer checks, or assessing only the final sentence without the proposal it corrects.

## 3. Both participants share a questionable premise

**User:** During development I need quick feedback on the one module I changed. The full build is a separate release check.

**Assistant:** Let's speed up full rebuilds. We could add more workers or cache the build outputs.

**User:** More workers may consume too much memory. Could caching help?

**Assistant:** We can compare a local cache with a shared cache for every edit.

**User:** Which option would you explore first?

- **Fidelity:** Remember the original feedback need and the distinction between edit-time feedback and release validation.
- **New perspective:** Question whether every edit requires a full rebuild. A focused check is an inference to explore, not a user quotation or proof that the full release build can be removed.
- **Failure to watch for:** Optimizing only the two cache options, or incorrectly claiming the user requested removal of release validation.

## Comparison procedure

1. Obtain approval for the model, data, settings, and cost before making real-model calls. Use the same complete dialogue and model/settings for both versions.
2. Baseline: `6ba4219dd6216b607dad6d2d4425b35b843226e7`. Record the candidate revision or working-tree diff being evaluated. Do not silently change the dialogue or prompt between observations.
3. Judge fidelity and useful new perspective separately. Neither agreement with the user nor always emitting `ROUTE_CORRECTION` is the goal. Check that claims attributed to the user are supported by the exchange.
4. Record tool calls and elapsed time. Lookups should address a concrete uncertainty and stop once sufficient; unavailable evidence should remain an explicit uncertainty rather than motivate extended investigation. No new numeric wall-clock acceptance limit is implied.
5. Report raw observations and limitations separately from mechanical test results. Do not turn canned provider responses or prompt-string assertions into evidence of better model understanding.

## Validation status

**Real-model comparison: not run.** Model/data/cost approval is separate from implementation. These fixtures specify what to inspect; they are not observed model outputs or a semantic-quality result. Local automated tests cover prompt delivery, locator handling, XML and lifecycle compatibility, not interpretation fidelity or prevention of timeouts.
