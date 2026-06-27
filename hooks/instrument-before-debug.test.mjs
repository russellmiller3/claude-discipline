import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debugSignal, isInstrumentationEdit, isSourceLogicFile, decideEdit } from './instrument-before-debug.mjs';

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
