export const PROMPT_KINDS = [
    "mainLoopLimitReached",
    "observedTotalLoopLimitReached",
    "wallClockLimitReached",
];
export const BUILT_IN_PROMPTS = Object.freeze({
    mainLoopLimitReached: `[pi-watchdog: Main agent loop threshold reached]

The main agent has completed {{mainLoops}} loops in the current task, reaching the configured limit of {{mainLoopLimit}}.

Reflect on whether the work has become trapped in a repetitive problem-solving loop. Before continuing, reassess:

- whether the current objective and acceptance criteria remain clear;
- whether the same searches, edits, tests, or failed approaches are being repeated;
- whether the available evidence still supports the current approach;
- whether progress is blocked by missing information, permissions, or a user decision;
- whether the approach should change, the scope should be reduced, or the current findings should be summarized.

This reminder does not require the task to stop. Make a deliberate decision to continue with a revised approach, summarize the current state, ask the user for guidance, reset the counter, or adjust the threshold. Do not mechanically continue the same pattern without reassessment.`,
    observedTotalLoopLimitReached: `[pi-watchdog: Observed task loop threshold reached]

The main agent and all observable subagent sessions have completed {{observedTotalLoops}} loops in the current task, reaching the configured limit of {{observedTotalLoopLimit}}.

The main agent completed {{mainLoops}} loops. Observable subagents completed {{observedChildLoops}} loops across {{observedChildSessions}} child sessions.

Reflect on whether the overall task has become trapped in a repetitive problem-solving loop. Check for duplicated investigation, repeated delegation, multiple agents attempting the same unsuccessful approach, uncontrolled task decomposition, or continued work that is waiting for a missing decision.

This total includes only sessions observable by pi-watchdog. It may exclude isolated sessions, sessions that did not load pi-watchdog, and agents running in another process.

Do not interrupt active subagents solely because this reminder was raised. Review the available results first, then deliberately decide whether to continue waiting, revise the task structure, stop an unproductive branch, ask the user for guidance, reset the counters, or adjust the threshold.`,
    wallClockLimitReached: `[pi-watchdog: Main agent wall-clock threshold reached]

The main agent has been continuously active for {{elapsed}}, reaching the configured wall-clock limit of {{wallClockMinutes}} minutes.

Pause and reassess the current work:

- whether the current approach is still making meaningful progress;
- whether a tool, test, debugging process, or external condition is blocking progress;
- whether the scope is expanding without completing the original objective;
- whether the confirmed findings, unresolved questions, and next steps should be summarized;
- whether progress or a required decision should be reported to the user.

This timer measures only the main agent's continuous active time. It excludes time spent waiting after the main agent has settled, and it never sends wall-clock reminders to subagents.`,
});
export function renderTemplate(template, variables) {
    return template.replace(/{{([A-Za-z][A-Za-z0-9_]*)}}/g, (placeholder, name) => Object.hasOwn(variables, name) ? String(variables[name]) : placeholder);
}
