#!/usr/bin/env node
// Tests for commit-cadence-guard — the PreToolUse mid-flow half and the Stop half added
// 2026-07-28 ("a stop hook", Russell). End-to-end: the hook is executed as a real process
// with a JSON payload on stdin, against a REAL temp git repo, so the git plumbing is
// exercised rather than mocked. A mocked git would prove nothing about `diff --stat HEAD`.
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), 'commit-cadence-guard.mjs');
const STATE_DIR = mkdtempSync(join(tmpdir(), 'cadence-state-'));
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) { passed += 1; console.log(`  ok  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}`); }
}

/** A throwaway git repo with one commit, so HEAD exists and `diff --stat HEAD` works. */
function makeRepo({ initializeBaseline = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cadence-'));
  const run = (cmd) => execSync(cmd, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
  run('git init -q');
  run('git config user.email t@t.t');
  run('git config user.name Test');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  run('git add -A');
  run('git commit -q -m seed --no-verify');
  if (initializeBaseline) invoke(editPayload(dir));
  return dir;
}

/** Invoke the hook as the harness does. Returns {exitCode, stdout}. */
function invoke(payload, env = {}) {
  try {
    const stdout = execFileSync('node', [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, COMMIT_CADENCE_OK: '', COMMIT_CADENCE_STATE_DIR: STATE_DIR, ...env },
    });
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: String(error.stdout ?? '') };
  }
}

const stopPayload = (cwd, extra = {}) => ({ hook_event_name: 'Stop', session_id: cwd, cwd, ...extra });
const editPayload = (cwd) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: cwd, cwd,
  tool_input: { file_path: join(cwd, 'x.txt'), old_string: 'a', new_string: 'b' },
});

// ── STOP PATH ────────────────────────────────────────────────────────────────────────
// The failure this half exists to stop: a turn that ends with finished work on disk.
{
  const repo = makeRepo();
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `new${i}.txt`), 'work\n'.repeat(20));
  const { exitCode, stdout } = invoke(stopPayload(repo));
  // cadence-override: fixing this guard's own stdout-truncation bug — see commit-cadence-guard.mjs.
  // exitCode 0 (not the old 2) is the FIX under test: process.exit(2) right after an async pipe
  // write raced the flush and truncated the JSON, so the harness saw a dead process with nothing
  // parseable instead of a real decision. The decision lives in stdout JSON, not the exit code.
  check('Stop BLOCKS when uncommitted work is over the threshold (clean exit, no truncation)',
    exitCode === 0 && JSON.parse(stdout).decision === 'block');
  check('Stop block names the no-dirt rule, not just the count', /NO-DIRT HANDOFF/i.test(stdout));
  check('Stop block emits decision:block', /"decision"\s*:\s*"block"/.test(stdout));
  check('Stop block requires explicit path staging', /stage paths explicitly/i.test(stdout));
  check('Stop block never recommends git add -A', !/git add -A/i.test(stdout));
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = makeRepo({ initializeBaseline: false });
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `user${i}.txt`), 'pre-existing user work\n'.repeat(20));
  check('Stop BLOCKS pre-existing dirt so it cannot leak to the next agent',
    /"decision"\s*:\s*"block"/.test(invoke(stopPayload(repo)).stdout));
  check('PreToolUse ALLOWS pre-existing dirty work and records a session baseline',
    invoke(editPayload(repo)).exitCode === 0);
  // cadence-override: continuing the same truncation-bug fix as the Stop-path test above.
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `agent${i}.txt`), 'new session work\n'.repeat(20));
  const blockedResult = invoke(editPayload(repo));
  check('PreToolUse BLOCKS after session-owned work crosses the threshold (clean exit, no truncation)',
    blockedResult.exitCode === 0 && JSON.parse(blockedResult.stdout).permissionDecision === 'deny');
  rmSync(repo, { recursive: true, force: true });
}

// NEGATIVE CASES — a guard that only proves it FIRES has proven nothing about over-firing.
{
  const repo = makeRepo();
  check('Stop ALLOWS a clean tree (nothing to bank)', invoke(stopPayload(repo)).exitCode === 0);
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = makeRepo();
  writeFileSync(join(repo, 'tiny.txt'), 'one line\n');
  check('Stop BLOCKS even one tiny dirty file',
    /NO-DIRT HANDOFF/i.test(invoke(stopPayload(repo)).stdout));
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = makeRepo();
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `n${i}.txt`), 'work\n'.repeat(20));
  const transcript = join(repo, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ text: 'cadence-override: mid-refactor, banking next turn' }));
  check('a model-authored cadence override cannot bypass no-dirt',
    /NO-DIRT HANDOFF/i.test(invoke(stopPayload(repo, { transcript_path: transcript })).stdout));
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = makeRepo();
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `n${i}.txt`), 'work\n'.repeat(20));
  check('an environment override cannot bypass no-dirt',
    /NO-DIRT HANDOFF/i.test(invoke(stopPayload(repo), { COMMIT_CADENCE_OK: '1' }).stdout));
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = makeRepo();
  writeFileSync(join(repo, 'uncertain.txt'), 'inherited work\n');
  const transcript = join(repo, 'safety-approval.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Safety concern: committing this inherited work could cause irreversible data loss.' }] }),
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'Yes, proceed.' }] }),
  ].join('\n'));
  check('human approval after a concrete safety concern is the sole no-dirt bypass',
    invoke(stopPayload(repo, { transcript_path: transcript })).stdout === '');
  rmSync(repo, { recursive: true, force: true });
}
{
  // Fail OPEN outside a repo: a guard that blocks everywhere gets disabled by its owner.
  const notARepo = mkdtempSync(join(tmpdir(), 'norepo-'));
  mkdirSync(join(notARepo, 'sub'), { recursive: true });
  check('Stop ALLOWS outside a git repo (fails open)',
    invoke(stopPayload(join(notARepo, 'sub'))).exitCode === 0);
  rmSync(notARepo, { recursive: true, force: true });
}

// ── HANDOFF FRESHNESS ────────────────────────────────────────────────────────────────
{
  const repo = makeRepo();
  writeFileSync(join(repo, 'HANDOFF.md'), 'stale parachute\n');
  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(repo, 'HANDOFF.md'), old, old);   // older than the seed commit
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `n${i}.txt`), 'work\n'.repeat(20));
  // CONTRACT CHANGED 2026-08-17 (Russell: "commit guard should say to refresh but never commit
  // handoff"). This used to assert the mtime-vs-newest-commit staleness message. That predicate
  // was unsatisfiable by construction: a commit always lands AFTER the file you refreshed to
  // prepare it, so refreshing the handoff and then committing made it instantly "stale" again —
  // an infinite loop even where the file IS tracked. The assertion is narrowed rather than
  // deleted, per the 2026-08-16 rule on newly-red sibling tests: it now defends the claim that
  // replaced it, so the original fixture still earns its keep.
  const staleStop = invoke(stopPayload(repo)).stdout;
  check('Stop still blocks while real work sits uncommitted',
    /NO-DIRT HANDOFF|COMMIT BEFORE YOU STOP|CHECKPOINT REQUIRED/i.test(staleStop));
  // Match the IMPERATIVE forms, never the bare co-occurrence of "commit" and "handoff": the
  // first draft of this assertion did the latter and so failed on the sentence that FORBIDS
  // committing the handoff. A prohibition and an instruction read alike to a proximity regex.
  check('Stop NEVER instructs committing the handoff',
    !/and commit it with the checkpoint/i.test(staleStop)
    && !/refresh and commit it/i.test(staleStop)
    && !/HANDOFF\.md is older than your newest commit/i.test(staleStop));
  check('Stop says outright that the handoff is refreshed, never committed',
    /never commit the handoff/i.test(staleStop));
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = makeRepo({ initializeBaseline: false });
  writeFileSync(join(repo, 'HANDOFF.md'), 'before checkpoint\n');
  invoke(editPayload(repo));
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `checkpoint${i}.txt`), 'work\n'.repeat(20));
  const result = invoke(stopPayload(repo));
  check('checkpoint block requires a fresh HANDOFF update',
    /refresh.*HANDOFF\.md|update.*HANDOFF\.md/i.test(result.stdout));
  check('checkpoint block still requires the WIP commit', /commit/i.test(result.stdout));
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = makeRepo({ initializeBaseline: false });
  writeFileSync(join(repo, 'HANDOFF.md'), 'before checkpoint\n');
  invoke(editPayload(repo));
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `checkpoint${i}.txt`), 'work\n'.repeat(20));
  invoke(stopPayload(repo));
  writeFileSync(join(repo, 'HANDOFF.md'), 'after checkpoint\n');
  execSync('git add checkpoint0.txt checkpoint1.txt checkpoint2.txt checkpoint3.txt && git commit -q --no-verify -m checkpoint', { cwd: repo });
  // CONTRACT CHANGED 2026-08-17, same reason. A dirty handoff is EXPECTED working state, not a
  // leak: it is refreshed every few turns and never committed, and in `~/.claude` it is gitignored
  // outright so `git add` refuses it. Demanding it be resolved before Stop named an action that
  // cannot be performed. Narrowed to the surviving claim — real work is committed here, so the
  // handoff is the ONLY dirt left, and that alone must not block.
  check('a dirty handoff ALONE does not block Stop', invoke(stopPayload(repo)).stdout === '');
  execSync('git add HANDOFF.md && git commit -q --no-verify -m handoff', { cwd: repo });
  const result = invoke(stopPayload(repo));
  check('committing both the work chunk and refreshed HANDOFF clears the checkpoint',
    result.exitCode === 0 && result.stdout === '');
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = makeRepo({ initializeBaseline: false });
  writeFileSync(join(repo, 'HANDOFF.md'), 'before checkpoint\n');
  invoke(editPayload(repo));
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `checkpoint${i}.txt`), 'work\n'.repeat(20));
  invoke(stopPayload(repo));
  execSync('git add checkpoint0.txt checkpoint1.txt checkpoint2.txt checkpoint3.txt && git commit -q --no-verify -m checkpoint', { cwd: repo });
  const result = invoke(editPayload(repo));
  check('a commit without the HANDOFF update still blocks the next mutation',
    /refresh.*HANDOFF\.md|update.*HANDOFF\.md/i.test(result.stdout));
  const patchResult = invoke({
    hook_event_name: 'PreToolUse', tool_name: 'apply_patch', session_id: repo, cwd: repo,
    tool_input: { patch: '*** Update File: checkpoint-next.txt\n@@\n+next\n' },
  });
  check('Codex apply_patch is covered by the same checkpoint gate',
    /CHECKPOINT REQUIRED/i.test(patchResult.stdout));
  const handoffPatchResult = invoke({
    hook_event_name: 'PreToolUse', tool_name: 'apply_patch', session_id: repo, cwd: repo,
    tool_input: { patch: '*** Update File: HANDOFF.md\n@@\n+next\n' },
  });
  check('a handoff-only apply_patch remains an allowed repair step', handoffPatchResult.exitCode === 0);
  rmSync(repo, { recursive: true, force: true });
}

// ── PRETOOLUSE PATH (the pre-existing half must not regress) ──────────────────────────
{
  const repo = makeRepo();
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `n${i}.txt`), 'work\n'.repeat(20));
  // cadence-override: continuing the same truncation-bug fix as the other two blocks above.
  const { exitCode, stdout } = invoke(editPayload(repo));
  check('PreToolUse still BLOCKS a mutation over the threshold (clean exit, no truncation)', exitCode === 0);
  check('PreToolUse still emits permissionDecision:deny', /"permissionDecision"\s*:\s*"deny"/.test(stdout));
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = makeRepo();
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `n${i}.txt`), 'work\n'.repeat(20));
  check('PreToolUse ALLOWS a read-only Bash command mid-investigation',
    invoke({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: repo, tool_input: { command: 'git status --short' } }).exitCode === 0);
  check('PreToolUse ALLOWS a non-mutating tool (Read)',
    invoke({ hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: repo, tool_input: {} }).exitCode === 0);
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = makeRepo();
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `n${i}.txt`), 'work\n'.repeat(20));
  check('PreToolUse ALLOWS the git commit remedy it prescribes',
    invoke({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: repo,
      tool_input: { command: 'git add -A && git commit --no-verify -m "wip: bank work"' },
    }).exitCode === 0);
  rmSync(repo, { recursive: true, force: true });
}

// ── MALFORMED INPUT — a guard that crashes on junk stdin blocks nothing at all. ───────
{
  try {
    execFileSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
    check('malformed stdin exits cleanly (fails open)', true);
  } catch {
    check('malformed stdin exits cleanly (fails open)', false);
  }
}

console.log(`\n${failed === 0 ? 'All' : `${passed}/${passed + failed}`} commit-cadence-guard checks passed.`);
rmSync(STATE_DIR, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
