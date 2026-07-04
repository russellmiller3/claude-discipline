#!/usr/bin/env node
/**
 * getty-no-repeat-mistakes — the J. Paul Getty guard: "You can make any mistake you want. Just never
 * make the same one twice." The reward-model half of Russell's DIY-RLVR loop.
 *
 * When Russell CORRECTS me, force the learn-or-build-a-hook cycle before the turn can end:
 *   • UserPromptSubmit — detect a correction in his message. Drop a pending-marker (recording whether
 *     it's a REPEAT) and inject the Getty checklist: grep learnings.md → already there? → build a hook.
 *   • Stop — if a marker is pending and this turn didn't satisfy it, BLOCK.
 *       first-time correction  → satisfied by adding a learning (learnings.md) OR a hook.
 *       REPEAT correction      → a learning already FAILED once → only a NEW/STRENGTHENED hook clears it.
 *
 * The model does the semantic judgment (grep learnings, decide repeat); the hook forces the artifact.
 * Detection is high-PRECISION on Russell's own correction wording — the verifiable reward signal — not
 * a flaky attempt to self-detect every mistake.
 *
 * Fail-open on any error. Override: "getty-override: <reason>" in the reply.
 * Marker path overridable via GETTY_MARKER_PATH (tests point it at a temp file).
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const MARKER_PATH = process.env.GETTY_MARKER_PATH || join(homedir(), '.claude', 'state', 'getty-pending.json');

// REPEAT signals — Russell's wording that says "you've done this before" → escalate to "build a hook".
// Robust: built as a set of phrasings, apostrophes straight (') or curly (’), case-insensitive.
const REPEAT_PATTERNS = [
  /\bagain\b/i,
  /\bsame (mistake|thing|error|issue|problem|bug)\b/i,
  /\byou keep (doing|making|forgetting|repeating)\b/i,
  /\bevery (single )?time\b/i,
  /\bhow many times\b/i,
  /\b(i )?(already )?told you (this|that|before|already|not to)\b/i,
  /\b(the )?second time\b/i,
  /\btwice\b/i,
  /\blike last time\b/i,
  /\bas i (said|mentioned) (before|earlier)\b/i,
  /\bstill (doing|happening|broken|wrong)\b/i,
  /\bstop (doing|making) (that|this)\b/i,
];

// General CORRECTION signals — "you got it wrong this turn" → at least log a learning.
const CORRECTION_PATTERNS = [
  /\byou should(?:['’]?ve| have)\b/i,
  /\byou shouldn['’]?t have\b/i,
  /\bwhy did(?:n['’]?t)? you\b/i,
  /\byou forgot\b/i,
  /\byou missed\b/i,
  /\byou were supposed to\b/i,
  /\bi asked you (to|not to)\b/i,
  /\bthat['’]?s not what i (asked|wanted|meant)\b/i,
  /\bthat['’]?s (wrong|not right|incorrect)\b/i,
  /\bdon['’]?t do that\b/i,
  /\byou (messed|screwed|fucked) (it |that )?up\b/i,
  /\byou broke\b/i,
  /\byou (ignored|skipped)\b/i,
  /\byou did(?:n['’]?t) (run|test|check|read|update|follow)\b/i,
];

// System-INJECTED content that lands in the user slot but is NOT Russell speaking: background-agent
// completion notices, harness reminders, hook output. The reward signal is Russell's OWN correction
// wording — never a notification. Detecting "you skipped"/"again" inside an agent's design doc or a
// task result is a false positive that wrongly armed the Getty gate (twice, 2026-06-19). Skip these.
// 2026-07-01: a THIRD vector in the same family — the harness re-presents a prior "Stop hook feedback"
// / "Stop hook blocking error" denial (this hook's OWN output, quoting "never make the same one TWICE")
// back as the next turn's prompt. That re-armed the marker on its own text, an infinite self-trigger.
const SYSTEM_INJECTED = /<task-notification\b|<\/task-notification>|<system-reminder\b|<task-id>|<tool-use-id>|came to rest|^\s*stop hook (feedback|blocking error)|stop-blocked\s*—/i;

const OVERRIDE = /getty-override:/i;
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const HOOK_FILE = /[\\/]hooks[\\/][^\\/]*\.mjs$/i; // any .mjs under a hooks dir (a new or strengthened hook)
const LEARNINGS_FILE = /learnings\.md$/i;

const isRepeat = (message) => REPEAT_PATTERNS.some((pattern) => pattern.test(message));
const isCorrection = (message) => isRepeat(message) || CORRECTION_PATTERNS.some((pattern) => pattern.test(message));

import { readTranscript, lastAssistantTextOf } from './lib/transcript.mjs';

// SATISFACTION WINDOW (2026-07-03, Russell: the Getty guard re-demanded "Should I build a hook for
// this?" AFTER it was asked via AskUserQuestion, Russell answered yes, and the build was dispatched):
// the marker can be armed in one turn and satisfied several turns later (asking, waiting for the
// answer, and dispatching a background Agent are each their own turn) — a check scoped to ONLY the
// current turn's edits misses all of that and keeps blocking. Scope to every entry SINCE the marker
// was armed (its `armedAtEntryIndex`, recorded when the marker file is written), not just the last
// user message. This mirrors the "widen the trigger to the session, keep satisfaction reading current
// state" pattern from `discipline-sync.mjs` (learnings.md, 2026-06-28).
function entriesSinceMarkerArmed(transcriptPath, armedAtEntryIndex) {
  const entries = readTranscript(transcriptPath);
  const startIndex = Number.isInteger(armedAtEntryIndex) ? Math.max(0, armedAtEntryIndex) : 0;
  return entries.slice(startIndex);
}

// File paths edited by mutating tools across the given entries.
function editedPathsIn(entries) {
  const editedPaths = [];
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    const blocks = entry.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === 'tool_use' && MUTATING_TOOLS.has(block.name)) {
        const filePath = block.input?.file_path || block.input?.path || '';
        if (filePath) editedPaths.push(String(filePath));
      }
    }
  }
  return editedPaths;
}

// A background Agent dispatch naming a hooks/*.mjs file counts as "building/strengthening a hook" —
// the fix is delegated, not skipped, matching `fix-false-positive-hooks.mjs`'s own dispatch model.
// Only `run_in_background: true` qualifies; a foreground Agent call blocks the main thread exactly
// like doing the edit inline, defeating the point of delegating.
function hookDispatchedIn(entries) {
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    const blocks = entry.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== 'tool_use' || block.name !== 'Agent') continue;
      const input = block.input || {};
      if (input.run_in_background !== true) continue;
      if (/[a-z0-9][a-z0-9-]*\.mjs\b/i.test(String(input.prompt || ''))) return true;
    }
  }
  return false;
}

// The "ASK Russell explicitly: Should I build a hook for this?" step is satisfied either by that
// exact sentence in assistant prose, OR by a structured AskUserQuestion tool call whose question
// text asks about building/strengthening a hook — the live 2026-07-03 case used AskUserQuestion, not
// plain text, and the hook had no path to recognize that at all before this fix.
const HOOK_QUESTION_WORDING = /build(?:ing)?\s+(?:a\s+|the\s+)?hook|strengthen(?:ing)?\s+(?:a\s+|the\s+)?hook/i;
function hookQuestionAskedIn(entries) {
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    const blocks = entry.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === 'text' && HOOK_QUESTION_WORDING.test(block.text || '')) return true;
      if (block?.type === 'tool_use' && block.name === 'AskUserQuestion') {
        const questions = block.input?.questions;
        if (Array.isArray(questions) && questions.some((question) => HOOK_QUESTION_WORDING.test(question?.question || ''))) return true;
      }
    }
  }
  return false;
}

// Russell's ANSWER to that question — a user-role entry (plain reply, or an AskUserQuestion
// tool_result) whose text affirms it. Matches a bare "yes" as well as a chosen-option echo.
const AFFIRMATIVE_ANSWER = /\byes\b|\byeah\b|\byep\b|\bsure\b|\bdo it\b|\bgo ahead\b|\bbuild it\b/i;
function hookQuestionAnsweredYesIn(entries) {
  for (const entry of entries) {
    if (entry.type !== 'user') continue;
    const blocks = entry.message?.content;
    if (typeof blocks === 'string' && AFFIRMATIVE_ANSWER.test(blocks)) return true;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === 'text' && AFFIRMATIVE_ANSWER.test(block.text || '')) return true;
      if (block?.type === 'tool_result') {
        const inner = block.content;
        const innerText = typeof inner === 'string' ? inner : Array.isArray(inner) ? inner.map((p) => p?.text || '').join('\n') : '';
        if (AFFIRMATIVE_ANSWER.test(innerText)) return true;
      }
    }
  }
  return false;
}

function clearMarker() {
  try { if (existsSync(MARKER_PATH)) rmSync(MARKER_PATH); } catch { /* ignore */ }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }
  const event = payload.hook_event_name || payload.hookEventName || '';

  // FRONT of turn: detect a correction in Russell's message; arm the marker + inject the checklist.
  if (event === 'UserPromptSubmit') {
    const message = payload.prompt || payload.user_prompt || '';
    if (SYSTEM_INJECTED.test(message)) return; // a notification/reminder, not Russell correcting me
    if (!isCorrection(message)) return;
    const repeat = isRepeat(message);
    // Record how far into the transcript we are RIGHT NOW, so the Stop-side satisfaction check can
    // scan every entry from this correction forward — across as many turns as it takes to ask,
    // wait for the answer, and dispatch the fix — instead of only the current turn's edits.
    const armedAtEntryIndex = readTranscript(payload.transcript_path).length;
    try {
      mkdirSync(dirname(MARKER_PATH), { recursive: true });
      writeFileSync(MARKER_PATH, JSON.stringify({ repeat, correction: message.slice(0, 300), ts: Date.now(), armedAtEntryIndex }));
    } catch { /* fail open */ }

    const checklist = repeat
      ? `=== GETTY GUARD — this looks like a REPEAT mistake (J. Paul Getty: never make the same one twice) ===
Russell is correcting you, and his wording signals you've done this before. A learning alone already FAILED to stop it.
Before this turn can end you MUST:
  1. grep learnings.md to confirm the lesson is already there.
  2. DESCRIBE to Russell exactly what the repeat mistake was and what hook would prevent it.
  3. ASK Russell explicitly: "Should I build a hook for this?" — DO NOT build anything until he says yes.
  4. Only after Russell approves: build/strengthen a hook in ~/.claude/hooks/ (with its *.test.mjs, registered in settings.json, a HOOKBOOK row).
NEVER start building a hook without Russell's explicit approval in this session. Override only if a hook genuinely can't catch it: "getty-override: <why>".`
      : `=== GETTY GUARD — you were just corrected (J. Paul Getty: any mistake once, never twice) ===
Close the loop before this turn ends:
  1. grep learnings.md — is this mistake already captured?
  2. If NOT → add a learning bullet now (the cheap fix).
  3. If it IS already there → it's a REPEAT → describe the pattern to Russell and ASK if he wants a hook built. Do NOT build one without his explicit approval.
Clear by adding a learning. Override: "getty-override: <why no rule is needed>".`;
    process.stdout.write(checklist);
    return;
  }

  // END of turn: if a correction is pending, require the artifact (learning, or a hook for repeats).
  if (!existsSync(MARKER_PATH)) return;
  let marker;
  try { marker = JSON.parse(readFileSync(MARKER_PATH, 'utf8')); } catch { clearMarker(); return; }

  const reply = lastAssistantTextOf(payload.transcript_path);
  if (OVERRIDE.test(reply)) { clearMarker(); return; }

  const sessionEntries = entriesSinceMarkerArmed(payload.transcript_path, marker.armedAtEntryIndex);
  const editedPaths = editedPathsIn(sessionEntries);
  const learningAdded = editedPaths.some((filePath) => LEARNINGS_FILE.test(filePath));
  const hookBuilt = editedPaths.some((filePath) => HOOK_FILE.test(filePath));
  const hookDispatched = hookDispatchedIn(sessionEntries);
  // For a REPEAT: asking Russell + getting an affirmative answer + dispatching (or building) the fix
  // fully closes the loop — the live 2026-07-03 case asked via AskUserQuestion, got a yes, and
  // dispatched a background Agent, none of which the old "current-turn file-edit only" check saw.
  const askedAndApprovedAndActed = hookQuestionAskedIn(sessionEntries)
    && hookQuestionAnsweredYesIn(sessionEntries)
    && (hookBuilt || hookDispatched);
  const satisfied = marker.repeat
    ? (hookBuilt || hookDispatched || askedAndApprovedAndActed)
    : (learningAdded || hookBuilt || hookDispatched);

  if (satisfied) { clearMarker(); return; }

  const correctionQuote = marker.correction ? `\nRussell said: "${marker.correction}"\n` : '';
  const reason = marker.repeat
    ? `STOP-BLOCKED — Getty rule: REPEAT mistake → ASK Russell before building a hook (J. Paul Getty: never make the same one twice).
${correctionQuote}
A learning already failed to stop this. Before stopping:
  1. Tell Russell what the repeat mistake was and what hook would prevent it.
  2. Ask Russell explicitly: "Should I build a hook for this?" — DO NOT build anything until he says yes in THIS session.
  3. Only after his approval: build/strengthen the hook (with its *.test.mjs, registered in settings.json, a HOOKBOOK row).
Override only if a hook genuinely can't catch it: "getty-override: <why>".`
    : `STOP-BLOCKED — Getty rule: you were corrected but captured nothing (J. Paul Getty: any mistake once, never twice).
${correctionQuote}
Close the loop before stopping:
  1. grep learnings.md — is this already there? If so it's a REPEAT → describe the pattern to Russell, ask if he wants a hook, wait for yes.
  2. Otherwise add a learning bullet so it's captured.
Override: "getty-override: <why no rule is needed>".`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

main().catch(() => process.exit(0));
