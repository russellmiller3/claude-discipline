import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateFreshness,
  extractActivePodIds,
  extractBuildTargets,
  findContradictoryStatusClaims,
} from './handoff-freshness-guard.mjs';

const repoDir = 'C:/work/marcus';
const currentGit = (args) => {
  if (args.includes('feature/live')) return 'abc1234';
  throw new Error('missing ref');
};

function evaluate(content, overrides = {}) {
  return evaluateFreshness({
    content,
    repoDir,
    pathExists: () => false,
    git: currentGit,
    listProviderPods: () => [],
    ...overrides,
  });
}

test('extractBuildTargets finds an explicit target on the BUILD line or its continuation', () => {
  assert.deepEqual(
    extractBuildTargets('1. **BUILD `handoff-freshness-guard` now.**'),
    ['handoff-freshness-guard'],
  );
  assert.deepEqual(
    extractBuildTargets('2. **BUILD: local monitor links.**\n`experiment-monitor-required` owns this.'),
    ['experiment-monitor-required'],
  );
});

test('BLOCKS a BUILD instruction whose named target already exists', () => {
  const verdict = evaluate('1. **BUILD `handoff-freshness-guard`.**', {
    pathExists: (candidate) => candidate.replaceAll('\\', '/').endsWith('/.claude/hooks/handoff-freshness-guard.mjs'),
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /already exists/i);
});

test('allows a BUILD instruction while its target does not exist', () => {
  assert.equal(evaluate('1. **BUILD `missing-guard`.**').block, false);
});

test('findContradictoryStatusClaims matches the same named task as active and terminal', () => {
  const contradictions = findContradictoryStatusClaims([
    '# Handoff — Depth Repair running at $0',
    '| **Depth Repair (170)** | killed; redesign required |',
  ].join('\n'));
  assert.equal(contradictions.length, 1);
  assert.match(contradictions[0], /Depth Repair/i);
});

test('BLOCKS RUNNING/in-flight claims contradicted by a terminal claim for the same task', () => {
  const verdict = evaluate([
    '# Handoff — Depth Repair running at $0',
    '| **Depth Repair (170)** | killed; redesign required |',
  ].join('\n'));
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /contradict/i);
});

test('does not mistake explicit zero/none wording for an active claim', () => {
  const verdict = evaluate('NO pods exist. STILL RUNNING: none. Every old pod was deleted.');
  assert.equal(verdict.block, false);
});

test('does not mistake a wrapped STILL RUNNING: none claim for active work', () => {
  const verdict = evaluate([
    '- **NO pods exist.** Every pod was deleted and verified ("STILL RUNNING:',
    '  none"). Any old pod id is dead.',
    '**MONEY: ZERO running.** All pods deleted and verified.',
  ].join('\n'));
  assert.equal(verdict.block, false);
});

test('extractActivePodIds reads only positive live-pod claims', () => {
  assert.deepEqual(extractActivePodIds('Pod `abc123def456` is RUNNING.'), ['abc123def456']);
  assert.deepEqual(extractActivePodIds('Pod `abc123def456` is NOT RUNNING; it was deleted.'), []);
});

test('BLOCKS an active pod id absent from the provider list', () => {
  const verdict = evaluate('Pod `abc123def456` is RUNNING.', {
    listProviderPods: () => [{ id: 'different98765' }],
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /provider/i);
});

test('allows an active pod id present in the provider list', () => {
  const verdict = evaluate('Pod `abc123def456` is RUNNING.', {
    listProviderPods: () => [{ id: 'abc123def456' }],
  });
  assert.equal(verdict.block, false);
});

test('provider failure blocks unless the uncheckable escape gives a reason', () => {
  const unavailable = () => { throw new Error('credential missing'); };
  const blocked = evaluate('Pod `abc123def456` is RUNNING.', { listProviderPods: unavailable });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /HANDOFF_FRESHNESS_UNCHECKABLE/i);

  const escaped = evaluate('Pod `abc123def456` is RUNNING.', {
    listProviderPods: unavailable,
    assistantText: 'HANDOFF_FRESHNESS_UNCHECKABLE: provider maintenance window',
  });
  assert.equal(escaped.block, false);
});

test('reuses the existing branch/head check and blocks a moved head', () => {
  const verdict = evaluate('**Repo:** `C:/work/marcus` on branch `feature/live` (head `dead999`).');
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /does not match/i);
});

test('allows a handoff whose branch, build targets, statuses, and pods are current', () => {
  const verdict = evaluate([
    '**Repo:** `C:/work/marcus` on branch `feature/live` (head `abc1234`).',
    'Next: BUILD `not-built-yet`.',
    'No pods are running.',
  ].join('\n'));
  assert.deepEqual(verdict, { block: false });
});
