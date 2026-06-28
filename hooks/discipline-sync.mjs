#!/usr/bin/env node
/**
 * discipline-sync — Stop hook. On ANY hook work this turn, FORCE the full publish loop:
 *   1. every changed live hook (incl. its *.test.mjs) is COPIED into the claude-discipline kit,
 *   2. the live ~/.claude repo has NO uncommitted hook/settings changes (commit them), and
 *   3. the kit repo has NO uncommitted changes (commit the kit).
 * Blocks Stop until all three hold.
 *
 * Russell, 2026-06-25: "hookbook and claude discipline need to update on any hook work — meta hook for that."
 * Russell, 2026-06-27: "the meta hook creation hook should have fired. should force you to commit, update hookbook,
 * copy into claude-discipline folder. didnt work. update that hook." — the prior version SKIPPED any hook not already
 * in the kit, so a brand-NEW hook was never forced in. Now a missing-from-kit hook is a publish requirement.
 * Russell, 2026-06-28 (this fix): "there should have been a hook that forced you to update hookbook + claude-discipline
 * — why didnt it work?" — it scoped detection to the CURRENT TURN only (`currentTurnEntries`), so hook work done in an
 * EARLIER turn (then committed to ~/.claude) was invisible by the Stop that mattered → the kit silently drifted. Fix:
 * scan the WHOLE SESSION transcript for hook edits. Scope stays tight because the SATISFACTION checks (kit in sync +
 * both repos committed) read CURRENT state — once you publish + commit, it stops blocking; it never yak-shaves
 * unrelated hooks you didn't touch this session. `hookbook-sync.mjs` still owns the live HOOKBOOK row.
 *
 * Fail-open (a git/fs error never blocks all work). Override: DISCIPLINE_SYNC_OVERRIDE=1.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE_HOOKS_DIR = join(homedir(), '.claude', 'hooks');
const LIVE_REPO_DIR = join(homedir(), '.claude');
const KIT_DIR_CANDIDATES = [
  process.env.DISCIPLINE_KIT_DIR,
  join(homedir(), 'Desktop', 'programming', 'claude-discipline'),
  'C:/Users/rmill/Desktop/programming/claude-discipline',
].filter(Boolean);

function findKitRoot() {
  for (const kitDir of KIT_DIR_CANDIDATES) {
    if (existsSync(join(kitDir, 'hooks'))) return kitDir;
  }
  return null;
}

// Compare hook bodies ignoring line-ending style: the kit is CRLF on Windows while live is LF, so a raw `!==`
// flags every hook as drifted. Content equality is what matters, not the byte that ends each line.
const sameContent = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

// Pure core: of the hook basenames changed this turn, which need to be published to / re-synced with the kit?
// A live hook with NO kit twin is 'missing' (a NEW hook — must be published now); one whose kit copy DIFFERS is
// 'drift'. A live file that's gone (deleted) is skipped (not this hook's job). Unit-tested with stub readers.
export function hooksNeedingSync(changedBasenames, readLive, readKit) {
  const needing = [];
  for (const basename of changedBasenames) {
    const liveText = readLive(basename);
    if (liveText === null) continue;                                  // live gone (deleted)
    const kitText = readKit(basename);
    if (kitText === null) { needing.push({ basename, reason: 'missing' }); continue; } // NEW → publish it
    if (!sameContent(liveText, kitText)) needing.push({ basename, reason: 'drift' });
  }
  return needing;
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
        for (const match of JSON.stringify(toolUse.input || '').matchAll(new RegExp(LIVE_HOOK_PATH_RE, 'gi'))) {
          changed.add(match[1].toLowerCase());
        }
      }
    }
  }
  return [...changed];
}

// `git status --porcelain` for a repo, or '' on any error (fail-open: a non-repo / missing git reads as clean).
function gitPorcelain(repoDir) {
  try {
    return execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

async function main() {
  if (process.env.DISCIPLINE_SYNC_OVERRIDE === '1') process.exit(0);
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }

  const kitRoot = findKitRoot();
  if (!kitRoot) process.exit(0);                            // no kit on this machine → nothing to sync
  const kitHooksDir = join(kitRoot, 'hooks');

  // Scan the WHOLE SESSION (not just the current turn) so hook work done in an earlier turn — then committed — is
  // still caught by the Stop that matters. The kit-drift + commit checks below read CURRENT state, so this stays
  // scoped to what you touched this session and stops blocking the moment you publish + commit.
  const sessionEntries = readTranscript(payload.transcript_path);
  if (!sessionEntries.length) process.exit(0);
  const changed = changedHookBasenames(sessionEntries);
  if (!changed.length) process.exit(0);                     // no hook work this session

  const readFileOrNull = (dir) => (basename) => {
    const path = join(dir, basename);
    if (!existsSync(path)) return null;
    try { return readFileSync(path, 'utf8'); } catch { return null; }
  };
  const needing = hooksNeedingSync(changed, readFileOrNull(LIVE_HOOKS_DIR), readFileOrNull(kitHooksDir));

  // Commit enforcement: hook work must be committed in BOTH repos before the turn can end.
  const liveUncommitted = gitPorcelain(LIVE_REPO_DIR)
    .split('\n').filter((line) => /(\bhooks\/|settings\.json)/.test(line));
  const kitUncommitted = gitPorcelain(kitRoot).split('\n').filter(Boolean);

  if (!needing.length && !liveUncommitted.length && !kitUncommitted.length) process.exit(0); // all done

  const lines = ['HOOK WORK NOT PUBLISHED — finish the full loop before stopping (copy to kit → update HOOKBOOK → commit BOTH repos).', ''];
  if (needing.length) {
    lines.push(`Kit: ${kitHooksDir}`, 'These changed hooks are NOT yet in the claude-discipline kit (or differ):');
    for (const { basename, reason } of needing) lines.push(`  • ${basename} (${reason})`);
    lines.push('Copy each (and its *.test.mjs) over + add a row to the kit\'s docs/HOOKBOOK.md, e.g.:');
    for (const { basename } of needing) lines.push(`  cp ~/.claude/hooks/${basename} "${join(kitHooksDir, basename)}"`);
    lines.push('');
  }
  if (liveUncommitted.length) {
    lines.push('Uncommitted hook/settings changes in ~/.claude — commit them:');
    lines.push('  cd ~/.claude && git add hooks settings.json && git commit -m "feat(hooks): ..."  (COMMIT_MAIN_OVERRIDE=1 if on main)', '');
  }
  if (kitUncommitted.length) {
    lines.push(`Uncommitted changes in the kit (${kitRoot}) — commit them:`);
    lines.push(`  cd "${kitRoot}" && git add -A && git commit -m "sync: publish hooks from ~/.claude"`, '');
  }
  lines.push('Override (rare — a deliberately unpublished/local hook): DISCIPLINE_SYNC_OVERRIDE=1.');
  process.stdout.write(JSON.stringify({ decision: 'block', reason: lines.join('\n') }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(() => process.exit(0));
