import assert from 'node:assert/strict';
import { evaluate, reachableSharedLibs } from './check-runner-logger-before-build.mjs';

let passed = 0;
function test(name, runCase) { runCase(); passed++; console.log(`  ✓ ${name}`); }

const pyPath = 'C:/Users/rmill/Desktop/programming/marcus/scripts/run_thing_remote.py';

// ---- true positives (BLOCK) -------------------------------------------------

test('blocks a hand-rolled concurrency launcher (strong: ThreadPoolExecutor)', () => {
  const content = 'import concurrent.futures\nwith ThreadPoolExecutor(max_workers=8) as pool:\n    pass\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true }).block, true);
});

test('blocks a hand-rolled pod launcher (strong: runpod + teardown)', () => {
  const content = 'def launch():\n    create_runpod_pod()\n    # ... teardown the pod when done\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true }).block, true);
});

test('blocks on two MEDIUM signal families (retry + concurrency)', () => {
  const content = '# a bespoke runner\ndef go():\n    retry_the_call()\n    manage_concurrency()\n';
  const verdict = evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true });
  assert.equal(verdict.block, true);
  assert.ok(Array.isArray(verdict.matched) && verdict.matched.length >= 2);
});

// ---- true negatives (PASS) --------------------------------------------------

test('passes when the file REUSES runner (import from runner)', () => {
  const content = 'from runner import Runner, TelemetryRecorder\nwith ThreadPoolExecutor() as p:\n    pass\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true }).block, false);
});

test('passes when the file references TrainingLifecycle (a Runner export)', () => {
  const content = 'lifecycle = TrainingLifecycle(db)\n# runpod pod teardown handled by runner\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true }).block, false);
});

test('passes with the override token present', () => {
  const content = '# runner-logger-checked: domain glue, Runner owns the launch\nwith ThreadPoolExecutor() as p:\n    pass\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true }).block, false);
});

test('passes when only ONE medium signal matches (below threshold)', () => {
  const content = 'def run():\n    do_one_retry()\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true }).block, false);
});

test('passes when no sibling shared lib is reachable', () => {
  const content = 'with ThreadPoolExecutor(max_workers=8) as pool:\n    pass\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: false }).block, false);
});

test('passes for an Edit (only a fresh Write is the build moment)', () => {
  const content = 'with ThreadPoolExecutor() as p:\n    teardown()\n';
  assert.equal(evaluate({ toolName: 'Edit', filePath: pyPath, content, hasSiblingLib: true }).block, false);
});

test('passes for a test file (test_ prefix)', () => {
  const filePath = 'C:/Users/rmill/Desktop/programming/marcus/scripts/test_run_thing.py';
  const content = 'with ThreadPoolExecutor() as p:\n    teardown()\n';
  assert.equal(evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: true }).block, false);
});

test('passes for a non-source file (.md)', () => {
  const filePath = 'C:/Users/rmill/Desktop/programming/marcus/NOTES.md';
  const content = 'runpod teardown retry concurrency telemetry pulse dashboard';
  assert.equal(evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: true }).block, false);
});

// ---- fail-open --------------------------------------------------------------

test('fails open on empty input', () => {
  assert.equal(evaluate({ toolName: 'Write', filePath: '', content: '', hasSiblingLib: true }).block, false);
  assert.equal(evaluate({}).block, false);
});

// ---- reachableSharedLibs (fs walk, injected existsFn) -----------------------

test('reachableSharedLibs finds programming/runner walking up', () => {
  const existsFn = (candidatePath) => /programming[/\\]runner$/.test(String(candidatePath).replace(/\\/g, '/'));
  const found = reachableSharedLibs('C:/Users/rmill/Desktop/programming/marcus/scripts', existsFn);
  assert.ok(found && found.includes('runner'));
});

test('reachableSharedLibs returns null when neither lib exists', () => {
  const found = reachableSharedLibs('C:/somewhere/else/deep', () => false);
  assert.equal(found, null);
});

console.log(`\n${passed} tests passed`);
