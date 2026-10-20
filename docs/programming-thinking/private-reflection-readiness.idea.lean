-- Lean core only. The model proves admission/cancellation rules, not SDK or transport refinement.
set_option autoImplicit false

namespace PrivateReflectionReadiness

-- Integration evidence is supplied externally; unverified gates keep production unchanged.
inductive Evidence where
  | unverified
  | supported
  deriving Repr, DecidableEq

structure Gates where
  backgroundDelivery : Evidence
  localEvidence : Evidence
  providerRetry : Evidence
  workingAccounting : Evidence
  deriving Repr, DecidableEq

inductive Decision where
  | retainCurrentImplementation
  | permitPrivateCutover
  deriving Repr, DecidableEq

def allSupported (gates : Gates) : Prop :=
  gates.backgroundDelivery = .supported ∧ gates.localEvidence = .supported ∧
    gates.providerRetry = .supported ∧ gates.workingAccounting = .supported

instance (gates : Gates) : Decidable (allSupported gates) := by
  unfold allSupported
  infer_instance

def decideCutover (gates : Gates) : Decision :=
  if allSupported gates then .permitPrivateCutover else .retainCurrentImplementation

def currentEvidence : Gates :=
  ⟨.unverified, .unverified, .unverified, .unverified⟩

-- History separates visible effects/accounting from authority and in-flight lifecycle flags.
-- childLaunches is the abstract operation identity; native session/child identity is not modeled.
structure History where
  reminderLoops : Nat := 0
  ordinaryLoops : Nat := 0
  cooldownRecords : Nat := 0
  completedReports : Nat := 0
  hooks : Nat := 0
  feedbackRequests : Nat := 0
  childLaunches : Nat := 0
  providerCalls : Nat := 0
  helperCalls : Nat := 0
  corrections : Nat := 0
  deriving Repr, DecidableEq

structure OperationState where
  authority : Bool := false
  active : Bool := false
  cancelRequested : Bool := false
  freshCrossing : Bool := false
  history : History := {}
  deriving Repr, DecidableEq

inductive Revocation where
  | inputQueued | userDelivered | branchChanged | ownerChanged | sessionChanged
  | cycleChanged | anchorLost | aborted | shutdown
  deriving Repr, DecidableEq

inductive Effect where
  | provider | helper | correction | publication
  deriving Repr, DecidableEq

-- Revocation atomically closes authority and signals cancellation. Exact-operation settlement completes drain.
def revoke (state : OperationState) (_reason : Revocation) : OperationState :=
  { state with authority := false, cancelRequested := true, freshCrossing := false }

def settleCancelled (state : OperationState) (operation : Nat) : OperationState :=
  if state.cancelRequested = true ∧ operation = state.history.childLaunches then
    { state with active := false }
  else state

-- Admission needs no active inquiry and a fresh ordinary-threshold token; it consumes the token and resets reminder accounting.
def admitInquiry (state : OperationState) : OperationState :=
  if state.active = false ∧ state.freshCrossing = true then
    { state with
      authority := true
      active := true
      cancelRequested := false
      freshCrossing := false
      history := { state.history with
        reminderLoops := 0
        childLaunches := state.history.childLaunches + 1 } }
  else state

-- A fresh ordinary completion at/above the reminder limit can grant a token only when no inquiry is active.
-- Crossing while active is not latched for later; another ordinary event is required after stale cleanup.
def ordinaryProgress (state : OperationState) (threshold : Nat) : OperationState :=
  { state with
    freshCrossing := decide (state.active = false ∧ threshold ≤ state.history.reminderLoops + 1)
    history := { state.history with
      reminderLoops := state.history.reminderLoops + 1
      ordinaryLoops := state.history.ordinaryLoops + 1 } }

-- All four effect kinds require live, uncancelled authority for this exact abstract operation.
-- Publication is one abstract effect; file validity and durable-record ordering remain pending integration obligations.
def mayEffect (state : OperationState) (operation : Nat) : Prop :=
  state.authority = true ∧ state.cancelRequested = false ∧ state.active = true ∧
    operation = state.history.childLaunches

instance (state : OperationState) (operation : Nat) : Decidable (mayEffect state operation) := by
  unfold mayEffect
  infer_instance

def performEffect (state : OperationState) (operation : Nat) (effect : Effect) : OperationState :=
  if mayEffect state operation then
    match effect with
    | .provider => { state with history := { state.history with providerCalls := state.history.providerCalls + 1 } }
    | .helper => { state with history := { state.history with helperCalls := state.history.helperCalls + 1 } }
    | .correction => { state with history := { state.history with corrections := state.history.corrections + 1 } }
    | .publication =>
        { state with
          authority := false
          active := false
          freshCrossing := false
          history := { state.history with
            completedReports := state.history.completedReports + 1
            hooks := state.history.hooks + 1
            feedbackRequests := state.history.feedbackRequests + 1 } }
  else state

-- Only these events are permitted. An ordinary event evaluates and consumes admission immediately; there is no drop-triggered replacement.
inductive Event where
  | ordinaryTurn
  | tryAdmission
  | revoked (reason : Revocation)
  | effect (operation : Nat) (kind : Effect)
  | cancelledSettled (operation : Nat)
  deriving Repr, DecidableEq

def step (threshold : Nat) (state : OperationState) : Event → OperationState
  | .ordinaryTurn => admitInquiry (ordinaryProgress state threshold)
  | .tryAdmission => admitInquiry state
  | .revoked reason => revoke state reason
  | .effect operation kind => performEffect state operation kind
  | .cancelledSettled operation => settleCancelled state operation

def run (threshold : Nat) (state : OperationState) : List Event → OperationState
  | [] => state
  | event :: rest => run threshold (step threshold state event) rest

def noOrdinaryTurn : Event → Prop
  | .ordinaryTurn => False
  | _ => True

def cancelledFence (state : OperationState) : Prop :=
  state.authority = false ∧ state.cancelRequested = true ∧ state.freshCrossing = false

def pendingCancellation (state : OperationState) : Prop :=
  cancelledFence state ∧ state.active = true

def drained (state : OperationState) : Prop := state.active = false

-- Guard proofs reject duplicate admission and every effect attempted with revoked or old-operation authority.
theorem admission_requires_fresh_crossing (state : OperationState)
    (launched : (admitInquiry state).history.childLaunches ≠ state.history.childLaunches) :
    state.active = false ∧ state.freshCrossing = true := by
  by_cases allowed : state.active = false ∧ state.freshCrossing = true
  · exact allowed
  · simp [admitInquiry, allowed] at launched

theorem duplicate_admission_is_inert (state : OperationState) :
    admitInquiry (admitInquiry state) = admitInquiry state := by
  by_cases allowed : state.active = false ∧ state.freshCrossing = true <;>
    simp [admitInquiry, allowed]

theorem revoked_state_is_fenced (state : OperationState) (reason : Revocation) :
    cancelledFence (revoke state reason) := ⟨rfl, rfl, rfl⟩

theorem revoked_effect_is_inert (state : OperationState) (reason : Revocation)
    (operation : Nat) (effect : Effect) :
    performEffect (revoke state reason) operation effect = revoke state reason := by
  simp [performEffect, mayEffect, revoke]

theorem old_operation_effect_is_inert (state : OperationState) (operation : Nat)
    (effect : Effect) (different : operation ≠ state.history.childLaunches) :
    performEffect state operation effect = state := by
  simp [performEffect, mayEffect, different]

-- Arbitrary stale-only interleavings include repeated admission attempts, late effects, revocations and settlement, but no new ordinary turn.
theorem stale_step_preserves (threshold : Nat) (state : OperationState) (event : Event)
    (fenced : cancelledFence state) (noTurn : noOrdinaryTurn event) :
    cancelledFence (step threshold state event) ∧
    (step threshold state event).history = state.history := by
  rcases fenced with ⟨ha, hc, hf⟩
  cases event <;>
    simp_all [noOrdinaryTurn, step, admitInquiry, performEffect, mayEffect,
      settleCancelled, revoke, cancelledFence]
  split <;> simp_all

theorem stale_trace_preserves (threshold : Nat) (state : OperationState) (events : List Event)
    (fenced : cancelledFence state)
    (noTurns : ∀ event ∈ events, noOrdinaryTurn event) :
    cancelledFence (run threshold state events) ∧
    (run threshold state events).history = state.history := by
  induction events generalizing state with
  | nil => exact ⟨fenced, rfl⟩
  | cons event rest ih =>
    have head := noTurns event (by simp)
    have tail : ∀ next ∈ rest, noOrdinaryTurn next := by
      intro next member
      exact noTurns next (by simp [member])
    obtain ⟨nextFence, sameHistory⟩ := stale_step_preserves threshold state event fenced head
    obtain ⟨lastFence, finalHistory⟩ := ih (step threshold state event) nextFence tail
    exact ⟨lastFence, finalHistory.trans sameHistory⟩

theorem stale_only_trace_cannot_relaunch (threshold : Nat) (state : OperationState)
    (reason : Revocation) (events : List Event)
    (noTurns : ∀ event ∈ events, noOrdinaryTurn event) :
    (run threshold (revoke state reason) events).history = state.history := by
  exact (stale_trace_preserves threshold (revoke state reason) events
    (revoked_state_is_fenced state reason) noTurns).2

theorem stale_readmission_is_inert (state : OperationState) (reason : Revocation) :
    (admitInquiry (settleCancelled (revoke (admitInquiry state) reason)
      (admitInquiry state).history.childLaunches)).history = (admitInquiry state).history := by
  simp [admitInquiry, settleCancelled, revoke]

-- Until cancellation drains, arbitrary ordinary turns and late callbacks cannot open another inquiry or restore authority.
theorem pending_step (threshold : Nat) (state : OperationState) (event : Event)
    (pending : pendingCancellation state) :
    drained (step threshold state event) ∨
    (pendingCancellation (step threshold state event) ∧
      (step threshold state event).history.childLaunches = state.history.childLaunches) := by
  rcases pending with ⟨⟨ha, hc, hf⟩, hactive⟩
  cases event <;>
    simp_all [step, admitInquiry, ordinaryProgress, performEffect, mayEffect,
      settleCancelled, revoke, pendingCancellation, cancelledFence, drained]
  split <;> simp_all

-- Schedules model asynchronous callbacks. Cooperation explicitly assumes that the requested operation eventually acknowledges cancellation.
-- No wall-clock bound or actual provider/helper interruptibility is proved; without an acknowledgement, drain liveness is not claimed.
def trajectory (threshold : Nat) (initial : OperationState) (events : Nat → Event) : Nat → OperationState
  | 0 => initial
  | n + 1 => step threshold (trajectory threshold initial events n) (events n)

def cooperativeCancellation (events : Nat → Event) (operation : Nat) : Prop :=
  ∃ n, events n = .cancelledSettled operation

theorem pending_or_already_drained (threshold : Nat) (initial : OperationState)
    (events : Nat → Event) (pending : pendingCancellation initial) (n : Nat) :
    (∃ k, k ≤ n ∧ drained (trajectory threshold initial events k)) ∨
    (pendingCancellation (trajectory threshold initial events n) ∧
      (trajectory threshold initial events n).history.childLaunches = initial.history.childLaunches) := by
  induction n with
  | zero => exact Or.inr ⟨pending, rfl⟩
  | succ n ih =>
    rcases ih with early | ⟨stillPending, sameOperation⟩
    · obtain ⟨k, before, settled⟩ := early
      exact Or.inl ⟨k, Nat.le_trans before (Nat.le_succ n), settled⟩
    · rcases pending_step threshold (trajectory threshold initial events n) (events n) stillPending with
        settled | ⟨nextPending, nextOperation⟩
      · exact Or.inl ⟨n + 1, Nat.le_refl _, settled⟩
      · exact Or.inr ⟨nextPending, nextOperation.trans sameOperation⟩

theorem cooperative_cancellation_reaches_drained (threshold : Nat) (state : OperationState)
    (reason : Revocation) (events : Nat → Event) (active : state.active = true)
    (cooperative : cooperativeCancellation events state.history.childLaunches) :
    ∃ n, drained (trajectory threshold (revoke state reason) events n) := by
  obtain ⟨n, ack⟩ := cooperative
  have pending : pendingCancellation (revoke state reason) :=
    ⟨revoked_state_is_fenced state reason, active⟩
  rcases pending_or_already_drained threshold (revoke state reason) events pending n with
      early | ⟨stillPending, sameOperation⟩
  · obtain ⟨k, _, settled⟩ := early
    exact ⟨k, settled⟩
  · refine ⟨n + 1, ?_⟩
    change drained (step threshold (trajectory threshold (revoke state reason) events n) (events n))
    have requested := stillPending.1.2.1
    have permit : (trajectory threshold (revoke state reason) events n).cancelRequested = true ∧
        state.history.childLaunches = (trajectory threshold (revoke state reason) events n).history.childLaunches :=
      ⟨requested, sameOperation.symm⟩
    simp only [step, ack, drained, settleCancelled, ite_eq_left permit]

-- This is the approved planning order, not a proof that project work executes in that order.
inductive Stage where
  | determineReflectNeeds | extractSharedModule | adaptReflect | adaptContinue
  | verifyAll | coordinatePushAll
  deriving Repr, DecidableEq

def approvedOrder : List Stage :=
  [.determineReflectNeeds, .extractSharedModule, .adaptReflect, .adaptContinue,
    .verifyAll, .coordinatePushAll]

theorem cutover_requires_every_gate (gates : Gates) :
    decideCutover gates = .permitPrivateCutover ↔ allSupported gates := by
  simp [decideCutover]

theorem reflect_precedes_continue_and_verification_precedes_push :
    approvedOrder.idxOf .adaptReflect < approvedOrder.idxOf .adaptContinue ∧
    approvedOrder.idxOf .verifyAll < approvedOrder.idxOf .coordinatePushAll := by
  decide

-- The combined result includes guarded admission, stale-trace safety and conditional cancellation progress; standard propext is trusted.
theorem process_is_correct (gates : Gates) (threshold : Nat) (state : OperationState)
    (reason : Revocation) (events : List Event) (schedule : Nat → Event)
    (noTurns : ∀ event ∈ events, noOrdinaryTurn event) :
    (decideCutover gates = .permitPrivateCutover ↔ allSupported gates) ∧
    ((admitInquiry state).history.childLaunches ≠ state.history.childLaunches →
      state.active = false ∧ state.freshCrossing = true) ∧
    (admitInquiry (admitInquiry state) = admitInquiry state) ∧
    (run threshold (revoke state reason) events).history = state.history ∧
    (∀ operation effect, performEffect (revoke state reason) operation effect = revoke state reason) ∧
    (state.active = true → cooperativeCancellation schedule state.history.childLaunches →
      ∃ n, drained (trajectory threshold (revoke state reason) schedule n)) := by
  exact ⟨cutover_requires_every_gate gates, admission_requires_fresh_crossing state,
    duplicate_admission_is_inert state,
    stale_only_trace_cannot_relaunch threshold state reason events noTurns,
    revoked_effect_is_inert state reason,
    cooperative_cancellation_reaches_drained threshold state reason schedule⟩

#print axioms process_is_correct

-- Concrete initial examples reject the reviewer's duplicate/stale-only relaunch witnesses without excluding valid first admission.
def seed : OperationState := {}

example : (step 1 seed .ordinaryTurn).history.childLaunches = 1 := by decide
example : (admitInquiry (admitInquiry (ordinaryProgress seed 1))).history.childLaunches = 1 := by decide
example : (admitInquiry (settleCancelled (revoke (step 1 seed .ordinaryTurn) .inputQueued) 1)).history.childLaunches = 1 := by decide

end PrivateReflectionReadiness

-- Explicitly unmodeled/pending: frozen full-fork source/open batches/model selection; concurrent parent progress;
-- busy/idle delivery and failure/no-result request silence; helper whitelist/budgets/same-child correction;
-- file validation/durability before hooks; native retry/identity/private-loop exclusion; abort hold/manual pending queue/takeover resets.
-- The four evidence fields do not certify any of those behaviors. Execution below is deterministic stdout only.
def main : IO Unit := do
  IO.println s!"Cutover: {repr (PrivateReflectionReadiness.decideCutover PrivateReflectionReadiness.currentEvidence)}"
  IO.println "Proved: guarded admission; stale-only traces preserve all effect/accounting history; revoked effects are inert; cooperative cancellation acknowledgement reaches drained."
  IO.println "SDK/transport refinement and remaining integration obligations are not modeled."
