import assert from 'node:assert/strict';
import {
  evaluate,
  isVerdictRecordingDoc,
  matchedDiagnosticPhrases,
  wasLearningsChecked,
} from './learnings-check-before-diagnosis.mjs';

let passed = 0;
function test(name, runCase) { runCase(); passed++; console.log(`  ✓ ${name}`); }

const methodsDoc = 'C:/Users/rmill/Desktop/programming/marcus/docs/exp999-METHODS.md';
const truthDoc = 'C:/Users/rmill/Desktop/programming/marcus/Marcus-Truth.md';
const findingsDoc = 'C:/Users/rmill/Desktop/programming/marcus/docs/exp167-findings.md';
const learningsDoc = 'C:/Users/rmill/Desktop/programming/marcus/learnings.md';
const globalLearnings = 'C:/Users/rmill/.claude/learnings.md';
const workerFile = 'C:/Users/rmill/Desktop/programming/marcus/scripts/exp999_worker.py';

// ---- isVerdictRecordingDoc ---------------------------------------------------

test('recognizes a *-METHODS.md doc', () => {
  assert.equal(isVerdictRecordingDoc(methodsDoc), true);
});
test('recognizes a *-Truth.md doc', () => {
  assert.equal(isVerdictRecordingDoc(truthDoc), true);
});
test('recognizes a *findings*.md doc', () => {
  assert.equal(isVerdictRecordingDoc(findingsDoc), true);
});
test('recognizes learnings.md itself (project or global)', () => {
  assert.equal(isVerdictRecordingDoc(learningsDoc), true);
  assert.equal(isVerdictRecordingDoc(globalLearnings), true);
});
test('does not flag an unrelated worker file', () => {
  assert.equal(isVerdictRecordingDoc(workerFile), false);
});

// ---- matchedDiagnosticPhrases (robust CLASS matching, not one fixed phrase) --

test('matches "Root cause: ..." phrasing', () => {
  assert.ok(matchedDiagnosticPhrases('Root cause: the gate collapsed because of X').length > 0);
});
test('matches "root-caused" phrasing', () => {
  assert.ok(matchedDiagnosticPhrases('This was root-caused to a shortcut feature.').length > 0);
});
test('matches "diagnosed" phrasing', () => {
  assert.ok(matchedDiagnosticPhrases('We diagnosed the failure as a reward bug.').length > 0);
});
test('matches "collapsed because" phrasing', () => {
  assert.ok(matchedDiagnosticPhrases('The gate collapsed because it found a shortcut.').length > 0);
});
test('matches "why it failed" phrasing', () => {
  assert.ok(matchedDiagnosticPhrases('Here is why it failed on seed 1.').length > 0);
});
test('matches "the reason this fails" phrasing', () => {
  assert.ok(matchedDiagnosticPhrases('The reason this fails is the held-out set.').length > 0);
});
test('matches a claimed first-principles derivation', () => {
  assert.ok(matchedDiagnosticPhrases('A first-principles analysis shows the reward was miswired.').length > 0);
});
test('does NOT match a bare mention of first-principles (no claimed derivation)', () => {
  assert.equal(matchedDiagnosticPhrases('Ran /first-principles before writing this up.').length, 0);
});
test('does NOT match plain RECIPE/PROVENANCE numbers (no diagnostic language)', () => {
  const content = 'seed 0: 0.62, seed 1: 0.58, seed 2: 0.60. Commit abc1234.';
  assert.equal(matchedDiagnosticPhrases(content).length, 0);
});

// ---- wasLearningsChecked (whole-session transcript scan) ---------------------

function readEntry(filePath) {
  return { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Read', input: { file_path: filePath } },
  ] } };
}
function grepEntry(path) {
  return { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Grep', input: { path } },
  ] } };
}

test('wasLearningsChecked true after a Read of learnings.md', () => {
  assert.equal(wasLearningsChecked([readEntry(learningsDoc)]), true);
});
test('wasLearningsChecked true after a Grep whose path targets learnings.md', () => {
  assert.equal(wasLearningsChecked([grepEntry(globalLearnings)]), true);
});
test('wasLearningsChecked false with no Read/Grep of learnings.md anywhere', () => {
  assert.equal(wasLearningsChecked([readEntry(methodsDoc)]), false);
  assert.equal(wasLearningsChecked([]), false);
});
test('wasLearningsChecked false for a Grep with no path (not learnings-targeted)', () => {
  assert.equal(wasLearningsChecked([grepEntry(undefined)]), false);
});
test('wasLearningsChecked false for a Grep pointed at a directory, not the file itself', () => {
  assert.equal(wasLearningsChecked([grepEntry('C:/Users/rmill/Desktop/programming/marcus')]), false);
});

// ---- evaluate — the full gate --------------------------------------------------

test('DENY: verdict doc + diagnostic language + learnings.md never checked', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: methodsDoc,
    content: 'Root cause: the gate collapsed because it found a shortcut feature.',
    learningsChecked: false, replyHasToken: false,
  });
  assert.equal(verdict.block, true);
});

test('ALLOW: same write, but learnings.md WAS Read this session', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: methodsDoc,
    content: 'Root cause: the gate collapsed because it found a shortcut feature.',
    learningsChecked: true, replyHasToken: false,
  });
  assert.equal(verdict.block, false);
});

test('ALLOW: same write, but learnings.md WAS Grepped this session (via wasLearningsChecked)', () => {
  const entries = [grepEntry(learningsDoc)];
  const verdict = evaluate({
    toolName: 'Write', filePath: methodsDoc,
    content: 'Root cause: the gate collapsed because it found a shortcut feature.',
    learningsChecked: wasLearningsChecked(entries), replyHasToken: false,
  });
  assert.equal(verdict.block, false);
});

test('ALLOW (must-not-over-fire): verdict doc with NO diagnostic language', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: methodsDoc,
    content: 'PROVENANCE: commit abc1234. RESULT: seed 0 0.62, seed 1 0.58, seed 2 0.60.',
    learningsChecked: false, replyHasToken: false,
  });
  assert.equal(verdict.block, false);
});

test('ALLOW (must-not-over-fire): non-verdict-doc file even with diagnostic-sounding content', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: workerFile,
    content: '# Root cause: the gate collapsed because of a bug',
    learningsChecked: false, replyHasToken: false,
  });
  assert.equal(verdict.block, false);
});

test('ALLOW: learnings-checked: token present in the file content', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: methodsDoc,
    content: 'learnings-checked: grepped learnings.md for "spawn gate", found nothing new.\nRoot cause: X.',
    learningsChecked: false, replyHasToken: false,
  });
  assert.equal(verdict.block, false);
});

test('ALLOW: learnings-checked: token present in the reply, not the file content', () => {
  const verdict = evaluate({
    toolName: 'Write', filePath: methodsDoc,
    content: 'Root cause: the gate collapsed because it found a shortcut feature.',
    learningsChecked: false, replyHasToken: true,
  });
  assert.equal(verdict.block, false);
});

test('DENY: Edit is gated the same as Write', () => {
  const verdict = evaluate({
    toolName: 'Edit', filePath: truthDoc,
    content: 'Root cause: diagnosed as a reward bug.',
    learningsChecked: false, replyHasToken: false,
  });
  assert.equal(verdict.block, true);
});

test('ALLOW: Edit clears the same as Write once learnings.md is checked', () => {
  const verdict = evaluate({
    toolName: 'Edit', filePath: truthDoc,
    content: 'Root cause: diagnosed as a reward bug.',
    learningsChecked: true, replyHasToken: false,
  });
  assert.equal(verdict.block, false);
});

test('does not fire on non-Write/Edit tools', () => {
  const verdict = evaluate({
    toolName: 'Read', filePath: methodsDoc,
    content: 'Root cause: X collapsed because Y.',
    learningsChecked: false, replyHasToken: false,
  });
  assert.equal(verdict.block, false);
});

// ---- fail-open / empty input ---------------------------------------------------

test('fails open on empty/missing input', () => {
  assert.equal(evaluate({}).block, false);
  assert.equal(evaluate({ toolName: 'Write', filePath: '', content: '' }).block, false);
});

console.log(`\n${passed} tests passed`);
