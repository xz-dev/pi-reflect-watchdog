-- Lean core only. Abstract model of Reflect's queued manual-reflection identity,
-- exact-child slot release and cooperative liveness (src/extension.ts:
-- queueManualReflection, maybeDispatch, queuedIsCurrent, releaseReflectionSlot,
-- resetCycleForUserTakeover, cancelAbortedRun, syncOwnership, the agent_start and
-- input handlers, the idle Escape terminal-input listener, replaceScope, safeToDispatch).
-- Frozen source: src/extension.ts sha256 683449f8d63de5701af1ebc4aaeeac53c81eea04f6a256983fab9b99c7106a0f.
-- Since that hash the result handler gained a terminal-failure diagnostic: one
-- bounded human-only notice for returned execution-error/decision-failed carrying
-- a fixed host-owned safe summary, the current operation's final error text
-- previewed as ordinary text within two display rows at notification-time
-- terminal width (label included, explicit `Last error:` section, omitted when
-- the final error is missing or blank), plus the verified absolute child JSONL
-- path or an honest unavailable reason on its own line, attempted exactly once
-- inside a swallowing notifier. It is display-only evidence — not modelled
-- authority — so `release` still covers every drain and the slot/cancellation
-- laws below are unchanged.
-- Abstractions: `abortPending` folds "abortBoundaryLeafId recorded, aborted terminal
-- outcome recognized and host idle" into one flag; `inputSinceBoundary` stands for
-- explicitInputClock > boundaryInputClock; `activeRevoked` is ActiveReflection.revoked;
-- revocation of an active child is not a slot change (the slot frees only on that exact
-- child's drain). Escape's `mainIdle` folds "TUI mode and probePiAgentState idle"; the
-- listener lives from session_start/replaceScope until the next replacement or shutdown.
-- A non-Escape key or a busy main passes through and is not an event here.
-- Not modeled: provider/SDK transport, report validation, hooks, UI notices
-- (including the terminal failure/path diagnostic), reserveReflection throwing,
-- process-domain cross-process counters, timers.
set_option autoImplicit false

namespace PrivateReflectionManualIdentity

structure Claim where
  attachment : Nat
  generation : Nat
  deriving Repr, DecidableEq

-- Identity frozen when /reflect is admitted (PendingReflection.admission).
structure Admission where
  session : Nat
  claim : Option Claim
  scope : Nat
  takeover : Nat
  deriving Repr, DecidableEq

structure Pending where
  id : Nat
  admission : Admission
  deriving Repr, DecidableEq

structure State where
  session : Nat
  claim : Option Claim
  scope : Nat
  takeover : Nat
  held : Bool              -- abortedHold
  abortPending : Bool      -- recognized aborted parent run awaiting settlement (host idle)
  inputSinceBoundary : Bool -- explicit interactive/rpc input since the last agent_start
  active : Option Nat      -- reflection slot (kept while a revoked child drains)
  activeRevoked : Bool     -- the occupying child's authority was revoked
  queue : List Pending     -- manualQueue
  launches : List Nat      -- every private operation admitted, newest first
  accounting : Nat         -- abstract counted loops since the last cycle boundary
  nextId : Nat
  deriving Repr, DecidableEq

def admissionOf (s : State) : Admission := ⟨s.session, s.claim, s.scope, s.takeover⟩

-- queuedIsCurrent: same session, scope revision, takeover generation and claim identity.
def current (s : State) (p : Pending) : Bool := decide (p.admission = admissionOf s)

def owns (s : State) : Bool := s.claim.isSome

-- safeToDispatch (ctx presence is folded into ownership).
def safe (s : State) : Bool := owns s && !s.held && s.active.isNone

-- Stale heads are dropped silently whenever the queue is inspected.
def dropStale (s : State) : List Pending → List Pending
  | [] => []
  | p :: rest => if current s p then p :: rest else dropStale s rest

-- maybeDispatch: manual-queue fulfilment only; never threshold reevaluation.
def maybeDispatch (s : State) : State :=
  match dropStale s s.queue with
  | [] => { s with queue := [] }
  | p :: rest =>
    if safe s then
      { s with queue := rest, active := some p.id, activeRevoked := false,
               launches := p.id :: s.launches }
    else { s with queue := p :: rest }

inductive Event where
  | command                  -- /reflect
  | release (id : Nat)       -- exact child drained (success, failure, stale or cancel)
  | userTakeover             -- resetCycleForUserTakeover alone: generation bump, cycle boundary
  | runStart                 -- agent_start: new run boundary, input clock resynced
  | parentAborted            -- the parent run ended aborted; settlement pending
  | abortSettle              -- settlement path calling cancelAbortedRun
  | input                    -- explicit interactive/rpc user input (input handler)
  | replaceScope (session : Nat)
  | cancelQueue              -- /cancel-reflect (pending only)
  | autoTrigger              -- ordinary threshold crossing (automatic intent)
  | loseClaim
  | gainClaim (c : Claim)
  | charge                   -- one ordinary counted loop
  | escape (mainIdle : Bool) -- Escape key while this attachment may own private work
  deriving Repr, DecidableEq

-- Generation bumps before any queue admission (resetCycleForUserTakeover).
def takeoverReset (s : State) : State :=
  if owns s then { s with takeover := s.takeover + 1, accounting := 0 } else s

-- A fresh /reflect is explicit re-entry: it releases the abort hold after a takeover reset.
def unhold (s : State) : State := if s.held then { takeoverReset s with held := false } else s

-- cancelAbortedRun: only with a pending recognized abort; hold, revoke (slot kept),
-- clear queue, takeover reset; input after the boundary releases the new hold at once.
def cancelAbort (s : State) : State :=
  if owns s && s.abortPending then
    { takeoverReset s with abortPending := false, queue := [], activeRevoked := true,
                           held := !s.inputSinceBoundary }
  else s

def push (t : State) : State :=
  { t with queue := [⟨t.nextId, admissionOf t⟩], nextId := t.nextId + 1 }

-- An existing queued request coalesces the command.
def enqueue (t : State) : State := if t.queue.isEmpty then maybeDispatch (push t) else t

-- queueManualReflection: abort preprocessing, then held-path reset, then coalesce or enqueue.
def command (s : State) : State := if owns s then enqueue (unhold (cancelAbort s)) else s

-- input handler (owned, interactive/rpc): clock tick, revoke, abort preprocessing,
-- takeover reset, hold released.
def input (s : State) : State :=
  if owns s then
    { takeoverReset (cancelAbort { s with inputSinceBoundary := true, activeRevoked := true })
        with held := false }
  else s

-- Idle Escape listener: consumed only for owned, unrevoked active private work while main
-- is idle; revoke the exact child (slot kept until its drain), clear the queue, and take
-- over the cycle. No launch, result, hook or main message.
def escape (s : State) (mainIdle : Bool) : State :=
  if owns s && s.active.isSome && !s.activeRevoked && mainIdle then
    { takeoverReset s with activeRevoked := true, queue := [] }
  else s

def consumesEscape (s : State) (mainIdle : Bool) : Bool :=
  owns s && s.active.isSome && !s.activeRevoked && mainIdle

def release (s : State) (id : Nat) : State :=
  if s.active = some id then maybeDispatch { s with active := none } else s


def autoTrigger (s : State) : State :=
  if safe s && s.queue.isEmpty then
    { s with active := some s.nextId, activeRevoked := false, launches := s.nextId :: s.launches,
             nextId := s.nextId + 1, accounting := 0 }
  else s

def step (s : State) : Event → State
  | .command => command s
  | .release id => release s id
  | .userTakeover => takeoverReset s
  | .runStart => { s with inputSinceBoundary := false, abortPending := false }
  | .parentAborted => if owns s then { s with abortPending := true } else s
  | .abortSettle => cancelAbort s
  | .input => input s
  | .replaceScope n =>
    -- replaceScope also drops abortBoundaryLeafId and abortSettlementPending.
    { s with session := n, scope := s.scope + 1, queue := [], activeRevoked := true, abortPending := false }
  | .cancelQueue => { s with queue := [] }
  | .autoTrigger => autoTrigger s
  | .loseClaim => if s.claim.isSome then { s with claim := none, queue := [], activeRevoked := true } else s
  -- syncOwnership revokes the active child and clears the queue on claim loss
  | .gainClaim c => { s with claim := some c }
  | .charge => { s with accounting := s.accounting + 1 }
  | .escape b => escape s b

def run (s : State) : List Event → State
  | [] => s
  | e :: es => run (step s e) es

/-! ## dropStale and maybeDispatch -/

theorem dropStale_mem (s : State) :
    ∀ (q : List Pending) (p : Pending), p ∈ dropStale s q → p ∈ q
  | [], p, h => by simp [dropStale] at h
  | x :: rest, p, h => by
    unfold dropStale at h
    split at h
    · exact h
    · exact List.mem_cons_of_mem x (dropStale_mem s rest p h)

theorem dropStale_head (s : State) :
    ∀ (q : List Pending) (p : Pending) (rest : List Pending),
      dropStale s q = p :: rest → current s p = true
  | [], p, rest, h => by simp [dropStale] at h
  | x :: xs, p, rest, h => by
    unfold dropStale at h
    split at h
    · rename_i hc
      injection h with h1 _
      subst h1
      exact hc
    · exact dropStale_head s xs p rest h

theorem dropStale_length (s : State) :
    ∀ (q : List Pending), (dropStale s q).length ≤ q.length
  | [] => by simp [dropStale]
  | x :: xs => by
    unfold dropStale
    split
    · simp
    · have := dropStale_length s xs
      simp
      omega

-- Identity, hold, accounting and id allocation are untouched by dispatch.
theorem maybeDispatch_frame (s : State) :
    (maybeDispatch s).session = s.session ∧ (maybeDispatch s).claim = s.claim ∧
    (maybeDispatch s).scope = s.scope ∧ (maybeDispatch s).takeover = s.takeover ∧
    (maybeDispatch s).held = s.held ∧ (maybeDispatch s).accounting = s.accounting ∧
    (maybeDispatch s).nextId = s.nextId := by
  unfold maybeDispatch
  split
  · simp
  · split <;> simp

theorem maybeDispatch_spec (s : State) :
    ((maybeDispatch s).launches = s.launches ∧ (maybeDispatch s).active = s.active ∧
      (∀ p, p ∈ (maybeDispatch s).queue → p ∈ s.queue) ∧
      (maybeDispatch s).queue.length ≤ s.queue.length) ∨
    (∃ p, p ∈ s.queue ∧ current s p = true ∧ safe s = true ∧
      (maybeDispatch s).launches = p.id :: s.launches ∧
      (maybeDispatch s).active = some p.id ∧
      (∀ r, r ∈ (maybeDispatch s).queue → r ∈ s.queue) ∧
      (maybeDispatch s).queue.length + 1 ≤ s.queue.length) := by
  unfold maybeDispatch
  split
  · left
    simp
  · rename_i p rest h
    have hmem : p ∈ s.queue := dropStale_mem s s.queue p (by rw [h]; simp)
    have hlen := dropStale_length s s.queue
    rw [h] at hlen
    simp at hlen
    have hrest : ∀ r, r ∈ rest → r ∈ s.queue := fun r hr =>
      dropStale_mem s s.queue r (by rw [h]; exact List.mem_cons_of_mem p hr)
    split
    · rename_i hs
      right
      refine ⟨p, hmem, dropStale_head s s.queue p rest h, hs, rfl, rfl, ?_, ?_⟩
      · exact hrest
      · simp; omega
    · left
      refine ⟨rfl, rfl, ?_, ?_⟩
      · intro r hr
        simp at hr
        rcases hr with hr | hr
        · subst hr; exact hmem
        · exact hrest r hr
      · simp; omega

theorem maybeDispatch_unsafe (s : State) (h : safe s = false) :
    (maybeDispatch s).launches = s.launches ∧ (maybeDispatch s).active = s.active := by
  rcases maybeDispatch_spec s with ⟨h1, h2, _⟩ | ⟨_, _, _, hs, _⟩
  · exact ⟨h1, h2⟩
  · rw [h] at hs; cases hs

theorem maybeDispatch_empty (s : State) (h : s.queue = []) :
    maybeDispatch s = { s with queue := [] } := by
  unfold maybeDispatch
  rw [h]
  simp [dropStale]

/-! ## Frame lemmas for the command path -/

theorem takeoverReset_frame (s : State) :
    (takeoverReset s).launches = s.launches ∧ (takeoverReset s).active = s.active ∧
    (takeoverReset s).queue = s.queue ∧ (takeoverReset s).nextId = s.nextId ∧
    (takeoverReset s).held = s.held ∧ (takeoverReset s).claim = s.claim ∧
    s.takeover ≤ (takeoverReset s).takeover := by
  unfold takeoverReset
  split <;> simp

theorem cancelAbort_frame (s : State) :
    (cancelAbort s).launches = s.launches ∧ (cancelAbort s).active = s.active ∧
    (∀ p, p ∈ (cancelAbort s).queue → p ∈ s.queue) ∧
    (cancelAbort s).queue.length ≤ s.queue.length ∧
    (cancelAbort s).nextId = s.nextId ∧ (cancelAbort s).claim = s.claim ∧
    s.takeover ≤ (cancelAbort s).takeover := by
  have h := takeoverReset_frame s
  unfold cancelAbort
  split
  · exact ⟨h.1, h.2.1, by simp, by simp, h.2.2.2.1, h.2.2.2.2.2.1, h.2.2.2.2.2.2⟩
  · exact ⟨rfl, rfl, fun p hp => hp, Nat.le_refl _, rfl, rfl, Nat.le_refl _⟩

theorem input_frame (s : State) :
    (input s).launches = s.launches ∧ (input s).active = s.active ∧
    (∀ p, p ∈ (input s).queue → p ∈ s.queue) ∧
    (input s).queue.length ≤ s.queue.length ∧
    (input s).nextId = s.nextId ∧ s.takeover ≤ (input s).takeover := by
  unfold input
  split
  · have hc := cancelAbort_frame { s with inputSinceBoundary := true, activeRevoked := true }
    have ht := takeoverReset_frame (cancelAbort { s with inputSinceBoundary := true, activeRevoked := true })
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩
    · show (takeoverReset _).launches = _; rw [ht.1, hc.1]
    · show (takeoverReset _).active = _; rw [ht.2.1, hc.2.1]
    · intro p hp
      have : p ∈ (takeoverReset (cancelAbort { s with inputSinceBoundary := true, activeRevoked := true })).queue := hp
      rw [ht.2.2.1] at this
      exact hc.2.2.1 p this
    · show (takeoverReset _).queue.length ≤ _; rw [ht.2.2.1]; exact hc.2.2.2.1
    · show (takeoverReset _).nextId = _; rw [ht.2.2.2.1, hc.2.2.2.2.1]
    · show s.takeover ≤ (takeoverReset _).takeover
      exact Nat.le_trans hc.2.2.2.2.2.2 ht.2.2.2.2.2.2
  · exact ⟨rfl, rfl, fun p hp => hp, Nat.le_refl _, rfl, Nat.le_refl _⟩

theorem unhold_frame (s : State) :
    (unhold s).launches = s.launches ∧ (unhold s).active = s.active ∧
    (unhold s).queue = s.queue ∧ (unhold s).nextId = s.nextId ∧
    (unhold s).claim = s.claim ∧ s.takeover ≤ (unhold s).takeover := by
  have h := takeoverReset_frame s
  unfold unhold
  split
  · exact ⟨h.1, h.2.1, h.2.2.1, h.2.2.2.1, h.2.2.2.2.2.1, h.2.2.2.2.2.2⟩
  · exact ⟨rfl, rfl, rfl, rfl, rfl, Nat.le_refl _⟩

/-! ## Release obligations (parent conditions 1-4) -/

-- (2) Empty queue: a failure, stale or drain release launches nothing and changes no counter.
theorem release_empty_queue_launches_nothing (s : State) (id : Nat) (h : s.queue = []) :
    (step s (.release id)).launches = s.launches ∧
    (step s (.release id)).accounting = s.accounting ∧
    (step s (.release id)).takeover = s.takeover ∧
    (step s (.release id)).queue = [] := by
  show (release s id).launches = s.launches ∧ (release s id).accounting = s.accounting ∧
    (release s id).takeover = s.takeover ∧ (release s id).queue = []
  unfold release
  split
  · rw [maybeDispatch_empty { s with active := none } h]
    exact ⟨rfl, rfl, rfl, rfl⟩
  · exact ⟨rfl, rfl, rfl, h⟩

-- (1) A release launches only the current queued request, never a fresh automatic intent.
theorem release_launches_only_current_queued (s : State) (id : Nat)
    (h : (step s (.release id)).launches ≠ s.launches) :
    ∃ p, p ∈ s.queue ∧ current s p = true ∧ s.active = some id ∧
      (step s (.release id)).launches = p.id :: s.launches := by
  change (release s id).launches ≠ s.launches at h
  show ∃ p, p ∈ s.queue ∧ current s p = true ∧ s.active = some id ∧
      (release s id).launches = p.id :: s.launches
  unfold release at h ⊢
  split at h
  · rename_i ha
    rw [ite_eq_left ha]
    rcases maybeDispatch_spec { s with active := none } with ⟨h1, _⟩ | ⟨p, hp, hc, _, hl, _⟩
    · exact absurd h1 h
    · exact ⟨p, hp, hc, ha, hl⟩
  · exact absurd rfl h

-- Release of anything but the exact occupying child is a no-op.
theorem release_requires_exact_child (s : State) (id : Nat) (h : s.active ≠ some id) :
    step s (.release id) = s := by
  show release s id = s
  unfold release
  simp [h]

/-! ## No overlap and cooperative liveness -/

theorem escape_frame (s : State) (b : Bool) :
    (escape s b).launches = s.launches ∧ (escape s b).active = s.active ∧
    (escape s b).nextId = s.nextId ∧ (∀ p, p ∈ (escape s b).queue → p ∈ s.queue) ∧
    s.takeover ≤ (escape s b).takeover := by
  have h := takeoverReset_frame s
  unfold escape
  split
  · exact ⟨h.1, h.2.1, h.2.2.2.1, by simp, h.2.2.2.2.2.2⟩
  · exact ⟨rfl, rfl, rfl, fun p hp => hp, Nat.le_refl _⟩

-- Escape with a busy main (or any non-consuming case) passes through unchanged.
theorem escape_passthrough (s : State) (b : Bool) (h : consumesEscape s b = false) :
    escape s b = s := by
  unfold escape
  unfold consumesEscape at h
  simp [h]

theorem escape_busy_main_passthrough (s : State) : escape s false = s :=
  escape_passthrough s false (by simp [consumesEscape])

-- A consumed Escape is a takeover: generation bumped, queue retired, child revoked, slot
-- still occupied (no forced release) and nothing launched.
theorem escape_consumed_is_takeover (s : State) (b : Bool) (h : consumesEscape s b = true) :
    (escape s b).takeover = s.takeover + 1 ∧ (escape s b).queue = [] ∧
    (escape s b).activeRevoked = true ∧ (escape s b).active = s.active ∧
    (escape s b).launches = s.launches := by
  unfold consumesEscape at h
  have ho : owns s = true := by simp_all
  unfold escape
  rw [ite_eq_left h]
  simp [takeoverReset, ho]

-- Repeated Escape is consumed at most once per active child.
theorem escape_consumed_at_most_once (s : State) (b c : Bool) (h : consumesEscape s b = true) :
    consumesEscape (escape s b) c = false := by
  have := (escape_consumed_is_takeover s b h).2.2.1
  simp [consumesEscape, this]

theorem command_occupied (s : State) (a : Nat) (h : s.active = some a) :
    (command s).launches = s.launches ∧ (command s).active = s.active := by
  unfold command
  split
  · have hc := cancelAbort_frame s
    have hu := unhold_frame (cancelAbort s)
    have hl : (unhold (cancelAbort s)).launches = s.launches := by rw [hu.1, hc.1]
    have ha : (unhold (cancelAbort s)).active = s.active := by rw [hu.2.1, hc.2.1]
    unfold enqueue
    split
    · have hs : safe (push (unhold (cancelAbort s))) = false := by
        simp [safe, push, ha, h]
      have hm := maybeDispatch_unsafe (push (unhold (cancelAbort s))) hs
      rw [hm.1, hm.2]
      exact ⟨hl, ha⟩
    · exact ⟨hl, ha⟩
  · exact ⟨rfl, rfl⟩

-- (4) While a child occupies the slot, nothing but its own release changes the slot or launches.
theorem occupied_slot_is_stable (s : State) (a : Nat) (h : s.active = some a)
    (e : Event) (he : e ≠ .release a) :
    (step s e).launches = s.launches ∧ (step s e).active = s.active := by
  cases e with
  | command => exact command_occupied s a h
  | release id =>
    have hne : s.active ≠ some id := by
      intro hc; apply he; rw [h] at hc; injection hc with hc; rw [hc]
    rw [release_requires_exact_child s id hne]
    exact ⟨rfl, rfl⟩
  | userTakeover =>
    have := takeoverReset_frame s
    exact ⟨this.1, this.2.1⟩
  | runStart => exact ⟨rfl, rfl⟩
  | parentAborted =>
    show (if owns s then { s with abortPending := true } else s).launches = s.launches ∧
      (if owns s then { s with abortPending := true } else s).active = s.active
    split <;> exact ⟨rfl, rfl⟩
  | abortSettle => exact ⟨(cancelAbort_frame s).1, (cancelAbort_frame s).2.1⟩
  | input => exact ⟨(input_frame s).1, (input_frame s).2.1⟩
  | replaceScope n => exact ⟨rfl, rfl⟩
  | cancelQueue => exact ⟨rfl, rfl⟩
  | autoTrigger =>
    show (autoTrigger s).launches = s.launches ∧ (autoTrigger s).active = s.active
    unfold autoTrigger
    simp [safe, h]
  | loseClaim =>
    show (if s.claim.isSome then _ else s).launches = s.launches ∧ (if s.claim.isSome then _ else s).active = s.active
    split <;> exact ⟨rfl, rfl⟩
  | gainClaim c => exact ⟨rfl, rfl⟩
  | charge => exact ⟨rfl, rfl⟩
  | escape b => exact ⟨(escape_frame s b).1, (escape_frame s b).2.1⟩

-- (cooperative liveness) If the occupying child never drains, the slot stays held and no
-- second private operation is ever admitted; nothing force-releases it.
theorem nonsettling_child_holds_slot (a : Nat) :
    ∀ (es : List Event) (s : State), s.active = some a → (∀ e, e ∈ es → e ≠ .release a) →
      (run s es).active = some a ∧ (run s es).launches = s.launches
  | [], s, h, _ => ⟨h, rfl⟩
  | e :: es, s, h, hes => by
    have he : e ≠ .release a := hes e (by simp)
    have ⟨hl, hact⟩ := occupied_slot_is_stable s a h e he
    have ih := nonsettling_child_holds_slot a es (step s e) (by rw [hact]; exact h)
      (fun e' he' => hes e' (by simp [he']))
    simp only [run]
    exact ⟨ih.1, by rw [ih.2, hl]⟩

/-! ## Takeover retires earlier admissions -/

theorem takeover_monotone (s : State) (e : Event) : s.takeover ≤ (step s e).takeover := by
  cases e with
  | command =>
    show s.takeover ≤ (command s).takeover
    unfold command
    split
    · have hc := (cancelAbort_frame s).2.2.2.2.2.2
      have hu := Nat.le_trans hc (unhold_frame (cancelAbort s)).2.2.2.2.2
      unfold enqueue
      split
      · rw [(maybeDispatch_frame _).2.2.2.1]
        exact hu
      · exact hu
    · exact Nat.le_refl _
  | release id =>
    show s.takeover ≤ (release s id).takeover
    unfold release
    split
    · rw [(maybeDispatch_frame _).2.2.2.1]; exact Nat.le_refl _
    · exact Nat.le_refl _
  | userTakeover => exact (takeoverReset_frame s).2.2.2.2.2.2
  | runStart => exact Nat.le_refl _
  | parentAborted =>
    show s.takeover ≤ (if owns s then { s with abortPending := true } else s).takeover
    split <;> exact Nat.le_refl _
  | abortSettle => exact (cancelAbort_frame s).2.2.2.2.2.2
  | input => exact (input_frame s).2.2.2.2.2
  | replaceScope n => exact Nat.le_refl _
  | cancelQueue => exact Nat.le_refl _
  | autoTrigger =>
    show s.takeover ≤ (autoTrigger s).takeover
    unfold autoTrigger
    split <;> exact Nat.le_refl _
  | loseClaim =>
    show s.takeover ≤ (if s.claim.isSome then _ else s).takeover
    split <;> exact Nat.le_refl _
  | gainClaim c => exact Nat.le_refl _
  | charge => exact Nat.le_refl _
  | escape b => exact (escape_frame s b).2.2.2.2

theorem run_takeover_monotone :
    ∀ (es : List Event) (s : State), s.takeover ≤ (run s es).takeover
  | [], _ => Nat.le_refl _
  | e :: es, s => Nat.le_trans (takeover_monotone s e) (run_takeover_monotone es (step s e))

-- (1) A request admitted before an explicit takeover is never current afterwards.
theorem retired_admission_never_current (p : Pending) (s : State)
    (hold : p.admission.takeover < s.takeover) (es : List Event) :
    current (run s es) p = false := by
  have hm := run_takeover_monotone es s
  unfold current admissionOf
  rw [decide_eq_false_iff_not]
  intro heq
  have : p.admission.takeover = (run s es).takeover := by rw [heq]
  omega

theorem userTakeover_bumps_generation (s : State) (ho : owns s = true) :
    (step s .userTakeover).takeover = s.takeover + 1 ∧ (step s .userTakeover).accounting = 0 := by
  show (takeoverReset s).takeover = s.takeover + 1 ∧ (takeoverReset s).accounting = 0
  simp [takeoverReset, ho]

/-! ## At most once -/

structure Inv (s : State) : Prop where
  nodup : s.launches.Nodup
  launched_lt : ∀ x, x ∈ s.launches → x < s.nextId
  queued_fresh : ∀ p, p ∈ s.queue → p.id < s.nextId ∧ p.id ∉ s.launches
  queue_small : s.queue.length ≤ 1

theorem inv_init (s : State) (h1 : s.launches = []) (h2 : s.queue = []) : Inv s :=
  ⟨by simp [h1], by simp [h1], by simp [h2], by simp [h2]⟩

-- Any transition that keeps launches/nextId and does not grow or refill the queue keeps Inv.
theorem inv_frame (s t : State) (h : Inv s) (hl : t.launches = s.launches) (hn : t.nextId = s.nextId)
    (hq : ∀ p, p ∈ t.queue → p ∈ s.queue) (hlen : t.queue.length ≤ s.queue.length) : Inv t :=
  ⟨by rw [hl]; exact h.nodup,
   by intro x hx; rw [hn]; rw [hl] at hx; exact h.launched_lt x hx,
   by intro p hp; rw [hn, hl]; exact h.queued_fresh p (hq p hp),
   Nat.le_trans hlen h.queue_small⟩

theorem inv_clear (s t : State) (h : Inv s) (hl : t.launches = s.launches) (hn : t.nextId = s.nextId)
    (hq : t.queue = []) : Inv t :=
  inv_frame s t h hl hn (by rw [hq]; simp) (by rw [hq]; simp)

theorem maybeDispatch_inv (s : State) (h : Inv s) : Inv (maybeDispatch s) := by
  have hn := (maybeDispatch_frame s).2.2.2.2.2.2
  rcases maybeDispatch_spec s with ⟨hl, _, hq, hlen⟩ | ⟨p, hp, _, _, hl, _, hq, hlen⟩
  · exact inv_frame s _ h hl hn hq hlen
  · have ⟨hplt, hpnot⟩ := h.queued_fresh p hp
    have hsmall := h.queue_small
    refine ⟨?_, ?_, ?_, ?_⟩
    · rw [hl]; exact List.nodup_cons.mpr ⟨hpnot, h.nodup⟩
    · intro x hx; rw [hn]; rw [hl] at hx
      simp at hx
      rcases hx with hx | hx
      · rw [hx]; exact hplt
      · exact h.launched_lt x hx
    · intro r hr
      have : (maybeDispatch s).queue.length = 0 := by omega
      rw [List.length_eq_zero_iff] at this
      rw [this] at hr
      simp at hr
    · omega

theorem command_inv (s : State) (h : Inv s) : Inv (command s) := by
  unfold command
  split
  · have hc := cancelAbort_frame s
    have hci : Inv (cancelAbort s) := inv_frame s _ h hc.1 hc.2.2.2.2.1 hc.2.2.1 hc.2.2.2.1
    have hu := unhold_frame (cancelAbort s)
    have hi : Inv (unhold (cancelAbort s)) := inv_frame _ _ hci hu.1 hu.2.2.2.1
      (by rw [hu.2.2.1]; exact fun p hp => hp) (by rw [hu.2.2.1]; exact Nat.le_refl _)
    unfold enqueue
    split
    · rename_i hq
      have hq' : (unhold (cancelAbort s)).queue = [] := by simpa using hq
      apply maybeDispatch_inv
      refine ⟨hi.nodup, ?_, ?_, by simp [push]⟩
      · intro x hx
        have := hi.launched_lt x hx
        simp [push]
        omega
      · intro p hp
        simp [push] at hp
        subst hp
        refine ⟨by simp [push], ?_⟩
        intro hin
        have := hi.launched_lt _ hin
        simp at this
    · exact hi
  · exact h

-- Every admitted private operation id is launched at most once along any trace
-- (the command path and the drain-release path cannot both fulfil one request).
theorem step_inv (s : State) (h : Inv s) (e : Event) : Inv (step s e) := by
  cases e with
  | command => exact command_inv s h
  | release id =>
    show Inv (release s id)
    unfold release
    split
    · exact maybeDispatch_inv _ (inv_frame s _ h rfl rfl (fun p hp => hp) (Nat.le_refl _))
    · exact h
  | userTakeover =>
    show Inv (takeoverReset s)
    have hf := takeoverReset_frame s
    exact inv_frame s _ h hf.1 hf.2.2.2.1 (by rw [hf.2.2.1]; exact fun p hp => hp)
      (by rw [hf.2.2.1]; exact Nat.le_refl _)
  | runStart => exact inv_frame s _ h rfl rfl (fun p hp => hp) (Nat.le_refl _)
  | parentAborted =>
    show Inv (if owns s then { s with abortPending := true } else s)
    split
    · exact inv_frame s _ h rfl rfl (fun p hp => hp) (Nat.le_refl _)
    · exact h
  | abortSettle =>
    have hc := cancelAbort_frame s
    exact inv_frame s _ h hc.1 hc.2.2.2.2.1 hc.2.2.1 hc.2.2.2.1
  | input =>
    have hi := input_frame s
    exact inv_frame s _ h hi.1 hi.2.2.2.2.1 hi.2.2.1 hi.2.2.2.1
  | replaceScope n => exact inv_clear s _ h rfl rfl rfl
  | cancelQueue => exact inv_clear s _ h rfl rfl rfl
  | autoTrigger =>
    show Inv (autoTrigger s)
    unfold autoTrigger
    split
    · rename_i hc
      simp at hc
      refine ⟨?_, ?_, ?_, ?_⟩
      · refine List.nodup_cons.mpr ⟨?_, h.nodup⟩
        intro hin
        have := h.launched_lt _ hin
        omega
      · intro x hx
        simp only [List.mem_cons] at hx
        show x < s.nextId + 1
        rcases hx with hx | hx
        · omega
        · have := h.launched_lt x hx; omega
      · intro p hp; rw [hc.2] at hp; simp at hp
      · simp [hc.2]
    · exact h
  | loseClaim =>
    show Inv (if s.claim.isSome then _ else s)
    split
    · exact inv_clear s _ h rfl rfl rfl
    · exact h
  | gainClaim c => exact inv_frame s _ h rfl rfl (fun p hp => hp) (Nat.le_refl _)
  | charge => exact inv_frame s _ h rfl rfl (fun p hp => hp) (Nat.le_refl _)
  | escape b =>
    have he := escape_frame s b
    refine inv_frame s _ h he.1 he.2.2.1 he.2.2.2.1 ?_
    show (escape s b).queue.length ≤ s.queue.length
    unfold escape
    split
    · simp
    · exact Nat.le_refl _

theorem run_inv : ∀ (es : List Event) (s : State), Inv s → Inv (run s es)
  | [], _, h => h
  | e :: es, s, h => run_inv es (step s e) (step_inv s h e)

theorem launched_at_most_once (s : State) (h1 : s.launches = []) (h2 : s.queue = [])
    (es : List Event) : (run s es).launches.Nodup :=
  (run_inv es s (inv_init s h1 h2)).nodup

/-! ## Concrete traces (non-vacuity) -/

def owner : Claim := ⟨1, 1⟩

-- Reflection 0 is running; the user aborts the parent (hold, revoke) while it drains.
def draining : State :=
  { session := 7, claim := some owner, scope := 0, takeover := 0, held := false,
    abortPending := false, inputSinceBoundary := false,
    active := some 0, activeRevoked := false, queue := [], launches := [0], accounting := 3, nextId := 1 }

-- /reflect during abort settlement is fulfilled exactly once, only after the exact drain.
example :
    let s := run draining [.parentAborted, .abortSettle, .command]
    s.active = some 0 ∧ s.launches = [0] ∧ s.queue.length = 1 := by decide
example : (run draining [.parentAborted, .abortSettle, .command, .release 0]).launches = [1, 0] := by decide
example : (run draining [.parentAborted, .abortSettle, .command, .release 0, .release 0]).launches = [1, 0] := by decide
-- A release for a different child is ignored and launches nothing.
example : (run draining [.parentAborted, .abortSettle, .command, .release 5]).launches = [0] := by decide
-- A takeover between queueing and drain retires the queued request silently.
example : (run draining [.command, .userTakeover, .release 0]).launches = [0] := by decide
example : (run draining [.command, .userTakeover, .release 0]).queue = [] := by decide
-- Claim loss and reacquisition under a new generation also retire it.
example : (run draining [.command, .loseClaim, .gainClaim ⟨1, 2⟩, .release 0]).launches = [0] := by decide
-- /cancel-reflect and scope replacement remove it.
example : (run draining [.command, .cancelQueue, .release 0]).launches = [0] := by decide
example : (run draining [.command, .replaceScope 8, .release 0]).launches = [0] := by decide
-- Empty queue: failure/stale/drain release launches nothing and keeps counters.
example : (run draining [.release 0]).launches = [0] ∧ (run draining [.release 0]).accounting = 3 := by decide
-- The abort hold blocks both automatic and queued dispatch until explicit input.
example : (run draining [.parentAborted, .abortSettle, .release 0, .autoTrigger]).launches = [0] := by decide
example : (run draining [.parentAborted, .abortSettle, .release 0, .input, .autoTrigger]).launches = [1, 0] := by decide
-- Reviewer trace 1: a command with a pending recognized abort first settles it, retiring
-- queued id 1, and admits id 2 under generation 2 (settlement bump, then held-path bump).
example :
    let s := run draining [.command, .parentAborted, .command]
    s.takeover = 2 ∧ s.queue.map (·.id) = [2] ∧ s.queue.map (·.admission.takeover) = [2] ∧
      s.held = false := by decide
example : (run draining [.command, .parentAborted, .command, .release 0]).launches = [2, 0] := by decide
-- Reviewer trace 2: explicit input after the run boundary but before settlement releases the
-- new hold immediately; without such input the hold stays.
example : (run draining [.runStart, .input, .parentAborted, .abortSettle]).held = false := by decide
example : (run draining [.runStart, .parentAborted, .abortSettle]).held = true := by decide
example : (run draining [.input, .runStart, .parentAborted, .abortSettle]).held = true := by decide
-- Reviewer trace 3: claim loss clears the queue; the new owner's command is admitted and
-- fulfilled after the exact drain.
example : (run draining [.command, .loseClaim, .gainClaim ⟨1, 2⟩, .command, .release 0]).launches = [2, 0] := by
  decide
-- Unowned input and commands do nothing.
example : (run { draining with claim := none } [.input, .command, .release 0]).launches = [0] := by decide
-- Scope replacement drops a pending abort: a later /reflect performs no stale settlement.
example :
    let s := run draining [.parentAborted, .replaceScope 8, .command]
    s.takeover = 0 ∧ s.queue.map (·.admission.takeover) = [0] := by decide
-- Idle Escape: the queued /reflect is retired and nothing relaunches on the exact drain.
example : (run draining [.command, .escape true, .release 0]).launches = [0] := by decide
example : (run draining [.command, .escape true]).active = some 0 := by decide
-- A busy-main Escape passes through: the queued request is still fulfilled on drain.
example : (run draining [.command, .escape false, .release 0]).launches = [1, 0] := by decide
-- Repeated Escape bumps the generation only once.
example : (run draining [.escape true, .escape true]).takeover = 1 := by decide
-- After the drain, a fresh /reflect is admitted under the new generation and launches once.
example : (run draining [.escape true, .release 0, .command]).launches = [1, 0] := by decide
-- No owned active work: Escape is not consumed.
example : consumesEscape { draining with active := none } true = false := by decide
-- An ordinary queued request without intervening takeover is fulfilled on drain.
example : (run draining [.command, .release 0]).launches = [1, 0] := by decide

/-! ## Rejected mutations (each would violate a proved obligation) -/

-- M1: dispatch without the currentness check fulfils a retired request.
def dispatchNoCurrentness (s : State) : State :=
  match s.queue with
  | [] => s
  | p :: rest =>
    if safe s then { s with queue := rest, active := some p.id, launches := p.id :: s.launches } else s
example :
    let s := step draining .command
    let t := step s .userTakeover
    (dispatchNoCurrentness { t with active := none }).launches = [1, 0] ∧
    (step t (.release 0)).launches = [0] := by decide

-- M2: releasing on any drain id (not the exact child) launches while 0 still occupies.
def releaseAny (s : State) : State := maybeDispatch { s with active := none }
example :
    let s := step draining .command
    (releaseAny s).launches = [1, 0] ∧ (step s (.release 9)).launches = [0] := by decide

-- M3: force-releasing a non-settling child admits a second operation while it may run.
example :
    let s := step draining .command
    (releaseAny s).active = some 1 ∧ (run s [.charge, .autoTrigger, .cancelQueue]).active = some 0 := by
  decide

-- M4: reevaluating thresholds on release (automatic relaunch) would launch with an empty queue.
def releaseRelaunch (s : State) : State := autoTrigger { s with active := none }
example : (releaseRelaunch draining).launches = [1, 0] ∧ (step draining (.release 0)).launches = [0] := by
  decide

-- M6: an Escape that force-releases the slot would launch a queued or fresh operation while
-- the revoked child may still run.
def escapeForceRelease (s : State) : State := maybeDispatch { escape s true with active := none }
example :
    let s := step (step draining .command) (.escape true)
    let t := step (escapeForceRelease s) .command
    t.launches = [2, 0] ∧ (step s .command).launches = [0] := by decide

-- M5: bumping the generation after (not before) queue admission on a held /reflect would
-- strand the fresh request as stale; the model admits it under the bumped generation.
example :
    let s := { draining with held := true }
    let t := step s .command
    t.takeover = 1 ∧ t.queue.map (·.admission.takeover) = [1] := by decide

def main : IO Unit := do
  let s := run draining [.parentAborted, .abortSettle, .command, .release 0]
  IO.println s!"during-settlement request fulfilled after drain: launches={s.launches}"
  let r := run draining [.command, .userTakeover, .release 0]
  IO.println s!"retired by takeover: launches={r.launches} queue={r.queue.length}"
  let e := run draining [.release 0]
  IO.println s!"empty-queue release: launches={e.launches} accounting={e.accounting}"
  let n := run draining [.command, .charge, .autoTrigger, .cancelQueue]
  IO.println s!"non-settling child holds slot: active={n.active} launches={n.launches}"
  let x := run draining [.command, .escape true, .release 0]
  IO.println s!"idle escape retires queued request: launches={x.launches} takeover={x.takeover}"

end PrivateReflectionManualIdentity

def main : IO Unit := PrivateReflectionManualIdentity.main

#print axioms PrivateReflectionManualIdentity.launched_at_most_once
#print axioms PrivateReflectionManualIdentity.nonsettling_child_holds_slot
#print axioms PrivateReflectionManualIdentity.release_launches_only_current_queued
#print axioms PrivateReflectionManualIdentity.retired_admission_never_current
#print axioms PrivateReflectionManualIdentity.escape_consumed_at_most_once
