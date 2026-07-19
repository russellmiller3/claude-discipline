import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  debugSignal,
  isInstrumentationEdit,
  isSourceLogicFile,
  decideEdit,
  mentionedFileBasenames,
  isTargetInScope,
  isTurnStale,
  humanTurnsSince,
  lastHumanPromptIndex,
  isTddContext,
} from './instrument-before-debug.mjs';

// Minimal transcript-entry builders matching what lib/transcript.mjs expects (message.role/content).
const humanTurn = (text) => ({ message: { role: 'user', content: [{ type: 'text', text }] } });
const toolResultTurn = () => ({ message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const assistantTurn = (text) => ({ message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('debugSignal catches in-app failure complaints (differently worded)', () => {
  assert.ok(debugSignal('still calls claude, still searches fandango. you failed'));
  assert.ok(debugSignal("it didn't work, routed to sonnet"));
  assert.ok(debugSignal('No, still messed up. still calls claude'));
  assert.ok(debugSignal('{ "kind": "skaffen-debug-session", "tier": "reserve" }'));
  assert.ok(debugSignal('why does it keep routing to the wrong tier'));
});

test('debugSignal stays quiet on normal, non-debug prompts', () => {
  assert.equal(debugSignal('add a new feature for exporting rows'), null);
  assert.equal(debugSignal('what movies are playing this weekend'), null);
  assert.equal(debugSignal('refactor the recipe runner for clarity'), null);
});

// 2026-07-16 FALSE-BLOCK: a TDD red→green cycle opened the gate — a freshly-written FAILING pytest
// (the designed RED) is not an in-app failure to instrument. TDD narration / test-runner markers must
// suppress the gate; a real in-app complaint must still open it.
test('debugSignal returns null in a TDD context (red→green, not in-app debugging)', () => {
  assert.equal(debugSignal('expect RED (import/field missing), then implement to green'), null);
  assert.equal(debugSignal('failing test first, then make it pass — TDD'), null);
  assert.equal(debugSignal('pytest collected 3 items\nE   ImportError: cannot import name Foo'), null);
});
test('isTddContext detects TDD narration and test-runner output', () => {
  assert.ok(isTddContext('red-to-green cycle'));
  assert.ok(isTddContext('this is the red state'));
  assert.ok(isTddContext('collected 12 items'));
  assert.equal(isTddContext('the app is still broken in production'), false);
});
test('debugSignal STILL fires on a genuine in-app failure (no TDD framing)', () => {
  assert.ok(debugSignal("it didn't work, routed to sonnet"));
  assert.ok(debugSignal('still calls claude, you failed'));
});

// 2026-07-16 FALSE-BLOCK: writing a brand-new file (a fresh TDD test that never ran) opened the gate —
// a file that has never existed has no failing path to instrument.
test('decideEdit does NOT block creating a brand-new file (fileExists=false)', () => {
  assert.equal(decideEdit({ gateActive: true, instrumented: false, filePath: 'src/newthing.py', editText: 'def f(): ...', fileExists: false }).block, false);
});
test('decideEdit STILL blocks a blind fix to an EXISTING source file (fileExists=true)', () => {
  assert.equal(decideEdit({ gateActive: true, instrumented: false, filePath: 'lib/chatRouter.js', editText: 'tier.model = "x";', fileExists: true }).block, true);
});
// A pytest test file (test_*.py) is a TEST, not source logic — the gate must not block writing it.
test('isSourceLogicFile is false for pytest test_*.py and Go *_test.go files', () => {
  assert.equal(isSourceLogicFile('tests/test_enact_loop.py'), false);
  assert.equal(isSourceLogicFile('pkg/foo_test.go'), false);
  assert.ok(isSourceLogicFile('src/enact_loop.py')); // the implementation is still logic
});

test('isInstrumentationEdit recognizes added logging', () => {
  assert.ok(isInstrumentationEdit('console.log("tier failed", tierError);'));
  assert.ok(isInstrumentationEdit('appendFileSync(logPath, JSON.stringify(row));'));
  assert.ok(isInstrumentationEdit('onDebug?.({ tier: tier.name, error: String(err) });'));
  assert.equal(isInstrumentationEdit('requestBody.toolConfig = { includeServerSideToolInvocations: true };'), false);
});

test('isSourceLogicFile is true for source, false for tests/docs/hooks', () => {
  assert.ok(isSourceLogicFile('extension/lib/chatRouter.js'));
  assert.ok(isSourceLogicFile('src/App.svelte'));
  assert.equal(isSourceLogicFile('extension/lib/chatRouter.test.js'), false);
  assert.equal(isSourceLogicFile('HANDOFF.md'), false);
  assert.equal(isSourceLogicFile('C:/Users/rmill/.claude/hooks/foo.mjs'), false);
});

test('decideEdit BLOCKS a blind logic fix while the gate is open', () => {
  const verdict = decideEdit({ gateActive: true, instrumented: false, filePath: 'lib/chatRouter.js', editText: 'tier.model = "x";' });
  assert.equal(verdict.block, true);
});

test('decideEdit CLEARS the gate when the edit adds instrumentation', () => {
  const verdict = decideEdit({ gateActive: true, instrumented: false, filePath: 'lib/chatRouter.js', editText: 'console.log("tier", tier.name, err);' });
  assert.equal(verdict.block, false);
  assert.equal(verdict.clears, true);
});

test('decideEdit CLEARS on an explicit override', () => {
  const verdict = decideEdit({ gateActive: true, instrumented: false, filePath: 'lib/x.js', editText: '// instrumented: the debug log showed tier reserve threw 400\nfix();' });
  assert.equal(verdict.block, false);
  assert.equal(verdict.clears, true);
});

test('decideEdit does NOT block a test-file edit, or once already instrumented, or when inactive', () => {
  assert.equal(decideEdit({ gateActive: true, instrumented: false, filePath: 'lib/x.test.js', editText: 'expect(1).toBe(1)' }).block, false);
  assert.equal(decideEdit({ gateActive: true, instrumented: true, filePath: 'lib/x.js', editText: 'fix();' }).block, false);
  assert.equal(decideEdit({ gateActive: false, instrumented: false, filePath: 'lib/x.js', editText: 'fix();' }).block, false);
});

// ── signal decay (2026-07-03 false positive: a stale "hook not working" debug signal from
// hours/several turns earlier blocked unrelated feature edits) ──────────────────────────────

test('mentionedFileBasenames extracts file names named in the debug-signal message', () => {
  assert.deepEqual(mentionedFileBasenames('chatRouter.js keeps routing to the wrong tier'), ['chatrouter.js']);
  assert.deepEqual(
    mentionedFileBasenames('extension/lib/chatRouter.js and extension/lib/chatRouter.js both broke'),
    ['chatrouter.js'],
  );
  assert.deepEqual(mentionedFileBasenames('still broken, you failed'), []); // no file named — nothing to scope to
});

test('isTargetInScope: no files named in the signal means everything stays in scope (unscoped fallback)', () => {
  assert.equal(isTargetInScope('trainingHarness.py', []), true);
  assert.equal(isTargetInScope('anything/at/all.js', undefined), true);
});

test('isTargetInScope: files WERE named — only a basename match is in scope', () => {
  const mentioned = ['chatrouter.js'];
  assert.equal(isTargetInScope('extension/lib/chatRouter.js', mentioned), true);
  assert.equal(isTargetInScope('chatRouter.js', mentioned), true);
  assert.equal(isTargetInScope('training/newExperimentArm.py', mentioned), false);
});

test('isTurnStale: fires at the configured turn count, not before', () => {
  assert.equal(isTurnStale(0), false);
  assert.equal(isTurnStale(2), false);
  assert.equal(isTurnStale(3), true);
  assert.equal(isTurnStale(10), true);
  assert.equal(isTurnStale(undefined), false); // unknown → don't decay on this axis
});

test('lastHumanPromptIndex finds the most recent real human turn, skipping tool results', () => {
  const entries = [humanTurn('first'), assistantTurn('ok'), toolResultTurn(), humanTurn('second'), assistantTurn('ok')];
  assert.equal(lastHumanPromptIndex(entries), 3);
  assert.equal(lastHumanPromptIndex([]), -1);
});

test('humanTurnsSince counts only human turns strictly after the gate opened', () => {
  const entries = [
    humanTurn('still broken you failed'), // index 0 — opens the gate
    assistantTurn('ok, widened the hook'),
    humanTurn('cool thanks'), // index 2 — turn 1 since open
    assistantTurn('np'),
    humanTurn('now add a new experiment arm'), // index 4 — turn 2 since open
    assistantTurn('sure'),
  ];
  assert.equal(humanTurnsSince(entries, 0), 2);
  assert.equal(humanTurnsSince(entries, -1), 3); // unknown open point → conservative, counts from the top
});

test('REGRESSION: stale signal (many turns back) + unrelated file → edit PASSES', () => {
  // Mirrors the live incident: a hook-narration gripe several turns ago, now an unrelated
  // feature edit to a training harness. Both decay axes independently would allow this;
  // here turn decay does the work even if the file were untracked.
  const verdict = decideEdit({
    gateActive: true,
    instrumented: false,
    filePath: 'training/newExperimentArm.py',
    editText: 'ARMS.push({ name: "exp18", lr: 0.05 });',
    turnsSinceOpen: 5,
    mentionedBasenames: [],
  });
  assert.equal(verdict.block, false);
});

test('REGRESSION: stale signal + unrelated file, scoped by target too → edit PASSES', () => {
  const verdict = decideEdit({
    gateActive: true,
    instrumented: false,
    filePath: 'training/newExperimentArm.py',
    editText: 'ARMS.push({ name: "exp18", lr: 0.05 });',
    turnsSinceOpen: 5,
    mentionedBasenames: ['narration-guard.mjs'],
  });
  assert.equal(verdict.block, false);
});

test('REGRESSION: fresh signal + same-file logic edit → still BLOCKS (canonical true positive)', () => {
  const verdict = decideEdit({
    gateActive: true,
    instrumented: false,
    filePath: 'extension/lib/chatRouter.js',
    editText: 'tier.model = "sonnet"; // just switch it',
    turnsSinceOpen: 0,
    mentionedBasenames: ['chatrouter.js'],
  });
  assert.equal(verdict.block, true);
});

test('REGRESSION: fresh signal, file named in signal, no mention list mismatch → BLOCKS even with 1 elapsed turn', () => {
  const verdict = decideEdit({
    gateActive: true,
    instrumented: false,
    filePath: 'extension/lib/chatRouter.js',
    editText: 'tier.model = "sonnet";',
    turnsSinceOpen: 1,
    mentionedBasenames: ['chatrouter.js'],
  });
  assert.equal(verdict.block, true);
});

test('instrumentation edit still clears the gate even with decay fields present', () => {
  const verdict = decideEdit({
    gateActive: true,
    instrumented: false,
    filePath: 'extension/lib/chatRouter.js',
    editText: 'console.log("tier", tier.name, err);',
    turnsSinceOpen: 0,
    mentionedBasenames: ['chatrouter.js'],
  });
  assert.equal(verdict.block, false);
  assert.equal(verdict.clears, true);
});

test('override token still clears the gate even with decay fields present', () => {
  const verdict = decideEdit({
    gateActive: true,
    instrumented: false,
    filePath: 'extension/lib/chatRouter.js',
    editText: '// instrument-override: no logging point exists on this vendored path\nfix();',
    turnsSinceOpen: 0,
    mentionedBasenames: ['chatrouter.js'],
  });
  assert.equal(verdict.block, false);
  assert.equal(verdict.clears, true);
});
