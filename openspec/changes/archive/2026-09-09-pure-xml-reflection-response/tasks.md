# Tasks: pure-xml-reflection-response

## 1. Prompt wording

- [x] 1.1 In `src/reflection-protocol.ts`, replace the "End the response with exactly one trailing..." XML-contract sentence in `buildReflectionPrompt` with an entire-response requirement (exactly one `<reflection>` XML document, no text before or after), framing the five fields as where observations and reasoning are expressed — verify: updated prompt-string assertions in `test/reflection-protocol.test.ts` match the new sentence.
- [x] 1.2 In `src/reflection-protocol.ts`, reword `buildReflectionReaskPrompt` to the same entire-response contract while keeping the shared tool-call budget sentence — verify: reask prompt contains no "trailing" prose-first phrasing.
- [x] 1.3 In `src/prompts.ts`, redirect the Oracle persona's speaking-style guidance into the XML field content so it no longer implies spoken output outside the XML document — verify: persona text contains no instruction to produce outer prose.

## 2. Tests

- [x] 2.1 Update `test/reflection-protocol.test.ts` prompt assertions for the new contract wording, and add assertions that the prompt contains no "trailing"/"End the response" phrasing — verify: `npm test` (reflection-protocol suite) passes.
- [x] 2.2 Confirm parser leniency unchanged: existing `parseReflectionXml` tests still pass without modification — verify: no test under `test/` that exercises `parseReflectionXml` is edited.

## 3. Integration verification

- [x] 3.1 Run the full unit test suite and the project's check/build commands — verify: `npm test` and the repo's typecheck/build steps exit cleanly (`npm run check` exit 0).
