# Reflection retry visibility

## Goal

Make the existing three-attempt reflection XML correction cycle visible without exposing internal inquiry content to the ordinary task context.

## Accepted behavior

- Invalid attempt 1/3 shows a warning with the parser error and says it is retrying.
- Invalid attempt 2/3 shows the same shape of warning and retries.
- Invalid attempt 3/3 shows the terminal failure warning and does not retry.
- All attempts keep one inquiry, one shared tool budget, and one terminal fold.
- Retry notices use `ctx.ui.notify()` only; they create no session result/status entry and no model-visible message.

## Verification

1. Focused runtime test proves the current implementation lacks the first two warnings.
2. Unit assertions lock the three warning messages plus existing inquiry/fold/no-entry invariants.
3. Packed stock-Pi E2E observes the three RPC UI notifications and exactly three provider requests.
4. `npm run check` and `npm run test:e2e:fast` pass.
