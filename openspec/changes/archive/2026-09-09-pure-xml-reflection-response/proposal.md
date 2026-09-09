# Proposal: pure-xml-reflection-response

## Why

The reflection prompt tells the model to "End the response with exactly one trailing reflection XML block", which invites free prose before the XML. That prose is immediately neutralized (`content: []`) and never stored or shown—no consumer exists—so it only burns tokens, risks the shared 16,384-code-point cap on non-thinking text, and causes invalid-XML reasks when the model writes conclusions in prose instead of the fields.

## What Changes

- The reflection prompt (and reask prompt) now require the **entire response to be exactly one `<reflection>` XML document, with no text before or after it**.
- The five structured fields are explicitly framed as the reasoning space; the Oracle persona's "speak" instructions are redirected into those fields.
- The parser stays lenient (trailing-XML extraction unchanged): a response that still carries stray prose before a valid trailing block remains valid. Strict wording teaches; lenient parsing catches.
- No parser, budget, reask, or fold behavior changes.

## Capabilities

### New Capabilities

- `reflection-response-contract`: requirements for the wording of the reflection response prompt—the pure-XML response shape, field-level reasoning framing, and lenient parser acceptance.

### Modified Capabilities

- `conversation-grounded-reflection`: the prompt suffix that instructs the response shape changes from "end with trailing XML" to "entire response is the XML document"; no requirement semantics (perspective, history, fidelity) change.

## Impact

- `src/reflection-protocol.ts`: `buildReflectionPrompt` XML-contract sentence and `buildReflectionReaskPrompt` wording.
- `src/prompts.ts`: `DEFAULT_REFLECTION_PROMPT` persona speaking instructions redirected into the XML fields.
- `test/reflection-protocol.test.ts`: prompt-string assertions updated to the new wording.
