#!/usr/bin/env node
// =============================================================================
// ASKQUESTION-OBVIOUS-DEFAULT-GUARD — PreToolUse(AskUserQuestion): questions
//   are forbidden unless they guard destructive data loss or an explicit >$5 estimate.
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
// RULE (Russell, 2026-07-26): BLOCK every AskUserQuestion unless its chosen
// action concretely deletes/overwrites data, or its explicit dollar estimate is
// above the standing $5 autonomy budget. Design, taste, browser, deploy, send,
// login, and missing-information questions are not exceptions: choose and act.
// There is no model-authored override token. Teeth: permissionDecision 'deny'.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECOMMENDED_RE = /\(recommended\)/i;
const DESTRUCTIVE_RE = /\b(delete|deletes|deleting|erase|erases|erasing|force[- ]?push|drop|drops|dropping|overwrite|overwrites|overwriting|destroy|destroys|destroying|wipe|wipes|wiping|purge|purges|purging|truncat\w*|reset\s+--hard|rm\s+-rf|format\s+(?:the\s+)?(?:disk|drive)|irreversible\s+data\s+loss|permanent(?:ly)?\s+(?:delete|erase|destroy|overwrite))\b/i;
const DOLLAR_ESTIMATE_RE = /\$\s*(\d+(?:\.\d{1,2})?)/g;

const optionText = (option) => `${option?.label || ''} ${option?.description || ''}`;

function estimateExceedsBudget(text) {
  return [...String(text || '').matchAll(DOLLAR_ESTIMATE_RE)]
    .some((match) => Number(match[1]) > 5);
}

// Pure core: returns the first forbidden question, or null when every question guards an allowed gate.
export function evaluateObviousDefault(toolInput) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  for (const question of questions) {
    const options = Array.isArray(question?.options) ? question.options : [];
    const stem = typeof question?.question === 'string' ? question.question.trim() : '';
    if (!stem) continue;
    const recommended = options.find((option) => RECOMMENDED_RE.test(optionText(option)));
    const actionContext = `${stem} ${recommended ? optionText(recommended) : ''}`;
    if (DESTRUCTIVE_RE.test(actionContext) || estimateExceedsBudget(actionContext)) continue;
    return { question: stem };
  }
  return null;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') process.exit(0);
  if ((event.tool_name || '') !== 'AskUserQuestion') process.exit(0);

  let hit;
  try { hit = evaluateObviousDefault(event.tool_input || {}); } catch { process.exit(0); } // fail-open
  if (!hit) process.exit(0);

  const reason = `Ross Perot: this question is not guarding destructive data loss or an explicit estimate above $5 — DO IT, don't ask.

Question: "${hit.question}"

Russell's rule (2026-07-26): never ask a question unless the action can destroy/irreversibly overwrite data, or a stated paid estimate exceeds the standing $5 budget restriction. Otherwise choose the best path and act now.

Browser access, login, deploys, external sends, design forks, preferences, missing information, and vague cost language are not exceptions. State a hard blocker declaratively and keep exhausting safe paths. There is no self-override.`;

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
