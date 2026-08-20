# Successful loop counting

- [x] Confirm product rule: count only model-success `stop` and `toolUse` turns.
- [x] Add focused runtime regression proving `error`, `aborted`, and `length` do not count while `stop` and `toolUse` do.
- [x] Filter root and observer loop accounting at the `turn_end` public seam.
- [x] Add global Symbol pause/resume API and `/reflect-watchdog pause|resume` without an AI tool.
- [x] Pause every time/loop path and re-probe live aggregate state on resume.
- [x] Synchronize and validate `docs/programming-thinking/pi-reflect-watchdog-lifecycle.idea.lean`.
- [x] Integrate optional API calls around pi-continue-watchdog decision inquiries.
- [x] Run full checks and relevant E2E.
- [x] Complete independent review.

Out of scope: tool-result success/failure classification; Pi core changes.
