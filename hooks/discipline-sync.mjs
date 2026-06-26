#!/usr/bin/env node
/**
 * discipline-sync — Stop hook. Keeps the PUBLISHED claude-discipline kit in sync with the live hooks.
 *
 * Russell, 2026-06-25: "hookbook and claude discipline need to update on any hook work — meta hook for that."
 * `hookbook-sync.mjs` already forces the HOOKBOOK row. This is its sibling for the distributable kit
 * (`programming/claude-discipline/`): when a hook under `~/.claude/hooks/` changed this turn AND a copy of
 * that hook already lives in the kit (i.e. it is a PUBLISHED hook), block Stop until the kit copy is
 * byte-identical. A shipped guard that drifted from its live source is a broken product.
 *
 * Scope by design: only hooks that ALREADY exist in the kit are enforced — curation of WHICH hooks get
 * published stays a manual call, this just keeps the published ones honest. Content equality is the check,
 * so it also catches drift left by a prior turn. Fail-open. Override: DISCIPLINE_SYNC_OVERRIDE=1.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LIVE_HOOKS_DIR = join(homedir(), '.claude', 'hooks');
const KIT_DIR_CANDIDATES = [
  process.env.DISCIPLINE_KIT_DIR,
  join(homedir(), 'Desktop', 'programming', 'claude-discipline'),
  'C:/Users/rmill/Desktop/programming/claude-discipline',
].filter(Boolean);

function findKitHooksDir() {
  for (const kitDir of KIT_DIR_CANDIDATES) {
    const hooksDir = join(kitDir, 'hooks');
    if (existsSync(hooksDir)) return hooksDir;
  }
  return null;
}

// Pure core: of the hook basenames changed this turn, which have a kit twin whose content DIFFERS from the
// live copy? `readLive`/`readKit` return file text or null if absent. A basename with no kit twin is skipped
// (not yet published). Unit-tested directly with stub readers.
export function driftedPublishedHooks(changedBasenames, readLive, readKit) {
  const drifted = [];
  for (const basename of changedBasenames) {
    const kitText = readKit(basename);
    if (kitText === null) continue;              // not published → curation stays manual
    const liveText = readLive(basename);
    if (liveText === null) continue;             // live gone (deleted) — not this hook's job
    if (liveText !== kitText) drifted.push(basename);
  }
  return drifted;
}

// ── transcript plumbing (same shape as hookbook-sync) ──
function readTranscript(path) {
  if (!path || !existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function roleOf(entry) { return entry.message?.role || entry.role || entry.type || ''; }
function contentBlocks(entry) {
  const blocks = entry.message?.content ?? entry.content ?? [];
  if (typeof blocks === 'string') return [{ type: 'text', text: blocks }];
  return Array.isArray(blocks) ? blocks : [];
}
function toolUsesOf(entry) { return contentBlocks(entry).filter((block) => block?.type === 'tool_use'); }
function currentTurnEntries(entries) {
  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'assistant') { lastAssistant = i; break; } }
  if (lastAssistant < 0) return [];
  let turnStart = 0;
  for (let i = lastAssistant - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'user') { turnStart = i; break; } }
  return entries.slice(turnStart);
}

// Basenames of live hook files (incl. *.test.mjs) written/edited this turn.
const LIVE_HOOK_PATH_RE = /[/\\]\.claude[/\\]hooks[/\\]([a-z0-9._-]+\.mjs)/i;
export function changedHookBasenames(turnEntries) {
  const changed = new Set();
  for (const entry of turnEntries) {
    if (roleOf(entry) !== 'assistant') continue;
    for (const toolUse of toolUsesOf(entry)) {
      const name = toolUse.name || '';
      if (['Write', 'Edit', 'MultiEdit'].includes(name)) {
        const editedPath = toolUse.input?.file_path || toolUse.input?.path || '';
        const match = LIVE_HOOK_PATH_RE.exec(editedPath);
        if (match) changed.add(match[1].toLowerCase());
      }
      if (['Bash', 'PowerShell'].includes(name)) {
        // a shell command that writes/copies into the live hooks dir
        for (const match of JSON.stringify(toolUse.input || '').matchAll(new RegExp(LIVE_HOOK_PATH_RE, 'gi'))) {
          changed.add(match[1].toLowerCase());
        }
      }
    }
  }
  return [...changed];
}

async function main() {
  if (process.env.DISCIPLINE_SYNC_OVERRIDE === '1') process.exit(0);
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }

  const kitHooksDir = findKitHooksDir();
  if (!kitHooksDir) process.exit(0);                       // no kit on this machine → nothing to sync

  const turnEntries = currentTurnEntries(readTranscript(payload.transcript_path));
  if (!turnEntries.length) process.exit(0);
  const changed = changedHookBasenames(turnEntries);
  if (!changed.length) process.exit(0);                    // no hook work this turn

  const readFileOrNull = (dir) => (basename) => {
    const path = join(dir, basename);
    if (!existsSync(path)) return null;
    try { return readFileSync(path, 'utf8'); } catch { return null; }
  };
  const drifted = driftedPublishedHooks(changed, readFileOrNull(LIVE_HOOKS_DIR), readFileOrNull(kitHooksDir));
  if (!drifted.length) process.exit(0);                    // published copies are in sync (or not published)

  const lines = [
    'DISCIPLINE KIT OUT OF SYNC — a PUBLISHED hook changed but its claude-discipline copy did not match.',
    '',
    `Kit hooks dir: ${kitHooksDir}`,
    'These published hooks differ from their live source:',
    ...drifted.map((basename) => `  • ${basename}`),
    '',
    'Copy each over so the shipped kit matches the live guard, e.g.:',
    ...drifted.map((basename) => `  cp ~/.claude/hooks/${basename} "${join(kitHooksDir, basename)}"`),
    '',
    'Also update the kit\'s docs/HOOKBOOK.md row if the behavior changed. Override: DISCIPLINE_SYNC_OVERRIDE=1.',
  ];
  process.stdout.write(JSON.stringify({ decision: 'block', reason: lines.join('\n') }));
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(() => process.exit(0));
