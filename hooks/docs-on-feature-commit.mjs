#!/usr/bin/env node
/**
 * Docs-on-commit guard — GLOBAL, project-agnostic. Two halves, mirroring learnings-write-nudge:
 *
 *   • PostToolUse(Bash): right after a `git commit` that didn't touch docs, NUDGE the agent to
 *     document what changed in the available docs (README / docs/).
 *   • Stop: if THIS TURN made ANY git commit whose message is not a docs commit, and never updated
 *     the available docs, BLOCK the turn until the docs are updated (or it's explicitly exempt).
 *
 * Russell's rule (2026-06-20, tightened 2026-06-30): trigger on a commit for ANYTHING — unless the
 * word "docs" is in the commit message (which marks it the docs commit itself). The satisfying surface
 * is now the FRONT-DOOR docs only: a README (at any level) or a CHANGELOG. A file under a docs/ tree
 * (a roadmap, an internal design doc) NO LONGER counts — features kept landing in docs/ROADMAP while
 * the README drifted, so "keep the README current as you go" is the enforced rule.
 * HANDOFF/plans/learnings do NOT count.
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

// The FRONT-DOOR documentation the user actually reads: a README at any level, or a CHANGELOG.
// Russell 2026-06-30: a file under a docs/ subtree (a roadmap, an internal design doc) NO LONGER
// satisfies the requirement — features kept landing in docs/ROADMAP while the README drifted. The
// README (or CHANGELOG) is the surface that must move on a feature commit; update those "as you go".
function isDocs(filePath) {
  if (!filePath) return false;
  const path = String(filePath).replace(/\\/g, '/');
  return /(^|\/)readme(\.[a-z]+)?$/i.test(path)
    || /(^|\/)changelog(\.[a-z]+)?$/i.test(path);
}

// A Bash/PowerShell command that writes or stages a README/CHANGELOG file also counts (a docs/ path
// does NOT — only the front-door surfaces satisfy the requirement).
function commandUpdatesDocs(command) {
  if (!/readme|changelog/i.test(command)) return false;
  return /(>>|>|\bgit\s+add\b|\btee\b|Set-Content|Out-File|writeFileSync|cp\b|mv\b)/i.test(command);
}

import { readTranscript, roleOf, contentBlocks, currentTurnEntries } from './lib/transcript.mjs';

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
      'README UPDATE REQUIRED — you committed this turn but never moved the README (or CHANGELOG).',
      '',
      "Russell's rule (2026-06-30): EVERY commit must update the FRONT-DOOR docs — unless the commit is",
      'itself a docs commit (the word "docs" in its message). The front-door docs are the README (or a',
      'CHANGELOG). A file under docs/ (a roadmap, an internal design doc) does NOT count — features kept',
      'landing in docs/ROADMAP while the README drifted. HANDOFF/plans/learnings do NOT count either.',
      '',
      'Do ONE of:',
      "  1. Update the project's README (or CHANGELOG) for what changed — the feature/behavior list, any",
      '     new setting or flag, the shipped section — and commit it. Keep the README current as you go.',
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
        '=== README WRITE NUDGE ===',
        `Commit didn't touch the README: ${committedFiles.slice(0, 4).join(', ')}`,
        '',
        "Russell's rule: every commit must move the FRONT-DOOR docs (README / CHANGELOG) — a docs/ file",
        "does NOT count. Update the README now and commit, or the Stop gate will require it before you finish.",
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
