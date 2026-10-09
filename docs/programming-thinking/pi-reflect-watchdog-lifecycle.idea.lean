-- This executable process document models the minimal Reflect Watchdog rebuilt
-- on Pi's authoritative run lifecycle. It uses Lean core only and has no effects.
set_option autoImplicit false

namespace PiReflectWatchdogLifecycle

-- Process vocabulary separates ordinary work from watchdog-owned reflection
-- work and names the exact agent-produced replies that count as loops.
inductive RunKind where
  | ordinary
  | reflection
  deriving Repr, DecidableEq

inductive TurnOutcome where
  | stop
  | toolUse
  | error
  | aborted
  | length
  | pending
  | deferred
  | unknown
  deriving Repr, DecidableEq

-- One assistant reply as observed at turn end: provider outcome, whether a
-- plugin attached errorMessage or piInquiry, and whether the agent produced
-- non-empty text or a tool call.
structure AssistantReply where
  outcome : TurnOutcome
  hasErrorMessage : Bool
  isInquiryReply : Bool
  hasAgentOutput : Bool
  deriving Repr, DecidableEq

inductive Trigger where
  | rootLoopLimit
  | allLoopLimit
  | taskTimeLimit
  | userRequest
  deriving Repr, DecidableEq

inductive ReflectionDecision where
  | noIssue
  | routeCorrection
  deriving Repr, DecidableEq

inductive AttachmentPhase where
  | observer
  | main
  | shutdown
  deriving Repr, DecidableEq

-- Process data carries one attachment phase, one run classification, one
-- counter authority, one bounded manual waiting slot, and one active inquiry.
structure Counters where
  activeMs : Nat
  activeLoops : Nat
  taskMs : Nat
  rootLoops : Nat
  allLoops : Nat
  deriving Repr, DecidableEq

structure Limits where
  taskMs : Nat
  rootLoops : Nat
  allLoops : Nat
  deriving Repr, DecidableEq

structure State where
  phase : AttachmentPhase
  localBusy : Bool
  otherBusy : Bool
  runKind : RunKind
  counters : Counters
  limits : Limits
  pending : List Trigger
  inquiryActive : Bool
  continuationQueued : Bool
  -- Post-abort eligibility hold: only explicit user input or a fresh
  -- user-invoked /reflect releases it; background events never do.
  held : Bool
  deriving Repr, DecidableEq

inductive Event where
  | acquireMain
  | loseMain
  | userTakeoverMessage
  | terminalAbortSettled
  | explicitUserInput
  | agentStart (kind : RunKind)
  | observeOtherBusy (busy : Bool)
  | semanticHook (name : String)
  | activeTick
  | successfulTurn (reply : AssistantReply)
  | agentSettled
  | queueManualReflection
  | dispatchReflection
  | reflectionFinished (decision : ReflectionDecision)
  | shutdown
  deriving Repr, DecidableEq

-- Loop allowlist and threshold guards are total and derived from one state.
def modelTurnSucceeded : TurnOutcome → Bool
  | .stop | .toolUse => true
  | _ => false

def agentLoop (reply : AssistantReply) : Bool :=
  modelTurnSucceeded reply.outcome && !reply.hasErrorMessage &&
    !reply.isInquiryReply && reply.hasAgentOutput

def crossed (state : State) : List Trigger :=
  let root := if state.counters.rootLoops >= state.limits.rootLoops
    then [.rootLoopLimit] else []
  let all := if state.counters.allLoops >= state.limits.allLoops
    then [.allLoopLimit] else []
  let task := if state.counters.taskMs >= state.limits.taskMs
    then [.taskTimeLimit] else []
  root ++ all ++ task


-- Official aggregate busy state counts inquiry activity too. A pulse never creates intent.
def countTick (state : State) : State :=
  if state.localBusy || state.otherBusy then
    { state with counters :=
      { state.counters with
        activeMs := state.counters.activeMs + 1
        taskMs := state.counters.taskMs + 1 } }
  else state

def resetCycle (_counters : Counters) : Counters :=
  { activeMs := 0
    activeLoops := 0
    taskMs := 0
    rootLoops := 0
    allLoops := 0 }

-- Ordinary successful turns increment the loop counters exactly once.
-- Reflection turns and replies outside the allowlist preserve every counter.
def countTurn (state : State) (reply : AssistantReply) : State :=
  if agentLoop reply && state.runKind = .ordinary then
    let next :=
      { state with counters :=
          { state.counters with
            activeLoops := state.counters.activeLoops + 1
            rootLoops := state.counters.rootLoops + 1
            allLoops := state.counters.allLoops + 1 } }
    next
  else state

-- Lifecycle dispatch consumes only manual waiting work. Automatic acceptance/cooldown
-- resets are modeled by decideFresh below; finalization never resets accounting.
def step (state : State) (event : Event) : State :=
  if state.phase = .shutdown then state
  else
    match event with
    | .acquireMain => { state with phase := .main }
    | .loseMain =>
        { state with phase := .observer, inquiryActive := false }
    | .agentStart kind =>
        { state with localBusy := true, runKind := kind }
    | .observeOtherBusy busy => { state with otherBusy := busy }
    | .semanticHook _ => state
    | .activeTick => countTick state
    | .successfulTurn reply => countTurn state reply
    | .userTakeoverMessage =>
        -- An ordinary user message resets accounting but preserves queued
        -- manual requests and any live, non-cancelled reflection handling.
        if state.phase = .main then
          { state with
            counters := resetCycle state.counters
            pending := state.pending.filter (fun trigger => trigger = .userRequest) }
        else state
    | .terminalAbortSettled =>
        -- A confirmed main-run abort cancels the whole old cycle before it
        -- can dispatch: the active inquiry, every pending ask (including the
        -- manual waiting slot), and any staged result lose authority, and
        -- dispatch stays held until explicit user re-entry.
        if state.phase = .main then
          { state with
            counters := resetCycle state.counters
            pending := []
            inquiryActive := false
            continuationQueued := false
            held := true }
        else state
    | .explicitUserInput =>
        -- New explicit user input is the only automatic-release path: the
        -- hold clears and the accounting cycle restarts from zero.
        if state.held then
          { state with
            counters := resetCycle state.counters
            pending := []
            held := false }
        else state
    | .agentSettled => { state with localBusy := false }
    | .queueManualReflection =>
        -- A user-invoked /reflect is explicit re-entry: it releases the
        -- post-abort hold and then queues normally.
        let released := if state.held then
          { state with counters := resetCycle state.counters, pending := [], held := false } else state
        { released with pending := [.userRequest] }
    | .dispatchReflection =>
        if state.phase = .main && state.pending ≠ [] &&
            !state.inquiryActive && !state.held then
          -- Dispatch consumes the submitted head (manualQueue.shift in the
          -- implementation); requests queued behind the inquiry remain pending.
          let consumed := { state with pending := state.pending.tail }
          { consumed with inquiryActive := true, runKind := .reflection }
        else state
    | .reflectionFinished _ =>
        if state.inquiryActive then
          { state with
            inquiryActive := false
            runKind := .ordinary
            continuationQueued := true }
        else state
    | .shutdown =>
        { state with
          phase := .shutdown
          localBusy := false
          otherBusy := false
          inquiryActive := false
          pending := []
          held := false }

-- Initial state is a clean observer with built-in limits and zero counters.
def initial : State :=
  { phase := .observer
    localBusy := false
    otherBusy := false
    runKind := .ordinary
    counters := {
      activeMs := 0
      activeLoops := 0
      taskMs := 0
      rootLoops := 0
      allLoops := 0 }
    limits := {
      taskMs := 1_200_000
      rootLoops := 60
      allLoops := 300 }
    pending := []
    inquiryActive := false
    continuationQueued := false
    held := false }

-- Safety forbids active work, inquiries, and pending asks after shutdown.
def Safe (state : State) : Prop :=
  state.phase = .shutdown →
    state.localBusy = false ∧ state.otherBusy = false ∧
      state.inquiryActive = false ∧ state.pending = []

-- Supporting lemmas prove the exact loop allowlist, inquiry loop exclusion, official busy time and native queued
-- dispatch while work is busy, ownership recovery, valid-result continuation, and shutdown.
theorem success_policy_exact (reply : AssistantReply) :
    agentLoop reply = true ↔
      (reply.outcome = .stop ∨ reply.outcome = .toolUse) ∧
      reply.hasErrorMessage = false ∧ reply.isInquiryReply = false ∧
      reply.hasAgentOutput = true := by
  rcases reply with ⟨outcome, err, inq, out⟩
  cases outcome <;> cases err <;> cases inq <;> cases out <;>
    simp [agentLoop, modelTurnSucceeded]

theorem busy_inquiry_tick_counts
    (state : State) (busy : state.localBusy = true) :
    (countTick state).counters.activeMs = state.counters.activeMs + 1 := by
  simp [countTick, busy]

theorem ticks_never_latch (state : State) :
    (countTick state).pending = state.pending := by
  simp [countTick]; split <;> rfl

theorem reflection_turn_never_counts
    (state : State) (reply : AssistantReply)
    (reflection : state.runKind = .reflection) :
    (countTurn state reply).counters = state.counters := by
  simp [countTurn, reflection]

theorem failed_ordinary_turn_never_counts
    (state : State) (reply : AssistantReply)
    (ordinary : state.runKind = .ordinary)
    (failed : agentLoop reply = false) :
    (countTurn state reply).counters = state.counters := by
  simp [countTurn, ordinary, failed]

theorem successful_ordinary_turn_counts_once
    (state : State) (reply : AssistantReply)
    (ordinary : state.runKind = .ordinary)
    (success : agentLoop reply = true) :
    (countTurn state reply).counters.activeLoops =
      state.counters.activeLoops + 1 ∧
    (countTurn state reply).counters.rootLoops =
      state.counters.rootLoops + 1 ∧
    (countTurn state reply).counters.allLoops =
      state.counters.allLoops + 1 := by
  simp [countTurn, ordinary, success]


theorem user_takeover_resets_cycle_and_keeps_manual_pending :
    let state := { initial with
      phase := .main
      counters := { activeMs := 1, activeLoops := 2, taskMs := 3, rootLoops := 4, allLoops := 5 }
      pending := [.rootLoopLimit, .userRequest] }
    let reset := step state .userTakeoverMessage
    reset.counters = resetCycle state.counters ∧
      reset.pending = [.userRequest] := by
  simp [step, resetCycle]

theorem observer_takeover_is_ignored :
    let observer := { initial with
      counters := { activeMs := 10, activeLoops := 2, taskMs := 30, rootLoops := 4, allLoops := 5 }
      pending := [.userRequest]
      localBusy := true
      inquiryActive := true }
    step observer .terminalAbortSettled = observer := by
  decide

theorem legacy_hooks_have_no_effect (state : State) (name : String) :
    step state (.semanticHook name) = state := by
  simp [step]

theorem manual_reflection_can_dispatch :
    let main := step initial .acquireMain
    let queued := step main .queueManualReflection
    (step queued .dispatchReflection).inquiryActive = true := by
  decide

theorem simultaneous_local_and_other_busy_still_dispatches :
    let main := step initial .acquireMain
    let localRun := step main (.agentStart .ordinary)
    let both := step localRun (.observeOtherBusy true)
    let queued := step both .queueManualReflection
    (step queued .dispatchReflection).inquiryActive = true := by
  decide

theorem local_busy_still_dispatches :
    let main := step initial .acquireMain
    let localRun := step main (.agentStart .ordinary)
    let queued := step localRun .queueManualReflection
    (step queued .dispatchReflection).inquiryActive = true := by
  decide

-- After a reflection finishes, a manual request that waited behind the
-- outstanding inquiry dispatches immediately: no settle or idle gate applies.
theorem waiting_manual_dispatches_after_finish :
    let main := step initial .acquireMain
    let first := step main .queueManualReflection
    let running := step first .dispatchReflection
    let waiting := step running .queueManualReflection
    let finished := step waiting (.reflectionFinished .noIssue)
    (step finished .dispatchReflection).inquiryActive = true := by
  decide

-- RED CHECK: a single submitted request must not be redispatchable after
-- its reflection finishes (dispatch consumes the submitted head).
theorem single_manual_not_redispatched_after_finish :
    let main := step initial .acquireMain
    let first := step main .queueManualReflection
    let running := step first .dispatchReflection
    let finished := step running (.reflectionFinished .noIssue)
    (step finished .dispatchReflection).inquiryActive = false := by
  decide

-- Repeated commands keep one waiting slot; finalization preserves accumulated work.
theorem manual_waiting_slot_coalesces :
    let main := step initial .acquireMain
    let running := step (step main .queueManualReflection) .dispatchReflection
    let waiting := step (step running .queueManualReflection) .queueManualReflection
    waiting.pending = [.userRequest] := by
  decide

theorem reflection_finish_preserves_counters (state : State) (decision : ReflectionDecision) :
    (step state (.reflectionFinished decision)).counters = state.counters := by
  by_cases shutdown : state.phase = .shutdown
  · simp [step, shutdown]
  · cases active : state.inquiryActive <;> simp [step, shutdown, active]

theorem dispatch_classifies_reflection :
    let main := step initial .acquireMain
    let queued := step main .queueManualReflection
    (step queued .dispatchReflection).runKind = .reflection := by
  decide

theorem observer_can_reclaim_main (state : State) :
    (step { state with phase := .observer } .acquireMain).phase = .main := by
  simp [step]

theorem valid_reflection_queues_one_continuation
    (state : State) (decision : ReflectionDecision)
    (openInquiry : state.inquiryActive = true)
    (notShutdown : state.phase ≠ .shutdown) :
    (step state (.reflectionFinished decision)).continuationQueued = true ∧
    step (step state (.reflectionFinished decision)) (.reflectionFinished decision) =
      step state (.reflectionFinished decision) := by
  simp [step, notShutdown, openInquiry]

-- Result submission is a function call, not assistant text. Its declaration
-- stays fixed; the runtime accepts submissions only for a confirmed main inquiry.
def resultToolAllowed (state : State) (promptConfirmed : Bool) : Bool :=
  state.phase == .main && state.inquiryActive && promptConfirmed &&
    state.runKind == .reflection

def submitResult (state : State) (promptConfirmed : Bool)
    (decision : ReflectionDecision) : Except String ReflectionDecision :=
  if resultToolAllowed state promptConfirmed then .ok decision
  else .error "This function is reserved for the plugin. Please try another function."

-- The gate excludes ordinary work, provisional inquiries, observers, and shutdown.
theorem result_tool_gate (state : State) (confirmed : Bool) :
    resultToolAllowed state confirmed = true ↔
      state.phase = .main ∧ state.inquiryActive = true ∧
        confirmed = true ∧ state.runKind = .reflection := by
  simp [resultToolAllowed, and_assoc]

theorem ordinary_result_is_rejected (state : State) (decision : ReflectionDecision)
    (ordinary : state.runKind = .ordinary) :
    submitResult state true decision =
      .error "This function is reserved for the plugin. Please try another function." := by
  simp [submitResult, resultToolAllowed, ordinary]

-- The fixed declaration carries structural constraints (required fields, the
-- result-type enum, no extra fields) but no explanatory parameter text.
-- Structure grants no authority; the runtime gate above still decides.
structure ResultDeclaration where
  description : String
  declaresRequiredFields : Bool
  enumeratesResultType : Bool
  rejectsExtraFields : Bool
  explainsParameters : Bool
  deriving Repr, DecidableEq

def resultDeclaration : ResultDeclaration :=
  { description := "don't use unless ask"
    declaresRequiredFields := true
    enumeratesResultType := true
    rejectsExtraFields := true
    explainsParameters := false }

theorem result_declaration_is_constrained_without_prose :
    resultDeclaration.description = "don't use unless ask" ∧
      resultDeclaration.declaresRequiredFields = true ∧
      resultDeclaration.enumeratesResultType = true ∧
      resultDeclaration.rejectsExtraFields = true ∧
      resultDeclaration.explainsParameters = false := by
  decide

-- An owned reflection response is projected before native dispatch. A result
-- call that fails the plugin parser stops the whole response with no
-- executable calls and marks one invalid attempt; a response with no calls is
-- also invalid; otherwise calls stay executable for normal handling.
inductive ResultArguments where
  | valid (decision : ReflectionDecision)
  | invalid
  deriving Repr, DecidableEq

structure OwnedResponse where
  resultCall : Option ResultArguments
  lookupCalls : Nat
  providerError : Bool := false
  deriving Repr, DecidableEq

structure OwnedProjection where
  executableCalls : Nat
  invalidAttempt : Bool
  resultSubmitted : Bool := false
  deriving Repr, DecidableEq

def projectOwnedResponse (response : OwnedResponse) : OwnedProjection :=
  if response.providerError then { executableCalls := 0, invalidAttempt := false }
  else match response.resultCall with
  | some .invalid => { executableCalls := 0, invalidAttempt := true }
  | some (.valid _) =>
      { executableCalls := response.lookupCalls + 1
        invalidAttempt := false, resultSubmitted := true }
  | none =>
      { executableCalls := response.lookupCalls
        invalidAttempt := response.lookupCalls == 0 }

theorem invalid_result_never_reaches_dispatch (lookups : Nat) :
    projectOwnedResponse { resultCall := some .invalid, lookupCalls := lookups } =
      { executableCalls := 0, invalidAttempt := true } := by
  rfl

-- Provider errors bypass result validation, including partial invalid result calls.
theorem provider_error_is_not_invalid (response : OwnedResponse) :
    projectOwnedResponse { response with providerError := true } =
      { executableCalls := 0, invalidAttempt := false } := by
  rfl

-- Invalid result attempts re-ask below the third attempt and fail at the limit.
-- A result submission is accepted; lookup-only work continues within the same attempt.
def maxResultAttempts : Nat := 3

inductive AttemptSettlement where
  | reask (nextAttempt : Nat)
  | failed
  | accepted
  | continueCalls
  | cancelled
  deriving Repr, DecidableEq

-- A canonical aborted outcome takes precedence over any response content: a
-- partial or invalid owned call never becomes a reask or an accepted result.
inductive OwnedOutcome where
  | completed
  | aborted
  deriving Repr, DecidableEq

def settleAttemptWith (attempt : Nat) (outcome : OwnedOutcome)
    (projection : OwnedProjection) : AttemptSettlement :=
  match outcome with
  | .aborted => .cancelled
  | .completed =>
      if projection.invalidAttempt then
        if attempt < maxResultAttempts then .reask (attempt + 1) else .failed
      else if projection.resultSubmitted then .accepted
      else .continueCalls

def settleAttempt (attempt : Nat) (projection : OwnedProjection) : AttemptSettlement :=
  if projection.invalidAttempt then
    if attempt < maxResultAttempts then .reask (attempt + 1) else .failed
  else if projection.resultSubmitted then .accepted
  else .continueCalls

-- Abort precedence: even a staged valid result or a schema-invalid partial
-- call settles as cancelled, never as accepted or reask.
theorem aborted_outcome_precedence (attempt : Nat) (projection : OwnedProjection) :
    settleAttemptWith attempt .aborted projection = .cancelled := by
  rfl

theorem aborted_staged_valid_result_is_cancelled (attempt : Nat) :
    settleAttemptWith attempt .aborted
      { executableCalls := 1, invalidAttempt := true, resultSubmitted := true } = .cancelled := by
  rfl

-- Count result-attempt boundaries, not provider requests: lookup-only replies
-- can request more work within an attempt and do not submit a result.
def attemptsUsed (attempt : Nat) : List OwnedResponse → Nat
  | [] => 0
  | response :: rest =>
      match settleAttempt attempt (projectOwnedResponse response) with
      | .reask next => 1 + attemptsUsed next rest
      | .continueCalls => attemptsUsed attempt rest
      | .accepted | .failed | .cancelled => 1

-- Native provider retries do not advance the plugin attempt; only a final
-- authoritative provider-error settlement cancels the inquiry without reasking.
theorem provider_retry_preserves_attempt (attempt : Nat) (response : OwnedResponse)
    (rest : List OwnedResponse) :
    attemptsUsed attempt ({ response with providerError := true } :: rest) =
      attemptsUsed attempt rest := by
  simp [attemptsUsed, projectOwnedResponse, settleAttempt]

inductive ProviderFailureOutcome where
  | pending
  | cancelled
  deriving Repr, DecidableEq

def providerFailureSettlement (hostSettled : Bool) : ProviderFailureOutcome :=
  if hostSettled then .cancelled else .pending

theorem provider_failure_settlement_boundary :
    providerFailureSettlement false = .pending ∧
    providerFailureSettlement true = .cancelled := by
  decide

theorem reask_advances_below_limit (attempt next : Nat) (projection : OwnedProjection)
    (settled : settleAttempt attempt projection = .reask next) :
    next = attempt + 1 ∧ attempt < maxResultAttempts := by
  unfold settleAttempt at settled
  split at settled
  · split at settled
    · cases settled
      constructor
      · rfl
      · assumption
    · cases settled
  · split at settled <;> cases settled

theorem attempts_bounded_from (responses : List OwnedResponse) :
    ∀ attempt, attempt ≤ maxResultAttempts →
      attemptsUsed attempt responses + attempt ≤ maxResultAttempts + 1 := by
  induction responses with
  | nil =>
      intro attempt bound
      simp [attemptsUsed]
      omega
  | cons response rest ih =>
      intro attempt bound
      simp only [attemptsUsed]
      cases settled : settleAttempt attempt (projectOwnedResponse response) with
      | reask next =>
          obtain ⟨advanced, below⟩ := reask_advances_below_limit attempt next _ settled
          subst advanced
          have recursive := ih (attempt + 1) (by omega)
          simp only
          omega
      | continueCalls => exact ih attempt bound
      | failed | accepted | cancelled =>
          simp only
          omega

theorem no_fourth_attempt (responses : List OwnedResponse) :
    attemptsUsed 1 responses ≤ maxResultAttempts := by
  have bounded := attempts_bounded_from responses 1 (by decide)
  omega

-- A lookup-only reply retains normal tool execution without accepting a result.
theorem lookup_only_continues (attempt lookups : Nat) (nonempty : lookups ≠ 0) :
    settleAttempt attempt (projectOwnedResponse
      { resultCall := none, lookupCalls := lookups }) = .continueCalls := by
  simp [settleAttempt, projectOwnedResponse, nonempty]

-- Branch-derived eligibility is checked before automatic dispatch. A report
-- projection is not an ordinary turn; only successful ordinary loops advance it.
-- The cooldown window is a bound on ordinary loops since the last completed
-- reflection: rootLoopLimit / 3, clamped to [10, 30].
def cooldownBound (rootLoopLimit : Nat) : Nat :=
  min (max (rootLoopLimit / 3) 10) 30

def cooldownAllows (trigger : Trigger) (completedInquiry : Bool)
    (rootLoopLimit ordinaryLoopsSince : Nat) : Bool :=
  if trigger = .userRequest then true
  else
    !completedInquiry ||
      decide (ordinaryLoopsSince > cooldownBound rootLoopLimit)

theorem cooldown_policy :
    (cooldownBound 60 = 20 ∧ cooldownBound 90 = 30 ∧
      cooldownBound 120 = 30 ∧ cooldownBound 30 = 10 ∧
      cooldownBound 2 = 10 ∧ cooldownBound 33 = 11) ∧
    (cooldownAllows .rootLoopLimit true 90 30 = false ∧
      cooldownAllows .rootLoopLimit true 90 31 = true) ∧
    (cooldownAllows .rootLoopLimit true 30 10 = false ∧
      cooldownAllows .rootLoopLimit true 30 11 = true) ∧
    (∀ loops, cooldownAllows .userRequest true 30 loops = true) ∧
    (∀ trigger loops, cooldownAllows trigger false 30 loops = true) := by
  refine ⟨?_, ?_, ?_, ?_, ?_⟩
  · decide
  · decide
  · decide
  · intro loops
    simp [cooldownAllows]
  · intro trigger loops
    simp [cooldownAllows]

theorem shutdown_is_clean (state : State)
    (active : state.phase ≠ .shutdown) : Safe (step state .shutdown) := by
  simp [Safe, step, active]

theorem shutdown_is_absorbing (state : State) (event : Event)
    (stopped : state.phase = .shutdown) :
    step state event = state := by
  simp [step, stopped]

-- Collection vocabulary keeps synchronization facts separate from the live
-- contributor set, lazy replay ledger, and cumulative accounting.
structure PeerCheckpoint where
  generation : Nat
  sequence : Nat
  busy : Bool
  rootLoops : Nat
  allLoops : Nat
  deriving Repr, DecidableEq

structure LedgerEntry where
  generation : Nat
  sequence : Nat
  rootLoops : Nat
  allLoops : Nat
  replayUntilMs : Option Nat
  deriving Repr, DecidableEq

structure LiveContributor where
  contributorId : String
  replayKey : String
  busy : Bool
  deriving Repr, DecidableEq

structure CollectionState where
  generation : Nat
  live : List LiveContributor
  ledger : List (String × LedgerEntry)
  activeMs : Nat
  taskMs : Nat
  rootLoops : Nat
  allLoops : Nat
  deriving Repr, DecidableEq

structure AcceptedLoopDelta where
  root : Nat
  all : Nat
  deriving Repr, DecidableEq

inductive CollectionEvent where
  | peerSynchronized
      (contributorId replayKey : String)
      (checkpoint : PeerCheckpoint)
      (accepted : AcceptedLoopDelta)
  | peerCheckpointVerified
      (contributorId : String)
      (checkpoint : PeerCheckpoint)
      (accepted : AcceptedLoopDelta)
  | peerOffline (contributorId : String) (atMs : Nat)
  deriving Repr, DecidableEq

-- List helpers make current live identity and replay high-water explicit; only
-- the live list contributes busy state, while ledger entries retain no busy bit.
def findLive (contributorId : String) : List LiveContributor → Option LiveContributor
  | [] => none
  | contributor :: rest =>
      if contributor.contributorId = contributorId then some contributor
      else findLive contributorId rest

def putLive (contributor : LiveContributor) (live : List LiveContributor) :
    List LiveContributor :=
  contributor :: live.filter (fun current =>
    current.contributorId ≠ contributor.contributorId &&
      current.replayKey ≠ contributor.replayKey)

def removeLive (contributorId : String) (live : List LiveContributor) :
    List LiveContributor :=
  live.filter (fun contributor => contributor.contributorId ≠ contributorId)

def findLedger (replayKey : String) : List (String × LedgerEntry) → Option LedgerEntry
  | [] => none
  | entry :: rest =>
      if entry.1 = replayKey then some entry.2 else findLedger replayKey rest

def findLedgerAt (replayKey : String) (atMs : Nat)
    (ledger : List (String × LedgerEntry)) : Option LedgerEntry :=
  match findLedger replayKey ledger with
  | some entry =>
      match entry.replayUntilMs with
      | some replayUntilMs => if atMs > replayUntilMs then none else some entry
      | none => some entry
  | none => none

def pruneLedgerAt (atMs : Nat) (ledger : List (String × LedgerEntry)) :
    List (String × LedgerEntry) :=
  ledger.filter (fun current =>
    match current.2.replayUntilMs with
    | some replayUntilMs => atMs ≤ replayUntilMs
    | none => true)

def putLedger (replayKey : String) (entry : LedgerEntry)
    (ledger : List (String × LedgerEntry)) : List (String × LedgerEntry) :=
  (replayKey, entry) :: ledger.filter (fun current => current.1 ≠ replayKey)

def anyLiveBusy (state : CollectionState) : Bool :=
  state.live.any (fun contributor => contributor.busy)

-- Adapter-verified synchronization can count from zero, replay an exact
-- retained delta, or seed a zero delta after history expiry.
def validCheckpoint (checkpoint : PeerCheckpoint) : Bool :=
  checkpoint.sequence > 0 && checkpoint.rootLoops ≤ checkpoint.allLoops

def exactReplayDelta (entry : LedgerEntry) (checkpoint : PeerCheckpoint) :
    Option AcceptedLoopDelta :=
  if checkpoint.generation = entry.generation &&
      checkpoint.sequence > entry.sequence &&
      checkpoint.rootLoops ≥ entry.rootLoops &&
      checkpoint.allLoops ≥ entry.allLoops then
    let delta := {
      root := checkpoint.rootLoops - entry.rootLoops
      all := checkpoint.allLoops - entry.allLoops }
    if delta.root ≤ delta.all then some delta else none
  else none

def synchronizationDeltaAllowed (previous : Option LedgerEntry)
    (checkpoint : PeerCheckpoint) (accepted : AcceptedLoopDelta) : Bool :=
  if accepted.root > accepted.all || accepted.root > checkpoint.rootLoops ||
      accepted.all > checkpoint.allLoops then false
  else
    match previous with
    | some entry => exactReplayDelta entry checkpoint = some accepted
    | none => accepted = { root := 0, all := 0 } ||
        accepted = { root := checkpoint.rootLoops, all := checkpoint.allLoops }

-- Collection transport handles synchronization and offline replay; reset semantics live solely in resetCompletionWindow below.
def stepCollectionAt (state : CollectionState) (event : CollectionEvent)
    (atMs : Nat) : CollectionState :=
  match event with
  | .peerSynchronized contributorId replayKey checkpoint accepted =>
      let retainedLedger := pruneLedgerAt atMs state.ledger
      let previous := findLedger replayKey retainedLedger
      if validCheckpoint checkpoint && checkpoint.generation = state.generation &&
          synchronizationDeltaAllowed previous checkpoint accepted then
        { state with
          live := putLive {
            contributorId := contributorId
            replayKey := replayKey
            busy := checkpoint.busy } state.live
          ledger := putLedger replayKey {
            generation := checkpoint.generation
            sequence := checkpoint.sequence
            rootLoops := checkpoint.rootLoops
            allLoops := checkpoint.allLoops
            replayUntilMs := none } retainedLedger
          rootLoops := state.rootLoops + accepted.root
          allLoops := state.allLoops + accepted.all }
      else state
  | .peerCheckpointVerified contributorId checkpoint accepted =>
      match findLive contributorId state.live with
      | none => state
      | some contributor =>
          let retainedLedger := pruneLedgerAt atMs state.ledger
          match findLedger contributor.replayKey retainedLedger with
          | none => state
          | some previous =>
              if checkpoint.generation = state.generation &&
                  exactReplayDelta previous checkpoint = some accepted then
                { state with
                  live := putLive { contributor with busy := checkpoint.busy } state.live
                  ledger := putLedger contributor.replayKey {
                    generation := checkpoint.generation
                    sequence := checkpoint.sequence
                    rootLoops := checkpoint.rootLoops
                    allLoops := checkpoint.allLoops
                    replayUntilMs := none } retainedLedger
                  rootLoops := state.rootLoops + accepted.root
                  allLoops := state.allLoops + accepted.all }
              else state
  | .peerOffline contributorId offlineAtMs =>
      match findLive contributorId state.live with
      | none => state
      | some contributor =>
          let nextLive := removeLive contributorId state.live
          let retainedLedger := pruneLedgerAt offlineAtMs state.ledger
          match findLedger contributor.replayKey retainedLedger with
          | none => { state with live := nextLive, ledger := retainedLedger }
          | some previous =>
              { state with
                live := nextLive
                ledger := putLedger contributor.replayKey
                  { previous with replayUntilMs := some (offlineAtMs + 10_000) }
                  retainedLedger }

def stepCollection (state : CollectionState) (event : CollectionEvent) : CollectionState :=
  stepCollectionAt state event 0

-- Collection invariants state the decoupling rules: ledger-only history cannot
-- report busy, offline removes activity now, replay restores loops only, and generations fence deltas.
def sampleCollection : CollectionState :=
  { generation := 0
    live := []
    ledger := []
    activeMs := 1_000
    taskMs := 1_000
    rootLoops := 1
    allLoops := 2 }

def firstCheckpoint : PeerCheckpoint :=
  { generation := 0, sequence := 1, busy := true, rootLoops := 1, allLoops := 2 }

def returnedCheckpoint : PeerCheckpoint :=
  { generation := 0, sequence := 2, busy := true, rootLoops := 2, allLoops := 5 }

def firstAccepted : AcceptedLoopDelta := { root := 1, all := 2 }
def replayAccepted : AcceptedLoopDelta := { root := 1, all := 3 }
def zeroAccepted : AcceptedLoopDelta := { root := 0, all := 0 }

def synchronizedSample : CollectionState :=
  stepCollection sampleCollection
    (.peerSynchronized "live-1" "child/process-1" firstCheckpoint firstAccepted)

def offlineSample : CollectionState :=
  stepCollection synchronizedSample (.peerOffline "live-1" 2_000)

def replayedSample : CollectionState :=
  stepCollectionAt offlineSample
    (.peerSynchronized "live-2" "child/process-1" returnedCheckpoint replayAccepted)
    9_000

def expiredSeededSample : CollectionState :=
  stepCollectionAt offlineSample
    (.peerSynchronized "live-2" "child/process-1" returnedCheckpoint zeroAccepted)
    12_001

def resynchronizedSample : CollectionState :=
  stepCollection synchronizedSample
    (.peerSynchronized "live-2" "child/process-1" returnedCheckpoint replayAccepted)

-- Supporting theorems prove exact offline removal, no offline time backfill,
-- exact retained replay, baseline seeding, and generation fencing.
theorem ledger_has_no_busy_authority (state : CollectionState)
    (ledger : List (String × LedgerEntry)) :
    anyLiveBusy { state with ledger := ledger } = anyLiveBusy state := by
  rfl

theorem offline_removes_busy_immediately :
    anyLiveBusy offlineSample = false := by
  decide

theorem offline_preserves_accounting_time :
    offlineSample.activeMs = synchronizedSample.activeMs ∧
      offlineSample.taskMs = synchronizedSample.taskMs := by
  decide

theorem retained_replay_adds_exact_loop_delta_only :
    replayedSample.rootLoops = offlineSample.rootLoops + replayAccepted.root ∧
      replayedSample.allLoops = offlineSample.allLoops + replayAccepted.all ∧
      replayedSample.activeMs = offlineSample.activeMs ∧
      replayedSample.taskMs = offlineSample.taskMs := by
  decide

theorem missing_history_accepts_only_zero_or_current :
    synchronizationDeltaAllowed none returnedCheckpoint zeroAccepted = true ∧
      synchronizationDeltaAllowed none returnedCheckpoint
        { root := returnedCheckpoint.rootLoops, all := returnedCheckpoint.allLoops } = true ∧
      synchronizationDeltaAllowed none returnedCheckpoint { root := 1, all := 1 } = false := by
  decide

theorem expired_history_seeds_without_replay :
    expiredSeededSample.rootLoops = offlineSample.rootLoops ∧
      expiredSeededSample.allLoops = offlineSample.allLoops ∧
      findLedger "child/process-1" expiredSeededSample.ledger = some {
        generation := returnedCheckpoint.generation
        sequence := returnedCheckpoint.sequence
        rootLoops := returnedCheckpoint.rootLoops
        allLoops := returnedCheckpoint.allLoops
        replayUntilMs := none } := by
  decide

theorem resynchronization_replaces_prior_live_handle :
    findLive "live-1" resynchronizedSample.live = none ∧
      (findLive "live-2" resynchronizedSample.live).isSome = true := by
  decide

-- A confirmed abort cancels the active inquiry and every pending ask,
-- including the manual waiting slot, and installs the hold.
theorem abort_cancels_cycle_and_holds :
    let main := step initial .acquireMain
    let queued := step main .queueManualReflection
    let running := step queued .dispatchReflection
    let waiting := step running .queueManualReflection
    let aborted := step waiting .terminalAbortSettled
    aborted.inquiryActive = false ∧ aborted.pending = [] ∧
      aborted.held = true ∧ aborted.continuationQueued = false := by
  decide

-- While held, neither an automatic threshold nor a leftover ask dispatches.
theorem hold_blocks_dispatch :
    let held := { initial with phase := .main, held := true, pending := [.userRequest] }
    step held .dispatchReflection = held := by
  decide

-- Background events never release the hold: counters, hooks, ticks, new
-- background runs, and role-only user messages leave it in force.
theorem background_events_keep_hold_and_role_only_message :
    let main := step initial .acquireMain
    let aborted := step main .terminalAbortSettled
    (step aborted .activeTick).held = true ∧
      (step aborted (.agentStart .ordinary)).held = true ∧
      (step aborted (.semanticHook "resume-a")).held = true ∧
      (step aborted .agentSettled).held = true ∧
      (step aborted (.observeOtherBusy true)).held = true ∧
      (step aborted .userTakeoverMessage).held = true := by
  decide

-- Explicit user input releases the hold and restarts accounting from zero;
-- a fresh /reflect is explicit re-entry and dispatches its new inquiry.
theorem explicit_input_and_fresh_manual_reentry :
    (let main := step initial .acquireMain
      let busy := step main (.agentStart .ordinary)
      let counted := step busy (.successfulTurn { outcome := .stop, hasErrorMessage := false, isInquiryReply := false, hasAgentOutput := true })
      let aborted := step counted .terminalAbortSettled
      let resumed := step aborted .explicitUserInput
      resumed.held = false ∧ resumed.counters = resetCycle counted.counters) ∧
    (let main := step initial .acquireMain
      let aborted := step main .terminalAbortSettled
      let queued := step aborted .queueManualReflection
      queued.held = false ∧ (step queued .dispatchReflection).inquiryActive = true) := by
  constructor <;> decide

-- A cancelled inquiry has no result authority: a late ref submission is
-- rejected exactly like an ordinary call.
theorem late_result_without_inquiry_is_rejected
    (state : State) (decision : ReflectionDecision)
    (noInquiry : state.inquiryActive = false) :
    submitResult state true decision =
      .error "This function is reserved for the plugin. Please try another function." := by
  simp [submitResult, resultToolAllowed, noInquiry]

-- Main scans trust recorded Pi markers; role/completion inference is legacy-only and stops at the first marker. Child contributions follow domain baselines only.
inductive HistoryBoundaryPolicy where
  | recorded
  | legacy
  | baselines
  deriving Repr, DecidableEq

-- Input sources model the C writer contract: only interactive/RPC input emits a full reset marker; a user role alone proves nothing.
inductive InputSource where
  | interactive
  | rpc
  | extension
  | background
  deriving Repr, DecidableEq

-- Selected-branch entries contain ordinary replies, role-only messages and validated metadata. No file, prompt text or live-completion permission is modeled.
inductive WindowBoundary where
  | none
  | userRole
  | fullMarker
  | reminderMarker
  deriving Repr, DecidableEq

structure HistoryEntry where
  entryId : String
  reply : Option AssistantReply := none
  boundary : WindowBoundary := .none
  correlatedLegacyCompletion : Bool := false
  deriving Repr, DecidableEq

structure HistoryWindows where
  fullAfter : Option String := none
  reminderAfter : Option String := none
  fullIds : List String := []
  reminderIds : List String := []
  explicitReminder : Bool := false
  deriving Repr, DecidableEq

-- Qualification occurs before marker creation. Main explicit markers reset windows; child-local/copy markers cannot govern domain contribution.
def realInputBoundary (source : InputSource) (id : String) : HistoryEntry :=
  { entryId := id
    boundary := if source = .interactive ∨ source = .rpc then .fullMarker else .userRole }

def effectiveBoundary (policy : HistoryBoundaryPolicy) (view : HistoryWindows)
    (entry : HistoryEntry) : WindowBoundary :=
  if policy = .baselines then .none
  else if entry.boundary = .userRole ∧ (policy ≠ .legacy ∨ view.explicitReminder) then .none
  else entry.boundary

def observeHistoryEntry (policy : HistoryBoundaryPolicy) (view : HistoryWindows)
    (entry : HistoryEntry) : HistoryWindows :=
  match effectiveBoundary policy view entry with
  | .userRole =>
      { fullAfter := some entry.entryId, reminderAfter := some entry.entryId }
  | .fullMarker =>
      { fullAfter := some entry.entryId, reminderAfter := some entry.entryId,
        explicitReminder := true }
  | .reminderMarker =>
      { view with reminderAfter := some entry.entryId, reminderIds := [], explicitReminder := true }
  | .none =>
      if policy = .legacy ∧ entry.correlatedLegacyCompletion ∧ !view.explicitReminder then
        { view with reminderAfter := some entry.entryId, reminderIds := [] }
      else
        match entry.reply with
        | some reply =>
            if agentLoop reply then
              { view with
                fullIds := view.fullIds ++ [entry.entryId]
                reminderIds := view.reminderIds ++ [entry.entryId] }
            else view
        | none => view

def scanHistory (policy : HistoryBoundaryPolicy) (entries : List HistoryEntry) : HistoryWindows :=
  entries.foldl (observeHistoryEntry policy) {}

-- Identity suffixes exclude attachment ancestry and superseded full/reminder budgets; missing anchors fail closed pending scope replacement.
def suffixAfterId (anchor : String) : List HistoryEntry → Option (List HistoryEntry)
  | [] => none
  | entry :: rest => if entry.entryId = anchor then some rest else suffixAfterId anchor rest

def baselineSuffix (anchor : Option String) (entries : List HistoryEntry) : Option (List HistoryEntry) :=
  match anchor with
  | none => some entries
  | some entryId => suffixAfterId entryId entries

structure LocalHistoryContribution where
  baselineFound : Bool
  activeIds : List String
  reminderIds : List String
  deriving Repr, DecidableEq

def deriveLocalHistory (policy : HistoryBoundaryPolicy) (entries : List HistoryEntry)
    (fullBaseline reminderBaseline : Option String) : LocalHistoryContribution :=
  let view := scanHistory policy entries
  match baselineSuffix fullBaseline entries, baselineSuffix reminderBaseline entries with
  | some fullSuffix, some reminderSuffix =>
      { baselineFound := true
        activeIds := view.fullIds.filter (fun id => fullSuffix.any (fun entry => entry.entryId = id))
        reminderIds := view.reminderIds.filter (fun id =>
          fullSuffix.any (fun entry => entry.entryId = id) &&
          reminderSuffix.any (fun entry => entry.entryId = id)) }
  | _, _ => { baselineFound := false, activeIds := [], reminderIds := [] }

-- Local safety covers source-qualified resets, synthetic-wake preservation, child-local reset exclusion and exact ordinary-reply filtering.
theorem full_boundary_resets_both (view : HistoryWindows) (id : String) :
    (observeHistoryEntry .recorded view { entryId := id, boundary := .fullMarker }).fullIds = [] ∧
    (observeHistoryEntry .recorded view { entryId := id, boundary := .fullMarker }).reminderIds = [] := by
  exact ⟨rfl, rfl⟩

theorem real_input_resets_both (view : HistoryWindows) (id : String) (source : InputSource)
    (qualified : source = .interactive ∨ source = .rpc) :
    (observeHistoryEntry .recorded view (realInputBoundary source id)).fullIds = [] ∧
    (observeHistoryEntry .recorded view (realInputBoundary source id)).reminderIds = [] := by
  simp [realInputBoundary, qualified, observeHistoryEntry, effectiveBoundary]

theorem recorded_user_role_preserves_windows (view : HistoryWindows) (id : String) :
    observeHistoryEntry .recorded view { entryId := id, boundary := .userRole } = view := by
  simp [observeHistoryEntry, effectiveBoundary]

theorem legacy_role_cannot_override_marker (view : HistoryWindows) (id : String)
    (explicit : view.explicitReminder = true) :
    observeHistoryEntry .legacy view { entryId := id, boundary := .userRole } = view := by
  simp [observeHistoryEntry, effectiveBoundary, explicit]

theorem child_local_reset_preserves_windows (view : HistoryWindows) (id : String)
    (boundary : WindowBoundary) (completion : Bool) :
    observeHistoryEntry .baselines view
      { entryId := id, boundary := boundary, correlatedLegacyCompletion := completion } = view := by
  simp [observeHistoryEntry, effectiveBoundary]

theorem reminder_boundary_preserves_full (view : HistoryWindows) (id : String) :
    (observeHistoryEntry .recorded view { entryId := id, boundary := .reminderMarker }).fullIds = view.fullIds ∧
    (observeHistoryEntry .recorded view { entryId := id, boundary := .reminderMarker }).reminderIds = [] := by
  exact ⟨rfl, rfl⟩

theorem excluded_reply_preserves_windows (policy : HistoryBoundaryPolicy)
    (view : HistoryWindows) (id : String) (reply : AssistantReply)
    (excluded : agentLoop reply = false) :
    observeHistoryEntry policy view { entryId := id, reply := some reply } = view := by
  cases policy <;> simp [observeHistoryEntry, effectiveBoundary, excluded]

theorem legacy_completion_cannot_override_explicit_boundary (view : HistoryWindows)
    (id : String) (explicit : view.explicitReminder = true) :
    observeHistoryEntry .legacy view { entryId := id, correlatedLegacyCompletion := true } = view := by
  simp [observeHistoryEntry, effectiveBoundary, explicit]

theorem missing_baseline_rejects_contribution (policy : HistoryBoundaryPolicy)
    (entries : List HistoryEntry) (full reminder : Option String)
    (missing : baselineSuffix full entries = none) :
    deriveLocalHistory policy entries full reminder =
      { baselineFound := false, activeIds := [], reminderIds := [] } := by
  simp [deriveLocalHistory, missing]

-- Finite child trace includes two unpublished replies, local input/copied resets, then a third; reminder/full domain baselines remain authoritative.
def ordinaryHistoryReply : AssistantReply :=
  { outcome := .toolUse, hasErrorMessage := false, isInquiryReply := false, hasAgentOutput := true }

def forkHistory : List HistoryEntry :=
  [{ entryId := "inherited", reply := some ordinaryHistoryReply },
   { entryId := "attachment" },
   { entryId := "child-first", reply := some ordinaryHistoryReply },
   { entryId := "child-second", reply := some ordinaryHistoryReply },
   { entryId := "local-input", boundary := .userRole },
   { entryId := "copied-full", boundary := .fullMarker },
   { entryId := "copied-reminder", boundary := .reminderMarker },
   { entryId := "local-completion", correlatedLegacyCompletion := true },
   { entryId := "child-third", reply := some ordinaryHistoryReply }]

theorem child_scope_preserves_unpublished_work :
    deriveLocalHistory .baselines forkHistory (some "attachment") none =
      { baselineFound := true, activeIds := ["child-first", "child-second", "child-third"],
        reminderIds := ["child-first", "child-second", "child-third"] } ∧
    (let extended := forkHistory ++ [{ entryId := "child-fourth", reply := some ordinaryHistoryReply }]
     deriveLocalHistory .baselines extended (some "attachment") (some "child-third") =
       { baselineFound := true, activeIds := ["child-first", "child-second", "child-third", "child-fourth"],
         reminderIds := ["child-fourth"] } ∧
     deriveLocalHistory .baselines extended (some "child-fourth") (some "child-third") =
       { baselineFound := true, activeIds := [], reminderIds := [] }) := by
  constructor <;> decide

-- Foundation proves classified-input/window safety and a finite child example, not C provenance wiring, metadata validation refinement or live transport.
theorem branch_accounting_foundation_is_correct :
    (∀ view id source, (source = .interactive ∨ source = .rpc) →
      (observeHistoryEntry .recorded view (realInputBoundary source id)).fullIds = [] ∧
      (observeHistoryEntry .recorded view (realInputBoundary source id)).reminderIds = []) ∧
    (∀ view id, observeHistoryEntry .recorded view { entryId := id, boundary := .userRole } = view) ∧
    (∀ view id boundary completion, observeHistoryEntry .baselines view
      { entryId := id, boundary := boundary, correlatedLegacyCompletion := completion } = view) ∧
    (∀ view id, (observeHistoryEntry .recorded view { entryId := id, boundary := .reminderMarker }).fullIds = view.fullIds ∧
      (observeHistoryEntry .recorded view { entryId := id, boundary := .reminderMarker }).reminderIds = []) ∧
    (∀ policy view id reply, agentLoop reply = false →
      observeHistoryEntry policy view { entryId := id, reply := some reply } = view) ∧
    (∀ view id, view.explicitReminder = true →
      observeHistoryEntry .legacy view { entryId := id, correlatedLegacyCompletion := true } = view) ∧
    (∀ view id, view.explicitReminder = true →
      observeHistoryEntry .legacy view { entryId := id, boundary := .userRole } = view) ∧
    (∀ policy entries full reminder, baselineSuffix full entries = none →
      deriveLocalHistory policy entries full reminder =
        { baselineFound := false, activeIds := [], reminderIds := [] }) ∧
    deriveLocalHistory .baselines forkHistory (some "attachment") none =
      { baselineFound := true, activeIds := ["child-first", "child-second", "child-third"],
        reminderIds := ["child-first", "child-second", "child-third"] } :=
  ⟨real_input_resets_both, recorded_user_role_preserves_windows, child_local_reset_preserves_windows,
    reminder_boundary_preserves_full, excluded_reply_preserves_windows,
    legacy_completion_cannot_override_explicit_boundary, legacy_role_cannot_override_marker,
    missing_baseline_rejects_contribution, child_scope_preserves_unpublished_work.1⟩

#print axioms branch_accounting_foundation_is_correct
#print axioms child_scope_preserves_unpublished_work

-- Coordinator vocabulary carries one accepted current-generation snapshot, finalized identity, counts and bounded completion high-water.
structure AcceptedBranchSnapshot where
  generation : Nat
  sequence : Nat
  scope : Nat
  entryId : String
  position : Nat
  active : Nat
  reminder : Nat
  deriving Repr, DecidableEq

structure CompletionAccounting where
  generation : Nat := 0
  accepted : Option AcceptedBranchSnapshot := none
  childActive : Nat := 0
  childReminder : Nat := 0
  rootLoops : Nat := 0
  completedPosition : Nat := 0
  notifications : List String := []
  liveBusy : Bool := false
  deriving Repr, DecidableEq

-- Authenticated repair updates accounting only; distinct finalized delivery requires exact accepted coordinates and a new live position.
def acceptBranchSnapshot (state : CompletionAccounting) (snapshot : AcceptedBranchSnapshot)
    (authenticated : Bool) : CompletionAccounting :=
  if authenticated && snapshot.generation == state.generation &&
      snapshot.active >= state.childActive && snapshot.reminder >= state.childReminder &&
      (state.accepted.isNone || snapshot.sequence > (state.accepted.map (·.sequence)).getD 0) then
    { state with
      accepted := some snapshot
      childActive := snapshot.active
      childReminder := snapshot.reminder }
  else state

def finalizedCompletion (state : CompletionAccounting) (snapshot : AcceptedBranchSnapshot)
    (authenticatedLive : Bool) : CompletionAccounting :=
  if authenticatedLive && snapshot.generation == state.generation &&
      state.accepted == some snapshot && snapshot.position > state.completedPosition then
    { state with
      completedPosition := snapshot.position
      notifications := state.notifications ++ [snapshot.entryId] }
  else state

-- Window reset fences old coordinates before observers, keeps live activity, and clears only applicable child counts.
def resetCompletionWindow (state : CompletionAccounting) (full : Bool) : CompletionAccounting :=
  { state with
    generation := state.generation + 1
    accepted := none
    childActive := if full then 0 else state.childActive
    childReminder := 0
    completedPosition := if full then 0 else state.completedPosition
    rootLoops := 0 }

-- Universal safety laws separate repair from notification, forbid child root inflation, and preserve reset fencing/activity.
theorem branch_repair_never_notifies (state : CompletionAccounting)
    (snapshot : AcceptedBranchSnapshot) (authenticated : Bool) :
    (acceptBranchSnapshot state snapshot authenticated).notifications = state.notifications := by
  unfold acceptBranchSnapshot
  split <;> rfl

theorem child_snapshot_never_changes_root (state : CompletionAccounting)
    (snapshot : AcceptedBranchSnapshot) (authenticated : Bool) :
    (acceptBranchSnapshot state snapshot authenticated).rootLoops = state.rootLoops := by
  unfold acceptBranchSnapshot
  split <;> rfl

theorem reset_fences_old_completion (state : CompletionAccounting)
    (snapshot : AcceptedBranchSnapshot) (full authenticatedLive : Bool)
    (old : snapshot.generation = state.generation) :
    finalizedCompletion (resetCompletionWindow state full) snapshot authenticatedLive =
      resetCompletionWindow state full := by
  simp [finalizedCompletion, resetCompletionWindow, old]

theorem reset_keeps_busy_without_notifications (state : CompletionAccounting) (full : Bool) :
    (resetCompletionWindow state full).liveBusy = state.liveBusy ∧
    (resetCompletionWindow state full).notifications = state.notifications ∧
    (resetCompletionWindow state full).childReminder = 0 := by
  exact ⟨rfl, rfl, rfl⟩

-- Finite trace counts a reply during tool execution, then delivers its unchanged-count completion once; duplicate delivery has no effect.
def sampleFreshSnapshot : AcceptedBranchSnapshot :=
  { generation := 0, sequence := 2, scope := 0, entryId := "finalized", position := 1,
    active := 1, reminder := 1 }

theorem unchanged_count_fresh_completion_then_duplicate :
    let repaired := acceptBranchSnapshot {} sampleFreshSnapshot true
    let fresh := finalizedCompletion repaired sampleFreshSnapshot true
    repaired.childActive = 1 ∧ repaired.notifications = [] ∧
      fresh.childActive = repaired.childActive ∧ fresh.notifications = ["finalized"] ∧
      finalizedCompletion fresh sampleFreshSnapshot true = fresh := by
  decide

-- Coordinator theorem proves classified transport-input safety and the finite unchanged-count trace, not wire authentication/refinement, fairness or application dispatch.
theorem scoped_completion_accounting_is_correct :
    (∀ state snapshot authenticated,
      (acceptBranchSnapshot state snapshot authenticated).notifications = state.notifications) ∧
    (∀ state snapshot authenticated,
      (acceptBranchSnapshot state snapshot authenticated).rootLoops = state.rootLoops) ∧
    (∀ state snapshot full authenticatedLive, snapshot.generation = state.generation →
      finalizedCompletion (resetCompletionWindow state full) snapshot authenticatedLive =
        resetCompletionWindow state full) ∧
    (∀ state full, (resetCompletionWindow state full).liveBusy = state.liveBusy ∧
      (resetCompletionWindow state full).notifications = state.notifications ∧
      (resetCompletionWindow state full).childReminder = 0) ∧
    (let repaired := acceptBranchSnapshot {} sampleFreshSnapshot true
     let fresh := finalizedCompletion repaired sampleFreshSnapshot true
     repaired.childActive = 1 ∧ repaired.notifications = [] ∧
       fresh.childActive = repaired.childActive ∧ fresh.notifications = ["finalized"] ∧
       finalizedCompletion fresh sampleFreshSnapshot true = fresh) :=
  ⟨branch_repair_never_notifies, child_snapshot_never_changes_root,
    reset_fences_old_completion, reset_keeps_busy_without_notifications,
    unchanged_count_fresh_completion_then_duplicate⟩

#print axioms scoped_completion_accounting_is_correct

-- Application dispatch consumes an accepted fresh snapshot, independent of local/child busyness. Historical repair is not a decision boundary.
structure FreshDecisionState where
  currentMain : Bool := true
  held : Bool := false
  outstanding : Bool := false
  root : Nat := 0
  all : Nat := 0
  task : Nat := 0
  rootLimit : Nat := 60
  allLimit : Nat := 300
  taskLimit : Nat := 1200000
  cooldown : Bool := false
  busy : Bool := false
  reminderResets : Nat := 0
  submissions : Nat := 0
  deriving Repr, DecidableEq

def decideFresh (s : FreshDecisionState) (fresh : Bool) : FreshDecisionState :=
  if fresh && s.currentMain && !s.held && !s.outstanding &&
      (s.root >= s.rootLimit || s.all >= s.allLimit || s.task >= s.taskLimit) then
    { s with
      root := 0
      all := 0
      task := 0
      reminderResets := s.reminderResets + 1
      outstanding := !s.cooldown
      submissions := s.submissions + (if s.cooldown then 0 else 1) }
  else s

-- Universal guards forbid hold/repair/outstanding dispatch; busy state never adds a barrier and cooldown consumes without latching.
theorem fresh_guards (s : FreshDecisionState) :
    decideFresh s false = s ∧
    decideFresh { s with held := true } true = { s with held := true } ∧
    decideFresh { s with outstanding := true } true = { s with outstanding := true } := by
  simp [decideFresh]

theorem child_idle_busy_and_cooldown_controls :
    (decideFresh { all := 300, busy := false } true).submissions = 1 ∧
    (decideFresh { all := 300, busy := true } true).submissions = 1 ∧
    (decideFresh { all := 300, held := true } true).submissions = 0 ∧
    (decideFresh { all := 300, cooldown := true } true).reminderResets = 1 ∧
    (decideFresh { all := 300, cooldown := true } true).submissions = 0 := by
  decide

-- A result and completion marker are both prerequisites for a new plugin continuation. Authority revoked before either marker never authorizes a send.
def authorizeContinuation (current nonCancelled durableResult durableCompletion : Bool) : Bool :=
  current && nonCancelled && durableResult && durableCompletion

theorem durable_handoff_gate (result marker : Bool) :
    authorizeContinuation true false result marker = false ∧
    authorizeContinuation true true true true = true ∧
    authorizeContinuation true true false marker = false ∧
    authorizeContinuation true true result false = false := by
  simp [authorizeContinuation]

-- This theorem proves guard and finite control laws, not Pi event provenance, queue ordering, transport cryptography, physical suspend detection or eventual progress.
theorem runtime_fresh_dispatch_is_correct :
    (∀ s, decideFresh s false = s ∧
      decideFresh { s with held := true } true = { s with held := true } ∧
      decideFresh { s with outstanding := true } true = { s with outstanding := true }) ∧
    ((decideFresh { all := 300, busy := false } true).submissions = 1 ∧
      (decideFresh { all := 300, busy := true } true).submissions = 1 ∧
      (decideFresh { all := 300, held := true } true).submissions = 0 ∧
      (decideFresh { all := 300, cooldown := true } true).reminderResets = 1 ∧
      (decideFresh { all := 300, cooldown := true } true).submissions = 0) ∧
    (∀ result marker, authorizeContinuation true false result marker = false ∧
      authorizeContinuation true true true true = true ∧
      authorizeContinuation true true false marker = false ∧
      authorizeContinuation true true result false = false) :=
  ⟨fresh_guards, child_idle_busy_and_cooldown_controls, durable_handoff_gate⟩

#print axioms runtime_fresh_dispatch_is_correct

-- Top-level correctness combines local safety laws and concrete lifecycle and
-- replay examples. It does not prove scheduling, eventual progress, or runtime refinement.
theorem process_is_correct :
    (∀ state confirmed, resultToolAllowed state confirmed = true ↔
      state.phase = .main ∧ state.inquiryActive = true ∧
        confirmed = true ∧ state.runKind = .reflection) ∧
    (resultDeclaration.description = "don't use unless ask" ∧
      resultDeclaration.declaresRequiredFields = true ∧
      resultDeclaration.enumeratesResultType = true ∧
      resultDeclaration.rejectsExtraFields = true ∧
      resultDeclaration.explainsParameters = false) ∧
    (∀ lookups, projectOwnedResponse
      { resultCall := some .invalid, lookupCalls := lookups } =
        { executableCalls := 0, invalidAttempt := true }) ∧
    (∀ responses, attemptsUsed 1 responses ≤ maxResultAttempts) ∧
    (∀ attempt (response : OwnedResponse) rest,
      attemptsUsed attempt ({ response with providerError := true } :: rest) =
        attemptsUsed attempt rest) ∧
    (providerFailureSettlement false = .pending ∧
      providerFailureSettlement true = .cancelled) ∧
    (∀ attempt lookups, lookups ≠ 0 → settleAttempt attempt (projectOwnedResponse
      { resultCall := none, lookupCalls := lookups }) = .continueCalls) ∧
    (∀ reply, agentLoop reply = true ↔
      (reply.outcome = .stop ∨ reply.outcome = .toolUse) ∧
      reply.hasErrorMessage = false ∧ reply.isInquiryReply = false ∧
      reply.hasAgentOutput = true) ∧
    (∀ state, state.localBusy = true →
      (countTick state).counters.activeMs = state.counters.activeMs + 1) ∧
    (∀ state reply, state.runKind = .reflection →
      (countTurn state reply).counters = state.counters) ∧
    (∀ state, (countTick state).pending = state.pending) ∧
    (∀ state name, step state (.semanticHook name) = state) ∧
    (let main := step initial .acquireMain
      let queued := step main .queueManualReflection
      (step queued .dispatchReflection).inquiryActive = true) ∧
    (let main := step initial .acquireMain
      let localRun := step main (.agentStart .ordinary)
      let both := step localRun (.observeOtherBusy true)
      let queued := step both .queueManualReflection
      (step queued .dispatchReflection).inquiryActive = true) ∧
    (let main := step initial .acquireMain
      let localRun := step main (.agentStart .ordinary)
      let queued := step localRun .queueManualReflection
      (step queued .dispatchReflection).inquiryActive = true) ∧
    (let main := step initial .acquireMain
      let queued := step main .queueManualReflection
      (step queued .dispatchReflection).runKind = .reflection) ∧
    (let main := step initial .acquireMain
      let queued := step main .queueManualReflection
      let running := step queued .dispatchReflection
      let waiting := step running .queueManualReflection
      let aborted := step waiting .terminalAbortSettled
      aborted.inquiryActive = false ∧ aborted.pending = [] ∧
        aborted.held = true ∧ aborted.continuationQueued = false) ∧

    ((let main := step initial .acquireMain
      let aborted := step main .terminalAbortSettled
      (step aborted .activeTick).held = true ∧
        (step aborted (.agentStart .ordinary)).held = true ∧
        (step aborted (.semanticHook "resume-a")).held = true ∧
        (step aborted .agentSettled).held = true ∧
        (step aborted (.observeOtherBusy true)).held = true ∧
        (step aborted .userTakeoverMessage).held = true)) ∧
    ((let main := step initial .acquireMain
      let busy := step main (.agentStart .ordinary)
      let counted := step busy (.successfulTurn { outcome := .stop, hasErrorMessage := false, isInquiryReply := false, hasAgentOutput := true })
      let aborted := step counted .terminalAbortSettled
      let resumed := step aborted .explicitUserInput
      resumed.held = false ∧ resumed.counters = resetCycle counted.counters) ∧
      (let main := step initial .acquireMain
        let aborted := step main .terminalAbortSettled
        let queued := step aborted .queueManualReflection
        queued.held = false ∧ (step queued .dispatchReflection).inquiryActive = true)) ∧
    (∀ state decision, state.inquiryActive = false →
      submitResult state true decision =
        .error "This function is reserved for the plugin. Please try another function.") ∧
    (∀ attempt projection, settleAttemptWith attempt .aborted projection = .cancelled) ∧
    (let main := step initial .acquireMain
      let first := step main .queueManualReflection
      let running := step first .dispatchReflection
      let waiting := step running .queueManualReflection
      let finished := step waiting (.reflectionFinished .noIssue)
      (step finished .dispatchReflection).inquiryActive = true) ∧
    (let main := step initial .acquireMain
      let first := step main .queueManualReflection
      let running := step first .dispatchReflection
      let finished := step running (.reflectionFinished .noIssue)
      (step finished .dispatchReflection).inquiryActive = false) ∧
    (∀ state reply, state.runKind = .ordinary →
      agentLoop reply = false →
      (countTurn state reply).counters = state.counters) ∧
    (∀ state reply, state.runKind = .ordinary →
      agentLoop reply = true →
      (countTurn state reply).counters.activeLoops =
        state.counters.activeLoops + 1 ∧
      (countTurn state reply).counters.rootLoops =
        state.counters.rootLoops + 1 ∧
      (countTurn state reply).counters.allLoops =
        state.counters.allLoops + 1) ∧
    (∀ state : State,
      (step { state with phase := .observer } .acquireMain).phase = .main) ∧
    (∀ state : State, state.phase ≠ .shutdown → Safe (step state .shutdown)) ∧
    (∀ state event, state.phase = .shutdown → step state event = state) ∧
    (∀ state decision, state.inquiryActive = true → state.phase ≠ .shutdown →
      (step state (.reflectionFinished decision)).continuationQueued = true ∧
      step (step state (.reflectionFinished decision)) (.reflectionFinished decision) =
        step state (.reflectionFinished decision)) ∧
    ((cooldownBound 60 = 20 ∧ cooldownBound 90 = 30 ∧
      cooldownBound 120 = 30 ∧ cooldownBound 30 = 10 ∧
      cooldownBound 2 = 10 ∧ cooldownBound 33 = 11) ∧
    (cooldownAllows .rootLoopLimit true 90 30 = false ∧
      cooldownAllows .rootLoopLimit true 90 31 = true) ∧
    (cooldownAllows .rootLoopLimit true 30 10 = false ∧
      cooldownAllows .rootLoopLimit true 30 11 = true) ∧
    (∀ loops, cooldownAllows .userRequest true 30 loops = true) ∧
    (∀ trigger loops, cooldownAllows trigger false 30 loops = true)) ∧
    anyLiveBusy offlineSample = false ∧
    (offlineSample.activeMs = synchronizedSample.activeMs ∧
      offlineSample.taskMs = synchronizedSample.taskMs) ∧
    (replayedSample.rootLoops = offlineSample.rootLoops + replayAccepted.root ∧
      replayedSample.allLoops = offlineSample.allLoops + replayAccepted.all ∧
      replayedSample.activeMs = offlineSample.activeMs ∧
      replayedSample.taskMs = offlineSample.taskMs) ∧
    (expiredSeededSample.rootLoops = offlineSample.rootLoops ∧
      expiredSeededSample.allLoops = offlineSample.allLoops ∧
      findLedger "child/process-1" expiredSeededSample.ledger = some {
        generation := returnedCheckpoint.generation
        sequence := returnedCheckpoint.sequence
        rootLoops := returnedCheckpoint.rootLoops
        allLoops := returnedCheckpoint.allLoops
        replayUntilMs := none }) ∧
    (synchronizationDeltaAllowed none returnedCheckpoint zeroAccepted = true ∧
      synchronizationDeltaAllowed none returnedCheckpoint
        { root := returnedCheckpoint.rootLoops, all := returnedCheckpoint.allLoops } = true ∧
      synchronizationDeltaAllowed none returnedCheckpoint { root := 1, all := 1 } = false) ∧
    (findLive "live-1" resynchronizedSample.live = none ∧
      (findLive "live-2" resynchronizedSample.live).isSome = true) ∧
    (∀ state ledger, anyLiveBusy { state with ledger := ledger } = anyLiveBusy state) ∧
    (let held := { initial with phase := .main, held := true, pending := [.userRequest] };
      step held .dispatchReflection = held) ∧
    (let observer := { initial with
      counters := { activeMs := 10, activeLoops := 2, taskMs := 30, rootLoops := 4, allLoops := 5 }
      pending := [.userRequest], localBusy := true, inquiryActive := true };
      step observer .terminalAbortSettled = observer) ∧
    (let main := step initial .acquireMain
      let running := step (step main .queueManualReflection) .dispatchReflection
      let waiting := step (step running .queueManualReflection) .queueManualReflection
      waiting.pending = [.userRequest]) ∧
    (∀ state decision, (step state (.reflectionFinished decision)).counters = state.counters) := by
  constructor
  · exact result_tool_gate
  constructor
  · exact result_declaration_is_constrained_without_prose
  constructor
  · exact invalid_result_never_reaches_dispatch
  constructor
  · exact no_fourth_attempt
  constructor
  · exact provider_retry_preserves_attempt
  constructor
  · exact provider_failure_settlement_boundary
  constructor
  · exact lookup_only_continues
  constructor
  · exact success_policy_exact
  constructor
  · exact busy_inquiry_tick_counts
  constructor
  · exact reflection_turn_never_counts
  constructor
  · exact ticks_never_latch
  constructor
  · exact legacy_hooks_have_no_effect
  constructor
  · exact manual_reflection_can_dispatch
  constructor
  · exact simultaneous_local_and_other_busy_still_dispatches
  constructor
  · exact local_busy_still_dispatches
  constructor
  · exact dispatch_classifies_reflection
  constructor
  · exact abort_cancels_cycle_and_holds
  constructor
  · exact background_events_keep_hold_and_role_only_message
  constructor
  · exact explicit_input_and_fresh_manual_reentry
  constructor
  · exact late_result_without_inquiry_is_rejected
  constructor
  · exact aborted_outcome_precedence
  constructor
  · exact waiting_manual_dispatches_after_finish
  constructor
  · exact single_manual_not_redispatched_after_finish
  constructor
  · exact failed_ordinary_turn_never_counts
  constructor
  · exact successful_ordinary_turn_counts_once
  constructor
  · exact observer_can_reclaim_main
  constructor
  · intro state active
    exact shutdown_is_clean state active
  constructor
  · exact shutdown_is_absorbing
  constructor
  · exact valid_reflection_queues_one_continuation
  constructor
  · exact cooldown_policy
  constructor
  · exact offline_removes_busy_immediately
  constructor
  · exact offline_preserves_accounting_time
  constructor
  · exact retained_replay_adds_exact_loop_delta_only
  constructor
  · exact expired_history_seeds_without_replay
  constructor
  · exact missing_history_accepts_only_zero_or_current
  constructor
  · exact resynchronization_replaces_prior_live_handle
  constructor
  · exact ledger_has_no_busy_authority
  constructor
  · exact hold_blocks_dispatch
  constructor
  · exact observer_takeover_is_ignored
  constructor
  · exact manual_waiting_slot_coalesces
  · exact reflection_finish_preserves_counters

#print axioms process_is_correct
#print axioms provider_error_is_not_invalid
#print axioms provider_retry_preserves_attempt
#print axioms provider_failure_settlement_boundary
#print axioms abort_cancels_cycle_and_holds
#print axioms hold_blocks_dispatch
#print axioms background_events_keep_hold_and_role_only_message
#print axioms explicit_input_and_fresh_manual_reentry
#print axioms late_result_without_inquiry_is_rejected
#print axioms aborted_outcome_precedence
#print axioms aborted_staged_valid_result_is_cancelled

end PiReflectWatchdogLifecycle

-- Executable summary exposes the modeled result without external effects.
def main : IO Unit := do
  IO.println "reflect model: confirmed-main result gate; constrained declaration without parameter prose; invalid results expose no calls; at most three result attempts, provider failures consume none and cancel only at terminal settlement, lookup-only replies continue; completion flag is idempotent; coordinator repair never notifies, child snapshots never change root loops, full/reminder scopes fence delayed completion while retaining busy contributors, unchanged-count finalized completion delivers once; abort cancels the old cycle (inquiry, pending asks, staged results) and holds dispatch until explicit user input or fresh /reflect; branch-accounting foundation requires recorded/legacy/domain-baseline policy; source-qualified markers reset main windows while role-only wakes and child-local resets preserve contributions; inherited fork history excluded and missing baselines rejected; official inquiry clocks; no counting pause or automatic latches; only fresh main/child completion decides; held/repair/outstanding controls cannot dispatch; durable result+marker gates new continuation; coalesced manual waiting slot; finalization preserves counters (automatic acceptance/cooldown consumption resets reminder budgets); lifecycle loop/shutdown laws and cooldown/replay examples; no runtime refinement or eventual-progress proof"
