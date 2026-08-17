/**
 * guard-turn-budget — a PreToolUse guard may INSIST, but it may not IMPRISON.
 *
 * WHY THIS EXISTS (2026-08-17, Russell: "refactor getty ceremony guard, too many mistakes").
 *
 * `getty-ceremony-guard` has taken FIVE separate deadlock repairs, each one patching a different
 * detector after that detector locked a live session with no legal move left. Read together they
 * are not five bugs, they are one missing rule: every detector could decide to DENY, and not one
 * of them ever asked whether anything was still ALLOWED. Patch six was never going to be the last.
 *
 * Stop already has this rule. `lib/stop-deadlock-breaker.mjs` gives each Stop hook one attempt at
 * a fixable redirect, then yields — the 2026-08-02 "may insist, may not imprison" fix. PreToolUse
 * never got the equivalent, and PreToolUse is where it matters MORE: a blocked Stop costs one
 * regenerated reply and the turn still ends, while a blocked PreToolUse costs the ACTION and can
 * repeat forever.
 *
 * WHY THE ARBITER'S BREAKER DOES NOT COVER THIS. `pretooluse-arbiter` already breaks a loop after
 * 2 refusals of the SAME call, keyed on the tool arguments. That catches a model retrying one call
 * into a wall. It is structurally blind to the failure that actually happens: OSCILLATION, where
 * every call is different and a different guard (or a different detector in one guard) refuses
 * each one. Guard A demands a commit, guard B refuses the commit, the model tries a third thing,
 * detector C calls that a sidequest. No call repeats, so no per-call budget ever trips, and the
 * turn dies. The missing budget is per-TURN and cross-call.
 *
 * THE RULE. Count the denials this guard has already issued in the current turn. Past the budget,
 * the guard reports its objection as ADVICE and lets the call proceed. Enforcement degrades; the
 * session does not stop. This terminates by construction no matter which detector is wrong, which
 * is exactly the property the five previous patches each failed to give.
 *
 * A REFUSAL IS NOT AN ATTEMPT — and that cuts both ways (2026-08-16, learnings.md line 61). That
 * lesson stopped counters from treating a refused call as a failed attempt by the model. The same
 * fact is what makes THIS budget honest: a denial is something the GUARD did, so counting it is
 * counting our own output, never the model's behavior. Work the model actually completed resets
 * the budget, because a call that ran proves the session is not wedged.
 */

/** How many refusals carrying one of this guard's own deny-reason prefixes ran during this turn. */
export function denialsThisTurn(completedTools = [], signatures = []) {
  if (!Array.isArray(completedTools) || !signatures.length) return 0;
  let denials = 0;
  for (const record of completedTools) {
    const resultText = String(record?.resultText || '');
    if (!resultText) continue;
    if (signatures.some((signature) => resultText.includes(signature))) denials += 1;
  }
  return denials;
}

/**
 * True when work genuinely ran after the most recent denial by this guard — proof the session is
 * not wedged, so the budget is spent fairly and starts over. "Ran" means a tool call that was not
 * an error and was not one of our own refusals; a call that errored proves nothing about whether a
 * legal move exists.
 */
export function progressedSinceLastDenial(completedTools = [], signatures = []) {
  if (!Array.isArray(completedTools)) return false;
  let lastDenialIndex = -1;
  for (let index = completedTools.length - 1; index >= 0; index--) {
    const resultText = String(completedTools[index]?.resultText || '');
    if (signatures.some((signature) => resultText.includes(signature))) { lastDenialIndex = index; break; }
  }
  if (lastDenialIndex === -1) return false;
  return completedTools
    .slice(lastDenialIndex + 1)
    .some((record) => !record?.isError);
}

/**
 * The one question every PreToolUse denial must pass through.
 *
 * Returns { yield: true, spent } when this guard has already denied `budget` times in this turn
 * with no completed work since — at which point the honest read is that the guard is contradicting
 * something rather than teaching, and it must step aside.
 */
export function shouldYieldInsteadOfDenying({ completedTools = [], signatures = [], budget = 3 } = {}) {
  const spent = denialsThisTurn(completedTools, signatures);
  if (spent < budget) return { yield: false, spent };
  if (progressedSinceLastDenial(completedTools, signatures)) return { yield: false, spent };
  return { yield: true, spent };
}
