#!/usr/bin/env node
/**
 * Stop hook — remind to mark completed items off the priority queue.
 *
 * Fires when work was merged to main this turn but the priority queue
 * wasn't updated. This is the gap that causes stale queues and re-doing
 * already-shipped work in future sessions.
 *
 * Signal: assistant text contains "merged to main" (standard beat language)
 * AND no tool use in the current turn targeted priority-queue.md.
 *
 * Suppressed when: user said handoff/wrap/stop (queue update happens there).
 */

import { existsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import {
  readTranscript, roleOf, toolUsesOf, currentTurnEntries, lastAssistantText, lastUserText,
} from './lib/transcript.mjs';

// Must match git merge tool use commands, not just assistant prose.
// Checked against actual Bash/PowerShell tool inputs, not reply text.
const MERGE_COMMAND_PATTERNS = [
  /git\s+merge\b/i,
  /--ff-only/i,
  /git\s+switch\s+main.*merge/i,
];

const USER_PAUSE_PATTERNS = [
  /\bhandoff\b/i,
  /\bsave context\b/i,
  /\bwrap (up|things up|the session)\b/i,
  /\bend (the )?(session|stretch|phase)\b/i,
  /\bi'?m done (for now|here)\b/i,
  /\bstop (working|here|for now)\b/i,
];

function queueWasUpdatedThisTurn(turnEntries) {
  for (const entry of turnEntries) {
    if (roleOf(entry) !== 'assistant') continue;
    for (const tu of toolUsesOf(entry)) {
      const inputStr = JSON.stringify(tu.input || '');
      if (/priority-queue/.test(inputStr)) return true;
    }
  }
  return false;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }
  if (payload.stop_hook_active) return;

  const entries = readTranscript(payload.transcript_path);
  const turnEntries = currentTurnEntries(entries);
  if (turnEntries.length === 0) return;

  const assistantText = lastAssistantText(turnEntries);
  const userText = lastUserText(turnEntries);

  if (USER_PAUSE_PATTERNS.some(p => p.test(userText))) return;

  // Only fire when a real git merge tool use happened this turn — not on prose.
  const mergeHappened = turnEntries.some(entry => {
    if (roleOf(entry) !== 'assistant') return false;
    return toolUsesOf(entry).some(tu => {
      if (!['Bash', 'PowerShell'].includes(tu.name || '')) return false;
      const cmd = JSON.stringify(tu.input || '');
      return MERGE_COMMAND_PATTERNS.some(p => p.test(cmd));
    });
  });
  if (!mergeHappened) return;
  if (queueWasUpdatedThisTurn(turnEntries)) return;

  const cwd = payload.cwd || process.cwd();
  const queuePath = pathJoin(cwd, '.claude', 'state', 'priority-queue.md');
  if (!existsSync(queuePath)) return; // no queue to update

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      'QUEUE UPDATE REQUIRED — work was merged to main this turn but the priority queue was not updated.',
      '',
      'The priority queue at .claude/state/priority-queue.md needs to reflect what just shipped.',
      'Without this, future sessions re-do completed work (see: optimizer re-verification, 2026-05-25).',
      '',
      'Before stopping:',
      '  1. Move the completed item to the "## Done" section of priority-queue.md',
      '  2. Add a one-line done-log entry: date + what shipped + commit hash',
      '  3. Re-check the "## Up next" order — does anything unlock from this ship?',
    ].join('\n'),
  }));
}

main().catch(() => process.exit(0));
