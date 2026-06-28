// Tests for agent-monitor-cadence — the two pure detectors the Stop gate keys on.
// Run: node --test agent-monitor-cadence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { activeAgentCount, recentlyCheckedAgents, staleAgentBranches, agentBranchAges, staleAgentsFromPulseLog, completedAgentLabels, staleAgentBranchesByRef, unsurfacedOrphans, orphanKey } from './agent-monitor-cadence.mjs';
import { join as joinPath } from 'node:path';

// THE RELIABLE DETECTOR (2026-06-28): an agent branch's loose-ref-file mtime. Build a fake workspace with a repo
// holding feature/* refs, backdate one, and assert only the stale one is flagged — and a merged-done branch (no ref
// file) never appears.
test('staleAgentBranchesByRef: flags a stale agent-branch ref, ignores a fresh one and non-agent branches', () => {
  const workspace = mkdtempSync(joinPath(tmpdir(), 'amc-ws-'));
  const repo = joinPath(workspace, 'myrepo');
  const featureHeads = joinPath(repo, '.git', 'refs', 'heads', 'feature');
  mkdirSync(featureHeads, { recursive: true });
  mkdirSync(joinPath(repo, '.git', 'refs', 'heads'), { recursive: true });
  const staleRef = joinPath(featureHeads, 'dead-agent');
  const freshRef = joinPath(featureHeads, 'live-agent');
  const mainRef = joinPath(repo, '.git', 'refs', 'heads', 'main'); // non-agent branch: must be ignored
  writeFileSync(staleRef, 'deadbeef\n');
  writeFileSync(freshRef, 'cafef00d\n');
  writeFileSync(mainRef, 'abc123\n');
  const now = Date.now();
  const stale = new Date(now - 25 * 60000); // 25 min → inside (20, 45) window → STUCK
  utimesSync(staleRef, stale, stale);
  utimesSync(mainRef, stale, stale); // even though stale, it's not an agent branch → ignored

  const stuck = staleAgentBranchesByRef(repo, now, 20 * 60000, 45 * 60000);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].branch, 'feature/dead-agent');
});

test('staleAgentBranchesByRef: a freshly-created branch ref (just-launched agent) is NOT flagged', () => {
  const workspace = mkdtempSync(joinPath(tmpdir(), 'amc-ws2-'));
  const repo = joinPath(workspace, 'r');
  const heads = joinPath(repo, '.git', 'refs', 'heads', 'feature');
  mkdirSync(heads, { recursive: true });
  writeFileSync(joinPath(heads, 'just-born'), 'x\n'); // mtime ≈ now
  assert.deepEqual(staleAgentBranchesByRef(repo, Date.now(), 20 * 60000, 45 * 60000), []);
});

test('staleAgentBranchesByRef: an ANCIENT ref (past the window) is NOT flagged — not a current agent', () => {
  const workspace = mkdtempSync(joinPath(tmpdir(), 'amc-ws3-'));
  const repo = joinPath(workspace, 'r');
  const heads = joinPath(repo, '.git', 'refs', 'heads', 'feature');
  mkdirSync(heads, { recursive: true });
  const ref = joinPath(heads, 'old-thing');
  writeFileSync(ref, 'x\n');
  const ancient = new Date(Date.now() - 5 * 60 * 60000); // 5 hours → outside the 45-min window
  utimesSync(ref, ancient, ancient);
  assert.deepEqual(staleAgentBranchesByRef(repo, Date.now(), 20 * 60000, 45 * 60000), []);
});

test('completedAgentLabels: extracts a finished agent label from its task-notification', () => {
  const transcript = '<task-notification><summary>Agent "UAT the stub Workspace" finished</summary><status>completed</status></task-notification>';
  const labels = completedAgentLabels(transcript);
  assert.ok(labels.has('UAT the stub Workspace'));
});

test('staleAgentsFromPulseLog: a COMPLETED agent (in excludeLabels) is not flagged even if its last pulse was not DONE', () => {
  const now = Date.UTC(2026, 5, 28, 12, 0, 0);
  const log = pulseLine(now, 27, 'UAT the stub Workspace', 'Agent: case 22 fixed. Progress: 6/7');
  const excluded = new Set(['UAT the stub Workspace']);
  assert.deepEqual(staleAgentsFromPulseLog(log, now, 12 * 60 * 1000, 45 * 60 * 1000, excluded), []);
});

// Helper: a pulse line at `minutesAgo` for `label`.
const pulseLine = (now, minutesAgo, label, message) =>
  `[${new Date(now - minutesAgo * 60000).toISOString()}] [${label}] ${message}`;

test('staleAgentsFromPulseLog: flags a non-DONE agent idle past the window, ignores a fresh one', () => {
  const now = Date.UTC(2026, 5, 28, 12, 0, 0);
  const log = [
    pulseLine(now, 1, 'search-ui', 'Agent: building SearchSurface. Progress: 4/8'), // fresh → healthy
    pulseLine(now, 20, 'projects-p1', 'Agent: Cycle 1.4 GREEN. Progress: 8/10'),     // 20m, no DONE → STUCK
  ].join('\n');
  const stuck = staleAgentsFromPulseLog(log, now, 12 * 60 * 1000);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].label, 'projects-p1');
});

test('staleAgentsFromPulseLog: a stale agent whose last pulse is DONE is NOT stuck', () => {
  const now = Date.UTC(2026, 5, 28, 12, 0, 0);
  const log = pulseLine(now, 30, 'compete', 'DONE: positioning doc written, wedge validated');
  assert.deepEqual(staleAgentsFromPulseLog(log, now, 12 * 60 * 1000), []);
});

test('staleAgentsFromPulseLog: ignores the Main thread label (the orchestrator, not a background agent)', () => {
  const now = Date.UTC(2026, 5, 28, 12, 0, 0);
  const log = pulseLine(now, 40, 'Main thread', 'Agent: Edited launch.json');
  assert.deepEqual(staleAgentsFromPulseLog(log, now, 12 * 60 * 1000), []);
});

test('staleAgentsFromPulseLog: a just-launched agent (recent pulse, old base commit) is healthy — the false-positive class', () => {
  const now = Date.UTC(2026, 5, 28, 12, 0, 0);
  const log = pulseLine(now, 0.5, 'folders', 'GOAL: design the org-model. Plan: 5 checkpoints');
  assert.deepEqual(staleAgentsFromPulseLog(log, now, 12 * 60 * 1000), []);
});

test('staleAgentsFromPulseLog: an ANCIENT label (pulsed weeks ago) is NOT flagged — the global-history bug', () => {
  const now = Date.UTC(2026, 5, 28, 12, 0, 0);
  // the exact bug: the pulse log is a months-long global history. A label last seen 65000 min ago is not a
  // current agent and must NOT be reported as stuck, even though it never said DONE.
  const log = [
    pulseLine(now, 65000, 'Phase 3', 'Agent: some old work from a different session'),
    pulseLine(now, 20, 'projects-p1', 'Agent: Cycle 1.4 GREEN. Progress: 8/10'), // recent + silent → the real stuck one
  ].join('\n');
  const stuck = staleAgentsFromPulseLog(log, now, 12 * 60 * 1000, 45 * 60 * 1000);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].label, 'projects-p1');
});

test('staleAgentsFromPulseLog: a label whose last line is only the orchestrator Goal: pulse is NOT flagged (the 27-orphan noise fix)', () => {
  const now = Date.UTC(2026, 5, 28, 15, 30, 0);
  const log = [
    // orchestrator placeholders: only ever a Goal line, never a DONE → must NOT flag (the agent pulses under its own label)
    pulseLine(now, 90, 'Phase 4 Activity surface', 'Agent: Goal: Phase 4 Activity surface.'),
    pulseLine(now, 21, 'Research AI plays logistics', 'Agent: Goal: Research AI plays logistics.'),
    // a real agent that pulsed WORK and then died → must flag
    pulseLine(now, 33, 'review-projects', 'Plan: 6 checkpoints — map scoped queries, audit project_id'),
  ].join('\n');
  const stuck = staleAgentsFromPulseLog(log, now, 2 * 60 * 1000, 12 * 60 * 60 * 1000);
  assert.deepEqual(stuck.map((s) => s.label), ['review-projects']);
});

test('staleAgentsFromPulseLog: empty log → null (caller falls back to the git path)', () => {
  assert.equal(staleAgentsFromPulseLog('', Date.UTC(2026, 5, 28, 12, 0, 0), 12 * 60 * 1000), null);
});

test('staleAgentsFromPulseLog: uses the LATEST line per label (recent activity overrides an old line)', () => {
  const now = Date.UTC(2026, 5, 28, 12, 0, 0);
  const log = [
    pulseLine(now, 40, 'uat', 'Agent: booting vite. Progress: 3/7'),  // old
    pulseLine(now, 2, 'uat', 'Agent: case 12 passing. Progress: 6/7'), // recent → healthy
  ].join('\n');
  assert.deepEqual(staleAgentsFromPulseLog(log, now, 12 * 60 * 1000), []);
});

// THE CROSS-SESSION DEADMAN (2026-06-28 fix): when a session ENDS, its background agents die with it. The OLD Stop-only
// monitor was gated on activeAgentCount(currentTranscript) — so a fresh session, whose transcript has ZERO spawns, never
// looked at the stale branches and never alerted that 3 agents had died in the prior session. The fix: a SessionStart
// orphan scan over the GLOBAL pulse log (session-independent), surfacing each pulsed-then-silent label ONCE.

test('staleAgentsFromPulseLog: each stuck entry carries a stable atMs (dedup key survives across sessions, idleMs does not)', () => {
  const now = Date.UTC(2026, 5, 28, 15, 0, 0);
  const log = pulseLine(now, 20, 'dreaming-build', 'Agent: Running the full test gate now. Progress: 6/6');
  const stuck = staleAgentsFromPulseLog(log, now, 5 * 60 * 1000, 12 * 60 * 60 * 1000);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].atMs, now - 20 * 60000); // the pulse time, not "now - idle" — stable next session
});

test('unsurfacedOrphans: drops orphans already surfaced (keyed by label@atMs), keeps new ones', () => {
  const now = Date.UTC(2026, 5, 28, 15, 0, 0);
  const a = { label: 'dreaming-build', atMs: now - 20 * 60000, idleMs: 20 * 60000, lastLine: 'x' };
  const b = { label: 'servo-headless', atMs: now - 7 * 60000, idleMs: 7 * 60000, lastLine: 'y' };
  const surfaced = new Set([orphanKey(a)]);
  const fresh = unsurfacedOrphans([a, b], surfaced);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].label, 'servo-headless');
});

test('orphanKey: same label + same pulse time → same key (stable); a later pulse → a new key', () => {
  const t = Date.UTC(2026, 5, 28, 14, 46, 0);
  assert.equal(orphanKey({ label: 'dreaming-build', atMs: t }), orphanKey({ label: 'dreaming-build', atMs: t }));
  assert.notEqual(orphanKey({ label: 'dreaming-build', atMs: t }), orphanKey({ label: 'dreaming-build', atMs: t + 60000 }));
});

test('SessionStart orphan threshold (5 min) flags a prior-session agent that died — the exact failure Russell hit', () => {
  // dreaming/review/servo last pulsed ~14:54; a fresh session boots at 15:13 → ~19 min silent, no DONE → orphans.
  const now = Date.UTC(2026, 5, 28, 15, 13, 0);
  const log = [
    pulseLine(now, 19, 'review-projects', 'Plan: 6 checkpoints — map scoped queries, audit project_id'),
    pulseLine(now, 19, 'servo-headless', 'Agent: worktree up, node_modules linked; reading skaffen servo refs'),
    pulseLine(now, 27, 'dreaming-build', 'Agent: Running the full test gate now. Progress: 6/6'),
  ].join('\n');
  const stuck = staleAgentsFromPulseLog(log, now, 5 * 60 * 1000, 12 * 60 * 60 * 1000);
  assert.deepEqual(stuck.map((s) => s.label).sort(), ['dreaming-build', 'review-projects', 'servo-headless']);
});

const spawnBlock = (id) => `{"id":"${id}","name":"Agent","input":{"run_in_background":true,"prompt":"do a thing"}}`;
const completedNotification = (id) => `<task-notification><tool-use-id>${id}</tool-use-id><status>completed</status></task-notification>`;

test('activeAgentCount counts a spawned background agent', () => {
  assert.equal(activeAgentCount(spawnBlock('toolu_abc')), 1);
});

test('activeAgentCount clears an agent once its completed task-notification arrives', () => {
  const transcript = spawnBlock('toolu_abc') + '\n' + completedNotification('toolu_abc');
  assert.equal(activeAgentCount(transcript), 0);
});

test('activeAgentCount counts two live and subtracts one completed', () => {
  const transcript = spawnBlock('toolu_a') + '\n' + spawnBlock('toolu_b') + '\n' + completedNotification('toolu_a');
  assert.equal(activeAgentCount(transcript), 1);
});

test('activeAgentCount is 0 with no background agents', () => {
  assert.equal(activeAgentCount('just some chatter, no agents here'), 0);
});

test('recentlyCheckedAgents true when the transcript tail has a git agent-branch check', () => {
  const path = resolve(tmpdir(), `monitor-test-checked-${process.pid}.jsonl`);
  writeFileSync(path, 'ran: git log --oneline -1 worktree-agent-a58c888e7f2f19313');
  try {
    assert.equal(recentlyCheckedAgents(path), true);
  } finally {
    rmSync(path, { force: true });
  }
});

test('recentlyCheckedAgents false when no agent-branch check is present', () => {
  const path = resolve(tmpdir(), `monitor-test-unchecked-${process.pid}.jsonl`);
  writeFileSync(path, 'ran: npm test and edited a file, no agent branch inspected');
  try {
    assert.equal(recentlyCheckedAgents(path), false);
  } finally {
    rmSync(path, { force: true });
  }
});

test('recentlyCheckedAgents false for a missing path (fail-open)', () => {
  assert.equal(recentlyCheckedAgents(resolve(tmpdir(), 'does-not-exist-xyz.jsonl')), false);
});

// THE FIX: the hook detects a stuck agent ITSELF (stale branch), instead of clearing on a throwaway git glance.
const TWELVE_MIN = 12 * 60 * 1000;

test('staleAgentBranches flags a branch idle past the threshold and ignores a fresh one', () => {
  const branchAges = [
    { branch: 'worktree-agent-stuck', ageMs: 30 * 60 * 1000 }, // 30 min idle → stuck
    { branch: 'worktree-agent-busy', ageMs: 1 * 60 * 1000 },   // 1 min idle → working
  ];
  const stuck = staleAgentBranches(branchAges, TWELVE_MIN);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].branch, 'worktree-agent-stuck');
});

test('staleAgentBranches returns none when every agent committed recently', () => {
  const fresh = staleAgentBranches([{ branch: 'worktree-agent-a', ageMs: 2 * 60 * 1000 }], TWELVE_MIN);
  assert.equal(fresh.length, 0);
});

test('agentBranchAges parses git for-each-ref output into branch ages (injected git)', () => {
  const now = 2_000_000_000_000; // fixed "now" in ms
  const fakeGit = () => `worktree-agent-aaa 1999999000\nworktree-agent-bbb 1999999940\n`; // 1000s and 60s ago
  const ages = agentBranchAges('/repo', now, fakeGit);
  assert.deepEqual(ages, [
    { branch: 'worktree-agent-aaa', ageMs: 1_000_000 }, // 1000s
    { branch: 'worktree-agent-bbb', ageMs: 60_000 },    // 60s
  ]);
});

test('agentBranchAges returns null when git is unavailable (fail-open to the cadence nag)', () => {
  assert.equal(agentBranchAges('/repo', Date.now(), () => null), null);
});
