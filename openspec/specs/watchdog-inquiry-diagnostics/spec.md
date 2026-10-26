# watchdog-inquiry-diagnostics Specification

## Purpose

Give Reflect users inspectable local session evidence for final private reflection failures, following the joint watchdog contract without leaking private exchanges into reflection feedback or main-model context.

## Requirements

### Requirement: Reflect retains exact-child evidence for final inquiry failure

Reflect SHALL follow the evidence-retention guarantees of the Continue-owned joint `watchdog-inquiry-diagnostics` contract for current terminal private-inquiry execution failures and exhausted invalid-result corrections, while applying this specification's Reflect-specific last-error notice rules. The failed child's existing native JSONL SHALL survive operation cleanup and normal extension teardown, retaining available partial history when a response cannot finish. The main session or another child's session SHALL NOT be substituted. A setup failure after a known fork file was created SHALL retain and disclose that file when availability can be verified; setup before file creation SHALL be reported as lacking a private session.

#### Scenario: Reflection exhausts result corrections
- **WHEN** a current private reflection exhausts its allowed invalid-result attempts
- **THEN** its exact private JSONL remains available for inspection after cleanup
- **AND** the retained evidence includes the inquiry and correction exchanges actually persisted

#### Scenario: Reflection execution fails after fork creation
- **WHEN** a current reflection suffers an execution failure after its native fork JSONL exists
- **THEN** its available private history is retained
- **AND** failure before a complete final response does not require discarding the file

### Requirement: Reflect exposes terminal execution and validation failure paths once

Reflect SHALL explicitly notify the user of both returned terminal execution failures and exhausted invalid-result failures. Each current failed operation SHALL emit at most one human-only retention/path notice, combined with its existing terminal warning, with Reflect identity, the existing host-owned failure summary, the last available error preview defined below, and the full copyable absolute private-session path verified after settlement. Setup failures SHALL use the same preview behavior when a final error is available. When no session exists or retention cannot be verified, the notice SHALL state that evidence is unavailable with a bounded safe reason. It SHALL NOT invent a path, show the parent session as failed-child evidence, claim an unverified file was saved or replace the original failure with an evidence error.

#### Scenario: Shared inquiry returns an execution failure
- **WHEN** a current reflection returns a terminal execution failure with an accessible private session JSONL and a final provider error
- **THEN** one terminal human notice identifies Reflect, the existing failure summary, the final error preview and the exact file's full absolute path
- **AND** the failure is not silently omitted because it is not an exhausted invalid-result failure

#### Scenario: Reflection cannot create a private session
- **WHEN** setup fails before a private JSONL is created
- **THEN** the human notice reports the failure, its final error preview when available, and that no private session was created
- **AND** the notice contains no invented saved-session location

#### Scenario: Private session availability cannot be verified
- **WHEN** the known private session file is missing, unreadable or not confirmable as the retained regular session file at notification preparation
- **THEN** the notice preserves the original inquiry failure summary and error preview while reporting evidence unavailable
- **AND** an evidence-check error does not replace the inquiry error or claim that a diagnostic session was successfully retained

#### Scenario: Result corrections are exhausted
- **WHEN** a current reflection exhausts its allowed invalid-result corrections
- **THEN** the existing terminal warning includes the last validation error preview and session evidence information
- **AND** it does not concatenate earlier validation errors or emit a second terminal notice

### Requirement: Reflect displays only the last error within two terminal rows

A terminal failure notice SHALL include at most one `Last error:` preview from the current operation's final failure. It SHALL NOT select an earlier retry error, an inherited parent-session error or an unrelated helper error. When final error text is missing or blank, the notice SHALL omit the preview and keep the existing failure summary and evidence information.

The preview SHALL display the error as ordinary text in its original order rather than replacing it with a summary or category; only normal terminal text layout and truncation SHALL be applied. Including its label and truncation indicator, it SHALL occupy at most two display rows at the terminal width sampled when the notice is emitted, accounting for the notification area's horizontal padding. Width SHALL be measured in terminal display columns rather than string length. Text beyond the second row SHALL be omitted with an ellipsis fitting inside that row. Existing line breaks SHALL not bypass the two-row bound. If terminal width is unavailable or invalid, formatting SHALL use an 80-column terminal fallback. The existing summary and full copyable evidence path SHALL remain outside the error preview's two-row budget; error truncation SHALL NOT truncate the path or rewrite the retained JSONL. This feature SHALL NOT add live resize handling for previously emitted notices.

#### Scenario: Final provider error is immediately visible
- **WHEN** a current reflection fails with `openai-api-extension API error (400): {"code":"model_not_found","message":"unknown provider for model aihub/gpt-6.1-sol","type":"upstream_error"}`
- **THEN** the notice includes that final error text after `Last error:` to the extent it fits within two rows
- **AND** it preserves the full retained-session path separately

#### Scenario: Earlier retry errors differ from the terminal error
- **GIVEN** the current reflection first reports a connection error and later terminates with a different model error
- **WHEN** its final failure notice is emitted
- **THEN** the preview uses only the terminal model error
- **AND** it does not include the earlier connection error or any inherited parent error

#### Scenario: Long or multiline error exceeds the display budget
- **WHEN** the labeled final error would occupy more than two rows at the current notification width
- **THEN** the preview keeps only the first two display rows with an ellipsis inside the second row
- **AND** multiline text, long unbroken strings and wide Unicode characters cannot expand the preview beyond that budget
- **AND** the full session path remains present outside the clipped preview

#### Scenario: Terminal width changes between notices
- **WHEN** two separate failures are notified at different terminal widths
- **THEN** each preview uses the width at its own notification time
- **AND** no resize listener or replacement notice is required for the earlier failure

#### Scenario: Notification runs without a measurable terminal
- **WHEN** the host exposes no valid terminal width
- **THEN** the preview uses the same two-row rule with an 80-column terminal fallback
- **AND** notification and cleanup do not require opening an interactive UI

#### Scenario: Final error has no text
- **WHEN** the current failure provides no nonblank final error text
- **THEN** the notice preserves the existing failure summary and session evidence information without a `Last error:` section
- **AND** Reflect does not search earlier history for a replacement error

### Requirement: Reflect excludes recovery and cancellation from final-failure notices

A successful reflection, including one recovered by allowed result corrections or native transport retries, SHALL NOT trigger the new session-path notice. Existing per-invalid-attempt warnings SHALL remain unchanged. Abort/withdrawal, user takeover, shutdown and stale operations SHALL NOT be reclassified as failures for this feature. Existing currentness/ownership checks SHALL qualify notification immediately before it is delivered.

#### Scenario: Reflection succeeds after one invalid result
- **WHEN** a first invalid result is corrected successfully within the existing allowance
- **THEN** Reflect keeps its existing intermediate warning and successful publication behavior
- **AND** it emits no new retained-session path notice

#### Scenario: Reflection is cancelled or becomes stale
- **WHEN** a pending private reflection is withdrawn, aborted, invalidated by takeover or replaced by another session
- **THEN** the operation follows existing cancellation and cleanup rules
- **AND** no new final-failure/path notice is published into the current or replacement session

### Requirement: Reflect diagnostics preserve isolation and slot release

The failure notice, including the last error preview, path and evidence-availability information, SHALL remain human-only, outside reflection reports, feedback/steering, model-bound context and completion hooks. The bounded last-error preview is an explicit exception to the prohibition on displaying provider or exception text: text already contained in the final error SHALL be eligible for display without an additional Reflect-specific redaction or classification layer. Reflect SHALL NOT separately copy private assistant responses, thinking, tool arguments or transcript excerpts into the notice. Retained JSONL SHALL remain local with no automatic upload or expanded access permissions. Failed inquiries SHALL still publish no successful reflection result, completion hook or continuation. Error formatting, evidence verification or notification failure SHALL NOT prevent slot release, alter helper/response allowances, schedule another reflection or restore execution authority. Existing temporary result cleanup and successful-session storage behavior SHALL remain unchanged; this feature SHALL NOT introduce automatic diagnostic expiry or replay on restart.

#### Scenario: Failed reflection contains sensitive history
- **WHEN** a reflection fails after inheriting private user history or reading local evidence
- **THEN** the notice contains only the existing failure summary, the bounded final-error preview when available, and session availability/path
- **AND** Reflect does not attach separate conversation, thinking or tool-content excerpts
- **AND** none of the notice content is copied into reflection feedback, model context or an upload

#### Scenario: Final error contains provider response text
- **WHEN** the final error text contains a provider response body or diagnostic identifiers
- **THEN** that text is eligible for the two-row preview as ordinary error text
- **AND** Reflect does not replace it with a category or add custom credential-redaction rules

#### Scenario: Failure diagnostic cannot be delivered
- **WHEN** error formatting, notification or evidence verification fails while handling a terminal reflection failure
- **THEN** the private operation still releases its slot through existing cleanup
- **AND** the diagnostic fault causes no successful report, continuation, extra reflection dispatch or model request

#### Scenario: Retained failed reflection exists after reload
- **WHEN** Reflect reloads while a failed private-session JSONL remains on disk
- **THEN** the evidence remains available for user inspection
- **AND** Reflect does not resume that inquiry or replay its result merely because the file exists
