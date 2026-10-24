## Purpose

Give Reflect users inspectable local session evidence for final private reflection failures, following the joint watchdog contract without leaking private exchanges into reflection feedback or main-model context.

## ADDED Requirements

### Requirement: Reflect retains exact-child evidence for final inquiry failure

Reflect SHALL follow the Continue-owned joint `watchdog-inquiry-diagnostics` contract for current terminal private-inquiry execution failures and exhausted invalid-result corrections. The failed child's existing native JSONL SHALL survive operation cleanup and normal extension teardown, retaining available partial history when a response cannot finish. The main session or another child's session SHALL NOT be substituted. A setup failure after a known fork file was created SHALL retain and disclose that file when availability can be verified; setup before file creation SHALL be reported as lacking a private session.

#### Scenario: Reflection exhausts result corrections
- **WHEN** a current private reflection exhausts its allowed invalid-result attempts
- **THEN** its exact private JSONL remains available for inspection after cleanup
- **AND** the retained evidence includes the inquiry and correction exchanges actually persisted

#### Scenario: Reflection execution fails after fork creation
- **WHEN** a current reflection suffers an execution failure after its native fork JSONL exists
- **THEN** its available private history is retained
- **AND** failure before a complete final response does not require discarding the file

### Requirement: Reflect exposes terminal execution and validation failure paths once

Reflect SHALL explicitly notify the user of both returned terminal execution failures and exhausted invalid-result failures. Each current failed operation SHALL emit at most one new human-only retention/path notice, combined with its existing terminal warning where possible, with Reflect identity, a bounded safe failure summary and the full copyable absolute private-session path verified after settlement. When no session exists or retention cannot be verified, the notice SHALL state that evidence is unavailable with a bounded safe reason. It SHALL NOT invent a path, show the parent session as failed-child evidence, claim an unverified file was saved or replace the original failure with an evidence error.

#### Scenario: Shared inquiry returns an execution failure
- **WHEN** a current reflection returns a terminal execution failure with an accessible private session JSONL
- **THEN** one terminal human notice identifies Reflect, the safe failure summary and the exact file's full absolute path
- **AND** the failure is not silently omitted because it is not an exhausted invalid-result failure

#### Scenario: Reflection cannot create a private session
- **WHEN** setup fails before a private JSONL is created
- **THEN** the human notice reports the failure and that no private session was created
- **AND** the notice contains no invented saved-session location

#### Scenario: Private session availability cannot be verified
- **WHEN** the known private session file is missing, unreadable or not confirmable as the retained regular session file at notification preparation
- **THEN** the notice preserves the safe inquiry failure summary and reports evidence unavailable
- **AND** it does not claim that a diagnostic session was successfully retained

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

The new path and evidence-availability information SHALL remain human-only, outside reflection reports, feedback/steering, model-bound context and completion hooks. Notices SHALL NOT echo raw private responses, provider response bodies, thinking or tool arguments. Retained JSONL SHALL remain local with no automatic upload or expanded access permissions. Failed inquiries SHALL still publish no successful reflection result, completion hook or continuation. Evidence verification or notification failure SHALL NOT prevent slot release, alter helper/response allowances, schedule another reflection or restore execution authority. Existing temporary result cleanup and successful-session storage behavior SHALL remain unchanged; this feature SHALL NOT introduce automatic diagnostic expiry or replay on restart.

#### Scenario: Failed reflection contains sensitive history
- **WHEN** a reflection fails after inheriting private user history or reading local evidence
- **THEN** the human notice contains only a safe summary and session availability/path
- **AND** the retained private content is not copied into reflection feedback, model context or an upload

#### Scenario: Failure diagnostic cannot be delivered
- **WHEN** notification or evidence verification fails while handling a terminal reflection failure
- **THEN** the private operation still releases its slot through existing cleanup
- **AND** the diagnostic fault causes no successful report, continuation, extra reflection dispatch or model request

#### Scenario: Retained failed reflection exists after reload
- **WHEN** Reflect reloads while a failed private-session JSONL remains on disk
- **THEN** the evidence remains available for user inspection
- **AND** Reflect does not resume that inquiry or replay its result merely because the file exists
