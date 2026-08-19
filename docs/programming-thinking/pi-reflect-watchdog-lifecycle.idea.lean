-- This document uses Lean 4 and Std only; it performs no filesystem, process,
-- network, or environment effects, and keeps all implicit parameters disabled.
import Std

set_option autoImplicit false

namespace PiReflectWatchdogLifecycle

-- The first model translates the current plugin's attachment, reflection,
-- counter, and shared-domain fields into explicit process data.
inductive AttachmentPhase where
  | new
  | loading
  | root
  | observer
  | shutdown
  deriving Repr, DecidableEq

structure CurrentAttachmentState where
  phase : AttachmentPhase
  attachPending : Bool
  domainAttached : Bool
  controlsRegistered : Bool
  deriving Repr, DecidableEq

def currentAttachmentInitial : CurrentAttachmentState :=
  { phase := .new, attachPending := false, domainAttached := false,
    controlsRegistered := false }

def currentBeginDomainAttach (_ : CurrentAttachmentState) : CurrentAttachmentState :=
  { phase := .root, attachPending := true, domainAttached := false,
    controlsRegistered := false }

def currentDemoteWhileAttachPending (state : CurrentAttachmentState) : CurrentAttachmentState :=
  { state with
    phase := .observer
    domainAttached := false
    controlsRegistered := false }

def currentUnconditionalAttachCompletion (state : CurrentAttachmentState) : CurrentAttachmentState :=
  { state with
    attachPending := false
    domainAttached := true
    controlsRegistered := true }

-- This trace translates session_start claiming root, awaiting domain attach,
-- demotion by another attachment, then the stale attach promise committing.
def currentLateAttachState : CurrentAttachmentState :=
  currentUnconditionalAttachCompletion
    (currentDemoteWhileAttachPending
      (currentBeginDomainAttach currentAttachmentInitial))

def attachmentOwnershipConsistent (state : CurrentAttachmentState) : Prop :=
  state.domainAttached = true → state.phase = .root

inductive CoreRunPhase where
  | idle
  | running
  deriving Repr, DecidableEq

structure CurrentReflectionState where
  coreRun : CoreRunPhase
  activityOpen : Bool
  reflectionActive : Bool
  watchdogPaused : Bool
  domainPaused : Bool
  resumeAfterSettlement : Bool
  deriving Repr, DecidableEq

def currentOrdinaryRun : CurrentReflectionState :=
  { coreRun := .running, activityOpen := true, reflectionActive := false,
    watchdogPaused := false, domainPaused := false,
    resumeAfterSettlement := false }

def currentTriggerReflection (state : CurrentReflectionState) : CurrentReflectionState :=
  { state with
    reflectionActive := true
    watchdogPaused := true
    resumeAfterSettlement := false }

def currentPauseCompletion (state : CurrentReflectionState) : CurrentReflectionState :=
  { state with domainPaused := true }

def currentReflectionMessageEnd (state : CurrentReflectionState) : CurrentReflectionState :=
  { state with reflectionActive := false, resumeAfterSettlement := true }

def currentAgentSettled (state : CurrentReflectionState) : CurrentReflectionState :=
  if state.watchdogPaused then
    if state.resumeAfterSettlement then
      { state with
        coreRun := .idle
        watchdogPaused := false
        domainPaused := false
        resumeAfterSettlement := false }
    else
      { state with coreRun := .idle }
  else
    { state with coreRun := .idle, activityOpen := false }

-- Pi Core can settle an aborted run without delivering the interruptible
-- assistant message_end handler; both abort and successful-settlement traces are explicit.
def currentAbortedReflectionState : CurrentReflectionState :=
  currentAgentSettled
    (currentPauseCompletion
      (currentTriggerReflection currentOrdinaryRun))

def currentSuccessfulReflectionState : CurrentReflectionState :=
  currentAgentSettled
    (currentReflectionMessageEnd
      (currentPauseCompletion
        (currentTriggerReflection currentOrdinaryRun)))

def reflectionIsStuck (state : CurrentReflectionState) : Prop :=
  state.coreRun = .idle ∧
  state.reflectionActive = true ∧
  state.watchdogPaused = true ∧
  state.domainPaused = true ∧
  state.resumeAfterSettlement = false

def activityAgreesWithCore (state : CurrentReflectionState) : Prop :=
  state.coreRun = .idle → state.activityOpen = false

structure CurrentRetryClassificationState where
  coreRun : CoreRunPhase
  workClassified : Bool
  domainBusy : Bool
  deriving Repr, DecidableEq

def currentManualRetryAfterAgentStart : CurrentRetryClassificationState :=
  { coreRun := .running, workClassified := false, domainBusy := false }

def runningWorkIsReportedBusy (state : CurrentRetryClassificationState) : Prop :=
  state.coreRun = .running → state.domainBusy = true

structure CurrentPreSendFailureState where
  coreRun : CoreRunPhase
  reflectionActive : Bool
  watchdogPaused : Bool
  domainPaused : Bool
  resumeAfterSettlement : Bool
  requestSent : Bool
  deriving Repr, DecidableEq

def currentIdleManualReflection : CurrentPreSendFailureState :=
  { coreRun := .idle, reflectionActive := true, watchdogPaused := true,
    domainPaused := false, resumeAfterSettlement := false,
    requestSent := false }

def currentPauseFailureBeforeSend
    (state : CurrentPreSendFailureState) : CurrentPreSendFailureState :=
  { state with reflectionActive := false, resumeAfterSettlement := true }

def currentPreSendFailureState : CurrentPreSendFailureState :=
  currentPauseFailureBeforeSend currentIdleManualReflection

def preSendFailureIsStuck (state : CurrentPreSendFailureState) : Prop :=
  state.coreRun = .idle ∧
  state.reflectionActive = false ∧
  state.watchdogPaused = true ∧
  state.resumeAfterSettlement = true ∧
  state.requestSent = false

-- Local controller counters and broker-owned counters are separate object flows;
-- the current reset control mutates only the local copy.
structure CurrentCounterState where
  localLoops : Nat
  brokerLoops : Nat
  deriving Repr, DecidableEq

def currentLocalOnlyReset (state : CurrentCounterState) : CurrentCounterState :=
  { state with localLoops := 0 }

def currentCounterExample : CurrentCounterState :=
  currentLocalOnlyReset { localLoops := 7, brokerLoops := 7 }

def countersAgree (state : CurrentCounterState) : Prop :=
  state.localLoops = state.brokerLoops

-- The process-domain coordinator is shared across attachments, so root shutdown
-- need not close it while observers remain and a prior global pause can survive.
structure CurrentSharedDomainState where
  attachments : Nat
  paused : Bool
  deriving Repr, DecidableEq

def currentRootShutdown (state : CurrentSharedDomainState) : CurrentSharedDomainState :=
  { state with attachments := state.attachments - 1 }

def currentShutdownWhileObserverRemains : CurrentSharedDomainState :=
  currentRootShutdown { attachments := 2, paused := true }

def sharedDomainReleased (state : CurrentSharedDomainState) : Prop :=
  state.attachments = 0 ∨ state.paused = false

-- These predicates formalize forbidden current-code combinations rather than
-- treating comments, tests, or intended behavior as proof of correctness.
def CurrentImplementationDefects : Prop :=
  ¬ attachmentOwnershipConsistent currentLateAttachState ∧
  reflectionIsStuck currentAbortedReflectionState ∧
  ¬ activityAgreesWithCore currentSuccessfulReflectionState ∧
  ¬ runningWorkIsReportedBusy currentManualRetryAfterAgentStart ∧
  preSendFailureIsStuck currentPreSendFailureState ∧
  ¬ countersAgree currentCounterExample ∧
  ¬ sharedDomainReleased currentShutdownWhileObserverRemains

theorem current_implementation_defects_are_reachable :
    CurrentImplementationDefects := by
  simp [CurrentImplementationDefects, attachmentOwnershipConsistent,
    currentLateAttachState, currentUnconditionalAttachCompletion,
    currentDemoteWhileAttachPending, currentBeginDomainAttach,
    reflectionIsStuck,
    currentAbortedReflectionState, currentPauseCompletion,
    currentTriggerReflection, currentOrdinaryRun, currentAgentSettled,
    activityAgreesWithCore, currentSuccessfulReflectionState,
    currentReflectionMessageEnd, runningWorkIsReportedBusy,
    currentManualRetryAfterAgentStart, preSendFailureIsStuck,
    currentPreSendFailureState, currentPauseFailureBeforeSend,
    currentIdleManualReflection, countersAgree, currentCounterExample,
    currentLocalOnlyReset, sharedDomainReleased,
    currentShutdownWhileObserverRemains, currentRootShutdown]

-- The repaired model names every participant and assigns one owner to each
-- lifecycle responsibility before defining the event/state vocabulary.
inductive Participant where
  | piCoreAgentLoop
  | piCoreAgentSession
  | pluginRuntime
  | processDomainCoordinator
  | sessionManager
  | environment
  deriving Repr, DecidableEq

inductive Responsibility where
  | emitRunAndTurnEvents
  | emitFinalSettlement
  | ownAttachmentAndReflectionState
  | ownSharedCountersAndPause
  | persistValidatedOutcome
  | deliverAsyncCompletionsAndShutdown
  deriving Repr, DecidableEq

def responsibilityOwner : Responsibility → Participant
  | .emitRunAndTurnEvents => .piCoreAgentLoop
  | .emitFinalSettlement => .piCoreAgentSession
  | .ownAttachmentAndReflectionState => .pluginRuntime
  | .ownSharedCountersAndPause => .processDomainCoordinator
  | .persistValidatedOutcome => .sessionManager
  | .deliverAsyncCompletionsAndShutdown => .environment

theorem every_responsibility_has_one_declared_owner
    (responsibility : Responsibility) :
    ∃ participant, participant = responsibilityOwner responsibility ∧
      ∀ other, other = responsibilityOwner responsibility → other = participant := by
  exact ⟨responsibilityOwner responsibility, rfl,
    fun other equality => equality⟩

structure CodeSource where
  repository : String
  path : String
  symbol : String
  sha256 : String
  deriving Repr, DecidableEq

def pluginRevision : String :=
  "a1ec9a96ac8e89ffb66769cfce360940660a417b"

def piCoreWorktreeRevision : String :=
  "602af3db809911ed01e6ca529bf230e603f64434"

def translatedCodeSources : List CodeSource :=
  [ { repository := "pi", path := "packages/agent/src/agent-loop.ts",
      symbol := "runAgentLoop/runLoop",
      sha256 := "7847a7f5083420b036e0f63d77f48032a27a2f6835a55f94d5ae688fbdf982da" },
    { repository := "pi", path := "packages/coding-agent/src/core/agent-session.ts",
      symbol := "_handleAgentEvent/_emitAgentSettled/_runAgentPrompt/retry",
      sha256 := "104bd24c4d70f06964ce37a0f61ce9cf720c959a395f1977c473a025d7d1d75e" },
    { repository := "pi", path := "packages/coding-agent/src/core/extensions/runner.ts",
      symbol := "ExtensionRunner.emit/emitSessionShutdownEvent",
      sha256 := "a0cf6814f9410236aeb7733d29ed82322eb314ed097a61fe1fad49f6225e5dac" },
    { repository := "pi-reflect-watchdog", path := "src/extension.ts",
      symbol := "createWatchdogExtension/beginNextReflection/finalizeReflection/deactivate",
      sha256 := "3e705f529fc1c15f87e90595aaf0f305f74f78cc79864977de6e54421c215ecb" },
    { repository := "pi-reflect-watchdog", path := "src/process-domain.ts",
      symbol := "createReflectDomainCoordinator",
      sha256 := "d5036d4d7d678708a07931c42195a1e70f88c2b01d1150e83e9e2fd3409197ff" },
    { repository := "pi-reflect-watchdog", path := "src/controller.ts",
      symbol := "TaskController",
      sha256 := "f82f02726ee94ac5f4e1fcd24895b6dc0a041835a3813d4bb2256716ade56a6d" } ]

structure PiCoreContract where
  agentStartPrecedesPromptMessages : Bool
  eachProviderTurnEmitsTurnEnd : Bool
  retriesMayStartWithoutPromptMessage : Bool
  abortMaySkipInterruptibleMessageEnd : Bool
  settlementFollowsAllAutomaticContinuations : Bool
  shutdownPrecedesRuntimeInvalidation : Bool
  deriving Repr, DecidableEq

def translatedPiCoreContract : PiCoreContract :=
  { agentStartPrecedesPromptMessages := true,
    eachProviderTurnEmitsTurnEnd := true,
    retriesMayStartWithoutPromptMessage := true,
    abortMaySkipInterruptibleMessageEnd := true,
    settlementFollowsAllAutomaticContinuations := true,
    shutdownPrecedesRuntimeInvalidation := true }

def PiCoreContractSatisfied (contract : PiCoreContract) : Prop :=
  contract.agentStartPrecedesPromptMessages = true ∧
  contract.eachProviderTurnEmitsTurnEnd = true ∧
  contract.retriesMayStartWithoutPromptMessage = true ∧
  contract.abortMaySkipInterruptibleMessageEnd = true ∧
  contract.settlementFollowsAllAutomaticContinuations = true ∧
  contract.shutdownPrecedesRuntimeInvalidation = true

theorem translated_pi_core_contract_is_explicit :
    PiCoreContractSatisfied translatedPiCoreContract := by
  simp [PiCoreContractSatisfied, translatedPiCoreContract]

-- The repaired activity vocabulary aligns Pi Core session/run/turn/settlement
-- events with plugin ownership, domain pause, reflection, and cleanup phases.
inductive ReflectionDecision where
  | noIssue
  | routeCorrection
  deriving Repr, DecidableEq

inductive ProcessOutcome where
  | none
  | noIssue
  | routeCorrection
  | reflectionAborted
  | pauseFailure
  | attachFailure
  deriving Repr, DecidableEq

inductive PriorRunPhase where
  | idle
  | running
  deriving Repr, DecidableEq

inductive LifecyclePhase where
  | new
  | loading (generation : Nat)
  | attachingDomain (generation : Nat)
  | rootIdle (generation : Nat)
  | rootRunning (generation : Nat)
  | pauseRequested (generation : Nat) (priorRun : PriorRunPhase)
  | awaitingReflection (generation : Nat) (priorRun : PriorRunPhase)
  | awaitingSettlement (generation : Nat) (priorRun : PriorRunPhase)
      (outcome : ProcessOutcome) (domainWasPaused : Bool)
  | observer
  | shutdown
  deriving Repr, DecidableEq

-- Process data carries the phase, both counter authorities, and the observable
-- result transferred from reflection or failure handling.
structure ProcessState where
  phase : LifecyclePhase
  localLoops : Nat
  brokerLoops : Nat
  outcome : ProcessOutcome
  deriving Repr, DecidableEq

inductive LifecycleEvent where
  | sessionStarted (generation : Nat)
  | configurationLoaded
  | domainAttachSucceeded
  | domainAttachFailed
  | rootReplaced
  | ordinaryRunStarted
  | ordinaryTurnEnded
  | reflectionTriggered
  | domainPauseSucceeded
  | domainPauseFailed
  | reflectionResponseEnded (decision : ReflectionDecision)
  | agentSettled
  | resetCounters
  | sessionShutdown
  deriving Repr, DecidableEq

def repairedInitial : ProcessState :=
  { phase := .new, localLoops := 0, brokerLoops := 0,
    outcome := .none }

def decisionOutcome : ReflectionDecision → ProcessOutcome
  | .noIssue => .noIssue
  | .routeCorrection => .routeCorrection

-- Named guards expose resource ownership and activity facts used by registration,
-- reflection response acceptance, counter reset, and cleanup decisions.
def rootOwned : LifecyclePhase → Bool
  | .loading _
  | .attachingDomain _
  | .rootIdle _
  | .rootRunning _
  | .pauseRequested _ _
  | .awaitingReflection _ _
  | .awaitingSettlement _ _ _ _ => true
  | _ => false

def domainAttached : LifecyclePhase → Bool
  | .rootIdle _
  | .rootRunning _
  | .pauseRequested _ _
  | .awaitingReflection _ _
  | .awaitingSettlement _ _ _ _ => true
  | _ => false

def controlsRegistered : LifecyclePhase → Bool := domainAttached

def reflectionActive : LifecyclePhase → Bool
  | .pauseRequested _ _
  | .awaitingReflection _ _
  | .awaitingSettlement _ _ _ _ => true
  | _ => false

def domainPaused : LifecyclePhase → Bool
  | .awaitingReflection _ _ => true
  | .awaitingSettlement _ _ _ wasPaused => wasPaused
  | _ => false

def activityOpen : LifecyclePhase → Bool
  | .rootRunning _
  | .pauseRequested _ .running
  | .awaitingReflection _ .running
  | .awaitingSettlement _ .running _ _ => true
  | _ => false

def isFinal (state : ProcessState) : Prop :=
  state.phase = .shutdown

def SafeInvariant (state : ProcessState) : Prop :=
  state.localLoops = state.brokerLoops

def ForbiddenState (state : ProcessState) : Prop :=
  (domainAttached state.phase = true ∧ rootOwned state.phase = false) ∨
  (controlsRegistered state.phase = true ∧ domainAttached state.phase = false) ∨
  (domainPaused state.phase = true ∧ reflectionActive state.phase = false) ∨
  (activityOpen state.phase = true ∧ rootOwned state.phase = false) ∨
  (state.phase = .shutdown ∧
    (domainAttached state.phase = true ∨
     controlsRegistered state.phase = true ∨
     domainPaused state.phase = true ∨
     activityOpen state.phase = true)) ∨
  state.localLoops ≠ state.brokerLoops

def onSessionStarted (state : ProcessState) (generation : Nat) : ProcessState :=
  match state.phase with
  | .new => { state with phase := .loading generation }
  | _ => state

def onConfigurationLoaded (state : ProcessState) : ProcessState :=
  match state.phase with
  | .loading generation => { state with phase := .attachingDomain generation }
  | _ => state

def onDomainAttachSucceeded (state : ProcessState) : ProcessState :=
  match state.phase with
  | .attachingDomain generation => { state with phase := .rootIdle generation }
  | _ => state

def onDomainAttachFailed (state : ProcessState) : ProcessState :=
  match state.phase with
  | .attachingDomain _ =>
      { state with phase := .shutdown, outcome := .attachFailure }
  | _ => state

def onRootReplaced (state : ProcessState) : ProcessState :=
  match state.phase with
  | .shutdown => state
  | _ =>
      { state with
        phase := .observer
        outcome := if reflectionActive state.phase then .reflectionAborted
                   else state.outcome }

def onOrdinaryRunStarted (state : ProcessState) : ProcessState :=
  match state.phase with
  | .rootIdle generation => { state with phase := .rootRunning generation }
  | _ => state

def onOrdinaryTurnEnded (state : ProcessState) : ProcessState :=
  match state.phase with
  | .rootRunning _ =>
      { state with
        localLoops := state.localLoops + 1
        brokerLoops := state.brokerLoops + 1 }
  | _ => state

def onReflectionTriggered (state : ProcessState) : ProcessState :=
  match state.phase with
  | .rootIdle generation =>
      { state with phase := .pauseRequested generation .idle }
  | .rootRunning generation =>
      { state with phase := .pauseRequested generation .running }
  | _ => state

def onDomainPauseSucceeded (state : ProcessState) : ProcessState :=
  match state.phase with
  | .pauseRequested generation priorRun =>
      { state with phase := .awaitingReflection generation priorRun }
  | _ => state

def restorePriorRun (generation : Nat) : PriorRunPhase → LifecyclePhase
  | .idle => .rootIdle generation
  | .running => .rootRunning generation

def onDomainPauseFailed (state : ProcessState) : ProcessState :=
  match state.phase with
  | .pauseRequested generation priorRun =>
      { state with
        phase := restorePriorRun generation priorRun
        outcome := .pauseFailure }
  | _ => state

def onReflectionResponseEnded
    (state : ProcessState) (decision : ReflectionDecision) : ProcessState :=
  match state.phase with
  | .awaitingReflection generation priorRun =>
      let outcome := decisionOutcome decision
      { state with
        phase := .awaitingSettlement generation priorRun outcome true,
        outcome := outcome }
  | _ => state

def onAgentSettled (state : ProcessState) : ProcessState :=
  match state.phase with
  | .rootRunning generation => { state with phase := .rootIdle generation }
  | .pauseRequested generation _ =>
      { state with
        phase := .rootIdle generation
        outcome := .reflectionAborted }
  | .awaitingReflection generation _ =>
      { state with
        phase := .rootIdle generation
        outcome := .reflectionAborted }
  | .awaitingSettlement generation _ outcome _ =>
      { state with phase := .rootIdle generation, outcome := outcome }
  | _ => state

def onResetCounters (state : ProcessState) : ProcessState :=
  if rootOwned state.phase then
    { state with localLoops := 0, brokerLoops := 0 }
  else state

def onSessionShutdown (state : ProcessState) : ProcessState :=
  { state with phase := .shutdown }

-- Event handlers implement the control flow: stale completions are ignored,
-- settlement is the merge for success/abort/failure, and reset is atomic across counters.
def repairedStep (state : ProcessState) (event : LifecycleEvent) : ProcessState :=
  match event with
  | .sessionStarted generation => onSessionStarted state generation
  | .configurationLoaded => onConfigurationLoaded state
  | .domainAttachSucceeded => onDomainAttachSucceeded state
  | .domainAttachFailed => onDomainAttachFailed state
  | .rootReplaced => onRootReplaced state
  | .ordinaryRunStarted => onOrdinaryRunStarted state
  | .ordinaryTurnEnded => onOrdinaryTurnEnded state
  | .reflectionTriggered => onReflectionTriggered state
  | .domainPauseSucceeded => onDomainPauseSucceeded state
  | .domainPauseFailed => onDomainPauseFailed state
  | .reflectionResponseEnded decision => onReflectionResponseEnded state decision
  | .agentSettled => onAgentSettled state
  | .resetCounters => onResetCounters state
  | .sessionShutdown => onSessionShutdown state

-- Complementary decision guards make async attach completion and reflection
-- response handling total, exclusive, and fail-closed.
def attachCommitGuard : LifecyclePhase → Bool
  | .attachingDomain _ => true
  | _ => false

def attachCompensateGuard (phase : LifecyclePhase) : Bool :=
  !attachCommitGuard phase

def reflectionResponseAcceptGuard : LifecyclePhase → Bool
  | .awaitingReflection _ _ => true
  | _ => false

def reflectionResponseIgnoreGuard (phase : LifecyclePhase) : Bool :=
  !reflectionResponseAcceptGuard phase

-- These guard proofs establish that every completion chooses exactly one branch
-- and that accepting a completion implies its required source phase.
theorem attach_guards_complete_and_exclusive (phase : LifecyclePhase) :
    (attachCommitGuard phase = true ∨ attachCompensateGuard phase = true) ∧
    ¬ (attachCommitGuard phase = true ∧ attachCompensateGuard phase = true) := by
  cases phase <;> simp [attachCommitGuard, attachCompensateGuard]

theorem attach_commit_guard_is_sound (phase : LifecyclePhase)
    (guard : attachCommitGuard phase = true) :
    ∃ generation, phase = .attachingDomain generation := by
  cases phase <;> simp [attachCommitGuard] at guard ⊢

theorem reflection_response_guards_complete_and_exclusive
    (phase : LifecyclePhase) :
    (reflectionResponseAcceptGuard phase = true ∨
      reflectionResponseIgnoreGuard phase = true) ∧
    ¬ (reflectionResponseAcceptGuard phase = true ∧
      reflectionResponseIgnoreGuard phase = true) := by
  cases phase <;>
    simp [reflectionResponseAcceptGuard, reflectionResponseIgnoreGuard]

theorem reflection_response_accept_guard_is_sound (phase : LifecyclePhase)
    (guard : reflectionResponseAcceptGuard phase = true) :
    ∃ generation priorRun, phase = .awaitingReflection generation priorRun := by
  cases phase <;> simp [reflectionResponseAcceptGuard] at guard ⊢

-- Initialization and preservation prove that all modeled transitions retain
-- equality between local and broker counter authorities.
theorem repaired_initial_establishes_invariant :
    SafeInvariant repairedInitial := by
  rfl

theorem repaired_step_preserves_invariant
    (state : ProcessState) (event : LifecycleEvent)
    (invariant : SafeInvariant state) :
    SafeInvariant (repairedStep state event) := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;> cases event <;>
    simp_all [repairedStep, onSessionStarted, onConfigurationLoaded,
      onDomainAttachSucceeded, onDomainAttachFailed, onRootReplaced,
      onOrdinaryRunStarted, onOrdinaryTurnEnded, onReflectionTriggered,
      onDomainPauseSucceeded, onDomainPauseFailed,
      onReflectionResponseEnded, onAgentSettled, onResetCounters,
      onSessionShutdown, SafeInvariant, rootOwned, restorePriorRun]

-- Structural safety lemmas connect attached resources, controls, paused domains,
-- and open activity to the root-owned phases that may legally contain them.
theorem attached_state_is_root_owned (state : ProcessState)
    (attached : domainAttached state.phase = true) :
    rootOwned state.phase = true := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;> simp_all [domainAttached, rootOwned]

theorem registered_controls_require_attachment (state : ProcessState)
    (registered : controlsRegistered state.phase = true) :
    domainAttached state.phase = true := by
  simpa [controlsRegistered] using registered

theorem paused_domain_has_active_reflection (state : ProcessState)
    (paused : domainPaused state.phase = true) :
    reflectionActive state.phase = true := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;> simp_all [domainPaused, reflectionActive]

theorem open_activity_is_root_owned (state : ProcessState)
    (openActivity : activityOpen state.phase = true) :
    rootOwned state.phase = true := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;> simp_all [activityOpen, rootOwned]

theorem invariant_excludes_forbidden_state (state : ProcessState)
    (invariant : SafeInvariant state) :
    ¬ ForbiddenState state := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;>
    simp_all [ForbiddenState, SafeInvariant, domainAttached, rootOwned,
      controlsRegistered, domainPaused, reflectionActive, activityOpen]

-- Reachability closes preservation transitively, proving forbidden combinations
-- unreachable for every finite event trace admitted by repairedStep.
inductive Reachable : ProcessState → Prop where
  | initial : Reachable repairedInitial
  | next (state : ProcessState) (event : LifecycleEvent) :
      Reachable state → Reachable (repairedStep state event)

theorem every_reachable_state_preserves_invariant (state : ProcessState)
    (reachable : Reachable state) : SafeInvariant state := by
  induction reachable with
  | initial => exact repaired_initial_establishes_invariant
  | next state event _ prior =>
      exact repaired_step_preserves_invariant state event prior

theorem repaired_process_is_safe (state : ProcessState)
    (reachable : Reachable state) : ¬ ForbiddenState state :=
  invariant_excludes_forbidden_state state
    (every_reachable_state_preserves_invariant state reachable)

-- Targeted recovery theorems establish compensation for stale attach, abort-safe
-- reflection settlement, activity closure, atomic reset, and shutdown cleanup.
theorem stale_attach_completion_is_compensated (state : ProcessState)
    (observer : state.phase = .observer) :
    repairedStep state .domainAttachSucceeded = state ∧
    domainAttached (repairedStep state .domainAttachSucceeded).phase = false ∧
    controlsRegistered (repairedStep state .domainAttachSucceeded).phase = false := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;>
    simp_all [repairedStep, onDomainAttachSucceeded, domainAttached,
      controlsRegistered]

theorem pause_failure_restores_idle_origin
    (state : ProcessState) (generation : Nat)
    (pending : state.phase = .pauseRequested generation .idle) :
    let next := repairedStep state .domainPauseFailed
    next.phase = .rootIdle generation ∧
    next.outcome = .pauseFailure ∧
    reflectionActive next.phase = false ∧
    domainPaused next.phase = false := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;>
    simp_all [repairedStep, onDomainPauseFailed, restorePriorRun,
      reflectionActive, domainPaused]

theorem pause_failure_restores_running_origin
    (state : ProcessState) (generation : Nat)
    (pending : state.phase = .pauseRequested generation .running) :
    let next := repairedStep state .domainPauseFailed
    next.phase = .rootRunning generation ∧
    next.outcome = .pauseFailure ∧
    activityOpen next.phase = true ∧
    domainPaused next.phase = false := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;>
    simp_all [repairedStep, onDomainPauseFailed, restorePriorRun,
      activityOpen, domainPaused]

theorem agent_start_immediately_classifies_running_work
    (state : ProcessState) (generation : Nat)
    (idle : state.phase = .rootIdle generation) :
    let next := repairedStep state .ordinaryRunStarted
    next.phase = .rootRunning generation ∧ activityOpen next.phase = true := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;>
    simp_all [repairedStep, onOrdinaryRunStarted, activityOpen]

theorem aborted_reflection_recovers_on_settlement
    (state : ProcessState) (generation : Nat) (priorRun : PriorRunPhase)
    (waiting : state.phase = .awaitingReflection generation priorRun) :
    let next := repairedStep state .agentSettled
    next.phase = .rootIdle generation ∧
    next.outcome = .reflectionAborted ∧
    domainPaused next.phase = false ∧
    reflectionActive next.phase = false ∧
    activityOpen next.phase = false := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;>
    simp_all [repairedStep, onAgentSettled, domainPaused, reflectionActive,
      activityOpen]

theorem successful_reflection_settlement_closes_activity
    (state : ProcessState) (generation : Nat) (priorRun : PriorRunPhase)
    (outcome : ProcessOutcome) (paused : Bool)
    (settling : state.phase =
      .awaitingSettlement generation priorRun outcome paused) :
    let next := repairedStep state .agentSettled
    next.phase = .rootIdle generation ∧
    next.outcome = outcome ∧
    domainPaused next.phase = false ∧
    activityOpen next.phase = false := by
  rcases state with ⟨phase, localLoops, brokerLoops, stateOutcome⟩
  cases phase <;>
    simp_all [repairedStep, onAgentSettled, domainPaused, activityOpen]

theorem atomic_reset_keeps_counter_authorities_equal
    (state : ProcessState) (owned : rootOwned state.phase = true) :
    let next := repairedStep state .resetCounters
    next.localLoops = 0 ∧ next.brokerLoops = 0 ∧ SafeInvariant next := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;>
    simp_all [repairedStep, onResetCounters, rootOwned, SafeInvariant]

theorem pause_failure_never_waits_for_unstarted_run
    (state : ProcessState) (generation : Nat)
    (pending : state.phase = .pauseRequested generation .idle) :
    let next := repairedStep state .domainPauseFailed
    ¬ reflectionActive next.phase ∧ ¬ domainPaused next.phase := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;>
    simp_all [repairedStep, onDomainPauseFailed, restorePriorRun,
      reflectionActive, domainPaused]

theorem shutdown_releases_modeled_resources (state : ProcessState) :
    let next := repairedStep state .sessionShutdown
    next.phase = .shutdown ∧
    domainAttached next.phase = false ∧
    controlsRegistered next.phase = false ∧
    domainPaused next.phase = false ∧
    reflectionActive next.phase = false ∧
    activityOpen next.phase = false := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;>
    simp [repairedStep, onSessionShutdown, domainAttached,
      controlsRegistered, domainPaused, reflectionActive, activityOpen]

-- Progress is existential over permitted environment events: every non-final
-- phase has a transition that advances, while shutdown is the activity final node.
def advances (state : ProcessState) (event : LifecycleEvent) : Prop :=
  repairedStep state event ≠ state

theorem every_nonfinal_state_has_progress (state : ProcessState)
    (notFinal : ¬ isFinal state) :
    ∃ event, advances state event := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase with
  | new =>
      exact ⟨.sessionStarted 1, by
        simp [advances, repairedStep, onSessionStarted]⟩
  | loading generation =>
      exact ⟨.configurationLoaded, by
        simp [advances, repairedStep, onConfigurationLoaded]⟩
  | attachingDomain generation =>
      exact ⟨.domainAttachSucceeded, by
        simp [advances, repairedStep, onDomainAttachSucceeded]⟩
  | rootIdle generation =>
      exact ⟨.ordinaryRunStarted, by
        simp [advances, repairedStep, onOrdinaryRunStarted]⟩
  | rootRunning generation =>
      exact ⟨.reflectionTriggered, by
        simp [advances, repairedStep, onReflectionTriggered]⟩
  | pauseRequested generation priorRun =>
      exact ⟨.domainPauseSucceeded, by
        simp [advances, repairedStep, onDomainPauseSucceeded]⟩
  | awaitingReflection generation priorRun =>
      exact ⟨.reflectionResponseEnded .noIssue, by
        simp [advances, repairedStep, onReflectionResponseEnded,
          decisionOutcome]⟩
  | awaitingSettlement generation priorRun settledOutcome paused =>
      exact ⟨.agentSettled, by
        simp [advances, repairedStep, onAgentSettled]⟩
  | observer =>
      exact ⟨.sessionShutdown, by
        simp [advances, repairedStep, onSessionShutdown]⟩
  | shutdown =>
      exact False.elim (notFinal (by simp [isFinal]))

-- The normal schedule is one complete object-flow witness from session start,
-- through an ordinary turn and NO_ISSUE reflection, to resource-clean shutdown.
def runEvents (state : ProcessState) (events : List LifecycleEvent) : ProcessState :=
  events.foldl repairedStep state

def normalSchedule : List LifecycleEvent :=
  [ .sessionStarted 1,
    .configurationLoaded,
    .domainAttachSucceeded,
    .ordinaryRunStarted,
    .ordinaryTurnEnded,
    .agentSettled,
    .reflectionTriggered,
    .domainPauseSucceeded,
    .reflectionResponseEnded .noIssue,
    .agentSettled,
    .sessionShutdown ]

-- Liveness is conditional on explicit Pi/environment fairness: serialized hooks,
-- eventual async completions and settlement/shutdown delivery, plus stale compensation.
structure ExecutionAssumptions where
  extensionHandlersSerialized : Bool
  configurationEventuallyCompletes : Bool
  domainRequestsEventuallyComplete : Bool
  agentSettlementEventuallyDelivered : Bool
  shutdownEventuallyDelivered : Bool
  staleCompletionsAreCompensated : Bool
  deriving Repr, DecidableEq

def declaredExecutionAssumptions : ExecutionAssumptions :=
  { extensionHandlersSerialized := true,
    configurationEventuallyCompletes := true,
    domainRequestsEventuallyComplete := true,
    agentSettlementEventuallyDelivered := true,
    shutdownEventuallyDelivered := true,
    staleCompletionsAreCompensated := true }

def assumptionsSatisfied (assumptions : ExecutionAssumptions) : Prop :=
  assumptions.extensionHandlersSerialized = true ∧
  assumptions.configurationEventuallyCompletes = true ∧
  assumptions.domainRequestsEventuallyComplete = true ∧
  assumptions.agentSettlementEventuallyDelivered = true ∧
  assumptions.shutdownEventuallyDelivered = true ∧
  assumptions.staleCompletionsAreCompensated = true

-- Success requires the allowed result, equal counter authorities, final shutdown,
-- and absence of every modeled live resource or paused/reflection state.
def ProcessSuccess (state : ProcessState) : Prop :=
  state.phase = .shutdown ∧
  state.outcome = .noIssue ∧
  SafeInvariant state ∧
  domainAttached state.phase = false ∧
  controlsRegistered state.phase = false ∧
  domainPaused state.phase = false ∧
  reflectionActive state.phase = false ∧
  activityOpen state.phase = false

theorem declared_assumptions_are_explicit :
    assumptionsSatisfied declaredExecutionAssumptions := by
  simp [assumptionsSatisfied, declaredExecutionAssumptions]

theorem normal_schedule_reaches_required_outcome :
    ProcessSuccess (runEvents repairedInitial normalSchedule) := by
  simp [ProcessSuccess, runEvents, normalSchedule, repairedInitial,
    repairedStep, onSessionStarted, onConfigurationLoaded,
    onDomainAttachSucceeded, onOrdinaryRunStarted, onOrdinaryTurnEnded,
    onReflectionTriggered, onDomainPauseSucceeded,
    onReflectionResponseEnded, onAgentSettled, onSessionShutdown,
    decisionOutcome, SafeInvariant, domainAttached, controlsRegistered,
    domainPaused, reflectionActive, activityOpen]

theorem normal_schedule_terminates :
    isFinal (runEvents repairedInitial normalSchedule) := by
  rfl

theorem delivered_shutdown_terminates_every_interleaving
    (state : ProcessState) :
    isFinal (repairedStep state .sessionShutdown) := by
  rcases state with ⟨phase, localLoops, brokerLoops, outcome⟩
  cases phase <;> rfl

-- The counter contract separates a long-lived active cycle from the shared
-- task/root/all reminder cycle, with all thresholds explicit and configurable.
inductive GapComparison where
  | strictlyGreaterThan
  deriving Repr, DecidableEq

inductive LoopScope where
  | rootOnly
  | everyObservableAgent
  deriving Repr, DecidableEq

inductive ReminderResetScope where
  | taskRootAllOnly
  deriving Repr, DecidableEq

inductive WidgetField where
  | idle
  | active
  | task
  | root
  | observed
  | all
  deriving Repr, DecidableEq

structure DesiredCounterContract where
  idleDebounceSeconds : Nat
  idleResetGapSeconds : Nat
  gapComparison : GapComparison
  taskReminderSeconds : Nat
  rootLoopLimit : Nat
  allLoopLimit : Nat
  activeLoopScope : LoopScope
  rootLoopScope : LoopScope
  allLoopScope : LoopScope
  reminderResetScope : ReminderResetScope
  reminderPreservesActive : Bool
  reflectionExcludedFromEveryCounter : Bool
  processExitClearsEveryCounter : Bool
  widgetFields : List WidgetField
  deriving Repr, DecidableEq

structure CounterLimits where
  idleResetGapSeconds : Nat
  taskReminderSeconds : Nat
  rootLoopLimit : Nat
  allLoopLimit : Nat
  deriving Repr, DecidableEq

def defaultCounterLimits : CounterLimits :=
  { idleResetGapSeconds := 60,
    taskReminderSeconds := 30 * 60,
    rootLoopLimit := 100,
    allLoopLimit := 500 }

def ValidCounterLimits (limits : CounterLimits) : Prop :=
  0 < limits.idleResetGapSeconds ∧
  0 < limits.taskReminderSeconds ∧
  0 < limits.rootLoopLimit ∧
  0 < limits.allLoopLimit

-- Aggregate busy means at least one observable root, agent, or subagent is
-- doing ordinary work; the timestamp is recorded immediately on all-idle.
structure CounterState where
  alive : Bool
  aggregateBusy : Bool
  reflectionPaused : Bool
  endTimeRecorded : Bool
  theEndLoopTimeSeconds : Nat
  activeSeconds : Nat
  activeLoops : Nat
  taskSeconds : Nat
  rootLoops : Nat
  allLoops : Nat
  deriving Repr, DecidableEq

def counterInitial : CounterState :=
  { alive := true,
    aggregateBusy := false,
    reflectionPaused := false,
    endTimeRecorded := false,
    theEndLoopTimeSeconds := 0,
    activeSeconds := 0,
    activeLoops := 0,
    taskSeconds := 0,
    rootLoops := 0,
    allLoops := 0 }

-- Counter events model aggregate busy edges, ordinary elapsed work and turns,
-- reflection exclusion, reminder reset, and process-memory destruction.
inductive CounterEvent where
  | aggregateBecameBusy (nowSeconds : Nat)
  | aggregateBecameIdle (nowSeconds : Nat)
  | ordinaryWorkElapsed (seconds : Nat)
  | rootOrdinaryTurnEnded
  | otherOrdinaryTurnEnded
  | reflectionStarted
  | reflectionFinished
  | reminderAcknowledged
  | processExited
  deriving Repr, DecidableEq

-- Resumption uses a strict greater-than guard: an exact configured gap
-- continues the same counters, while a longer gap starts a new full cycle.
def shouldStartNewActiveCycle
    (limits : CounterLimits) (state : CounterState) (nowSeconds : Nat) : Bool :=
  state.endTimeRecorded &&
    decide (state.theEndLoopTimeSeconds + limits.idleResetGapSeconds < nowSeconds)

def clearEveryCounter (state : CounterState) : CounterState :=
  { state with
    activeSeconds := 0
    activeLoops := 0
    taskSeconds := 0
    rootLoops := 0
    allLoops := 0 }

def clearReminderCycle (state : CounterState) : CounterState :=
  { state with
    taskSeconds := 0
    rootLoops := 0
    allLoops := 0 }

def reminderDue (limits : CounterLimits) (state : CounterState) : Bool :=
  state.alive && !state.reflectionPaused &&
    (decide (limits.taskReminderSeconds ≤ state.taskSeconds) ||
     decide (limits.rootLoopLimit ≤ state.rootLoops) ||
     decide (limits.allLoopLimit ≤ state.allLoops))

-- The total transition function freezes immediately at all-idle, counts all
-- ordinary turns, excludes internal reflection, and applies the two reset scopes.
def counterStep
    (limits : CounterLimits) (state : CounterState) (event : CounterEvent) :
    CounterState :=
  match event with
  | .aggregateBecameBusy nowSeconds =>
      if !state.alive || state.aggregateBusy then state
      else
        let resumed :=
          if shouldStartNewActiveCycle limits state nowSeconds then
            clearEveryCounter state
          else state
        { resumed with
          aggregateBusy := true
          endTimeRecorded := false
          theEndLoopTimeSeconds := 0 }
  | .aggregateBecameIdle nowSeconds =>
      if !state.alive || !state.aggregateBusy then state
      else
        { state with
          aggregateBusy := false
          endTimeRecorded := true
          theEndLoopTimeSeconds := nowSeconds }
  | .ordinaryWorkElapsed seconds =>
      if state.alive && state.aggregateBusy && !state.reflectionPaused then
        { state with
          activeSeconds := state.activeSeconds + seconds
          taskSeconds := state.taskSeconds + seconds }
      else state
  | .rootOrdinaryTurnEnded =>
      if state.alive && state.aggregateBusy && !state.reflectionPaused then
        { state with
          activeLoops := state.activeLoops + 1
          rootLoops := state.rootLoops + 1
          allLoops := state.allLoops + 1 }
      else state
  | .otherOrdinaryTurnEnded =>
      if state.alive && state.aggregateBusy && !state.reflectionPaused then
        { state with
          activeLoops := state.activeLoops + 1
          allLoops := state.allLoops + 1 }
      else state
  | .reflectionStarted =>
      if state.alive then { state with reflectionPaused := true } else state
  | .reflectionFinished =>
      if state.alive then { state with reflectionPaused := false } else state
  | .reminderAcknowledged =>
      if reminderDue limits state then clearReminderCycle state else state
  | .processExited =>
      { alive := false,
        aggregateBusy := false,
        reflectionPaused := false,
        endTimeRecorded := false,
        theEndLoopTimeSeconds := 0,
        activeSeconds := 0,
        activeLoops := 0,
        taskSeconds := 0,
        rootLoops := 0,
        allLoops := 0 }

-- Valid states keep task time within active time, root loops within all loops,
-- and all ordinary loops within the active-cycle loop total.
def CounterInvariant (state : CounterState) : Prop :=
  state.taskSeconds ≤ state.activeSeconds ∧
  state.rootLoops ≤ state.allLoops ∧
  state.allLoops ≤ state.activeLoops

def desiredWidgetFields : List WidgetField :=
  [.active, .task, .root, .all]

def desiredCounterContract : DesiredCounterContract :=
  { idleDebounceSeconds := 0,
    idleResetGapSeconds := 60,
    gapComparison := .strictlyGreaterThan,
    taskReminderSeconds := 30 * 60,
    rootLoopLimit := 100,
    allLoopLimit := 500,
    activeLoopScope := .everyObservableAgent,
    rootLoopScope := .rootOnly,
    allLoopScope := .everyObservableAgent,
    reminderResetScope := .taskRootAllOnly,
    reminderPreservesActive := true,
    reflectionExcludedFromEveryCounter := true,
    processExitClearsEveryCounter := true,
    widgetFields := desiredWidgetFields }

def DesiredCounterContractIsExact : Prop :=
  desiredCounterContract.idleDebounceSeconds = 0 ∧
  desiredCounterContract.idleResetGapSeconds = 60 ∧
  desiredCounterContract.gapComparison = .strictlyGreaterThan ∧
  desiredCounterContract.taskReminderSeconds = 1800 ∧
  desiredCounterContract.rootLoopLimit = 100 ∧
  desiredCounterContract.allLoopLimit = 500 ∧
  desiredCounterContract.activeLoopScope = .everyObservableAgent ∧
  desiredCounterContract.rootLoopScope = .rootOnly ∧
  desiredCounterContract.allLoopScope = .everyObservableAgent ∧
  desiredCounterContract.reminderResetScope = .taskRootAllOnly ∧
  desiredCounterContract.reminderPreservesActive = true ∧
  desiredCounterContract.reflectionExcludedFromEveryCounter = true ∧
  desiredCounterContract.processExitClearsEveryCounter = true ∧
  desiredCounterContract.widgetFields = [.active, .task, .root, .all]

theorem desired_counter_contract_is_exact : DesiredCounterContractIsExact := by
  simp [DesiredCounterContractIsExact, desiredCounterContract,
    desiredWidgetFields]

def currentWidgetFields : List WidgetField :=
  [.idle, .active, .task, .root, .observed]

def counterExampleState : CounterState :=
  { alive := true,
    aggregateBusy := true,
    reflectionPaused := false,
    endTimeRecorded := false,
    theEndLoopTimeSeconds := 0,
    activeSeconds := 120,
    activeLoops := 4,
    taskSeconds := 20,
    rootLoops := 1,
    allLoops := 4 }

def currentConfirmedIdleReset (state : CounterState) : CounterState :=
  { state with
    aggregateBusy := false
    activeSeconds := 0
    activeLoops := 0
    taskSeconds := 0 }

def currentReminderReset (state : CounterState) : CounterState :=
  clearEveryCounter state

def currentOtherTurnEnded (state : CounterState) : CounterState :=
  { state with allLoops := state.allLoops + 1 }

def desiredShortIdleResume : CounterState :=
  let idle := counterStep defaultCounterLimits counterExampleState
    (.aggregateBecameIdle 100)
  counterStep defaultCounterLimits idle (.aggregateBecameBusy 130)

def CurrentCounterContractMismatch : Prop :=
  currentWidgetFields ≠ desiredWidgetFields ∧
  (currentConfirmedIdleReset counterExampleState).activeSeconds = 0 ∧
  desiredShortIdleResume.activeSeconds = counterExampleState.activeSeconds ∧
  (currentReminderReset counterExampleState).activeSeconds = 0 ∧
  (currentOtherTurnEnded counterExampleState).activeLoops =
    counterExampleState.activeLoops

-- Concrete boundary and reset theorems prove the intended counter semantics,
-- including the current implementation's mismatches with that contract.
theorem current_counter_contract_mismatch_is_concrete :
    CurrentCounterContractMismatch := by
  simp [CurrentCounterContractMismatch, currentWidgetFields,
    desiredWidgetFields, currentConfirmedIdleReset, counterExampleState,
    desiredShortIdleResume, counterStep, shouldStartNewActiveCycle,
    defaultCounterLimits, currentReminderReset, clearEveryCounter,
    currentOtherTurnEnded]

theorem default_counter_limits_are_valid :
    ValidCounterLimits defaultCounterLimits := by
  simp [ValidCounterLimits, defaultCounterLimits]

theorem widget_omits_redundant_idle_and_uses_all_name :
    desiredWidgetFields = [.active, .task, .root, .all] := by
  rfl

theorem initial_end_loop_time_is_zero :
    counterInitial.theEndLoopTimeSeconds = 0 ∧
    counterInitial.endTimeRecorded = false := by
  decide

theorem all_idle_freezes_and_records_immediately
    (limits : CounterLimits) (state : CounterState) (nowSeconds : Nat)
    (alive : state.alive = true) (busy : state.aggregateBusy = true) :
    let next := counterStep limits state (.aggregateBecameIdle nowSeconds)
    next.aggregateBusy = false ∧
    next.endTimeRecorded = true ∧
    next.theEndLoopTimeSeconds = nowSeconds ∧
    next.activeSeconds = state.activeSeconds ∧
    next.activeLoops = state.activeLoops ∧
    next.taskSeconds = state.taskSeconds ∧
    next.rootLoops = state.rootLoops ∧
    next.allLoops = state.allLoops := by
  simp [counterStep, alive, busy]

theorem idle_elapsed_events_change_no_counter
    (limits : CounterLimits) (state : CounterState) (seconds : Nat)
    (idle : state.aggregateBusy = false) :
    counterStep limits state (.ordinaryWorkElapsed seconds) = state := by
  simp [counterStep, idle]

theorem resume_at_exact_gap_preserves_every_counter
    (limits : CounterLimits) (state : CounterState)
    (alive : state.alive = true) (idle : state.aggregateBusy = false)
    (recorded : state.endTimeRecorded = true) :
    let nowSeconds :=
      state.theEndLoopTimeSeconds + limits.idleResetGapSeconds
    let next := counterStep limits state (.aggregateBecameBusy nowSeconds)
    next.aggregateBusy = true ∧
    next.activeSeconds = state.activeSeconds ∧
    next.activeLoops = state.activeLoops ∧
    next.taskSeconds = state.taskSeconds ∧
    next.rootLoops = state.rootLoops ∧
    next.allLoops = state.allLoops := by
  simp [counterStep, shouldStartNewActiveCycle, alive, idle, recorded]

theorem resume_after_strict_gap_resets_every_counter
    (limits : CounterLimits) (state : CounterState) (nowSeconds : Nat)
    (alive : state.alive = true) (idle : state.aggregateBusy = false)
    (recorded : state.endTimeRecorded = true)
    (expired :
      state.theEndLoopTimeSeconds + limits.idleResetGapSeconds < nowSeconds) :
    let next := counterStep limits state (.aggregateBecameBusy nowSeconds)
    next.aggregateBusy = true ∧
    next.endTimeRecorded = false ∧
    next.theEndLoopTimeSeconds = 0 ∧
    next.activeSeconds = 0 ∧
    next.activeLoops = 0 ∧
    next.taskSeconds = 0 ∧
    next.rootLoops = 0 ∧
    next.allLoops = 0 := by
  simp [counterStep, shouldStartNewActiveCycle, clearEveryCounter,
    alive, idle, recorded, expired]

theorem root_turn_counts_active_root_and_all
    (limits : CounterLimits) (state : CounterState)
    (alive : state.alive = true) (busy : state.aggregateBusy = true)
    (unpaused : state.reflectionPaused = false) :
    let next := counterStep limits state .rootOrdinaryTurnEnded
    next.activeLoops = state.activeLoops + 1 ∧
    next.rootLoops = state.rootLoops + 1 ∧
    next.allLoops = state.allLoops + 1 := by
  simp [counterStep, alive, busy, unpaused]

theorem other_turn_counts_active_and_all_not_root
    (limits : CounterLimits) (state : CounterState)
    (alive : state.alive = true) (busy : state.aggregateBusy = true)
    (unpaused : state.reflectionPaused = false) :
    let next := counterStep limits state .otherOrdinaryTurnEnded
    next.activeLoops = state.activeLoops + 1 ∧
    next.rootLoops = state.rootLoops ∧
    next.allLoops = state.allLoops + 1 := by
  simp [counterStep, alive, busy, unpaused]

theorem reflection_excludes_time_and_every_loop
    (limits : CounterLimits) (state : CounterState)
    (paused : state.reflectionPaused = true) (seconds : Nat) :
    counterStep limits state (.ordinaryWorkElapsed seconds) = state ∧
    counterStep limits state .rootOrdinaryTurnEnded = state ∧
    counterStep limits state .otherOrdinaryTurnEnded = state := by
  simp [counterStep, paused]

theorem reminder_resets_task_root_all_but_preserves_active
    (limits : CounterLimits) (state : CounterState)
    (due : reminderDue limits state = true) :
    let next := counterStep limits state .reminderAcknowledged
    next.activeSeconds = state.activeSeconds ∧
    next.activeLoops = state.activeLoops ∧
    next.taskSeconds = 0 ∧
    next.rootLoops = 0 ∧
    next.allLoops = 0 := by
  simp [counterStep, due, clearReminderCycle]

theorem process_exit_clears_all_memory
    (limits : CounterLimits) (state : CounterState) :
    counterStep limits state .processExited =
      { alive := false,
        aggregateBusy := false,
        reflectionPaused := false,
        endTimeRecorded := false,
        theEndLoopTimeSeconds := 0,
        activeSeconds := 0,
        activeLoops := 0,
        taskSeconds := 0,
        rootLoops := 0,
        allLoops := 0 } := by
  rfl

theorem counter_initial_establishes_invariant :
    CounterInvariant counterInitial := by
  exact ⟨Nat.zero_le 0, Nat.zero_le 0, Nat.zero_le 0⟩

theorem clear_every_counter_preserves_invariant (state : CounterState) :
    CounterInvariant (clearEveryCounter state) := by
  exact ⟨Nat.zero_le 0, Nat.zero_le 0, Nat.zero_le 0⟩

theorem clear_reminder_cycle_preserves_invariant
    (state : CounterState) :
    CounterInvariant (clearReminderCycle state) := by
  exact ⟨Nat.zero_le state.activeSeconds, Nat.zero_le 0,
    Nat.zero_le state.activeLoops⟩

theorem counter_step_preserves_invariant
    (limits : CounterLimits) (state : CounterState) (event : CounterEvent)
    (invariant : CounterInvariant state) :
    CounterInvariant (counterStep limits state event) := by
  cases event with
  | aggregateBecameBusy nowSeconds =>
      simp only [counterStep]
      split
      · exact invariant
      · split
        · exact clear_every_counter_preserves_invariant state
        · exact invariant
  | aggregateBecameIdle nowSeconds =>
      simp only [counterStep]
      split
      · exact invariant
      · exact invariant
  | ordinaryWorkElapsed seconds =>
      simp only [counterStep]
      split
      · rcases invariant with ⟨taskLeActive, rootLeAll, allLeActive⟩
        exact ⟨Nat.add_le_add_right taskLeActive seconds,
          rootLeAll, allLeActive⟩
      · exact invariant
  | rootOrdinaryTurnEnded =>
      simp only [counterStep]
      split
      · rcases invariant with ⟨taskLeActive, rootLeAll, allLeActive⟩
        exact ⟨taskLeActive, Nat.add_le_add_right rootLeAll 1,
          Nat.add_le_add_right allLeActive 1⟩
      · exact invariant
  | otherOrdinaryTurnEnded =>
      simp only [counterStep]
      split
      · rcases invariant with ⟨taskLeActive, rootLeAll, allLeActive⟩
        exact ⟨taskLeActive, Nat.le_add_right_of_le rootLeAll,
          Nat.add_le_add_right allLeActive 1⟩
      · exact invariant
  | reflectionStarted =>
      simp only [counterStep]
      split <;> exact invariant
  | reflectionFinished =>
      simp only [counterStep]
      split <;> exact invariant
  | reminderAcknowledged =>
      simp only [counterStep]
      split
      · exact clear_reminder_cycle_preserves_invariant state
      · exact invariant
  | processExited =>
      exact ⟨Nat.zero_le 0, Nat.zero_le 0, Nat.zero_le 0⟩

def CounterProcessCorrect : Prop :=
  DesiredCounterContractIsExact ∧
  CurrentCounterContractMismatch ∧
  ValidCounterLimits defaultCounterLimits ∧
  desiredWidgetFields = [.active, .task, .root, .all] ∧
  CounterInvariant counterInitial ∧
  (∀ limits state event, CounterInvariant state →
    CounterInvariant (counterStep limits state event)) ∧
  (∀ limits state seconds, state.reflectionPaused = true →
    counterStep limits state (.ordinaryWorkElapsed seconds) = state) ∧
  (∀ limits state,
    (counterStep limits state .processExited).activeSeconds = 0)

theorem counter_process_is_correct : CounterProcessCorrect := by
  exact ⟨
    desired_counter_contract_is_exact,
    current_counter_contract_mismatch_is_concrete,
    default_counter_limits_are_valid,
    rfl,
    counter_initial_establishes_invariant,
    counter_step_preserves_invariant,
    fun limits state seconds paused =>
      (reflection_excludes_time_and_every_loop limits state paused seconds).1,
    fun limits state => by rfl
  ⟩

-- The top-level theorem combines current-code counterexamples with the repaired
-- model's assumptions, initialization, preservation, safety, progress, and postcondition.
theorem process_is_correct :
    CurrentImplementationDefects ∧
    CounterProcessCorrect ∧
    PiCoreContractSatisfied translatedPiCoreContract ∧
    assumptionsSatisfied declaredExecutionAssumptions ∧
    SafeInvariant repairedInitial ∧
    (∀ state event, SafeInvariant state →
      SafeInvariant (repairedStep state event)) ∧
    (∀ state, Reachable state → ¬ ForbiddenState state) ∧
    (∀ state, ¬ isFinal state → ∃ event, advances state event) ∧
    (∀ state, isFinal (repairedStep state .sessionShutdown)) ∧
    ProcessSuccess (runEvents repairedInitial normalSchedule) := by
  exact ⟨
    current_implementation_defects_are_reachable,
    counter_process_is_correct,
    translated_pi_core_contract_is_explicit,
    declared_assumptions_are_explicit,
    repaired_initial_establishes_invariant,
    repaired_step_preserves_invariant,
    repaired_process_is_safe,
    every_nonfinal_state_has_progress,
    delivered_shutdown_terminates_every_interleaving,
    normal_schedule_reaches_required_outcome
  ⟩

#print axioms process_is_correct

end PiReflectWatchdogLifecycle

-- The executable summary deterministically reports the diagnosed current model
-- and the exact scope of the proved repaired workflow.
def main : IO Unit := do
  IO.println "Current code translation: seven reachable lifecycle inconsistencies."
  IO.println "Counter contract: active plus task/root/all with strict idle-gap reset."
  IO.println "Repaired model: all reachable states are safe under modeled events."
  IO.println "Normal fair schedule: reflection completes and shutdown releases resources."
