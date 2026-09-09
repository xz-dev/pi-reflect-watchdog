# Design: pure-xml-reflection-response

## Context

`buildReflectionPrompt` ends its instructions with "End the response with exactly one trailing `<reflection>...</reflection>` XML block." Combined with the Oracle persona's speaking instructions ("Speak calmly, kindly, and directly..."), the model believes it should narrate first and append XML afterwards. The narration is then destroyed by `handle.neutralize()` (`content: []`) and the stored report is built only from the five fields. The prose has zero downstream consumers.

Two concrete failure modes follow: wasted tokens/time, and invalid-XML reasks when the model puts conclusions in prose, writes past the 16,384-code-point cap shared with tool-use text, or forgets the block. The design intent of "slow-thinking space for weak models" is already served by the free-text fields themselves; the unstructured preamble adds failure modes, not reasoning capacity.

## Goals / Non-Goals

**Goals:**

- Prompt wording demands the entire response be the one XML document.
- Redirect persona voice into the fields so the perspective contract stays intact.
- Keep parser, budgets, reask counts, folding, and report storage untouched.

**Non-Goals:**

- Changing `parseReflectionXml` or `extractTrailingXml` leniency.
- Changing the five-field shape, validation rules, or case-insensitivity.
- Adding any new enforcement beyond wording.

## Decisions

### Decision 1: Teach strictly, parse leniently

The prompt switches from "end with a trailing block" to "your entire response must be exactly one `<reflection>` XML document; no text before or after it." The parser's trailing-block extraction already accepts a pure-XML response (`lastIndexOf(open) === 0`), so pure output needs no parser change. Conversely, a weak model that still emits stray prose before a valid block keeps parsing successfully—leniency is the safety net, not the teacher. No dual-mode behavior is added.

### Decision 2: Fields are the named slow-thinking space

The prompt explicitly states that observations and reasoning belong in the fields (reason/done/current_step/next_step). The persona's speaking guidance is redirected: its voice applies to field content. This preserves the conversation-grounded perspective requirements while removing the implicit license for outer prose.

### Decision 3: Reask prompt mirrors the contract

`buildReflectionReaskPrompt` currently repeats "End with one valid trailing reflection XML block." It is reworded to the same entire-response contract so a corrective attempt is not re-taught the prose-first habit. The shared tool-call budget sentence stays.

## Risks / Notes

- Models without thinking blocks lose an unstructured scratchpad. Mitigation: fields are free text sized for it; reask x3 catches shape failures; parser leniency accepts partial compliance.
- Prompt-string tests assert current wording and must be updated in the same change.
- `MAX_REFLECTION_REASKS` comment references the continue-watchdog contract; the sibling repo gets the same wording change so the cross-project comment stays accurate.
