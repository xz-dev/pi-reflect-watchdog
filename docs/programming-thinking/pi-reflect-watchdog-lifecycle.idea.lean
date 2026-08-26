-- This executable process document models the minimal Reflect Watchdog rebuilt
-- on Pi's authoritative run lifecycle. It uses Lean core only and has no effects.
set_option autoImplicit false

namespace PiReflectWatchdogLifecycle

-- Process vocabulary separates ordinary work from watchdog-owned reflection
-- work and names the exact successful model outcomes.
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
-- counter authority, one pending ask, and one active inquiry. No pause exists.
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
  correctionQueued : Bool
  deriving Repr, DecidableEq

inductive Event where
  | acquireMain
  | loseMain
  | agentStart (kind : RunKind)
  | observeOtherBusy (busy : Bool)
  | activeTick
  | successfulTurn (outcome : TurnOutcome)
  | agentSettled
  | queueManualReflection
  | dispatchReflection
  | reflectionFinished (decision : ReflectionDecision)
  | shutdown
  deriving Repr, DecidableEq

-- Successful-loop and threshold guards are total and derived from one state.
def modelTurnSucceeded : TurnOutcome → Bool
  | .stop | .toolUse => true
  | _ => false

def crossed (state : State) : List Trigger :=
  let root := if state.counters.rootLoops >= state.limits.rootLoops
    then [.rootLoopLimit] else []
  let all := if state.counters.allLoops >= state.limits.allLoops
    then [.allLoopLimit] else []
  let task := if state.counters.taskMs >= state.limits.taskMs
    then [.taskTimeLimit] else []
  root ++ all ++ task

def mergeTriggers (current additions : List Trigger) : List Trigger :=
  additions.foldl (fun result trigger =>
    if trigger ∈ result then result else result ++ [trigger]) current

-- Ordinary active ticks advance both clocks; reflection ticks are lifecycle
-- visible but excluded from active and task time without any pause transition.
def countTick (state : State) : State :=
  if state.localBusy && state.runKind = .ordinary then
    let next :=
      { state with counters :=
          { state.counters with
            activeMs := state.counters.activeMs + 1
            taskMs := state.counters.taskMs + 1 } }
    { next with pending := mergeTriggers next.pending (crossed next) }
  else state

-- Ordinary successful turns increment the loop counters exactly once.
-- Reflection turns and unsuccessful outcomes preserve every counter.
def countTurn (state : State) (outcome : TurnOutcome) : State :=
  if modelTurnSucceeded outcome && state.runKind = .ordinary then
    let next :=
      { state with counters :=
          { state.counters with
            activeLoops := state.counters.activeLoops + 1
            rootLoops := state.counters.rootLoops + 1
            allLoops := state.counters.allLoops + 1 } }
    { next with pending := mergeTriggers next.pending (crossed next) }
  else state

-- Lifecycle transitions follow Continue Watchdog seams. Pending reasons can
-- dispatch one inquiry, reflection completion clears it, and shutdown is final.
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
    | .activeTick => countTick state
    | .successfulTurn outcome => countTurn state outcome
    | .agentSettled => { state with localBusy := false }
    | .queueManualReflection =>
        { state with pending := state.pending ++ [.userRequest] }
    | .dispatchReflection =>
        if state.phase = .main && state.pending ≠ [] &&
            !state.inquiryActive && !state.localBusy && !state.otherBusy then
          { state with inquiryActive := true, runKind := .reflection }
        else state
    | .reflectionFinished decision =>
        if state.inquiryActive then
          { state with
            inquiryActive := false
            pending := []
            counters := { state.counters with
              taskMs := 0
              rootLoops := 0
              allLoops := 0 }
            runKind := .ordinary
            correctionQueued := match decision with
              | .routeCorrection => true
              | .noIssue => false }
        else state
    | .shutdown =>
        { state with
          phase := .shutdown
          localBusy := false
          otherBusy := false
          inquiryActive := false
          pending := [] }

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
      taskMs := 1_800_000
      rootLoops := 100
      allLoops := 500 }
    pending := []
    inquiryActive := false
    correctionQueued := false }

-- Safety forbids active work, inquiries, and pending asks after shutdown.
def Safe (state : State) : Prop :=
  state.phase = .shutdown →
    state.localBusy = false ∧ state.otherBusy = false ∧
      state.inquiryActive = false ∧ state.pending = []

-- Supporting lemmas prove exact outcomes, time/loop exclusion, inquiry guards,
-- ownership recovery, correction behavior, and terminal shutdown.
theorem success_policy_exact (outcome : TurnOutcome) :
    modelTurnSucceeded outcome = true ↔
      outcome = .stop ∨ outcome = .toolUse := by
  cases outcome <;> simp [modelTurnSucceeded]

theorem reflection_tick_never_counts
    (state : State) (reflection : state.runKind = .reflection) :
    (countTick state).counters = state.counters := by
  simp [countTick, reflection]

theorem reflection_turn_never_counts
    (state : State) (outcome : TurnOutcome)
    (reflection : state.runKind = .reflection) :
    (countTurn state outcome).counters = state.counters := by
  simp [countTurn, reflection]

theorem failed_ordinary_turn_never_counts
    (state : State) (outcome : TurnOutcome)
    (ordinary : state.runKind = .ordinary)
    (failed : modelTurnSucceeded outcome = false) :
    (countTurn state outcome).counters = state.counters := by
  simp [countTurn, ordinary, failed]

theorem successful_ordinary_turn_counts_once
    (state : State) (outcome : TurnOutcome)
    (ordinary : state.runKind = .ordinary)
    (success : modelTurnSucceeded outcome = true) :
    (countTurn state outcome).counters.activeLoops =
      state.counters.activeLoops + 1 ∧
    (countTurn state outcome).counters.rootLoops =
      state.counters.rootLoops + 1 ∧
    (countTurn state outcome).counters.allLoops =
      state.counters.allLoops + 1 := by
  simp [countTurn, ordinary, success]

theorem manual_reflection_can_dispatch :
    let main := step initial .acquireMain
    let queued := step main .queueManualReflection
    (step queued .dispatchReflection).inquiryActive = true := by
  decide

theorem simultaneous_local_and_other_busy_blocks_dispatch :
    let main := step initial .acquireMain
    let localRun := step main (.agentStart .ordinary)
    let both := step localRun (.observeOtherBusy true)
    let queued := step both .queueManualReflection
    (step queued .dispatchReflection).inquiryActive = false := by
  decide

theorem local_busy_blocks_dispatch :
    let main := step initial .acquireMain
    let localRun := step main (.agentStart .ordinary)
    let queued := step localRun .queueManualReflection
    (step queued .dispatchReflection).inquiryActive = false := by
  decide

theorem dispatch_classifies_reflection :
    let main := step initial .acquireMain
    let queued := step main .queueManualReflection
    (step queued .dispatchReflection).runKind = .reflection := by
  decide

theorem observer_can_reclaim_main (state : State) :
    (step { state with phase := .observer } .acquireMain).phase = .main := by
  simp [step]

theorem route_correction_queues_continuation
    (state : State)
    (openInquiry : state.inquiryActive = true)
    (notShutdown : state.phase ≠ .shutdown) :
    (step state (.reflectionFinished .routeCorrection)).correctionQueued = true ∧
    (step state (.reflectionFinished .noIssue)).correctionQueued = false := by
  simp [step, notShutdown, openInquiry]

theorem shutdown_is_clean (state : State)
    (active : state.phase ≠ .shutdown) : Safe (step state .shutdown) := by
  simp [Safe, step, active]

theorem shutdown_is_absorbing (state : State) (event : Event)
    (stopped : state.phase = .shutdown) :
    step state event = state := by
  simp [step, stopped]

-- Top-level correctness combines exact successful-loop policy, complete
-- internal time/loop exclusion, dispatch/reclaim, correction, and termination.
theorem process_is_correct :
    (∀ outcome, modelTurnSucceeded outcome = true ↔
      outcome = .stop ∨ outcome = .toolUse) ∧
    (∀ state, state.runKind = .reflection →
      (countTick state).counters = state.counters) ∧
    (∀ state outcome, state.runKind = .reflection →
      (countTurn state outcome).counters = state.counters) ∧
    (let main := step initial .acquireMain
      let queued := step main .queueManualReflection
      (step queued .dispatchReflection).inquiryActive = true) ∧
    (let main := step initial .acquireMain
      let localRun := step main (.agentStart .ordinary)
      let both := step localRun (.observeOtherBusy true)
      let queued := step both .queueManualReflection
      (step queued .dispatchReflection).inquiryActive = false) ∧
    (let main := step initial .acquireMain
      let localRun := step main (.agentStart .ordinary)
      let queued := step localRun .queueManualReflection
      (step queued .dispatchReflection).inquiryActive = false) ∧
    (let main := step initial .acquireMain
      let queued := step main .queueManualReflection
      (step queued .dispatchReflection).runKind = .reflection) ∧
    (∀ state outcome, state.runKind = .ordinary →
      modelTurnSucceeded outcome = false →
      (countTurn state outcome).counters = state.counters) ∧
    (∀ state outcome, state.runKind = .ordinary →
      modelTurnSucceeded outcome = true →
      (countTurn state outcome).counters.activeLoops =
        state.counters.activeLoops + 1 ∧
      (countTurn state outcome).counters.rootLoops =
        state.counters.rootLoops + 1 ∧
      (countTurn state outcome).counters.allLoops =
        state.counters.allLoops + 1) ∧
    (∀ state : State,
      (step { state with phase := .observer } .acquireMain).phase = .main) ∧
    (∀ state : State, state.phase ≠ .shutdown → Safe (step state .shutdown)) ∧
    (∀ state event, state.phase = .shutdown → step state event = state) ∧
    (∀ state, state.inquiryActive = true → state.phase ≠ .shutdown →
      (step state (.reflectionFinished .routeCorrection)).correctionQueued = true ∧
      (step state (.reflectionFinished .noIssue)).correctionQueued = false) := by
  constructor
  · exact success_policy_exact
  constructor
  · exact reflection_tick_never_counts
  constructor
  · exact reflection_turn_never_counts
  constructor
  · exact manual_reflection_can_dispatch
  constructor
  · exact simultaneous_local_and_other_busy_blocks_dispatch
  constructor
  · exact local_busy_blocks_dispatch
  constructor
  · exact dispatch_classifies_reflection
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
  · exact route_correction_queues_continuation

#print axioms process_is_correct

end PiReflectWatchdogLifecycle

-- Executable summary exposes the modeled result without external effects.
def main : IO Unit := do
  IO.println "minimal reflect lifecycle: ask + successful loops; internal time and loops excluded; no pause state"
