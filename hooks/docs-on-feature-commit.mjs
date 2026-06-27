#!/usr/bin/env node
/**
 * Docs-on-commit guard — GLOBAL, project-agnostic. Two halves, mirroring learnings-write-nudge:
 *
 *   • PostToolUse(Bash): right after a `git commit` that didn't touch docs, NUDGE the agent to
 *     document what changed in the available docs (README / docs/).
 *   • Stop: if THIS TURN made ANY git commit whose message is not a docs commit, and never updated
 *     the available docs, BLOCK the turn until the docs are updated (or it's explicitly exempt).
 *
 * The rule: trigger on a commit for ANYTHING — unless the word "docs"
 * is in the commit message (which marks it as the docs commit itself). The first cut was feat-only
 * and missed a `fix(...)` commit; the corrected rule is "every commit must move the available docs
 * unless it IS a docs commit." "The available documentation" is whatever the repo keeps: a README
 * at any level, anything under a docs/ tree, or a CHANGELOG. HANDOFF/plans/learnings do NOT count.
 *
 * Override: put `docs-skip: <why>` in the commit command OR the final reply when a change genuinely
 * has no documentation surface to move. Fail open on any error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const COMMIT_RE = /\bgit\b[\s\S]*\bcommit\b/;
// "docs" anywhere in the commit command/message marks it a docs commit → exempt. (docs-skip also
// contains "docs", so the explicit override is naturally caught here too.)
const DOCS_COMMIT_RE = /\bdocs\b/i;
const OVERRIDE_RE = /docs-skip\s*:/i;
const CODE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// The available documentation: a README at any level, or anything under a docs/ tree, or CHANGELOG.
function isDocs(filePath) {
  if (!filePath) return false;
  const path = String(filePath).replace(/\\/g, '/');
  return /(^|\/)readme(\.[a-z]+)?$/i.test(path)
    || /(^|\/)docs\//i.test(path)
    || /(^|\/)changelog(\.[a-z]+)?$/i.test(path);
}

// A Bash/PowerShell command that writes or stages a README/docs file also counts as a docs update.
function commandUpdatesDocs(command) {
  if (!/readme|(^|[\s"'\/])docs\//i.test(command)) return false;
  return /(>>|>|\bgit\s+add\b|\btee\b|Set-Content|Out-File|writeFileSync|cp\b|mv\b)/i.test(command);
}

// ── transcript helpers (shared shape with learnings-write-nudge) ───────────────
function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  try {
    return readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function roleOf(entry) { return entry.message?.role || entry.role || entry.type || ''; }
function contentBlocks(entry) {
  const blocks = entry.message?.content ?? entry.content ?? [];
  if (typeof blocks === 'string') return [{ type: 'text', text: blocks }];
  return Array.isArray(blocks) ? blocks : [];
}
function currentTurnEntries(entries) {
  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'assistant') { lastAssistant = i; break; } }
  if (lastAssistant < 0) return [];
  let turnStart = 0;
  for (let i = lastAssistant - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'user') { turnStart = i; break; } }
  return entries.slice(turnStart);
}

// ── Stop: hard gate ────────────────────────────────────────────────────────────
function onStop(hookEvent) {
  const turnEntries = currentTurnEntries(readTranscript(hookEvent.transcript_path));
  if (turnEntries.length === 0) return;

  let committedNonDocs = false, updatedDocs = false, override = false;
  for (const entry of turnEntries) {
    for (const block of contentBlocks(entry)) {
      if (block.type === 'text' && OVERRIDE_RE.test(block.text || '')) override = true;
      if (block.type !== 'tool_use') continue;
      const toolName = block.name || '';
      const toolInput = block.input || {};
      if (CODE_EDIT_TOOLS.has(toolName)) {
        const filePath = toolInput.file_path || toolInput.path || '';
        if (isDocs(filePath)) updatedDocs = true; // edited the available docs directly
      }
      if (toolName === 'Bash' || toolName === 'PowerShell') {
        const command = toolInput.command || '';
        if (COMMIT_RE.test(command)) {
          // Any commit triggers the requirement — UNLESS its message says "docs" (it IS the docs
          // commit) which both exempts it and counts as the docs being moved.
          if (DOCS_COMMIT_RE.test(command)) updatedDocs = true;
          else committedNonDocs = true;
        }
        if (commandUpdatesDocs(command)) updatedDocs = true;
      }
    }
  }

  if (!committedNonDocs) return;       // no non-docs commit this turn → nothing to enforce
  if (updatedDocs || override) return; // docs were moved, a docs commit happened, or exempted

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      'DOCS UPDATE REQUIRED — you committed this turn but never moved the available documentation.',
      '',
      "The rule: EVERY commit must update the available docs — unless the commit is",
      'itself a docs commit (the word "docs" in its message). The canonical docs are the README (or a',
      'docs/ tree, or CHANGELOG). HANDOFF/plans/learnings do NOT count.',
      '',
      'Do ONE of:',
      "  1. Update the project's README (or docs/) for what changed — behavior/feature list, any new",
      '     setting or flag, the shipped/changelog section — and commit it.',
      '  2. If the commit you made IS a docs commit, put the word "docs" in its message.',
      '  3. If this change genuinely has no documentation surface to move, say so with the literal token:',
      '     docs-skip: <why no doc change is needed>',
    ].join('\n'),
  }));
}

// ── PostToolUse: soft nudge right after the commit ─────────────────────────────
function onPostToolUse(hookEvent) {
  if (hookEvent.tool_name !== 'Bash') return;
  const command = hookEvent.tool_input?.command || '';
  if (!COMMIT_RE.test(command)) return;
  if (DOCS_COMMIT_RE.test(command) || OVERRIDE_RE.test(command)) return; // docs commit / exempt

  const explicitRepo = command.match(/\bgit\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))/);
  const repoDirectory = (explicitRepo && (explicitRepo[2] || explicitRepo[3] || explicitRepo[4])) || hookEvent.cwd || process.cwd();

  let committedFiles = [];
  try {
    committedFiles = execSync('git show --name-only --format= HEAD', { cwd: repoDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n').map((line) => line.trim()).filter(Boolean);
  } catch { return; }
  if (committedFiles.length === 0) return;
  if (committedFiles.some(isDocs)) return; // the commit already moved docs

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        '=== DOCS WRITE NUDGE ===',
        `Commit didn't touch docs: ${committedFiles.slice(0, 4).join(', ')}`,
        '',
        "The rule: every commit must move the available documentation (README / docs/) — unless",
        "it's a docs commit. Update it now and commit, or the Stop gate will require it before you finish.",
      ].join('\n'),
    },
  }));
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); }
  const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
  if (eventName === 'Stop') onStop(hookEvent);
  else onPostToolUse(hookEvent);
  process.exit(0);
}

main();
