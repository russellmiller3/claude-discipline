#!/usr/bin/env node
/**
 * prompt-covers-actions — Stop gate (Jarvis): a LEVERAGE recipe action that the model won't use unless it's
 * TAUGHT must be documented in the system prompt. The brain CAN emit any action in STEP_SCHEMA's enum (it gets
 * the tool schema), but it only PREFERS the primitives the prompt's doctrine actually names. So a primitive can
 * ship "callable but untaught" and silently never get used — exactly what happened: parallelMap/iterate/kv/api_call
 * landed in the schema while personality.js lagged.
 *
 * Russell's rule (2026-06-23): "how do we ensure Jarvis/Rhonda use the new primitives? should we have a hook?"
 * Yes — ENFORCE it. When a turn edits the recipe schema (tools/recipeTools.js) or the prompt (personality.js),
 * every leverage action in the STEP_SCHEMA action enum must appear by name in personality.js, else BLOCK.
 *
 * Scope: only fires when this turn edited one of those two files AND both exist in the repo (no-op elsewhere).
 * Basic DOM verbs and the Google/Sheet/email actions are EXEMPT (covered by the broad "use the API for Google
 * apps / act on the page" doctrine, or too trivial to need their own line). Override: `prompt-coverage-skip: <why>`.
 * Fails open on any error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_RE = /prompt-coverage-skip\s*:/i;
const CODE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

const SCHEMA_REL = 'extension/lib/tools/recipeTools.js';
const PROMPT_REL = 'extension/lib/personality.js';

// Actions that do NOT need their own prompt doctrine: the basic DOM verbs (the brain uses them reflexively from
// the schema) and the Google/Sheet/email actions (covered by the "use the API for Google apps" doctrine). Every
// OTHER action — the leverage primitives — must be named in the prompt so the brain knows WHEN to reach for it.
export const COVERAGE_EXEMPT = new Set([
  'navigate', 'click', 'fill', 'select', 'press', 'hover', 'scroll', 'wait_for', 'note',
  'sheet_read', 'sheet_paste_rows', 'sheet_update_rows', 'compose_email',
]);

export function isSchemaFile(filePath) {
  return String(filePath || '').replace(/\\/g, '/').endsWith(SCHEMA_REL);
}
export function isPromptFile(filePath) {
  return String(filePath || '').replace(/\\/g, '/').endsWith(PROMPT_REL);
}

// Pull the action enum out of the STEP_SCHEMA source: `action: { type: 'string', enum: ['a','b',...] }`.
export function extractActions(schemaSource) {
  const enumMatch = String(schemaSource || '').match(/action:\s*\{[^}]*enum:\s*\[([^\]]*)\]/);
  if (!enumMatch) return [];
  return [...enumMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((hit) => hit[1]);
}

// Pure decision: the leverage actions (enum minus exempt) that the prompt never names. Empty → all covered.
export function uncoveredActions(actions, promptText, exempt = COVERAGE_EXEMPT) {
  const prompt = String(promptText || '');
  return actions.filter((action) => !exempt.has(action) && !prompt.includes(action));
}

import { readTranscript, roleOf, contentBlocks, currentTurnEntries } from './lib/transcript.mjs';

function onStop(hookEvent) {
  const turnEntries = currentTurnEntries(readTranscript(hookEvent.transcript_path));
  if (turnEntries.length === 0) return;

  let touchedSchemaOrPrompt = false, override = false;
  const repoDirectory = hookEvent.cwd || process.cwd();

  for (const entry of turnEntries) {
    for (const block of contentBlocks(entry)) {
      if (block.type === 'text' && OVERRIDE_RE.test(block.text || '')) override = true;
      if (block.type !== 'tool_use' || !CODE_EDIT_TOOLS.has(block.name || '')) continue;
      const filePath = block.input?.file_path || block.input?.path || '';
      if (isSchemaFile(filePath) || isPromptFile(filePath)) touchedSchemaOrPrompt = true;
    }
  }
  if (!touchedSchemaOrPrompt || override) return;

  const schemaPath = join(repoDirectory, SCHEMA_REL);
  const promptPath = join(repoDirectory, PROMPT_REL);
  if (!existsSync(schemaPath) || !existsSync(promptPath)) return; // not the Jarvis project → no-op

  const actions = extractActions(readFileSync(schemaPath, 'utf8'));
  const missing = uncoveredActions(actions, readFileSync(promptPath, 'utf8'));
  if (missing.length === 0) return;

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      `PROMPT COVERAGE REQUIRED — these recipe action(s) are in STEP_SCHEMA but the system prompt never names them: ${missing.join(', ')}.`,
      '',
      "The brain CAN call them (they're in the tool schema) but won't PREFER them unless personality.js teaches",
      'WHEN to use each. A callable-but-untaught primitive silently never gets used.',
      '',
      'Do ONE of:',
      `  1. Add doctrine to extension/lib/personality.js naming each missing action (when/why to reach for it).`,
      '  2. If it is a basic verb that needs no doctrine, add it to COVERAGE_EXEMPT in this hook with a reason.',
      '  3. If this turn genuinely should not gate, say:  prompt-coverage-skip: <why>',
    ].join('\n'),
  }));
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
  if (eventName === 'Stop') onStop(hookEvent);
  process.exit(0);
}

// Only run when executed directly as a hook — importing (e.g. from the test) must NOT block on stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
