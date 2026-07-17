#!/usr/bin/env node
// =============================================================================
// MAIN-TASK-FOCUS-GUARD — keep the main thing the main thing. At Stop, block DRIFT
// from the recorded MAIN TASK into unauthorized side quests.
// =============================================================================
//
// new-hook-category: Process-discipline meta (Getty / Munger / parallelism) —
// complements ross-perot-guard (which pushes to KEEP working the queue). This one
// guards the OTHER failure: working hard on the WRONG thing. Together: work the queue,
// but the MAIN item, not a detour.
//
// THE MISTAKE (2026-07-17, a repeat pattern): main task = get the 7B verdict, but under
// pressure I wandered into side quests Russell never asked for — editing hook test files,
// syncing the discipline kit, three passes at monitor-streaming infra — while the science
// sat dead. Each felt like forward work; none was the MAIN TASK, and Russell hadn't
// authorized the detour. This is the Getty "chasing clever past obvious" rabbit hole.
//
// THE RULE: there is ONE main task per stretch of work (the one Russell last set). Work on
// a DIFFERENT task — a side quest — only if Russell EXPLICITLY authorized it. Otherwise,
// return to the main task.
//
// CONSERVATIVE BY DESIGN (fail-open dominates; low false-positive). At Stop it BLOCKS only
// when ALL of:
//   - a main task is recorded (`.claude/state/main-task.txt`; absent → no-op), AND
//   - the turn was AUTONOMOUS (a bare "g"/"continue" prompt — Russell isn't steering), AND
//   - there are >= 3 substantive non-brief edits this turn, AND
//   - ALL of them are unrelated (zero token overlap) to the main task.
// A written .md brief (agent-prompts/ or HANDOFF.md) is the SANCTIONED response to "I found
// a side thing" (the .md-handoff discipline) and never counts as drift.
//
// COMPANION (UserPromptSubmit): records `MAIN TASK: <text>` to the state file when a message
// sets one explicitly, so the Stop guard has a task to compare against.
//
// TEETH: Stop decision 'block'. Escape: SIDEQUEST_OK: <why> in the reply/prompt, or
// MAIN_TASK_FOCUS_OK=1 env. Respects stop_hook_active. FAILS OPEN. basename entry-guard.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, currentTurnEntries, toolUsesOf, textOf, isHumanPrompt, lastAssistantText } from './lib/transcript.mjs';

const ENV_OVERRIDE = 'MAIN_TASK_FOCUS_OK';
const ESCAPE_TOKEN = /\bSIDEQUEST_OK\b/;
const DRIFT_MIN_EDITS = 3;

// A bare continue prompt = an autonomous turn where Russell is NOT steering. Only these
// turns are eligible to block; any message with real content means he's directing the work.
const PURE_CONTINUE_RE = /^(?:g|go|continue|keep going|resume|proceed|next|carry on|carryon|k|ok|okay|y|yes|yep|yeah|)$/i;

// A written .md brief / parachute — the sanctioned response to a side thing, never drift.
const SANCTIONED_EDIT_RE = /agent-prompts[\/\\]|(?:^|[\/\\])HANDOFF\.md$|[\/\\]briefs?[\/\\]/i;

// Editing tools whose file_path is a real edit this turn.
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you',
  'not', 'but', 'are', 'was', 'will', 'its', 'our', 'get', 'via', 'per', 'over', 'onto', 'main', 'task']);

// Meaningful tokens of a string: lowercased alphanumeric runs of >= 4 chars, minus stopwords.
function meaningfulTokens(source) {
  if (!source || typeof source !== 'string') return [];
  return source.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

/** True when a path shares a meaningful token with the main task text (heuristic). */
export function relatedToMainTask(path, mainTask) {
  const taskTokens = new Set(meaningfulTokens(mainTask));
  if (taskTokens.size === 0) return false;
  return meaningfulTokens(path).some((token) => taskTokens.has(token));
}

/** Pull the task from a `MAIN TASK: <text>` marker (case-insensitive). null if absent. */
export function extractMainTask(sourceText) {
  if (!sourceText || typeof sourceText !== 'string') return null;
  const markerMatch = sourceText.match(/MAIN TASK:\s*(.+?)(?:\n|$)/i);
  return markerMatch ? markerMatch[1].trim() : null;
}

/**
 * PURE core. Returns { block, mode?, reason? }. Never throws on malformed input.
 * Stop only. `turnEditPaths` = file paths edited this turn; `humanPrompt` = the text of
 * the prompt that started the turn.
 */
export function evaluate({ event, mainTask = '', turnEditPaths = [], humanPrompt = '', replyText = '', stopHookActive = false } = {}) {
  if (event !== 'Stop') return { block: false };
  if (stopHookActive) return { block: false };
  if (ESCAPE_TOKEN.test(replyText || '') || ESCAPE_TOKEN.test(humanPrompt || '')) return { block: false };
  if (!mainTask || typeof mainTask !== 'string' || !mainTask.trim()) return { block: false }; // no task recorded → fail open

  // Russell steering this turn (any non-continue message) → not a detour, never block.
  if (!PURE_CONTINUE_RE.test((humanPrompt || '').trim())) return { block: false };

  const paths = (turnEditPaths || []).filter((path) => typeof path === 'string' && path);
  const substantiveEdits = paths.filter((path) => !SANCTIONED_EDIT_RE.test(path)); // briefs/parachutes are sanctioned
  if (substantiveEdits.length < DRIFT_MIN_EDITS) return { block: false }; // too little to call drift

  const unrelated = substantiveEdits.filter((path) => !relatedToMainTask(path, mainTask));
  if (unrelated.length !== substantiveEdits.length) return { block: false }; // some on-task work → not pure drift

  const uniqueDrift = [...new Set(unrelated)].slice(0, 6);
  const reason = `MAIN TASK: ${mainTask}

You drifted to work unrelated to the main task without Russell's OK — ${substantiveEdits.length} edits this turn, none touching the main task:
${uniqueDrift.map((path) => `  - ${path}`).join('\n')}

This is the Getty rabbit hole (chasing clever past obvious): forward-looking work that isn't THE thing Russell
last set. The sanctioned response to "I found a side thing" is a written .md brief in ~/.claude/agent-prompts/
(handed to Russell to run separately), not an inline detour.

Return to the main task. If Russell actually authorized this detour, add to your reply:
  SIDEQUEST_OK: <how Russell authorized it>
Or set ${ENV_OVERRIDE}=1.`;
  return { block: true, mode: 'stop', reason };
}

// ── companion: record MAIN TASK: markers to the state file ────────────────────
function mainTaskFilePath(repoRoot) {
  if (process.env.MAIN_TASK_FILE) return process.env.MAIN_TASK_FILE;
  return resolve(repoRoot || process.cwd(), '.claude', 'state', 'main-task.txt');
}

function readRecordedMainTask(repoRoot) {
  const filePath = mainTaskFilePath(repoRoot);
  if (!existsSync(filePath)) return '';
  try { return (readFileSync(filePath, 'utf8') || '').split('\n')[0].trim(); } catch { return ''; }
}

function recordMainTask(repoRoot, task) {
  try {
    const filePath = mainTaskFilePath(repoRoot);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, task + '\n', 'utf8');
  } catch { /* fail open */ }
}

// Editing tool-use file paths in a set of transcript entries.
function editPathsIn(entries) {
  const paths = [];
  for (const entry of entries || []) {
    for (const block of toolUsesOf(entry)) {
      if (EDIT_TOOLS.has(block?.name)) {
        const path = block?.input?.file_path || block?.input?.notebook_path || '';
        if (path) paths.push(path);
      }
    }
  }
  return paths;
}

// The text of the prompt that started the current turn (the turn opener human message).
function turnOpenerPrompt(turnEntries) {
  const opener = (turnEntries || [])[0];
  return opener && isHumanPrompt(opener) ? textOf(opener) : '';
}

function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') process.exit(0);
    const payload = readPayload();
    const event = payload.hook_event_name || payload.hookEventName || '';
    const repoRoot = payload.cwd || payload.cwd_path || process.cwd();

    // Companion: on a new human prompt carrying a MAIN TASK: marker, record it.
    if (event === 'UserPromptSubmit') {
      const promptText = payload.prompt || payload.user_prompt || '';
      const declaredTask = extractMainTask(promptText);
      if (declaredTask) recordMainTask(repoRoot, declaredTask);
      process.exit(0);
    }

    if (event !== 'Stop') process.exit(0);
    if (payload.stop_hook_active) process.exit(0);

    const entries = readTranscript(payload.transcript_path || payload.transcriptPath || '');
    const turnEntries = currentTurnEntries(entries);
    const mainTask = readRecordedMainTask(repoRoot);
    const verdict = evaluate({
      event: 'Stop',
      mainTask,
      turnEditPaths: editPathsIn(turnEntries),
      humanPrompt: turnOpenerPrompt(turnEntries),
      replyText: lastAssistantText(entries),
    });
    if (!verdict.block) process.exit(0);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }));
    process.exit(0);
  } catch {
    process.exit(0); // fail open — never brick a stop or a prompt
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
