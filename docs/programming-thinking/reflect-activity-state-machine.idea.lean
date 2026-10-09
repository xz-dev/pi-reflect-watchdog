set_option autoImplicit false

namespace ReflectActivityStateMachine

/-- Timing constants: host heartbeat period, sleep-detection gap, and grace fence before settling idle. -/
def BEAT_MS : Nat := 1000
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
  taskMs : Nat := 0
  taskSinceMs : Option Nat := none
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

/-- A proof-of-life gap over ten seconds approximates suspension, crediting one normal second; it does not identify physical sleep. -/
def sleepShiftMs (lastBeatMs t : Nat) : Nat :=
  if SLEEP_GAP_MS < t - lastBeatMs then t - lastBeatMs - BEAT_MS else 0

def shiftOpen (shift : Nat) : Option Nat → Option Nat
  | none => none
  | some v => some (v + shift)

/-- Every observation applies the same active-interval cap before settlement; idle and grace origins remain the true all-idle time. -/
def advance (s : ActivityState) (t : Nat) : ActivityState :=
  { s with
    nowMs := t
    lastBeatMs := t
    activeSinceMs := shiftOpen (sleepShiftMs s.lastBeatMs t) s.activeSinceMs
    taskSinceMs := shiftOpen (sleepShiftMs s.lastBeatMs t) s.taskSinceMs }

def settleActive (activeMs : Nat) (activeSinceMs : Option Nat) (t : Nat) : Nat :=
  match activeSinceMs with
  | none => activeMs
  | some a => activeMs + (t - a)

def activeElapsed (s : ActivityState) : Nat :=
  settleActive s.activeMs s.activeSinceMs s.nowMs

def taskElapsed (s : ActivityState) : Nat :=
  settleActive s.taskMs s.taskSinceMs s.nowMs

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
      activeMs := if shouldResetCycle s'.idleResetGapMs s'.graceSinceMs t then 0 else s'.activeMs
      loops := if shouldResetCycle s'.idleResetGapMs s'.graceSinceMs t then 0 else s'.loops
      taskMs := if shouldResetCycle s'.idleResetGapMs s'.graceSinceMs t then 0 else s'.taskMs
      taskSinceMs := some t
      activeSinceMs := some t }
  | .idle =>
    { s' with
      phase := .collecting
      busyContributors := s'.busyContributors + 1
      activeMs := if shouldResetCycle s'.idleResetGapMs s'.idleSinceMs t then 0 else s'.activeMs
      activeSinceMs := some t
      taskMs := if shouldResetCycle s'.idleResetGapMs s'.idleSinceMs t then 0 else s'.taskMs
      taskSinceMs := some t
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
      taskMs := settleActive s'.taskMs s'.taskSinceMs t
      taskSinceMs := none
      idleSinceMs := none }
  | n + 2 => { s' with busyContributors := n + 1 }

def contributorIdle (s : ActivityState) (t : Nat) : ActivityState :=
  applyIdle (advance s t) t

/-- Grace settles to idle only after the fence elapsed with zero contributors, closing transient idle seams between main settle and subagent checkpoints. -/
def applyGraceExpired (s' : ActivityState) (t : Nat) : ActivityState :=
  match s'.phase, s'.graceSinceMs with
  | .grace, some g =>
    if GRACE_FENCE_MS < t - g ∧ s'.busyContributors = 0 then
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
    (advance s t).idleSinceMs = s.idleSinceMs := rfl
theorem advance_graceSince (s : ActivityState) (t : Nat) :
    (advance s t).graceSinceMs = s.graceSinceMs := rfl
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
  · rw [advance_phase, advance_graceSince]
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
          rw [ite_eq_left hsleep]
        rw [hsh] at *
        omega
      · have hsh : sleepShiftMs s.lastBeatMs t = 0 := by
          unfold sleepShiftMs
          rw [ite_eq_right hsleep]
        rw [hsh] at *
        omega
  · intro i hi
    rw [advance_idleSince] at hi
    have hle := h7 i hi
    rw [advance_now]
    omega
  · intro g hg
    rw [advance_graceSince] at hg
    have hle := h8 g hg
    rw [advance_now]
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
      by_cases hcond : GRACE_FENCE_MS < t - g ∧ (advance s t).busyContributors = 0
      · rw [ite_eq_left hcond]
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
      · rw [ite_eq_right hcond]
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
    (hfence : GRACE_FENCE_MS < t - g) :
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
  rw [ite_eq_left ⟨hfence, hbusy⟩]

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
    rw [ite_eq_left hsleep]
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
    rw [ite_eq_right (by unfold SLEEP_GAP_MS at *; omega : ¬ SLEEP_GAP_MS < t - s.lastBeatMs)]
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

/-- Fresh observations cap long gaps identically for timer, busy-edge, and loop paths. -/
theorem suspension_credit_is_one_second (s : ActivityState) (t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t)
    (fresh : s.lastBeatMs = s.nowMs) (collecting : s.phase = .collecting)
    (gap : SLEEP_GAP_MS < t - s.lastBeatMs) :
    activeElapsed (advance s t) = activeElapsed s + BEAT_MS := by
  rw [sleep_freeze_exact s t hw hnt collecting gap]
  obtain ⟨_, _, _, _, hopen, hbound, _, _⟩ := hw
  have hsome := hopen.mpr collecting
  cases anchor : s.activeSinceMs with
  | none => simp [anchor] at hsome
  | some a =>
      have bound := hbound a anchor
      simp only [activeElapsed, settleActive, anchor]
      rw [fresh]
      omega

theorem collecting_activity_observations_share_gap_cap (s : ActivityState) (t : Nat)
    (hw : wellFormed s) (hnt : s.nowMs ≤ t)
    (fresh : s.lastBeatMs = s.nowMs) (collecting : s.phase = .collecting)
    (gap : SLEEP_GAP_MS < t - s.lastBeatMs) :
    activeElapsed (contributorBusy s t) = activeElapsed s + BEAT_MS ∧
    activeElapsed (loopRecorded s t) = activeElapsed s + BEAT_MS := by
  have credit := suspension_credit_is_one_second s t hw hnt fresh collecting gap
  constructor
  · simpa [contributorBusy, applyBusy, advance_phase, collecting, activeElapsed] using credit
  · simpa [loopRecorded, applyLoop, activeElapsed] using credit

/-- Concrete traces retain sub-second remainder, union time, and the frozen true idle edge. -/
theorem delayed_observation_keeps_fraction_and_union :
    (let start := contributorBusy (initialState 60000) 0
     let parallel := contributorBusy start 750
     let delayed := heartbeat parallel 3200
     activeElapsed delayed = 3200 ∧ activeElapsed delayed / 1000 = 3 ∧
       activeElapsed delayed % 1000 = 200) ∧
    (let start := contributorBusy (initialState 60000) 0
     let stopped := contributorIdle start 3200
     let resumed := contributorBusy stopped 4200
     activeElapsed resumed = 3200) := by
  constructor <;> decide

theorem idle_reset_uses_strict_true_idle_edge :
    (let stopped := contributorIdle (contributorBusy (initialState 60000) 0) 200
     (contributorBusy stopped 60200).activeMs = 200 ∧
     (contributorBusy stopped 60201).activeMs = 0) ∧
    (∀ s t, (advance s t).idleSinceMs = s.idleSinceMs ∧
      (advance s t).graceSinceMs = s.graceSinceMs) := by
  constructor
  · decide
  · intro s t
    exact ⟨rfl, rfl⟩

/-- Top theorem preserves phase/timestamp safety and formal gap-capping arithmetic; it makes no physical sleep-detection claim. -/
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
      GRACE_FENCE_MS < t - g →
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

-- Full/reminder reset observations first share the same gap rule; reminder preserves active duration, full restarts both clocks.
def reminderAccepted (s : ActivityState) (t : Nat) : ActivityState :=
  let observed := advance s t
  { observed with taskMs := 0, taskSinceMs := if 0 < observed.busyContributors then some t else none }

def fullCycleReset (s : ActivityState) (t : Nat) : ActivityState :=
  let observed := advance s t
  { observed with
    activeMs := 0
    loops := 0
    taskMs := 0
    activeSinceMs := if 0 < observed.busyContributors then some t else none
    taskSinceMs := if 0 < observed.busyContributors then some t else none }

theorem reminder_preserves_active_duration (s : ActivityState) (t : Nat) :
    activeElapsed (reminderAccepted s t) = activeElapsed (advance s t) := rfl

theorem full_reset_restarts_busy_clocks (s : ActivityState) (t : Nat)
    (busy : 0 < s.busyContributors) :
    activeElapsed (fullCycleReset s t) = 0 ∧ taskElapsed (fullCycleReset s t) = 0 := by
  simp [fullCycleReset, advance, busy, activeElapsed, taskElapsed, settleActive]

theorem reminder_fractional_reset_example :
    let start := contributorBusy (initialState 60000) 0
    let reminder := reminderAccepted start 3200
    activeElapsed reminder = 3200 ∧ taskElapsed reminder = 0 ∧
      activeElapsed (heartbeat reminder 3450) = 3450 ∧
      taskElapsed (heartbeat reminder 3450) = 250 := by
  decide

-- Accounting foundation combines measured active-time laws and concrete cadence/idle-boundary examples.
-- Timestamps are monotonic owner-local milliseconds; fairness, physical suspension detection, and runtime dispatch are outside proof scope.
theorem elapsed_accounting_foundation_is_correct :
    (∀ s t, wellFormed s → s.nowMs ≤ t → s.lastBeatMs = s.nowMs →
      s.phase = .collecting → SLEEP_GAP_MS < t - s.lastBeatMs →
      activeElapsed (advance s t) = activeElapsed s + BEAT_MS) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t → s.lastBeatMs = s.nowMs →
      s.phase = .collecting → SLEEP_GAP_MS < t - s.lastBeatMs →
      activeElapsed (contributorBusy s t) = activeElapsed s + BEAT_MS ∧
      activeElapsed (loopRecorded s t) = activeElapsed s + BEAT_MS) ∧
    (∀ s t, wellFormed s → s.nowMs ≤ t → s.phase = .collecting →
      t - s.lastBeatMs ≤ SLEEP_GAP_MS →
      activeElapsed (advance s t) = activeElapsed s + (t - s.nowMs)) ∧
    (let start := contributorBusy (initialState 60000) 0
     let parallel := contributorBusy start 750
     let delayed := heartbeat parallel 3200
     activeElapsed delayed = 3200 ∧ activeElapsed delayed / 1000 = 3 ∧
       activeElapsed delayed % 1000 = 200) ∧
    (let start := contributorBusy (initialState 60000) 0
     let stopped := contributorIdle start 3200
     let resumed := contributorBusy stopped 4200
     activeElapsed resumed = 3200) ∧
    (let stopped := contributorIdle (contributorBusy (initialState 60000) 0) 200
     (contributorBusy stopped 60200).activeMs = 200 ∧
     (contributorBusy stopped 60201).activeMs = 0) ∧
    (∀ s t, (advance s t).idleSinceMs = s.idleSinceMs ∧
      (advance s t).graceSinceMs = s.graceSinceMs) ∧
    activeElapsed (contributorBusy (initialState 60000) 0) = 0 ∧
    (∀ s t, activeElapsed (reminderAccepted s t) = activeElapsed (advance s t)) ∧
    (∀ s t, 0 < s.busyContributors →
      activeElapsed (fullCycleReset s t) = 0 ∧ taskElapsed (fullCycleReset s t) = 0) ∧
    (let start := contributorBusy (initialState 60000) 0
     let reminder := reminderAccepted start 3200
     activeElapsed reminder = 3200 ∧ taskElapsed reminder = 0 ∧
       activeElapsed (heartbeat reminder 3450) = 3450 ∧
       taskElapsed (heartbeat reminder 3450) = 250) :=
  ⟨suspension_credit_is_one_second, collecting_activity_observations_share_gap_cap,
    busy_tick_continuity, delayed_observation_keeps_fraction_and_union.1,
    delayed_observation_keeps_fraction_and_union.2, idle_reset_uses_strict_true_idle_edge.1,
    idle_reset_uses_strict_true_idle_edge.2, rfl, reminder_preserves_active_duration,
    full_reset_restarts_busy_clocks, reminder_fractional_reset_example⟩

-- Every actual owner publication settles/rebases before projecting elapsed values, including duplicate/repair-only observations with no accepted loop delta.
def publicationObserved (s : ActivityState) (t : Nat) : ActivityState :=
  let observed := advance s t
  { observed with
    activeMs := activeElapsed observed
    activeSinceMs := observed.activeSinceMs.map (fun _ => t)
    taskMs := taskElapsed observed
    taskSinceMs := observed.taskSinceMs.map (fun _ => t) }

-- Captured values belong to one observed state before any reentrant subscriber may mutate current state. Transport authentication/generation are outside this clock model.
structure ClockPublication where
  observedAtMs : Nat
  activeMs : Nat
  taskMs : Nat
  busyContributors : Nat
  loops : Nat
  deriving Repr, DecidableEq

def captureClockPublication (s : ActivityState) (t : Nat) : ActivityState × ClockPublication :=
  let observed := publicationObserved s t
  (observed, {
    observedAtMs := observed.nowMs
    activeMs := activeElapsed observed
    taskMs := taskElapsed observed
    busyContributors := observed.busyContributors
    loops := observed.loops })

-- Rebase preserves measured duration and refreshes proof-of-life without altering busy membership or loop authority; captured clock fields remain coherent.
theorem publication_rebase_preserves_elapsed (s : ActivityState) (t : Nat) :
    activeElapsed (publicationObserved s t) = activeElapsed (advance s t) ∧
    taskElapsed (publicationObserved s t) = taskElapsed (advance s t) := by
  constructor
  · cases anchor : (advance s t).activeSinceMs <;>
      simp [publicationObserved, activeElapsed, settleActive, anchor, advance_now]
  · cases anchor : (advance s t).taskSinceMs <;>
      simp [publicationObserved, taskElapsed, settleActive, anchor, advance_now]

theorem publication_observation_is_fresh_without_loop_authority (s : ActivityState) (t : Nat) :
    (publicationObserved s t).lastBeatMs = t ∧
    (publicationObserved s t).nowMs = t ∧
    (publicationObserved s t).loops = s.loops ∧
    (publicationObserved s t).busyContributors = s.busyContributors := by
  exact ⟨rfl, rfl, rfl, rfl⟩

theorem captured_publication_is_coherent (s : ActivityState) (t : Nat) :
    (captureClockPublication s t).2.observedAtMs = (captureClockPublication s t).1.nowMs ∧
    (captureClockPublication s t).2.activeMs = activeElapsed (captureClockPublication s t).1 ∧
    (captureClockPublication s t).2.taskMs = taskElapsed (captureClockPublication s t).1 ∧
    (captureClockPublication s t).2.loops = (captureClockPublication s t).1.loops := by
  exact ⟨rfl, rfl, rfl, rfl⟩

-- Consecutive publication traces preserve 9000/11000/11000ms; a genuine long quiet gap credits one second once and then resumes measured time.
theorem publication_delays_preserve_measured_milliseconds :
    let start := contributorBusy (initialState 60000) 0
    let first := publicationObserved start 9000
    let second := publicationObserved first 11000
    activeElapsed first = 9000 ∧ activeElapsed second = 11000 ∧
      activeElapsed (heartbeat second 11000) = 11000 ∧ taskElapsed second = 11000 := by
  decide

theorem quiet_gap_publication_credits_once_then_rebases :
    let start := contributorBusy (initialState 60000) 0
    let first := publicationObserved start 300000
    let second := publicationObserved first 300200
    activeElapsed first = 1000 ∧ activeElapsed second = 1200 ∧
      activeElapsed (heartbeat second 300200) = 1200 ∧ taskElapsed second = 1200 := by
  decide

-- Top publication theorem combines clock observation laws, coherent capture and finite cadence/gap examples. It proves neither physical sleep detection nor runtime refinement.
theorem publication_accounting_is_correct :
    (∀ s t, activeElapsed (publicationObserved s t) = activeElapsed (advance s t) ∧
      taskElapsed (publicationObserved s t) = taskElapsed (advance s t)) ∧
    (∀ s t, (publicationObserved s t).lastBeatMs = t ∧ (publicationObserved s t).nowMs = t ∧
      (publicationObserved s t).loops = s.loops ∧
      (publicationObserved s t).busyContributors = s.busyContributors) ∧
    (∀ s t, (captureClockPublication s t).2.observedAtMs = (captureClockPublication s t).1.nowMs ∧
      (captureClockPublication s t).2.activeMs = activeElapsed (captureClockPublication s t).1 ∧
      (captureClockPublication s t).2.taskMs = taskElapsed (captureClockPublication s t).1 ∧
      (captureClockPublication s t).2.loops = (captureClockPublication s t).1.loops) ∧
    (let start := contributorBusy (initialState 60000) 0
     let first := publicationObserved start 9000
     let second := publicationObserved first 11000
     activeElapsed first = 9000 ∧ activeElapsed second = 11000 ∧
       activeElapsed (heartbeat second 11000) = 11000 ∧ taskElapsed second = 11000) ∧
    (let start := contributorBusy (initialState 60000) 0
     let first := publicationObserved start 300000
     let second := publicationObserved first 300200
     activeElapsed first = 1000 ∧ activeElapsed second = 1200 ∧
       activeElapsed (heartbeat second 300200) = 1200 ∧ taskElapsed second = 1200) :=
  ⟨publication_rebase_preserves_elapsed, publication_observation_is_fresh_without_loop_authority,
    captured_publication_is_coherent, publication_delays_preserve_measured_milliseconds,
    quiet_gap_publication_credits_once_then_rebases⟩

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
  let s11 := graceExpired s10 27001
  let s12 := contributorBusy s11 28000
  let s13 := heartbeat s12 30000
  let s14 := heartbeat s13 100000
  [ s!"t=12000 main stops, child busy: phase={repr s5.phase} busy={s5.busyContributors}",
    s!"t=17000 last stops: phase={repr s8.phase} graceSince={repr s8.graceSinceMs} activeMs={s8.activeMs}",
    s!"t=27001 fence expired: phase={repr s11.phase} idleSince={repr s11.idleSinceMs}",
    s!"t=28000 re-busy within gap: phase={repr s12.phase} activeMs={s12.activeMs}",
    s!"t=100000 long observation gap: activeElapsed={activeElapsed s14} (one-second credit beyond last proof-of-life)" ]

def main : IO Unit := do
  for line in demoScenario do
    IO.println line
  IO.println "proved: union activity; ordinary delay retains milliseconds; >10s proof-of-life gap credits one second at every observation; idle origins unchanged; every owner publication rebases before coherent capture without loop authority"

end ReflectActivityStateMachine

def main : IO Unit := ReflectActivityStateMachine.main

#print axioms ReflectActivityStateMachine.activity_state_machine_is_correct
#print axioms ReflectActivityStateMachine.elapsed_accounting_foundation_is_correct

#print axioms ReflectActivityStateMachine.publication_accounting_is_correct
