#!/usr/bin/env node
// =============================================================================
// EXPERIMENT-KHAN-EXPLAINER-REQUIRED — explain it to Russell BEFORE you run it
// =============================================================================
//
// new-hook-category: Experiment design review — siblings gate DURABILITY
// (experiment-monitor-required), STATISTICS (experiment-statistical-rigor-guard)
// and CONTROLS (experiment-ablation-required). None of them gate whether the
// design was ever EXPLAINED to, and APPROVED by, the person paying for it.
//
// WHY (Russell, 2026-07-22, verbatim: "I think once again you set up the
// experiment wrong ... to fix, i need to review before launch. make a hook that
// you have to explain experiments at khan level ... before you run them"):
// the variable-tracking run produced a technically clean result that could not
// support the claim it was built for — the harness held the loop and the memory,
// so each forward pass saw a constant-size input and the flat curve was true by
// construction. Every OTHER gate passed: tests green, controls present, seeds
// sufficient, monitor attached. The flaw was CONCEPTUAL, and the only thing that
// catches a conceptual flaw is a human who understands the design reading it
// before the money is spent. "Once again" — this is a repeat.
//
// The reference standard is `plans/167-spawn-judgment-design-and-metacognition-
// findings.md`: ONE sustained concrete metaphor carried through every mechanism,
// a worked example, and an explicit statement of what would falsify the claim.
//
// HOW IT WORKS: PreToolUse on Bash/PowerShell. When the command LAUNCHES an
// experiment (runpod launcher `launch`, modal run, or a local scripts/exp*.py
// worker run — smokes and dry-runs exempt), require BOTH:
//   1. a Khan-level explainer for THIS experiment written this session — a
//      plan/*.md or docs/explainers/*.html naming the experiment whose content
//      carries a metaphor, a worked example, AND a falsification statement;
//   2. an explicit approval from RUSSELL in a user message.
// Approval must come from Russell's own words — the assistant cannot self-certify.
//
// TEETH: PreToolUse permissionDecision 'deny'. Escape: EXPERIMENT_KHAN_OK=1 in
// env, or the token EXPERIMENT_KHAN_OK in the reply (for a re-run of an
// already-reviewed design — a new seed of an unchanged experiment). FAILS OPEN.
// basename entry-guard.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, toolUsesOf, lastAssistantText } from './lib/transcript.mjs';

const ENV_OVERRIDE = 'EXPERIMENT_KHAN_OK';
const ESCAPE_TOKEN = /\bEXPERIMENT_KHAN_OK\b/;

// Launch shapes, mirroring experiment-monitor-required so the two agree.
const RUNPOD_LAUNCH = /runpod_\w*\.py\b[\s\S]*\blaunch\b/;
const MODAL_RUN = /\bmodal\s+run\b/;
const LOCAL_EXPERIMENT = /\b(?:python[0-9.]*|py)\b\s+(?:-3\s+)?\S*scripts[\/\\]exp\w+\.py\b/;
// Never gated: help, dry runs, smokes, listings, finalize/teardown, and the
// support scripts (refreshers/feeders) that serve an already-running experiment.
const NOT_A_LAUNCH = /\bfinalize\b|--help\b|(?:^|\s)-h(?:\s|$)|--dry-run\b|--smoke\b|--check\b|--list\b/;
const PYTEST_RE = /\bpytest\b|(?:^|[\/\\])test_\w+\.py\b/;
const SUPPORT_SCRIPT_RE = /_(?:live_)?refresher\.py\b|_(?:live_)?feeder\.py\b|_monitor\.py\b|_watch(?:er)?\.py\b/i;

/** True when this command actually STARTS an experiment that costs something. */
export function isExperimentLaunch(command) {
  if (!command || typeof command !== 'string') return false;
  if (NOT_A_LAUNCH.test(command)) return false;
  if (PYTEST_RE.test(command)) return false;
  if (SUPPORT_SCRIPT_RE.test(command)) return false;
  return RUNPOD_LAUNCH.test(command) || MODAL_RUN.test(command) || LOCAL_EXPERIMENT.test(command);
}

/** The experiment slug a launch command refers to (exp170, exp147e, …). */
export function launchSlug(command) {
  // Capture ONLY the number + optional letter. A greedy \w+ swallowed the rest of
  // the filename ("exp170_depth_repair"), so the slug never matched the prose and
  // the recency/naming check silently passed on everything.
  const match = /\bexp(\d{2,4}[a-z]?)/i.exec(String(command || '').replace(/runpod_/i, ''));
  return match ? `exp${match[1]}`.toLowerCase() : null;
}

// The three marks of a Khan-level explanation, per the 167 reference doc.
const METAPHOR_RE = /\b(?:metaphor|analog(?:y|ous)|like a|think of it as|imagine|the kitchen|repeater)\b/i;
const WORKED_EXAMPLE_RE = /\b(?:worked example|for example|e\.g\.|concretely|walk through|step by step|say the)\b/i;
const FALSIFICATION_RE = /\b(?:falsif\w+|what would (?:disprove|falsify)|fails? if|pass bar|does NOT prove|honest negative|would refute)\b/i;

function flattenToolUses(entries) {
  const toolUses = [];
  for (const entry of entries || []) {
    for (const block of toolUsesOf(entry)) {
      toolUses.push({
        name: block?.name || '',
        command: block?.input?.command || '',
        filePath: block?.input?.file_path || '',
        content: block?.input?.content || block?.input?.new_string || '',
      });
    }
  }
  return toolUses;
}

// The TEST and its ABLATION must BOTH be named (Russell, 2026-07-22: "this
// experiment was set up totally wrong, didn't test depth repair at all. This
// should have been the Test: Digital in-layer repeater. Ablation: No repeater.").
// An explanation that describes a mechanism but never says what is COMPARED
// AGAINST WHAT is how a design ships measuring nothing.
const TEST_ARM_RE = /\btest\b\s*[:\-–—]|\btest arm\b|\btreatment\b|\bwe (?:test|measure)\b|\bthe claim\b/i;
const ABLATION_ARM_RE = /\b(?:ablation|control(?: arm)?|without the|no[- ](?:repeater|refresh|restore|fetch|tool|repair)|compared (?:to|against)|versus|vs\.?)\b/i;
// What the task actually STRESSES — a design that never says what is hard is a
// design that can come out at chance and look like a null result.
const TASK_DIFFICULTY_RE = /\b(?:remember|recall|carry|hold|track|over many|across \d+|complex state|compound|accumulat|degrad|decay)\w*/i;

/**
 * Was THIS experiment's design explained in chat, RECENTLY? (Russell,
 * 2026-07-22: "no full explainer html required. just a few lines in chat.")
 *
 * THE BUG THIS FIXES (same day, caught by Russell): the first version scanned
 * EVERY assistant message in the session, so an explanation written for one
 * experiment silently satisfied the gate for a DIFFERENT, later launch. A
 * depth-repair run then shipped with hand-added noise, an oracle-computed
 * answer, and a "restore" that re-encoded from scratch — it tested nothing, and
 * every arm came out at chance (0.124 vs a 0.125 floor). The gate had passed.
 *
 * Now the explanation must (a) sit in one of the LAST `recentWindow` assistant
 * messages, (b) NAME this experiment, and (c) contain all five marks: metaphor,
 * worked example, falsification, the TEST arm, and the ABLATION it is compared
 * against. Naming the ablation is the one that would have caught the bad run.
 */
export function explainedInChat(entries, slug, recentWindow = 6) {
  const assistantMessages = [];
  for (const entry of entries || []) {
    const role = entry?.role || entry?.message?.role;
    if (role !== 'assistant') continue;
    const content = entry?.content ?? entry?.message?.content ?? [];
    let messageProse = '';
    if (typeof content === 'string') messageProse = content;
    else {
      for (const block of content || []) {
        if (typeof block === 'string') messageProse += ' ' + block;
        else if (block?.type === 'text' && block?.text) messageProse += ' ' + block.text;
      }
    }
    if (messageProse.trim()) assistantMessages.push(messageProse);
  }
  // Only the most recent messages count — a stale explanation of something else
  // must not license this launch.
  const recentProse = assistantMessages.slice(-recentWindow).join(' \n ');
  if (slug) {
    const slugPattern = new RegExp(slug.replace(/^exp/, '(?:exp)?'), 'i');
    if (!slugPattern.test(recentProse)) return false;
  }
  return METAPHOR_RE.test(recentProse)
    && WORKED_EXAMPLE_RE.test(recentProse)
    && FALSIFICATION_RE.test(recentProse)
    && TEST_ARM_RE.test(recentProse)
    && ABLATION_ARM_RE.test(recentProse)
    && TASK_DIFFICULTY_RE.test(recentProse);
}

/**
 * Was a Khan-level explainer for THIS experiment written this session?
 * Content-checked, not filename-checked: a stub named right proves nothing.
 */
export function hasKhanExplainer(entries, slug) {
  const toolUses = Array.isArray(entries) && entries[0]?.name !== undefined
    ? entries : flattenToolUses(entries);
  const slugPattern = slug ? new RegExp(slug.replace(/^exp/, '(?:exp)?'), 'i') : null;
  return toolUses.some((toolUse) => {
    if (!['Write', 'Edit', 'MultiEdit'].includes(toolUse.name)) return false;
    const filePath = toolUse.filePath || '';
    const isExplainerFile = /plans[\/\\].*\.md$|explainers?[\/\\].*\.html?$|.*-explainer\.html?$/i.test(filePath);
    if (!isExplainerFile) return false;
    const explainerBody = toolUse.content || '';
    if (slugPattern && !slugPattern.test(filePath) && !slugPattern.test(explainerBody)) return false;
    return METAPHOR_RE.test(explainerBody)
      && WORKED_EXAMPLE_RE.test(explainerBody)
      && FALSIFICATION_RE.test(explainerBody);
  });
}

// Russell's own words approving the design. Deliberately narrow: a question,
// a correction, or a neutral remark is NOT approval (meta-rule: broad on the
// catching side, NARROW on the release side).
const APPROVAL_RE = /\b(?:go ahead|(?:launch|run|ship) (?:it|all|them|these|those|the \w+)|looks? (?:right|good|correct)|approved?|lgtm|makes sense[,.]? (?:go|run|launch)|yes,? (?:launch|run|go))\b/i;

/** Did RUSSELL (a user message) explicitly approve the design this session? */
export function russellApprovedThisSession(entries) {
  for (const entry of entries || []) {
    const role = entry?.role || entry?.message?.role;
    if (role !== 'user') continue;
    const content = entry?.content ?? entry?.message?.content ?? [];
    const userMessage = typeof content === 'string' ? content
      : (content || []).map((block) => (typeof block === 'string' ? block : block?.text || '')).join(' ');
    if (APPROVAL_RE.test(userMessage)) return true;
  }
  return false;
}

const reasonFor = (slug, hasExplainer) => `EXPERIMENT NOT REVIEWED — explain it at Khan level before spending.

Experiment: ${slug || '(unnamed)'}
Missing: ${hasExplainer ? "Russell's explicit approval of the design" : "a Khan-level explainer, AND Russell's approval"}

Russell's rule (2026-07-22, verbatim): "i think once again you set up the experiment wrong ... to
fix, i need to review before launch. make a hook that you have to explain experiments at khan
level ... before you run them."

WHY THIS EXISTS: the variable-tracking run produced a technically clean result that could not
support the claim it was built for — the harness held the loop and the memory, so every forward
pass saw a constant-size input and the flat curve was true BY CONSTRUCTION. Tests were green,
controls present, seeds sufficient, monitor attached. Every mechanical gate passed. The flaw was
CONCEPTUAL, and only a human reading the design catches that.

A FEW LINES IN CHAT IS ENOUGH (Russell, 2026-07-22: "no full explainer html required. just a few
lines in chat"). The bar is the CONTENT, not the medium — a written doc is optional. Say ALL of
this, in the CURRENT message, naming THIS experiment:

  1. TEST: what is the treatment arm, in one line?          e.g. "Digital in-layer repeater"
  2. ABLATION: what is it compared against?                  e.g. "No repeater"
  3. THE TASK and WHY IT IS HARD — what must be remembered/tracked, over what depth or length?
     e.g. "remember very complex state across 64 layers"
  4. ONE concrete metaphor for the mechanism — what is this LIKE?
  5. A concrete EXAMPLE with real numbers: one step, start to finish.
  6. What would FALSIFY it — the outcome that kills the claim, AND the outcome that means the TASK
     is broken rather than the model.

WHY ITEMS 1-3 EXIST (Russell, 2026-07-22, after a run that measured nothing): a depth-repair
experiment shipped with hand-added noise, an oracle-computed answer, and a "restore" that
re-encoded from scratch. Every arm came out at CHANCE — 0.124 against a 0.125 floor — so the
treatment, the control, and the soft control were indistinguishable. It tested nothing. An
explanation that names the mechanism but never says WHAT IS COMPARED AGAINST WHAT, or what the
task actually strains, cannot catch that before the run.

Then WAIT for Russell's explicit go. His words, not your summary of them.

Escape (a re-run of an ALREADY-reviewed, unchanged design — e.g. one more seed): put
${ENV_OVERRIDE} in your reply, or set ${ENV_OVERRIDE}=1.`;

/** PURE core. Returns { block, mode?, reason? }. Never throws. */
export function evaluate({ command = '', entries = [], replyText = '', envOk = false } = {}) {
  if (envOk) return { block: false };
  if (ESCAPE_TOKEN.test(command || '') || ESCAPE_TOKEN.test(replyText || '')) return { block: false };
  if (!isExperimentLaunch(command)) return { block: false };

  const slug = launchSlug(command);
  const toolUses = flattenToolUses(entries);
  // A few plain sentences in CHAT satisfy this, or a written explainer — the bar
  // is the content, not the medium (Russell, 2026-07-22).
  const explainerExists = explainedInChat(entries, slug) || hasKhanExplainer(toolUses, slug);
  const approved = russellApprovedThisSession(entries);
  if (explainerExists && approved) return { block: false };
  return { block: true, mode: 'deny', reason: reasonFor(slug, explainerExists) };
}

function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') process.exit(0);
    const payload = readPayload();
    const event = payload.hook_event_name || payload.hookEventName || '';
    if (event !== 'PreToolUse') process.exit(0);
    const entries = readTranscript(payload.transcript_path || payload.transcriptPath || '');
    const verdict = evaluate({
      command: (payload.tool_input || {}).command || '',
      entries,
      replyText: lastAssistantText(entries),
    });
    if (!verdict.block) process.exit(0);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.reason,
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0); // fail open — never brick a legitimate command
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
