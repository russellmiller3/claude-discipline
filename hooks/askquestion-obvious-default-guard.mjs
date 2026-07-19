#!/usr/bin/env node
// =============================================================================
// ASKQUESTION-OBVIOUS-DEFAULT-GUARD — PreToolUse(AskUserQuestion): don't ask a
//   question whose Recommended option is a free, reversible, just-do-it default.
// =============================================================================
//
// new-hook-category: Ross Perot / decision discipline — nearest existing is options-need-recommendation (same tool boundary) but that hook REQUIRES a recommendation; it never blocks a question that shouldn't be asked at all. This is the complementary teeth.
//
// Russell's rule (verbatim, 2026-07-16): "the ross perot rule is designed to
// prevent bullshit questions like this so that hook isnt working... Do what
// makes sense. right now. then afterwards fix the hook so you dont waste my
// time." The Ross Perot Stop hook exempts the AskUserQuestion TOOL, so a
// bullshit question whose answer was obvious (option 1 marked "(Recommended)":
// "Build free harness", "Leave parked") sailed straight through.
//
// RULE: BLOCK an AskUserQuestion when a question has an option that is BOTH
//   (1) marked "(Recommended)" — the model already knows the answer — AND
//   (2) a proceed/no-op verb ("build", "proceed", "keep going", "leave parked",
//       "leave as-is", "continue", "go ahead", "do it", "ship it", "no-op"),
// AND the whole question is FREE + REVERSIBLE (no $/spend/cost/paid/budget, no
// destructive/irreversible/external-send action). That's the do-what-makes-sense
// next step — DO IT, don't ask.
//
// PRESERVED (never blocks): a paid/cost-gated decision (>$5 needs a go), a
// destructive/irreversible action, a genuine design fork with no Recommended
// proceed-option, and a Recommended PREFERENCE question with no proceed-verb
// (e.g. "which palette? Recommended: teal" — a real taste call, not a no-op).
//
// Teeth: permissionDecision 'deny'. Override: ASKQUESTION_OBVIOUS_OK=1 in env,
// or the literal token ASKQUESTION_OBVIOUS_OK in a question/option. Fail-open.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECOMMENDED_RE = /\(recommended\)/i;
const PROCEED_VERB_RE = /\b(build|proceed|keep\s+going|do\s+it|continue|go\s+ahead|leave\s+(?:as[- ]?is|parked|it)|no[- ]?op|noop|ship\s+it|just\s+do)\b/i;
// A paid/cost signal means the decision legitimately needs Russell's go (cost-autonomy > $5).
const PAID_RE = /\$|\bpaid\b|\bspend(?:ing|s)?\b|\bcosts?\b|\bdollars?\b|\bbudget\b|\bpricing\b|\bper\s+(?:run|call|token)\b/i;
// A destructive/irreversible/external-send action is never a "just do it" — always a real question.
const DESTRUCTIVE_RE = /\b(delete|deletes|deleting|force[- ]?push|drop|drops|overwrite|overwrites|destroy|destroys|wipe|wipes|truncat\w*|reset\s+--hard|rm\s+-rf|send|sends|publish|publishes|deploy|deploys|migrat\w*|irreversible|permanent(?:ly)?)\b/i;
const OVERRIDE_RE = /\bASKQUESTION_OBVIOUS_OK\b/;

const optionText = (option) => `${option?.label || ''} ${option?.description || ''}`;

// Pure core: returns { question, option } to block on, or null to allow.
export function evaluateObviousDefault(toolInput) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  for (const question of questions) {
    const options = Array.isArray(question?.options) ? question.options : [];
    if (options.length < 1) continue;
    const stem = question?.question || '';
    if (OVERRIDE_RE.test(`${stem} ${options.map(optionText).join(' ')}`)) continue; // explicitly waved through
    const recommended = options.find((option) => RECOMMENDED_RE.test(optionText(option)));
    if (!recommended) continue;
    // Gate paid/destructive on the RECOMMENDED action itself (stem + that option) — NOT on a rejected
    // alternative that merely mentions cost ("Wait for a paid decision"); the recommended action is what
    // you'd actually do, so its cost/reversibility is what decides whether the question is genuine.
    const recommendedContext = `${stem} ${optionText(recommended)}`;
    if (PAID_RE.test(recommendedContext) || DESTRUCTIVE_RE.test(recommendedContext)) continue;
    if (PROCEED_VERB_RE.test(optionText(recommended))) {
      return {
        question: stem || '(unnamed)',
        option: (recommended.label || '').replace(/\s*\(recommended\)\s*/i, '').trim(),
      };
    }
  }
  return null;
}

function main() {
  if (process.env.ASKQUESTION_OBVIOUS_OK === '1') process.exit(0);
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') process.exit(0);
  if ((event.tool_name || '') !== 'AskUserQuestion') process.exit(0);

  let hit;
  try { hit = evaluateObviousDefault(event.tool_input || {}); } catch { process.exit(0); } // fail-open
  if (!hit) process.exit(0);

  const reason = `Ross Perot: you marked "${hit.option}" (Recommended) and it's a free, reversible, obvious next step — DO IT, don't ask.

Question: "${hit.question}"

Russell's rule (2026-07-16, verbatim): "the ross perot rule is designed to prevent bullshit questions like this... Do what makes sense. right now." A recommended option that is free + reversible + a proceed/no-op is the do-what-makes-sense answer — execute it and narrate what you did; Russell can veto after the fact.

This guard does NOT block: a paid/cost-gated decision (>$5 needs a go), a destructive/irreversible/external-send action, or a genuine design fork. If this is genuinely one of those (or a real taste call you need input on), put ASKQUESTION_OBVIOUS_OK in the question/option text or set ASKQUESTION_OBVIOUS_OK=1.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// Entry-point guard by BASENAME (the Windows import.meta gotcha) so tests can import the pure core.
if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
