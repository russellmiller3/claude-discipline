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

// Pure: of a `git status --porcelain` text, the lines that touch THIS session's hook work — a changed hook basename
// or settings.json (where registration lives). Scopes the commit-enforcement so it never demands committing OTHER
// sessions' unrelated WIP hooks. Tested without git.
export function uncommittedForChanged(porcelainText, changedBasenames) {
  const basenames = changedBasenames || [];
  return String(porcelainText || '').split('\n').filter(Boolean)
    .filter((line) => /settings\.json/.test(line) || basenames.some((basename) => line.includes(basename)));
}

import { readTranscript, roleOf, toolUsesOf } from './lib/transcript.mjs';

// The file path a Write/Edit/MultiEdit tool use targeted.
const editedPathOf = (toolUse) => toolUse.input?.file_path || toolUse.input?.path || '';

// Basenames of live hook files (incl. *.test.mjs) written/edited this turn.
const LIVE_HOOK_PATH_RE = /[/\\]\.claude[/\\]hooks[/\\]([a-z0-9._-]+\.mjs)/i;
export function changedHookBasenames(turnEntries) {
  const changed = new Set();
  for (const entry of turnEntries) {
    if (roleOf(entry) !== 'assistant') continue;
    for (const toolUse of toolUsesOf(entry)) {
      const name = toolUse.name || '';
      if (['Write', 'Edit', 'MultiEdit'].includes(name)) {
        const match = LIVE_HOOK_PATH_RE.exec(editedPathOf(toolUse));
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

// Hook basenames REGISTERED in ~/.claude/settings.json (the active global guards). An UNREGISTERED hook — e.g. a
// project-specific one not wired in (`new-chat-clears-debug-log`) — is NOT forced into the public kit: Russell's
// curation is that the kit is a portable subset; project-specific hooks stay out (2026-06-29 false-publish).
function registeredHookBasenames() {
  try {
    const settingsText = readFileSync(join(LIVE_REPO_DIR, 'settings.json'), 'utf8');
    return new Set([...settingsText.matchAll(/([a-z0-9._-]+\.mjs)/gi)].map((nameMatch) => nameMatch[1].toLowerCase()));
  } catch { return new Set(); }
}

// `git status --porcelain` for a repo, or '' on any error (fail-open: a non-repo / missing git reads as clean).
function gitPorcelain(repoDir) {
  try {
    return execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

// Did this session touch the kit's PUBLISHED docs (README or anything under docs/)? A hook change must move the
// surface people actually read, not just the hook files. Pure + exported so the rule is unit-tested. Russell
// 2026-06-29 ("update hookbook and claude-discipline folder and readme ... on editing hooks").
const KIT_DOCS_PATH_RE = /claude-discipline[/\\](readme\.md|docs[/\\])/i;
export function kitDocsTouchedThisSession(sessionEntries) {
  for (const entry of sessionEntries) {
    if (roleOf(entry) !== 'assistant') continue;
    for (const toolUse of toolUsesOf(entry)) {
      if (!['Write', 'Edit', 'MultiEdit'].includes(toolUse.name || '')) continue;
      if (KIT_DOCS_PATH_RE.test(editedPathOf(toolUse))) return true;
    }
  }
  return false;
}

// The kit is a PUBLISHED artifact — a local commit isn't "published" until it's on GitHub. Once the publish loop
// is otherwise satisfied, push the kit's current branch (the KIT repo ONLY — never ~/.claude, which has no remote,
// and never a project). Auto-pushes, then BLOCKS only if commits remain unpushed (so a failed/again-needed push
// still has teeth). Runs git directly (not a Bash tool call) so it doesn't trip the no-push-without-permission
// guard — Russell 2026-06-29 ("it should push in this case"). Disable the push half with DISCIPLINE_NO_PUSH=1.
function ensureKitPushed(kitRoot) {
  if (process.env.DISCIPLINE_NO_PUSH === '1') return null;
  const git = (gitArgs) => execSync(`git ${gitArgs}`, { cwd: kitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).trim();
  let branch;
  try {
    branch = git('rev-parse --abbrev-ref HEAD');
    git(`rev-parse --verify origin/${branch}`); // throws when there's no matching upstream → nothing to push
  } catch { return null; }
  const unpushedCount = () => { try { return Number(git(`rev-list --count origin/${branch}..HEAD`)); } catch { return 0; } };
  if (unpushedCount() === 0) return null;                 // already in sync
  try { git(`push origin ${branch}`); } catch { /* re-check below decides */ }
  if (unpushedCount() === 0) return null;                 // pushed successfully
  return `the kit has unpushed commit(s) on ${branch} — push it:\n  cd "${kitRoot}" && git push origin ${branch}`;
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

  // Only hooks that are kit-relevant — REGISTERED in settings.json (or their registered `.mjs` for a `.test.mjs`),
  // or ALREADY in the kit — are forced into / re-synced with the kit. An unregistered project-specific hook stays
  // out. The LIVE-repo commit check below still covers ALL your hook work (commit everything locally regardless).
  const registered = registeredHookBasenames();
  const kitRelevant = (basename) => registered.has(basename)
    || registered.has(basename.replace(/\.test\.mjs$/, '.mjs'))
    || existsSync(join(kitHooksDir, basename));
  const kitChanged = changed.filter(kitRelevant);

  const needing = hooksNeedingSync(kitChanged, readFileOrNull(LIVE_HOOKS_DIR), readFileOrNull(kitHooksDir));

  // Commit enforcement: hook work must be committed in BOTH repos before the turn can end — but ONLY the hooks YOU
  // touched this session (+ settings.json, which hook registration lives in). Now that the scan spans the whole
  // session, a blanket "any uncommitted hook" check would demand committing OTHER sessions' unrelated WIP hooks on
  // every Stop — a yak-shave. `uncommittedForChanged` scopes the porcelain to this session's hook work.
  const liveUncommitted = uncommittedForChanged(gitPorcelain(LIVE_REPO_DIR), changed);
  const kitUncommitted = uncommittedForChanged(gitPorcelain(kitRoot), kitChanged);

  // The published surface (kit README / docs) must move too, and be committed so the push carries it.
  const docsTouched = kitDocsTouchedThisSession(sessionEntries);
  const kitDocsDirty = gitPorcelain(kitRoot).split('\n').filter(Boolean).filter((line) => /readme\.md|[/\\]docs[/\\]/i.test(line));

  if (!needing.length && !liveUncommitted.length && !kitUncommitted.length && docsTouched && !kitDocsDirty.length) {
    // Sync + commits + docs are all done — the only thing left is getting it onto GitHub. Push the kit.
    const pushReason = ensureKitPushed(kitRoot);
    if (!pushReason) process.exit(0);                       // fully published (synced, committed, docs, pushed)
    process.stdout.write(JSON.stringify({ decision: 'block', reason:
      ['KIT NOT PUSHED — the publish loop is done but GitHub is behind.', '', pushReason, '',
       'Override: DISCIPLINE_NO_PUSH=1 (gate without auto-push) or DISCIPLINE_SYNC_OVERRIDE=1.'].join('\n') }));
    return;
  }

  const lines = ['HOOK WORK NOT PUBLISHED — finish the full loop before stopping (copy to kit → update kit README/HOOKBOOK → commit BOTH repos → push the kit).', ''];
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
  if (!docsTouched) {
    lines.push('Kit docs NOT updated this session — a hook change must move the published surface people read:');
    lines.push(`  • update ${join(kitRoot, 'README.md')} and/or ${join(kitRoot, 'docs', 'HOOKBOOK.md')} for what changed, then commit.`, '');
  }
  if (kitDocsDirty.length) {
    lines.push('Uncommitted kit README/docs — commit them so the push carries them:');
    lines.push(`  cd "${kitRoot}" && git add README.md docs && git commit -m "docs: ..."`, '');
  }
  lines.push('Once synced + committed + docs updated, the kit is pushed automatically (DISCIPLINE_NO_PUSH=1 to gate without push).');
  lines.push('Override (rare — a deliberately unpublished/local hook): DISCIPLINE_SYNC_OVERRIDE=1.');
  process.stdout.write(JSON.stringify({ decision: 'block', reason: lines.join('\n') }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(() => process.exit(0));
