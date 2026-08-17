export const DEFAULT_REFLECTION_PROMPT = `Pause the current work rhythm and critically review the steps taken so far.

Determine whether the work is still following the user's actual objective and agreed plan. Check for repeated investigation, repeated attempts to repair the same failure without learning from prior results, duplicated work across agents, scope drift, or deviation from the final objective that was not reported to the user in advance.

Use the existing conversation and, when necessary, bounded tool verification to separate real progress from repetition. Report what has actually been completed, the current step, and the correct next step. If the route needs correction, state the correction clearly rather than justifying the existing approach.`;
