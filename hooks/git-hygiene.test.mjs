#!/usr/bin/env node
/**
 * Tests for git-hygiene.mjs — the consolidated worktree/branch hygiene hook.
 *
 * Proves PARITY with the three hooks it replaced (clean-worktrees, clean-merged-worktrees, delete-merged-branches)
 * PLUS the two new capabilities (proactive merged-branch delete + the >3 durable-branch cap warning) and the
 * staleness tier (reap abandoned unmerged agent trees, archive-before-delete). Every destructive path gets a real
 * throwaway git repo with real worktrees and a hard assertion. Dependency-free:  node git-hygiene.test.mjs
 */

import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

import { runGitHygiene, formatNote } from './git-hygiene.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = join(here, 'git-hygiene.mjs');

// Reaping tests create worktrees and immediately assert removal, so they run with the live grace DISABLED (0 min)
// — otherwise the freshly-created trees would all be "recently-active" and survive. Staleness tests re-enable a
// real grace explicitly to prove the two windows are independent.
process.env.GIT_HYGIENE_GRACE_MIN = '0';
// The single-repo tests put their repos directly under tmpdir(); with the sibling
// sweep on, each would scan every other test's temp repo. Default it OFF here and
// enable it explicitly (with an isolated workspace) in the sibling-sweep tests.
process.env.GIT_HYGIENE_SIBLING_SWEEP = '0';
const SIBLING_ENV = { ...process.env, GIT_HYGIENE_SIBLING_SWEEP: '1', GIT_HYGIENE_GRACE_MIN: '0' };
const STALE_ENV = { ...process.env, GIT_HYGIENE_GRACE_MIN: '20', GIT_HYGIENE_STALE_HOURS: '1' };
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

let passed = 0;
let failed = 0;
const tempDirs = [];

function test(label, runCase) {
  try { runCase(); passed++; console.log(`  ok ${label}`); }
  catch (caseError) { failed++; console.log(`  XX ${label}`); console.log(`      ${caseError.message}`); }
}

function run(command, workingDir) {
  const isolated = command.replace(/^git /, 'git -c core.hooksPath=C:/Users/rmill/.claude/test-no-hooks ');
  return execSync(isolated, { cwd: workingDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function branchExists(repoRoot, name) {
  try { execSync(`git show-ref --verify -q "refs/heads/${name}"`, { cwd: repoRoot, stdio: 'ignore' }); return true; }
  catch { return false; }
}

function reapedShas(repoRoot) {
  try {
    return run('git for-each-ref --format=%(objectname) refs/reaped/', repoRoot)
      .split(/\r?\n/).map((sha) => sha.trim()).filter(Boolean);
  } catch { return []; }
}

function backdate(paths, ageMs) {
  const when = new Date(Date.now() - ageMs);
  for (const targetPath of paths) { try { utimesSync(targetPath, when, when); } catch { /* may not exist */ } }
}

function makeRepoAt(repoRoot) {
  mkdirSync(repoRoot, { recursive: true });
  run('git init -b main', repoRoot);
  run('git config user.email test@example.com', repoRoot);
  run('git config user.name Test', repoRoot);
  run('git config commit.gpgsign false', repoRoot);
  run('git commit --allow-empty -m initial', repoRoot);
  run('git switch -c integration', repoRoot);
  return repoRoot;
}

function makeRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gh-'));
  tempDirs.push(repoRoot);
  return makeRepoAt(repoRoot);
}

function addAgentWorktree(repoRoot, agentId, { merge = true } = {}) {
  const branch = `worktree-agent-${agentId}`;
  const worktreePath = join(repoRoot, '.claude', 'worktrees', `agent-${agentId}`);
  run(`git worktree add -b "${branch}" "${worktreePath}" integration`, repoRoot);
  run('git commit --allow-empty -m "agent work"', worktreePath);
  if (merge) run(`git merge --no-ff -m "merge ${branch}" "${branch}"`, repoRoot);
  return { branch, worktreePath };
}

console.log('git-hygiene');

// ---- WORKTREE REAPING (parity with clean-merged-worktrees) ----
test('Stop: removes a worktree merged into the integration branch', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'merged1', { merge: true });
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(!existsSync(worktreePath), 'merged worktree gone');
  assert.ok(!branchExists(repoRoot, branch), 'merged branch deleted');
  assert.ok(outcome.worktreesRemoved.some((entry) => entry.branch === branch && entry.why === 'merged'), 'reported merged');
});

test('Stop: keeps an UNMERGED fresh agent worktree', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'unmerged1', { merge: false });
  runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(existsSync(worktreePath), 'unmerged fresh worktree survives');
  assert.ok(branchExists(repoRoot, branch), 'unmerged branch survives');
});

test('Stop: keeps a DIRTY merged worktree (uncommitted work must not be lost)', () => {
  const repoRoot = makeRepo();
  const { worktreePath } = addAgentWorktree(repoRoot, 'dirty1', { merge: true });
  writeFileSync(join(worktreePath, 'dirty.txt'), 'uncommitted');
  runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(existsSync(worktreePath), 'dirty worktree survives');
});

test('Stop: never removes the main checkout or the integration branch', () => {
  const repoRoot = makeRepo();
  addAgentWorktree(repoRoot, 'safe1', { merge: true });
  runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(existsSync(repoRoot), 'main checkout untouched');
  assert.ok(branchExists(repoRoot, 'integration'), 'integration survives');
  assert.ok(branchExists(repoRoot, 'main'), 'main survives');
});

// ---- STALENESS TIER (the immortal-fork fix) ----
test('Stop: STALE unmerged agent worktree is reaped AND its tip archived to refs/reaped/*', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'stalewt', { merge: false });
  const tip = run(`git rev-parse ${branch}`, repoRoot);
  const worktreeGitDir = run('git rev-parse --absolute-git-dir', worktreePath);
  backdate([worktreePath, worktreeGitDir, join(worktreeGitDir, 'HEAD'), join(worktreeGitDir, 'logs', 'HEAD')], TWO_HOURS_MS);
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', env: STALE_ENV });
  assert.ok(!existsSync(worktreePath), 'stale unmerged worktree removed');
  assert.ok(outcome.worktreesRemoved.some((entry) => entry.branch === branch && entry.why === 'stale-unmerged'), 'reported stale-unmerged');
  assert.ok(reapedShas(repoRoot).includes(tip), 'tip archived (nothing lost)');
});

test('Stop: a live (recently-active) worktree survives the grace window', () => {
  const repoRoot = makeRepo();
  const branch = 'worktree-agent-live1';
  const worktreePath = join(repoRoot, '.claude', 'worktrees', 'agent-live1');
  run(`git worktree add -b "${branch}" "${worktreePath}" integration`, repoRoot); // 0 commits => trivially "merged"
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', env: STALE_ENV });
  assert.ok(existsSync(worktreePath), 'live worktree survives');
  assert.ok(branchExists(repoRoot, branch), 'live branch survives');
});

// ---- LOCAL BRANCH DELETION (parity with delete-merged-branches) ----
test('Stop: deletes a loose branch whose work is on main', () => {
  const repoRoot = makeRepo();
  run('git switch main', repoRoot);
  run('git switch -c done-on-main', repoRoot);
  run('git commit --allow-empty -m "done"', repoRoot);
  run('git switch main', repoRoot);
  run('git merge --no-ff -m "merge done-on-main" done-on-main', repoRoot);
  run('git switch integration', repoRoot);
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(!branchExists(repoRoot, 'done-on-main'), 'branch whose work is on main deleted');
  assert.ok(outcome.branchesDeleted.some((entry) => entry.branch === 'done-on-main'), 'reported deleted');
});

test('Stop: keeps a loose UNMERGED feature/* branch', () => {
  const repoRoot = makeRepo();
  run('git switch -c feature/wip', repoRoot);
  run('git commit --allow-empty -m wip', repoRoot);
  run('git switch integration', repoRoot);
  runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(branchExists(repoRoot, 'feature/wip'), 'unmerged feature branch survives');
});

test('Stop: STALE loose worktree-agent-* branch is reaped + archived; a stale feature/* SURVIVES', () => {
  const repoRoot = makeRepo();
  run('git switch -c worktree-agent-loose', repoRoot);
  run('git commit --allow-empty -m "agent wip"', repoRoot);
  const agentTip = run('git rev-parse worktree-agent-loose', repoRoot);
  run('git switch -c feature/paused', repoRoot);
  run('git commit --allow-empty -m "paused"', repoRoot);
  run('git switch integration', repoRoot);
  const commonGitDir = run('git rev-parse --absolute-git-dir', repoRoot);
  backdate([
    join(commonGitDir, 'refs', 'heads', 'worktree-agent-loose'),
    join(commonGitDir, 'logs', 'refs', 'heads', 'worktree-agent-loose'),
    join(commonGitDir, 'refs', 'heads', 'feature', 'paused'),
    join(commonGitDir, 'logs', 'refs', 'heads', 'feature', 'paused'),
  ], TWO_HOURS_MS);
  runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', env: STALE_ENV });
  assert.ok(!branchExists(repoRoot, 'worktree-agent-loose'), 'stale loose agent branch reaped');
  assert.ok(reapedShas(repoRoot).includes(agentTip), 'agent branch tip archived');
  assert.ok(branchExists(repoRoot, 'feature/paused'), 'stale feature/* branch SURVIVES (never age-reaped)');
});

// ---- SIBLING-REPO SWEEP (the cross-repo gap: a merged branch in a SIBLING repo must also reap) ----
function makeWorkspaceWithSibling() {
  const workspace = mkdtempSync(join(tmpdir(), 'gh-ws-'));
  tempDirs.push(workspace);
  const primary = join(workspace, 'primary');
  const sibling = join(workspace, 'sibling');
  makeRepoAt(primary);
  makeRepoAt(sibling);
  return { primary, sibling };
}

test('Stop: reaps a merged branch in a SIBLING repo under the same workspace', () => {
  const { primary, sibling } = makeWorkspaceWithSibling();
  run('git switch main', sibling);
  run('git switch -c merged-elsewhere', sibling);
  run('git commit --allow-empty -m done', sibling);
  run('git switch main', sibling);
  run('git merge --no-ff -m "merge merged-elsewhere" merged-elsewhere', sibling);
  run('git switch integration', sibling);
  assert.ok(branchExists(sibling, 'merged-elsewhere'), 'precondition: sibling branch exists');

  const outcome = runGitHygiene({ commandCwd: primary, eventName: 'Stop', env: SIBLING_ENV });
  assert.ok(!branchExists(sibling, 'merged-elsewhere'), 'merged branch in the SIBLING repo was reaped');
  assert.ok((outcome.siblingBranchesDeleted || []).some((entry) => entry.branch === 'merged-elsewhere'), 'reported sibling deletion');
});

test('Stop: sibling sweep keeps an UNMERGED branch in the sibling repo', () => {
  const { primary, sibling } = makeWorkspaceWithSibling();
  run('git switch -c feature/wip-elsewhere', sibling);
  run('git commit --allow-empty -m wip', sibling);
  run('git switch integration', sibling);
  runGitHygiene({ commandCwd: primary, eventName: 'Stop', env: SIBLING_ENV });
  assert.ok(branchExists(sibling, 'feature/wip-elsewhere'), 'unmerged sibling branch survives');
});

test('Stop: GIT_HYGIENE_SIBLING_SWEEP=0 disables the sibling sweep', () => {
  const { primary, sibling } = makeWorkspaceWithSibling();
  run('git switch main', sibling);
  run('git switch -c merged-elsewhere', sibling);
  run('git commit --allow-empty -m done', sibling);
  run('git switch main', sibling);
  run('git merge --no-ff -m "merge merged-elsewhere" merged-elsewhere', sibling);
  run('git switch integration', sibling);
  runGitHygiene({ commandCwd: primary, eventName: 'Stop', env: { ...process.env, GIT_HYGIENE_SIBLING_SWEEP: '0', GIT_HYGIENE_GRACE_MIN: '0' } });
  assert.ok(branchExists(sibling, 'merged-elsewhere'), 'sweep disabled => sibling branch survives');
});

// ---- BRANCH CAP (new) ----
test('Stop: warns when durable branches exceed the cap', () => {
  const repoRoot = makeRepo();
  for (const suffix of ['a', 'b', 'c', 'd']) {
    run(`git switch -c feature/${suffix}`, repoRoot);
    run(`git commit --allow-empty -m ${suffix}`, repoRoot);
  }
  run('git switch integration', repoRoot);
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop' });
  assert.ok(outcome.durable.length > outcome.branchCap, `durable ${outcome.durable.length} > cap ${outcome.branchCap}`);
  assert.match(formatNote(outcome) || '', /durable local branches/);
});

test('SessionStart: reports ONE parked branch, which the cap warning misses', () => {
  // The gap Russell found 2026-08-17: the cap warning only fires on too MANY
  // branches, so a single branch abandoned for weeks stayed silent. CodeServo
  // had 50 commits parked 581 behind main and nothing anywhere said so.
  const repoRoot = makeRepo();
  run('git switch -c feature/parked', repoRoot);
  run('git commit --allow-empty -m "parked work"', repoRoot);
  run('git switch integration', repoRoot);
  run('git commit --allow-empty -m "trunk moved on"', repoRoot);

  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'SessionStart', env: STALE_ENV });

  assert.ok(outcome.durable.length <= outcome.branchCap, 'this must be UNDER the cap, or it proves nothing');
  const note = formatNote(outcome) || '';
  assert.match(note, /Work parked outside/, 'a parked branch must be named at session start');
  assert.match(note, /feature\/parked/);
  assert.match(note, /\+1\/-1/, 'the drift in both directions must be shown');
});

test('SessionStart: says nothing when no branch is parked', () => {
  // Silence on a clean repository, or the report becomes noise you learn to skip.
  const repoRoot = makeRepo();
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'SessionStart', env: STALE_ENV });

  assert.ok(!outcome.durableDetail?.length, 'nothing parked means nothing to detail');
  assert.doesNotMatch(formatNote(outcome) || '', /Work parked outside/);
});

test('Stop: agent worktree branches do NOT count toward the durable cap', () => {
  const repoRoot = makeRepo();
  addAgentWorktree(repoRoot, 'capagent', { merge: false });
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', env: STALE_ENV });
  assert.ok(!outcome.durable.some((name) => name.startsWith('worktree-agent-')), 'agent branch excluded from durable set');
});

test('PreToolUse: blocks a third active branch before sprawl begins', () => {
  const repoRoot = makeRepo();
  run('git switch -c feature/active', repoRoot);
  run('git commit --allow-empty -m active', repoRoot);
  run('git switch -c feature/second', repoRoot);
  run('git commit --allow-empty -m second', repoRoot);
  run('git switch integration', repoRoot);
  const outcome = runGitHygiene({
    commandCwd: repoRoot, eventName: 'PreToolUse', toolName: 'Bash',
    command: 'git switch -c feature/third',
  });
  assert.strictEqual(outcome.reason, 'branch-sprawl');
  assert.strictEqual(outcome.blocked, true);
  assert.deepStrictEqual(outcome.durable, ['feature/active', 'feature/second']);
});

test('PreToolUse: merged branch labels never consume active-work slots', () => {
  const repoRoot = makeRepo();
  for (const suffix of ['one', 'two', 'three', 'four', 'five', 'six']) {
    run(`git branch feature/spent-${suffix}`, repoRoot);
  }
  run('git switch -c feature/active', repoRoot);
  run('git commit --allow-empty -m active', repoRoot);
  run('git switch integration', repoRoot);
  const outcome = runGitHygiene({
    commandCwd: repoRoot, eventName: 'PreToolUse', toolName: 'Bash',
    command: 'git worktree add -b feature/second ../feature-two',
  });
  assert.strictEqual(outcome.reason, 'pretool-allowed');
  assert.deepStrictEqual(outcome.durable, ['feature/active']);
});

test('PreToolUse: temporary fix branches stay creatable beside two active features', () => {
  const repoRoot = makeRepo();
  for (const suffix of ['active', 'second']) {
    run(`git switch -c feature/${suffix}`, repoRoot);
    run(`git commit --allow-empty -m ${suffix}`, repoRoot);
  }
  run('git switch integration', repoRoot);
  const outcome = runGitHygiene({
    commandCwd: repoRoot, eventName: 'PreToolUse', toolName: 'Bash',
    command: 'git worktree add -b fix/anthropic-http-400 ../repair',
  });
  assert.strictEqual(outcome.reason, 'pretool-allowed');
  assert.deepStrictEqual(outcome.durable, ['feature/active', 'feature/second']);
});

test('PreToolUse: GOAP branches count toward the two active branch cap', () => {
  const repoRoot = makeRepo();
  run('git switch -c feature/goap-planner', repoRoot);
  run('git commit --allow-empty -m goap', repoRoot);
  run('git switch -c feature/active', repoRoot);
  run('git commit --allow-empty -m active', repoRoot);
  run('git switch integration', repoRoot);
  const outcome = runGitHygiene({
    commandCwd: repoRoot, eventName: 'PreToolUse', toolName: 'Bash',
    command: 'git worktree add -b feature/goap-launcher ../active',
  });
  assert.strictEqual(outcome.reason, 'branch-sprawl');
});

test('PreToolUse: a branch-list command never false-blocks', () => {
  const repoRoot = makeRepo();
  for (const suffix of ['one', 'two']) {
    run(`git switch -c feature/${suffix}`, repoRoot);
    run(`git commit --allow-empty -m ${suffix}`, repoRoot);
  }
  run('git switch integration', repoRoot);
  const outcome = runGitHygiene({
    commandCwd: repoRoot, eventName: 'PreToolUse', toolName: 'Bash',
    command: 'git branch --list',
  });
  assert.strictEqual(outcome.reason, 'pretool-allowed');
});

test('PreToolUse end-to-end: emits a real permission denial for branch sprawl', () => {
  const repoRoot = makeRepo();
  run('git switch -c feature/active', repoRoot);
  run('git commit --allow-empty -m active', repoRoot);
  run('git switch -c feature/second', repoRoot);
  run('git commit --allow-empty -m second', repoRoot);
  run('git switch integration', repoRoot);
  const event = JSON.stringify({
    hook_event_name: 'PreToolUse', cwd: repoRoot, tool_name: 'Bash',
    tool_input: { command: 'git checkout -b feature/third' },
  });
  const emitted = JSON.parse(execFileSync(process.execPath, [hookPath], { input: event, encoding: 'utf8' }));
  assert.strictEqual(emitted.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(emitted.hookSpecificOutput.permissionDecisionReason, /Branch sprawl guard/);
});

test('live settings register git-hygiene for the whole lifecycle with no dangling cleaners', () => {
  const settings = JSON.parse(readFileSync(join(here, '..', 'settings.json'), 'utf8'));
  const registrations = [];
  for (const [eventName, groups] of Object.entries(settings.hooks || {})) {
    for (const group of groups || []) {
      for (const hook of group.hooks || []) {
        registrations.push({ eventName, matcher: group.matcher || '*', command: hook.command || '' });
      }
    }
  }
  const gitHygieneEvents = registrations
    .filter((entry) => entry.command.includes('git-hygiene.mjs'))
    .map((entry) => entry.eventName)
    .sort();
  // PreToolUse moved BEHIND the arbiter: settings.json now registers only
  // pretooluse-arbiter.mjs there, and the arbiter runs each guard from a
  // registry GENERATED from settings.json. So a direct PreToolUse entry no
  // longer exists for any guard, and asserting one here was checking the
  // pre-arbiter shape rather than whether the guard actually runs.
  //
  // The invariant is unchanged and still enforced: git-hygiene must cover the
  // whole lifecycle. Only the place PreToolUse coverage LIVES has moved, so
  // that is where it is now read from.
  assert.deepStrictEqual(
    gitHygieneEvents,
    ['PostToolUse', 'SessionEnd', 'SessionStart'],
  );
  const preToolUseRegistry = readFileSync(join(here, 'lib', 'pretooluse-registry.mjs'), 'utf8');
  assert.match(
    preToolUseRegistry,
    /"label":\s*"git-hygiene"/,
    'git-hygiene must still run at PreToolUse — the branch-sprawl blocker is dead code otherwise',
  );
  assert.ok(
    !registrations.some((entry) => /clean-(?:merged-)?worktrees\.mjs/.test(entry.command)),
    'deleted cleaner filenames must never remain registered',
  );
  const stopRegistry = readFileSync(join(here, 'lib', 'stop-registry.mjs'), 'utf8');
  assert.match(stopRegistry, /repoHook\('git-hygiene'/);
  const kimiConfig = readFileSync(join(here, '..', '..', '.kimi-code', 'config.toml'), 'utf8');
  const kimiRegistrations = kimiConfig.split('[[hooks]]').filter((block) => (
    block.includes('command = "node ~/.claude/hooks/git-hygiene.mjs"')
  ));
  assert.ok(kimiRegistrations.some((block) => block.includes('event = "PreToolUse"')));
  assert.ok(kimiRegistrations.some((block) => block.includes('event = "Stop"')));
});

// ---- EVENT ROUTING ----
test('PostToolUse: a non-git command does nothing (no-trigger)', () => {
  const repoRoot = makeRepo();
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'PostToolUse', toolName: 'Bash', command: 'ls -la' });
  assert.strictEqual(outcome.reason, 'no-trigger');
});

test('PostToolUse after a git merge: deletes merged local branches', () => {
  const repoRoot = makeRepo();
  run('git switch main', repoRoot);
  run('git switch -c shipped', repoRoot);
  run('git commit --allow-empty -m shipped', repoRoot);
  run('git switch main', repoRoot);
  run('git merge --no-ff -m "merge shipped" shipped', repoRoot);
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'PostToolUse', toolName: 'Bash', command: 'git merge --no-ff shipped' });
  assert.ok(!branchExists(repoRoot, 'shipped'), 'merged branch deleted on PostToolUse');
  assert.ok(outcome.branchesDeleted.some((entry) => entry.branch === 'shipped'), 'reported');
});

test('SessionEnd: reaps a merged worktree even with a sqlite file present', () => {
  const repoRoot = makeRepo();
  const { worktreePath } = addAgentWorktree(repoRoot, 'sess1', { merge: true });
  writeFileSync(join(worktreePath, 'data.sqlite'), 'x'); // committed? no — but it's the only change and would make it dirty
  run('git add -A', worktreePath);
  run('git commit -m "add db"', worktreePath);
  run('git merge --no-ff -m remerge worktree-agent-sess1', repoRoot);
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'SessionEnd' });
  assert.ok(!existsSync(worktreePath), 'SessionEnd reaped the merged worktree');
  assert.strictEqual(outcome.eventName, 'SessionEnd');
});

// ---- SAFETY ----
test('GIT_HYGIENE_OFF=1 disables everything', () => {
  const repoRoot = makeRepo();
  const { worktreePath } = addAgentWorktree(repoRoot, 'off1', { merge: true });
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', env: { GIT_HYGIENE_OFF: '1' } });
  assert.strictEqual(outcome.reason, 'disabled');
  assert.ok(existsSync(worktreePath), 'disabled => worktree survives');
});

test('fails open outside a git repo', () => {
  const looseDir = mkdtempSync(join(tmpdir(), 'gh-norepo-'));
  tempDirs.push(looseDir);
  const outcome = runGitHygiene({ commandCwd: looseDir, eventName: 'Stop' });
  assert.strictEqual(outcome.reason, 'not-a-repo');
});

test('dry run reports but removes nothing', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'dry1', { merge: true });
  const outcome = runGitHygiene({ commandCwd: repoRoot, eventName: 'Stop', dryRun: true });
  assert.ok(existsSync(worktreePath), 'dry run leaves worktree');
  assert.ok(branchExists(repoRoot, branch), 'dry run leaves branch');
  assert.ok(outcome.worktreesRemoved.some((entry) => entry.dryRun), 'dry run reports the candidate');
});

test('end-to-end through stdin: reaps and emits additionalContext', () => {
  const repoRoot = makeRepo();
  const { branch, worktreePath } = addAgentWorktree(repoRoot, 'e2e1', { merge: true });
  const event = JSON.stringify({ hook_event_name: 'Stop', cwd: repoRoot });
  const stdout = execFileSync(process.execPath, [hookPath], { input: event, encoding: 'utf8', env: { ...process.env, GIT_HYGIENE_GRACE_MIN: '0' } });
  const emitted = JSON.parse(stdout);
  assert.match(emitted.hookSpecificOutput.additionalContext, new RegExp(branch));
  assert.strictEqual(emitted.hookSpecificOutput.hookEventName, 'Stop');
  assert.ok(!existsSync(worktreePath), 'worktree removed via the real hook process');
});

// Cleanup temp dirs.
for (const dir of tempDirs) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows lock; harmless for a temp dir */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
