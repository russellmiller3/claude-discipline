#!/usr/bin/env node
/**
 * Stop hook — require HOOKBOOK.md update when a global hook file changes.
 *
 * Fires when any registered .mjs hook was written/run this SESSION but
 * ~/.claude/hooks/HOOKBOOK.md wasn't touched this session.
 * This is the same pattern as mark-queue-on-ship: mechanical enforcement
 * of a doc-update discipline that would otherwise be forgotten.
 *
 * 2026-06-28 fix (Russell: "why didnt the hook fire?"): was scoped to the
 * CURRENT TURN (currentTurnEntries), so a hook edited in an earlier turn slipped
 * the Stop that mattered. Now scans the whole-session transcript; the HOOKBOOK-
 * touched check is over the same span, so updating HOOKBOOK once clears it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOKS_DIR_RE = /[/\\]\.claude[/\\]hooks[/\\][^/\\]+\.mjs/i;
const HOOKBOOK_RE  = /HOOKBOOK\.md/i;
const HOOK_FILENAME_RE = /([^/\\]+\.mjs)/i;

// Every .mjs basename REGISTERED as a hook in settings.json — including hooks that live OUTSIDE
// ~/.claude/hooks/ (e.g. claude-voice/hooks/silent-mode.mjs, wired via an absolute path). Editing any
// of these must require a HOOKBOOK update, even though the dir-based check above wouldn't catch them.
function registeredHookBasenames() {
  try {
    const settingsText = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8');
    return new Set([...settingsText.matchAll(/([a-z0-9._-]+\.mjs)/gi)].map((m) => m[1].toLowerCase()));
  } catch {
    return new Set();
  }
}

// A registered hook file (anywhere), but NOT its *.test.mjs sibling — editing only a test shouldn't
// demand a HOOKBOOK row.
function isRegisteredHookPath(filePath, registeredBasenames) {
  const basename = (HOOK_FILENAME_RE.exec(filePath || '')?.[1] || '').toLowerCase();
  if (!basename || basename.endsWith('.test.mjs')) return false;
  return registeredBasenames.has(basename);
}

function readTranscript(path) {
  if (!path || !existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function roleOf(e) { return e.message?.role || e.role || e.type || ''; }

function contentBlocks(e) {
  const c = e.message?.content ?? e.content ?? [];
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

function toolUsesOf(e) {
  return contentBlocks(e).filter(b => b?.type === 'tool_use');
}

function hookFileChangedThisSession(sessionEntries) {
  const registeredBasenames = registeredHookBasenames();
  for (const entry of sessionEntries) {
    if (roleOf(entry) !== 'assistant') continue;
    for (const tu of toolUsesOf(entry)) {
      const inputStr = JSON.stringify(tu.input || '');
      // Write/Edit targeting a hook: either it sits in any .claude/hooks/ dir, OR it's a file
      // registered as a hook in settings.json (catches hooks living in other dirs, e.g. claude-voice).
      if (['Write', 'Edit', 'MultiEdit'].includes(tu.name || '')) {
        const editedPath = tu.input?.file_path || tu.input?.path || '';
        if (HOOKS_DIR_RE.test(editedPath) || isRegisteredHookPath(editedPath, registeredBasenames)) return true;
      }
      // Bash/PowerShell writing to a hook file (by dir or by registered basename).
      if (['Bash', 'PowerShell'].includes(tu.name || '')) {
        const wroteAFile = /cat\s*>|Out-File|Set-Content|tee\b|>\s*["']/.test(inputStr);
        if (wroteAFile && (HOOKS_DIR_RE.test(inputStr) || [...registeredBasenames].some((name) => inputStr.toLowerCase().includes(name)))) return true;
      }
    }
  }
  return false;
}

function hookbookUpdatedThisSession(sessionEntries) {
  for (const entry of sessionEntries) {
    if (roleOf(entry) !== 'assistant') continue;
    for (const tu of toolUsesOf(entry)) {
      const inputStr = JSON.stringify(tu.input || '');
      if (HOOKBOOK_RE.test(inputStr)) return true;
    }
  }
  return false;
}

// The "N hooks across 5 event types" headline is hand-maintained and drifted
// (said 43 while 45 were registered, 2026-05-29). Mechanically derive the truth:
// count unique hooks/<name>.mjs referenced in settings.json, compare to the
// headline. Returns null when they match, else {headline, registered}.
function getCountDrift() {
  try {
    const settingsText = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8');
    const hookbookText = readFileSync(join(homedir(), '.claude', 'hooks', 'HOOKBOOK.md'), 'utf8');
    const registered = new Set(
      [...settingsText.matchAll(/hooks\/([a-z0-9-]+)\.mjs/gi)].map((m) => m[1])
    ).size;
    const headlineMatch = hookbookText.match(/(\d+)\s+hooks across/i);
    if (!headlineMatch) return null;
    const headline = Number(headlineMatch[1]);
    return headline === registered ? null : { headline, registered };
  } catch {
    return null;
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }
  // NOTE: intentionally do NOT bail on payload.stop_hook_active. Doing so
  // defeated enforcement whenever ANOTHER Stop hook blocked first (which is
  // common given how many Stop hooks exist) — the re-evaluation set
  // stop_hook_active=true and this hook bailed before checking, so hook-file
  // writes slipped through unrecorded (2026-05-29: pixels-only-proof.mjs and
  // require-learnings-ack.mjs were both written but never logged to HOOKBOOK).
  // It cannot loop forever: it only blocks while a hook changed in the current
  // turn-span AND HOOKBOOK.md wasn't touched in that same span — updating
  // HOOKBOOK.md clears it. Matches never-stop-asking.mjs, which also re-fires.

  // Scan the WHOLE SESSION (not just the current turn): a hook edited in an earlier turn must still require a
  // HOOKBOOK row by the Stop that matters. The HOOKBOOK-touched check below is over the same span, so updating
  // HOOKBOOK once in the session clears the block.
  const sessionEntries = readTranscript(payload.transcript_path);
  if (sessionEntries.length === 0) return;

  if (!hookFileChangedThisSession(sessionEntries)) return;

  const rowMissing = !hookbookUpdatedThisSession(sessionEntries);
  const drift = getCountDrift();
  if (!rowMissing && !drift) return; // row added this turn AND count is accurate

  const hookbookPath = join(homedir(), '.claude', 'hooks', 'HOOKBOOK.md');
  const lines = ['HOOKBOOK UPDATE REQUIRED — a hook file changed this session.', '', `HOOKBOOK lives at: ${hookbookPath}`, ''];
  if (rowMissing) {
    lines.push('• Add or update the row for the changed hook (under the right event section).');
  }
  if (drift) {
    lines.push(`• Fix the headline count: it says "${drift.headline} hooks" but ${drift.registered} are registered in settings.json. Update it to ${drift.registered}.`);
  }
  process.stdout.write(JSON.stringify({ decision: 'block', reason: lines.join('\n') }));
}

main().catch(() => process.exit(0));
