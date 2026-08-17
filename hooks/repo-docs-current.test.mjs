/**
 * Every repository gets ONE trustworthy entry document — proven on real repos.
 *
 * The failures this was built from, all real, all in CodeServo on 2026-08-17:
 * four files each claiming to be the source of truth, an entry doc that said
 * "69 tools" while there were 73, and a 68 KB "queue" with "# START HERE" at
 * line 578. Russell: "all the documentation and update machinery you created
 * for this repo i want it to be enforced for every repo."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HANDOFF_MAX_BYTES,
  findDocProblems,
  renderDocumentMap,
  renderTruth,
} from '../scripts/repo-truth-doc.mjs';
import { buildNotice } from './repo-docs-current.mjs';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'repo-docs-'));
  const run = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  run('init', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  writeFileSync(join(root, 'README.md'), '# demo\n', 'utf8');
  run('add', '-A');
  run('commit', '-m', 'first real commit');
  return root;
}

const MARKED = [
  '# Demo - Truth',
  '',
  'Hand-written opening nobody may touch.',
  '',
  '<!-- truth:generated:document-map START -->',
  'stale map',
  '<!-- truth:generated:document-map END -->',
  '',
  'Judgement below, equally untouchable.',
  '',
].join('\n');

test('a repository with no TRUTH.md is reported', () => {
  const root = makeRepo();
  const problems = findDocProblems(root);
  assert.ok(problems.some((problem) => /No TRUTH\.md/.test(problem)));
});

test('the complaint always names the command that clears it', () => {
  const root = makeRepo();
  for (const problem of findDocProblems(root)) {
    assert.match(problem, /repo-truth-doc\.mjs/, 'a gate must say how to satisfy it');
  }
});

test('an oversized HANDOFF is reported as a diary, not a queue', () => {
  const root = makeRepo();
  writeFileSync(join(root, 'HANDOFF.md'), 'x'.repeat(HANDOFF_MAX_BYTES + 1), 'utf8');
  assert.ok(findDocProblems(root).some((problem) => /over the .* ceiling/.test(problem)));
});

test('a queue-sized HANDOFF is not reported', () => {
  const root = makeRepo();
  writeFileSync(join(root, 'HANDOFF.md'), '# what to do next\n', 'utf8');
  assert.ok(!findDocProblems(root).some((problem) => /ceiling/.test(problem)));
});

test('hand-written prose survives regeneration', () => {
  // The safety property that makes a generator acceptable inside a human document.
  const root = makeRepo();
  const rendered = renderTruth(MARKED, root, { includeGitSections: false });
  assert.match(rendered, /Hand-written opening nobody may touch\./);
  assert.match(rendered, /Judgement below, equally untouchable\./);
  assert.doesNotMatch(rendered, /stale map/);
});

test('the document map lists only files that actually exist', () => {
  const root = makeRepo();
  const map = renderDocumentMap(root);
  assert.match(map, /README\.md/);
  assert.doesNotMatch(map, /CONTRIBUTING\.md/, 'a map naming absent files is worse than none');
});

test('a document with no markers is left completely alone', () => {
  // Repositories that keep their own richer generator (CodeServo does) must not
  // have this one fight them for the same file.
  const root = makeRepo();
  const foreign = '# Truth\n\nOwned by another generator entirely.\n';
  assert.equal(renderTruth(foreign, root, { includeGitSections: false }), foreign);
});

test('a TRUTH.md whose map is current reports nothing about the map', () => {
  const root = makeRepo();
  // The file must EXIST before the map is rendered, because the map lists
  // TRUTH.md itself — rendering first and writing after produces a map missing
  // its own row. `main()` gets this right by writing the starter, then reading
  // it back and rendering; this fixture has to do the same.
  writeFileSync(join(root, 'TRUTH.md'), MARKED, 'utf8');
  writeFileSync(join(root, 'TRUTH.md'), renderTruth(MARKED, root, { includeGitSections: false }), 'utf8');

  const problems = findDocProblems(root);

  assert.ok(!problems.some((problem) => /document map/.test(problem)));
});

test('creating TRUTH.md leaves the map naming TRUTH.md itself', () => {
  // Guards the idempotence trap above: a generator whose own output is stale the
  // instant it runs would make the gate unsatisfiable on a fresh repository.
  const root = makeRepo();
  writeFileSync(join(root, 'TRUTH.md'), MARKED, 'utf8');
  const rendered = renderTruth(MARKED, root, { includeGitSections: false });

  assert.match(rendered, /TRUTH\.md/, 'the entry document must appear in its own map');
  assert.equal(
    renderTruth(rendered, root, { includeGitSections: false }),
    rendered,
    'a second render must change nothing',
  );
});

test('recent-work staleness is a WINDOW, so a commit cannot re-break it', () => {
  // The trap: a gate demanding exactness fails every commit, including the one
  // that refreshed it. Its satisfying action must not re-falsify it.
  const root = makeRepo();
  const truth = `${renderTruth(MARKED, root, { includeGitSections: false })}\n\nfirst real commit\n`;
  writeFileSync(join(root, 'TRUTH.md'), truth, 'utf8');
  assert.ok(!findDocProblems(root).some((problem) => /recent-work/.test(problem)));
});

test('a TRUTH.md naming no recent commit IS reported', () => {
  const root = makeRepo();
  writeFileSync(join(root, 'TRUTH.md'), renderTruth(MARKED, root, { includeGitSections: false }), 'utf8');
  assert.ok(findDocProblems(root).some((problem) => /recent-work/.test(problem)));
});

test('the notice is silent when there is nothing wrong', () => {
  assert.equal(buildNotice([]), null, 'a clean repo must produce no noise at all');
});

test('the notice lists every problem at once', () => {
  const notice = buildNotice(['first thing', 'second thing']);
  assert.match(notice, /first thing/);
  assert.match(notice, /second thing/);
  assert.match(notice, /2 problem\(s\)/);
});
