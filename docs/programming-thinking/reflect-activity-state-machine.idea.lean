set_option autoImplicit false

namespace ReflectActivityStateMachine

/-- Timing constants: host heartbeat period, sleep-detection gap, and grace fence before settling idle. -/
def BEAT_MS : Nat := 5000
def SLEEP_GAP_MS : Nat := 10000
def GRACE_FENCE_MS : Nat := 10000

/-- Aggregate lifecycle phase: every contributor (main or subagent, local or cross-process) is one equal busy signal. -/
inductive Phase where
  | idle
  | collecting
  | grace
  deriving Repr, DecidableEq

/-- Full clock/counter state; timestamps are Option because idle/collecting/grace open at different instants. -/
structure ActivityState where
  nowMs : Nat
  lastBeatMs : Nat
  phase : Phase
  busyContributors : Nat
  graceSinceMs : Option Nat
  activeMs : Nat
  activeSinceMs : Option Nat
  idleSinceMs : Option Nat
  loops : Nat
  idleResetGapMs : Nat
  deriving Repr

/-- Everything starts idle at time zero with no open interval. -/
def initialState (idleResetGapMs : Nat) : ActivityState :=
  { nowMs := 0
    lastBeatMs := 0
    phase := .idle
    busyContributors := 0
    graceSinceMs := none
    activeMs := 0
    activeSinceMs := none
    idleSinceMs := none
    loops := 0
    idleResetGapMs := idleResetGapMs }

/-- A missed heartbeat (>10s) means the host slept; freeze by shifting open timestamps forward, counting only up to lastBeat+BEAT. -/
def sleepShiftMs (lastBeatMs t : Nat) : Nat :=
  if SLEEP_GAP_MS < t - lastBeatMs then t - lastBeatMs - BEAT_MS else 0

def shiftOpen (shift : Nat) : Option Nat → Option Nat
  | none => none
  | some v => some (v + shift)

/-- Every transition first advances the clock and applies the sleep freeze; advance is a pure record update so its projections reduce by rfl. -/
def advance (s : ActivityState) (t : Nat) : ActivityState :=
  { s with
    nowMs := t
    lastBeatMs := t
    graceSinceMs := shiftOpen (sleepShiftMs s.lastBeatMs t) s.graceSinceMs
    activeSinceMs := shiftOpen (sleepShiftMs s.lastBeatMs t) s.activeSinceMs
    idleSinceMs := shiftOpen (sleepShiftMs s.lastBeatMs t) s.idleSinceMs }

def settleActive (activeMs : Nat) (activeSinceMs : Option Nat) (t : Nat) : Nat :=
  match activeSinceMs with
  | none => activeMs
  | some a => activeMs + (t - a)

def activeElapsed (s : ActivityState) : Nat :=
  settleActive s.activeMs s.activeSinceMs s.nowMs

def shouldResetCycle (idleResetGapMs : Nat) (idleSinceMs : Option Nat) (t : Nat) : Bool :=
  match idleSinceMs with
  | some i => decide (idleResetGapMs < t - i)
  | none => false

/-- Busy joins are uniform: any contributor flips idle/grace to collecting and reopens the active interval; a >60s idle gap resets counters only. -/
def applyBusy (s' : ActivityState) (t : Nat) : ActivityState :=
  match s'.phase with
  | .collecting => { s' with busyContributors := s'.busyContributors + 1 }
  | .grace =>
    { s' with
      phase := .collecting
      busyContributors := s'.busyContributors + 1
      graceSinceMs := none
      activeSinceMs := some t }
  | .idle =>
    { s' with
      phase := .collecting
      busyContributors := s'.busyContributors + 1
      activeMs := if shouldResetCycle s'.idleResetGapMs s'.idleSinceMs t then 0 else s'.activeMs
      activeSinceMs := some t
      idleSinceMs := none
      loops := if shouldResetCycle s'.idleResetGapMs s'.idleSinceMs t then 0 else s'.loops }

def contributorBusy (s : ActivityState) (t : Nat) : ActivityState :=
  applyBusy (advance s t) t

/-- Idle leaves are uniform too: the last busy contributor closes the active interval at the true all-idle instant and opens grace. -/
def applyIdle (s' : ActivityState) (t : Nat) : ActivityState :=
  match s'.busyContributors with
  | 0 => s'
  | 1 =>
    { s' with
      phase := .grace
      busyContributors := 0
      graceSinceMs := some t
      activeMs := settleActive s'.activeMs s'.activeSinceMs t
      activeSinceMs := none
      idleSinceMs := none }
  | n + 2 => { s' with busyContributors := n + 1 }

def contributorIdle (s : ActivityState) (t : Nat) : ActivityState :=
  applyIdle (advance s t) t

/-- Grace settles to idle only after the fence elapsed with zero contributors, closing transient idle seams between main settle and subagent checkpoints. -/
def applyGraceExpired (s' : ActivityState) (t : Nat) : ActivityState :=
  match s'.phase, s'.graceSinceMs with
  | .grace, some g =>
    if GRACE_FENCE_MS ≤ t - g ∧ s'.busyContributors = 0 then
      { s' with phase := .idle, graceSinceMs := none, idleSinceMs := some g }
    else s'
  | _, _ => s'

def graceExpired (s : ActivityState) (t : Nat) : ActivityState :=
  applyGraceExpired (advance s t) t

def applyLoop (s' : ActivityState) : ActivityState :=
  { s' with loops := s'.loops + 1 }

def loopRecorded (s : ActivityState) (t : Nat) : ActivityState :=
  applyLoop (advance s t)

def heartbeat (s : ActivityState) (t : Nat) : ActivityState :=
  advance s t

/-- Invariant: clock freshness plus phase/counter coherence and timestamp bounds; preserved by every transition. -/
def wellFormed (s : ActivityState) : Prop :=
  s.lastBeatMs ≤ s.nowMs ∧
  s.nowMs ≤ s.lastBeatMs + BEAT_MS ∧
  (s.phase = .collecting ↔ 0 < s.busyContributors) ∧
  (s.phase = .grace ↔ s.graceSinceMs.isSome = true) ∧
  (s.activeSinceMs.isSome = true ↔ s.phase = .collecting) ∧
  (∀ a, s.activeSinceMs = some a → a ≤ s.nowMs) ∧
  (∀ i, s.idleSinceMs = some i → i ≤ s.nowMs) ∧
  (∀ g, s.graceSinceMs = some g → g ≤ s.nowMs)

theorem initial_wellFormed (gap : Nat) : wellFormed (initialState gap) := by
  refine ⟨Nat.le_refl 0, Nat.zero_le BEAT_MS,
    by simp [initialState],
    by simp [initialState],
    by simp [initialState], ?_, ?_, ?_⟩ <;>
    intro v hv <;> simp [initialState] at hv

theorem advance_now (s : ActivityState) (t : Nat) : (advance s t).nowMs = t := rfl
theorem advance_lastBeat (s : ActivityState) (t : Nat) : (advance s t).lastBeatMs = t := rfl
theorem advance_activeSince (s : ActivityState) (t : Nat) :
    (advance s t).activeSinceMs = shiftOpen (sleepShiftMs s.lastBeatMs t) s.activeSinceMs := rfl
theorem advance_idleSince (s : ActivityState) (t : Nat) :
    (advance s t).idleSinceMs = shiftOpen (sleepShiftMs s.lastBeatMs t) s.idleSinceMs := rfl
theorem advance_graceSince (s : ActivityState) (t : Nat) :
    (advance s t).graceSinceMs = shiftOpen (sleepShiftMs s.lastBeatMs t) s.graceSinceMs := rfl
theorem advance_phase (s : ActivityState) (t : Nat) :
    (advance s t).phase = s.phase := rfl
theorem advance_activeMs (s : ActivityState) (t : Nat) :
    (advance s t).activeMs = s.activeMs := rfl

theorem advance_wellFormed (s : ActivityState) (t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t) :
    wellFormed (advance s t) := by
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩ := hw
  have hisome : ∀ v : Option Nat,
      (shiftOpen (sleepShiftMs s.lastBeatMs t) v).isSome = v.isSome := by
    intro v
    cases v <;> simp [shiftOpen]
  have hbound : sleepShiftMs s.lastBeatMs t ≤ t - s.lastBeatMs := by
    unfold sleepShiftMs
    split <;> omega
  refine ⟨Nat.le_refl t, Nat.le_add_right t BEAT_MS,
    by rw [advance_phase]; exact h3, ?_, ?_, ?_, ?_, ?_⟩
  · rw [advance_phase, advance_graceSince, hisome]
    exact h4
  · rw [advance_activeSince, hisome, advance_phase]
    exact h5
  · intro a ha
    rw [advance_activeSince] at ha
    cases hv : s.activeSinceMs with
    | none => rw [hv] at ha; cases ha
    | some v =>
      rw [hv] at ha
      cases ha
      have hle := h6 v hv
      rw [advance_now]
      by_cases hsleep : SLEEP_GAP_MS < t - s.lastBeatMs
      · have hsh : sleepShiftMs s.lastBeatMs t = t - s.lastBeatMs - BEAT_MS := by
          unfold sleepShiftMs
          rw [if_pos hsleep]
        rw [hsh] at *
        omega
      · have hsh : sleepShiftMs s.lastBeatMs t = 0 := by
          unfold sleepShiftMs
          rw [if_neg hsleep]
        rw [hsh] at *
        omega
  · intro i hi
    rw [advance_idleSince] at hi
    cases hv : s.idleSinceMs with
    | none => rw [hv] at hi; cases hi
    | some v =>
      rw [hv] at hi
      cases hi
      have hle := h7 v hv
      rw [advance_now]
      by_cases hsleep : SLEEP_GAP_MS < t - s.lastBeatMs
      · have hsh : sleepShiftMs s.lastBeatMs t = t - s.lastBeatMs - BEAT_MS := by
          unfold sleepShiftMs
          rw [if_pos hsleep]
        rw [hsh] at *
        omega
      · have hsh : sleepShiftMs s.lastBeatMs t = 0 := by
          unfold sleepShiftMs
          rw [if_neg hsleep]
        rw [hsh] at *
        omega
  · intro g hg
    rw [advance_graceSince] at hg
    cases hv : s.graceSinceMs with
    | none => rw [hv] at hg; cases hg
    | some v =>
      rw [hv] at hg
      cases hg
      have hle := h8 v hv
      rw [advance_now]
      by_cases hsleep : SLEEP_GAP_MS < t - s.lastBeatMs
      · have hsh : sleepShiftMs s.lastBeatMs t = t - s.lastBeatMs - BEAT_MS := by
          unfold sleepShiftMs
          rw [if_pos hsleep]
        rw [hsh] at *
        omega
      · have hsh : sleepShiftMs s.lastBeatMs t = 0 := by
          unfold sleepShiftMs
          rw [if_neg hsleep]
        rw [hsh] at *
        omega

theorem heartbeat_wellFormed (s : ActivityState) (t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t) :
    wellFormed (heartbeat s t) :=
  advance_wellFormed s t hw hnt

theorem contributorBusy_wellFormed (s : ActivityState) (t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t) :
    wellFormed (contributorBusy s t) := by
  have hadv := advance_wellFormed s t hw hnt
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩ := hadv
  simp only [contributorBusy, applyBusy]
  cases hphase : (advance s t).phase with
  | collecting =>
    dsimp only
    refine ⟨h1, h2, ?_, ?_, ?_, h6, h7, h8⟩
    · show Phase.collecting = Phase.collecting ↔
        0 < (advance s t).busyContributors + 1
      exact ⟨fun _ => Nat.succ_pos _, fun _ => rfl⟩
    · show Phase.collecting = Phase.grace ↔
        (advance s t).graceSinceMs.isSome = true
      rw [hphase] at h4
      exact h4
    · show (advance s t).activeSinceMs.isSome = true ↔
        Phase.collecting = Phase.collecting
      rw [hphase] at h5
      exact h5
  | grace =>
    dsimp only
    refine ⟨h1, h2, ?_, ?_, ?_, ?_, h7, ?_⟩
    · show Phase.collecting = Phase.collecting ↔
        0 < (advance s t).busyContributors + 1
      exact ⟨fun _ => Nat.succ_pos _, fun _ => rfl⟩
    · show Phase.collecting = Phase.grace ↔ (none : Option Nat).isSome = true
      exact ⟨fun h => Phase.noConfusion h, fun h => by simp at h⟩
    · show (some t).isSome = true ↔ Phase.collecting = Phase.collecting
      exact ⟨fun _ => rfl, fun _ => rfl⟩
    · intro a ha
      show a ≤ (advance s t).nowMs
      cases ha
      rw [advance_now]
      exact Nat.le_refl t
    · intro g hg
      show g ≤ (advance s t).nowMs
      cases hg
  | idle =>
    dsimp only
    refine ⟨h1, h2, ?_, ?_, ?_, ?_, ?_, ?_⟩
    · show Phase.collecting = Phase.collecting ↔
        0 < (advance s t).busyContributors + 1
      exact ⟨fun _ => Nat.succ_pos _, fun _ => rfl⟩
    · show Phase.collecting = Phase.grace ↔
        (advance s t).graceSinceMs.isSome = true
      rw [hphase] at h4
      exact ⟨fun h => Phase.noConfusion h, fun h => Phase.noConfusion (h4.mpr h)⟩
    · show (some t).isSome = true ↔ Phase.collecting = Phase.collecting
      exact ⟨fun _ => rfl, fun _ => rfl⟩
    · intro a ha
      show a ≤ (advance s t).nowMs
      cases ha
      rw [advance_now]
      exact Nat.le_refl t
    · intro i hi
      show i ≤ (advance s t).nowMs
      cases hi
    · intro g hg
      show g ≤ (advance s t).nowMs
      exact h8 g hg

theorem contributorIdle_wellFormed (s : ActivityState) (t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t) :
    wellFormed (contributorIdle s t) := by
  have hadv := advance_wellFormed s t hw hnt
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩ := hadv
  simp only [contributorIdle, applyIdle]
  cases hn : (advance s t).busyContributors with
  | zero =>
    dsimp only
    exact ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩
  | succ n =>
    cases n with
    | zero =>
      dsimp only
      refine ⟨h1, h2, ?_, ?_, ?_, ?_, ?_, ?_⟩
      · show Phase.grace = Phase.collecting ↔ 0 < 0
        exact ⟨fun h => Phase.noConfusion h, fun h => absurd h (Nat.not_lt_zero 0)⟩
      · show Phase.grace = Phase.grace ↔ (some t).isSome = true
        exact ⟨fun _ => rfl, fun _ => rfl⟩
      · show (none : Option Nat).isSome = true ↔ Phase.grace = Phase.collecting
        exact ⟨fun h => by simp at h, fun h => Phase.noConfusion h⟩
      · intro a ha
        show a ≤ (advance s t).nowMs
        cases ha
      · intro i hi
        show i ≤ (advance s t).nowMs
        cases hi
      · intro g hg
        show g ≤ (advance s t).nowMs
        cases hg
        rw [advance_now]
        exact Nat.le_refl t
    | succ m =>
      dsimp only
      refine ⟨h1, h2, ?_, h4, h5, h6, h7, h8⟩
      show (advance s t).phase = Phase.collecting ↔ 0 < m + 1
      exact ⟨fun _ => Nat.succ_pos m, fun _ => h3.mpr (by omega)⟩

theorem graceExpired_wellFormed (s : ActivityState) (t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t) :
    wellFormed (graceExpired s t) := by
  have hadv := advance_wellFormed s t hw hnt
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩ := hadv
  simp only [graceExpired, applyGraceExpired]
  cases hphase : (advance s t).phase with
  | grace =>
    cases hg : (advance s t).graceSinceMs with
    | none =>
      dsimp only
      exact ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩
    | some g =>
      dsimp only
      by_cases hcond : GRACE_FENCE_MS ≤ t - g ∧ (advance s t).busyContributors = 0
      · rw [if_pos hcond]
        obtain ⟨hfence, hbusy⟩ := hcond
        have hnotcol : (advance s t).phase ≠ Phase.collecting := by
          rw [hphase]
          exact Phase.noConfusion
        refine ⟨h1, h2, ?_, ?_, ?_, h6, ?_, ?_⟩
        · show Phase.idle = Phase.collecting ↔ 0 < (advance s t).busyContributors
          rw [hbusy]
          exact ⟨fun h => Phase.noConfusion h, fun h => absurd h (Nat.not_lt_zero 0)⟩
        · show Phase.idle = Phase.grace ↔ (none : Option Nat).isSome = true
          exact ⟨fun h => Phase.noConfusion h, fun h => by simp at h⟩
        · show (advance s t).activeSinceMs.isSome = true ↔
            Phase.idle = Phase.collecting
          exact ⟨fun h => absurd (h5.mp h) hnotcol, fun h => Phase.noConfusion h⟩
        · intro i hi
          show i ≤ (advance s t).nowMs
          cases hi
          exact h8 g hg
        · intro g2 hg2
          show g2 ≤ (advance s t).nowMs
          cases hg2
      · rw [if_neg hcond]
        exact ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩
  | _ =>
    dsimp only
    exact ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩

theorem loopRecorded_wellFormed (s : ActivityState) (t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t) :
    wellFormed (loopRecorded s t) := by
  have hadv := advance_wellFormed s t hw hnt
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩ := hadv
  exact ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩

theorem main_stop_not_all_stop (s : ActivityState) (t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t)
    (hge : 2 ≤ (advance s t).busyContributors) :
    (contributorIdle s t).phase = .collecting := by
  have hadv := advance_wellFormed s t hw hnt
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩ := hadv
  simp only [contributorIdle, applyIdle]
  cases hn : (advance s t).busyContributors with
  | zero => omega
  | succ n =>
    cases n with
    | zero => omega
    | succ m =>
      dsimp only
      show (advance s t).phase = Phase.collecting
      exact h3.mpr (by omega)

theorem last_busy_enters_grace (s : ActivityState) (t : Nat)
    (_hw : wellFormed s) (_hnt : s.nowMs ≤ t)
    (hone : (advance s t).busyContributors = 1) :
    (contributorIdle s t).phase = .grace ∧
    (contributorIdle s t).graceSinceMs = some t := by
  simp only [contributorIdle, applyIdle]
  cases hn : (advance s t).busyContributors with
  | zero => omega
  | succ n =>
    cases n with
    | zero => dsimp only; exact ⟨rfl, rfl⟩
    | succ m => omega

theorem grace_expires_to_idle (s : ActivityState) (g t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t)
    (hphase : (advance s t).phase = .grace)
    (hg : (advance s t).graceSinceMs = some g)
    (hfence : GRACE_FENCE_MS ≤ t - g) :
    (graceExpired s t).phase = .idle := by
  have hadv := advance_wellFormed s t hw hnt
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩ := hadv
  have hnotpos : ¬ 0 < (advance s t).busyContributors := by
    intro hpos
    have hc : (advance s t).phase = Phase.collecting := h3.mpr hpos
    rw [hphase] at hc
    exact Phase.noConfusion hc
  have hbusy : (advance s t).busyContributors = 0 :=
    Nat.eq_zero_of_not_pos hnotpos
  simp only [graceExpired, applyGraceExpired]
  rw [hphase, hg]
  dsimp only
  rw [if_pos ⟨hfence, hbusy⟩]

theorem sleep_freeze_exact (s : ActivityState) (t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t)
    (hcol : s.phase = .collecting)
    (hsleep : SLEEP_GAP_MS < t - s.lastBeatMs) :
    activeElapsed (advance s t) =
      settleActive s.activeMs s.activeSinceMs (s.lastBeatMs + BEAT_MS) := by
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩ := hw
  have hsome : s.activeSinceMs.isSome = true := h5.mpr hcol
  cases h : s.activeSinceMs with
  | none => simp [h] at hsome
  | some a =>
    have hle : a ≤ s.nowMs := h6 a h
    have hge : a ≤ s.lastBeatMs + BEAT_MS := by omega
    unfold activeElapsed
    rw [advance_activeMs, advance_activeSince, advance_now, h]
    simp only [settleActive, shiftOpen, sleepShiftMs]
    rw [if_pos hsleep]
    unfold SLEEP_GAP_MS BEAT_MS at *
    omega

theorem busy_tick_continuity (s : ActivityState) (t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t)
    (hcol : s.phase = .collecting)
    (hawake : t - s.lastBeatMs ≤ SLEEP_GAP_MS) :
    activeElapsed (advance s t) = activeElapsed s + (t - s.nowMs) := by
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8⟩ := hw
  have hsome : s.activeSinceMs.isSome = true := h5.mpr hcol
  cases h : s.activeSinceMs with
  | none => simp [h] at hsome
  | some a =>
    have hle : a ≤ s.nowMs := h6 a h
    unfold activeElapsed
    rw [advance_activeMs, advance_activeSince, advance_now, h]
    simp only [settleActive, shiftOpen, sleepShiftMs]
    rw [if_neg (by unfold SLEEP_GAP_MS at *; omega : ¬ SLEEP_GAP_MS < t - s.lastBeatMs)]
    unfold SLEEP_GAP_MS BEAT_MS at *
    omega

theorem no_active_loss_in_grace (s : ActivityState) (t : Nat)
    (_hw : wellFormed s) (_hnt : s.nowMs ≤ t)
    (hone : (advance s t).busyContributors = 1) :
    s.activeMs ≤ (contributorIdle s t).activeMs := by
  have hval : (contributorIdle s t).activeMs =
      settleActive (advance s t).activeMs (advance s t).activeSinceMs t := by
    simp only [contributorIdle, applyIdle]
    cases hn : (advance s t).busyContributors with
    | zero => omega
    | succ n =>
      cases n with
      | zero => rfl
      | succ m => omega
  rw [hval]
  unfold settleActive
  cases (advance s t).activeSinceMs with
  | none => exact Nat.le_refl _
  | some a => exact Nat.le_add_right _ _

/-- Top theorem: invariant holds initially and under all transitions, main-stop is not all-stop, grace settles honestly, sleep freezes exactly, and no active time is lost at the grace seam. -/
theorem activity_state_machine_is_correct (idleResetGapMs : Nat) :
    wellFormed (initialState idleResetGapMs) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t → wellFormed (heartbeat s t)) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t → wellFormed (contributorBusy s t)) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t → wellFormed (contributorIdle s t)) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t → wellFormed (graceExpired s t)) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t → wellFormed (loopRecorded s t)) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t →
      2 ≤ (advance s t).busyContributors →
      (contributorIdle s t).phase = .collecting) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t →
      (advance s t).busyContributors = 1 →
      (contributorIdle s t).phase = .grace ∧
      (contributorIdle s t).graceSinceMs = some t) ∧
    (∀ s g t, wellFormed s → s.nowMs ≤ t →
      (advance s t).phase = .grace →
      (advance s t).graceSinceMs = some g →
      GRACE_FENCE_MS ≤ t - g →
      (graceExpired s t).phase = .idle) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t → s.phase = .collecting →
      SLEEP_GAP_MS < t - s.lastBeatMs →
      activeElapsed (advance s t) =
        settleActive s.activeMs s.activeSinceMs (s.lastBeatMs + BEAT_MS)) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t → s.phase = .collecting →
      t - s.lastBeatMs ≤ SLEEP_GAP_MS →
      activeElapsed (advance s t) = activeElapsed s + (t - s.nowMs)) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t →
      (advance s t).busyContributors = 1 →
      s.activeMs ≤ (contributorIdle s t).activeMs) :=
  ⟨initial_wellFormed idleResetGapMs,
   heartbeat_wellFormed,
   contributorBusy_wellFormed,
   contributorIdle_wellFormed,
   graceExpired_wellFormed,
   loopRecorded_wellFormed,
   main_stop_not_all_stop,
   last_busy_enters_grace,
   grace_expires_to_idle,
   sleep_freeze_exact,
   busy_tick_continuity,
   no_active_loss_in_grace⟩

/-- Executable trace: two contributors, main stops first, sleep gap, grace settle, and re-busy within the reset gap. -/
def demoScenario : List String :=
  let s0 := initialState 60000
  let s1 := contributorBusy s0 1000
  let s2 := heartbeat s1 5000
  let s3 := contributorBusy s2 6000
  let s4 := heartbeat s3 10000
  let s5 := contributorIdle s4 12000
  let s6 := loopRecorded s5 12500
  let s7 := heartbeat s6 15000
  let s8 := contributorIdle s7 17000
  let s9 := heartbeat s8 20000
  let s10 := heartbeat s9 25000
  let s11 := graceExpired s10 27000
  let s12 := contributorBusy s11 28000
  let s13 := heartbeat s12 30000
  let s14 := heartbeat s13 100000
  [ s!"t=12000 main stops, child busy: phase={repr s5.phase} busy={s5.busyContributors}",
    s!"t=17000 last stops: phase={repr s8.phase} graceSince={repr s8.graceSinceMs} activeMs={s8.activeMs}",
    s!"t=27000 fence expired: phase={repr s11.phase} idleSince={repr s11.idleSinceMs}",
    s!"t=28000 re-busy within gap: phase={repr s12.phase} activeMs={s12.activeMs}",
    s!"t=100000 woke from sleep: activeElapsed={activeElapsed s14} (frozen at 35000+5000 boundary)" ]

def main : IO Unit := do
  for line in demoScenario do
    IO.println line
  IO.println "proved: aggregate phase survives main stop; sleep freezes active elapsed; grace fence settles idle"

end ReflectActivityStateMachine

open ReflectActivityStateMachine in
#eval main

#print axioms ReflectActivityStateMachine.activity_state_machine_is_correct
