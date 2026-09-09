# reflection-response-contract Specification

## Purpose

Define the response-shape contract the reflection prompt communicates to the model, so the model outputs a pure XML document whose structured fields carry the analysis, while parser acceptance remains lenient for partial compliance.

## Requirements

### Requirement: Entire response is the reflection XML document

The reflection prompt SHALL instruct that the entire assistant response consist of exactly one `<reflection>` XML document, with no text before or after it. The prompt SHALL NOT invite, permit, or imply free prose outside the XML block. The prompt SHALL state that the structured fields are where the reflection's observations and reasoning are expressed.

#### Scenario: Prompt forbids prose around the XML

- **WHEN** `buildReflectionPrompt` renders its XML-contract instructions
- **THEN** the prompt requires the whole response to be the single reflection XML document
- **AND** it contains no wording that permits explaining before or after the block

#### Scenario: Fields framed as the reasoning space

- **WHEN** the prompt describes how to express the reflection
- **THEN** it directs analysis, observations, and any persona voice into the five fields rather than into surrounding text

### Requirement: Persona voice lives inside the fields

The default reflection perspective SHALL direct its speaking-style guidance to the content of the five XML fields. It SHALL NOT instruct the model to produce spoken-style output that would exist outside the XML document.

#### Scenario: Oracle persona redirects its voice

- **WHEN** the default perspective prompt is rendered
- **THEN** its communication guidance applies to the field values (for example, the reason field)
- **AND** it does not conflict with the pure-XML response requirement

### Requirement: Reask prompt states the same response shape

A reask after an invalid reflection response SHALL state the same entire-response contract: exactly one valid `<reflection>` XML document and nothing else.

#### Scenario: Reask wording matches the initial contract

- **WHEN** `buildReflectionReaskPrompt` renders a correction prompt
- **THEN** it demands the full response be the single valid reflection XML document
- **AND** it repeats the shared tool-call budget constraint

### Requirement: Lenient parser acceptance is unchanged

Parser acceptance SHALL remain unchanged: a response whose non-thinking text ends with exactly one valid `<reflection>` block remains valid even if unrelated text precedes the block, and all existing field, case-insensitivity, duplication, size-limit, and reask-count behaviors are preserved.

#### Scenario: Stray prose before a valid block still parses

- **WHEN** a response contains prose before a valid trailing reflection XML block
- **THEN** parsing succeeds exactly as before this change
