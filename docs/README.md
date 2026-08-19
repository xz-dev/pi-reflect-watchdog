# Project documents

This directory collects the durable design, acceptance, and formal-reasoning documents for `pi-reflect-watchdog`.

## Planning

- [`v1-acceptance.md`](planning/v1-acceptance.md): v1 acceptance contract, including the active/task/root/all counter semantics and reflection outcomes.
- [`user-controls-red-waiver.md`](planning/user-controls-red-waiver.md): historical waiver note for the user-controls repair slice.

## Formal model

- [`pi-reflect-watchdog-lifecycle.idea.lean`](programming-thinking/pi-reflect-watchdog-lifecycle.idea.lean): executable Lean 4 authority for the Reflect Watchdog lifecycle, exact counter contract, repaired transition system, and top-level safety theorem. Run it with:

  ```bash
  lean docs/programming-thinking/pi-reflect-watchdog-lifecycle.idea.lean
  ```
