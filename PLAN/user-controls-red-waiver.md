# User-controls repair RED waiver note

The original user-controls feature slice missed executable pre-implementation RED evidence. The tests added during this review are retrospective defect-repair tests, not original feature-slice RED.

Raw failing evidence for the defective candidate is saved at `/tmp/pi-reflect-watchdog-controls-repair-red.txt`. It demonstrates the review findings before the repair: Pi command wrappers around the same session were rejected, and slash-limit crossings sent a model message.

The repository owner explicitly granted the waiver on 2026-07-29 after independent code approval, 82 passing tests, retrospective defect-repair RED, and a successful real Pi RPC smoke test. The owner accepted the missing historical feature RED without treating the retrospective evidence as a substitute for it.
