import assert from 'node:assert/strict';
import { evaluate, evaluateEdit, reachableSharedLibs, looksLikeExperiment, codeOnly } from './check-runner-logger-before-build.mjs';

let passed = 0;
function test(name, runCase) { runCase(); passed++; console.log(`  ✓ ${name}`); }

const pyPath = 'C:/Users/rmill/Desktop/programming/marcus/scripts/run_thing_remote.py';

// ---- true positives (BLOCK) -------------------------------------------------

test('blocks a hand-rolled concurrency launcher (strong: ThreadPoolExecutor)', () => {
  const content = 'import concurrent.futures\nwith ThreadPoolExecutor(max_workers=8) as pool:\n    pass\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true }).block, true);
});

test('blocks a hand-rolled pod launcher (strong: runpod + teardown in CODE)', () => {
  // teardown() is a real code call, not a comment — the 2026-07-19 comment-scan fix means a bare
  // `# teardown` comment no longer fires; genuine hand-rolled teardown in code still must.
  const content = 'def launch():\n    runpod.create_pod()\n    teardown()\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true }).block, true);
});

test('blocks on two MEDIUM signal families (retry + concurrency)', () => {
  const content = '# a bespoke runner\ndef go():\n    retry_the_call()\n    manage_concurrency()\n';
  const verdict = evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true });
  assert.equal(verdict.block, true);
  assert.ok(Array.isArray(verdict.matched) && verdict.matched.length >= 2);
});

test('blocks a plain experiment script by NAME alone (no infra vocabulary at all)', () => {
  const filePath = 'C:/Users/rmill/Desktop/programming/legible/scripts/exp96_train.py';
  const content = 'model = build_model()\nresult = model(x)\nprint(result)\n';
  const verdict = evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: true });
  assert.equal(verdict.block, true);
});

test('blocks a runpod_exp launcher by NAME alone', () => {
  const filePath = 'C:/Users/rmill/Desktop/programming/legible/scripts/runpod_exp96.py';
  const content = 'print("launching")\n';
  assert.equal(evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: true }).block, true);
});

test('blocks on experiment CONTENT signals (train + checkpoint + epoch) with a generic name', () => {
  const filePath = 'C:/Users/rmill/Desktop/programming/legible/scripts/model_runner.py';
  const content = 'def train(model):\n    for epoch in range(10):\n        save_checkpoint(model)\n';
  const verdict = evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: true });
  assert.equal(verdict.block, true);
  assert.ok(verdict.matched.some((m) => m.includes('experiment-file-identity')));
});

test('looksLikeExperiment: true for exp<N> path convention', () => {
  assert.equal(looksLikeExperiment('scripts/exp105_train.py', ''), true);
});

test('looksLikeExperiment: false for an unrelated helper with < 2 content signals', () => {
  assert.equal(looksLikeExperiment('scripts/utils.py', 'def epoch_label(): pass\n'), false);
});

// ---- true negatives (PASS) --------------------------------------------------

test('passes an experiment-named file that ALREADY imports runner/Logger', () => {
  const filePath = 'C:/Users/rmill/Desktop/programming/legible/scripts/exp96_train.py';
  const content = 'from runner import TrainingLifecycle\nfrom logger import StructuredLogger\ndef train(model):\n    pass\n';
  assert.equal(evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: true }).block, false);
});

test('passes an experiment-named file with the override token', () => {
  const filePath = 'C:/Users/rmill/Desktop/programming/legible/scripts/exp96_train.py';
  const content = '# runner-logger-checked: uses shared TrainingLifecycle via a helper module\ndef train(model):\n    pass\n';
  assert.equal(evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: true }).block, false);
});

test('passes an experiment-named file when no sibling lib is reachable', () => {
  const filePath = 'C:/somewhere/unrelated/exp1_train.py';
  const content = 'def train(model):\n    pass\n';
  assert.equal(evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: false }).block, false);
});



test('passes when the file REUSES runner (import from runner)', () => {
  const content = 'from runner import Runner, TelemetryRecorder\nwith ThreadPoolExecutor() as p:\n    pass\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true }).block, false);
});

test('passes when the file references TrainingLifecycle (a Runner export)', () => {
  const content = 'lifecycle = TrainingLifecycle(db)\n# runpod pod teardown handled by runner\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true }).block, false);
});

test('BLOCKS the override token when the file ALSO hand-rolls plumbing (token cannot bless a ThreadPoolExecutor)', () => {
  // The 2026-07-19 hole: the self-cert token was a blanket rubber-stamp — a file
  // could claim "checked" while cloning the exact plumbing Runner owns. A pool /
  // retry / pulse / teardown is never "domain glue", so a STRONG signal voids the token.
  const content = '# runner-logger-checked: domain glue, Runner owns the launch\nwith ThreadPoolExecutor() as p:\n    pass\n';
  const verdict = evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true });
  assert.equal(verdict.block, true);
  assert.equal(verdict.tokenVoided, true);
});

test('BLOCKS an experiment worker that hand-rolls pool+pulse+retry even WITH the token (the demonstrated hole)', () => {
  const filePath = 'C:/Users/rmill/Desktop/programming/marcus/scripts/exp147b_full_worker.py';
  const content = '"""runner-logger-checked: domain glue."""\n'
    + 'from concurrent.futures import ProcessPoolExecutor, as_completed\n'
    + 'def pulse(s): open("agent-pulse.log","a").write(s)\n'
    + 'def train(seed):\n    for attempt in range(3):\n        pass\n';
  assert.equal(evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: true }).block, true);
});

test('PASSES the token for genuine domain glue with NO hand-rolled plumbing (mask-smoke shape)', () => {
  // The regression guard: a pure science worker (loads a model, imposes a mask)
  // that correctly delegates its lifecycle elsewhere still self-certifies cleanly.
  const filePath = 'C:/Users/rmill/Desktop/programming/marcus/scripts/exp147b_mask_smoke.py';
  const content = '"""runner-logger-checked: science worker; lifecycle owned by runpod_exp147.py."""\n'
    + 'from transformers import AutoModelForCausalLM\ndef run_mask_smoke(device):\n    return {"cuda": True}\n';
  assert.equal(evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: true }).block, false);
});

test('passes when only ONE medium signal matches (below threshold)', () => {
  const content = 'def run():\n    do_one_retry()\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: true }).block, false);
});

test('passes when no sibling shared lib is reachable', () => {
  const content = 'with ThreadPoolExecutor(max_workers=8) as pool:\n    pass\n';
  assert.equal(evaluate({ toolName: 'Write', filePath: pyPath, content, hasSiblingLib: false }).block, false);
});

test('Edit path: BLOCKS adding a hand-rolled turn_metrics dict (the 2026-07-17 incident)', () => {
  // This is literally the edit that should have been caught: a parallel per-turn
  // telemetry dict added next to programming/runner, which owns ExperimentTelemetry.
  const newString = `        this_turn = {
            "model_calls": 1, "wall_ms": turn.wall_ms,
            "input_tokens": turn.input_tokens,
            "turn_metrics": [],
            "steps": [],
        }
        turn_metrics.append(this_turn)`;
  const verdict = evaluateEdit({ filePath: pyPath, newString, fullContent: '', hasSiblingLib: true });
  assert.equal(verdict.block, true);
  assert.equal(verdict.path, 'edit-parallel-mechanism');
});

test('Edit path: BLOCKS adding a record_tool_call reimplementation', () => {
  const newString = 'def record_tool_call(self, name, args):\n    self._log.append({"name": name, "args": args})\n';
  const verdict = evaluateEdit({ filePath: pyPath, newString, fullContent: '', hasSiblingLib: true });
  assert.equal(verdict.block, true);
});

test('Edit path: BLOCKS adding a bespoke clipping/redaction helper', () => {
  const newString = 'def _clip_obj(obj, limit):\n    """Clip long strings — bespoke redaction."""\n    return obj[:limit]\n';
  const verdict = evaluateEdit({ filePath: pyPath, newString, fullContent: '', hasSiblingLib: true });
  assert.equal(verdict.block, true);
});

test('Edit path: BLOCKS adding a hand-rolled retry loop via Edit', () => {
  const newString = 'def retry_the_call(fn):\n    while attempt < 5:\n        try: return fn()\n        except: attempt += 1\n';
  const verdict = evaluateEdit({ filePath: pyPath, newString, fullContent: '', hasSiblingLib: true });
  assert.equal(verdict.block, true);
});

test('Edit path: BLOCKS adding a custom Logger/Recorder class', () => {
  const newString = 'class CheapTelemeter:\n    def __init__(self): self.events = []\n';
  const verdict = evaluateEdit({ filePath: pyPath, newString, fullContent: '', hasSiblingLib: true });
  assert.equal(verdict.block, true);
});

test('Edit path: PASSES a normal feature edit (no infra vocabulary)', () => {
  const newString = 'def add_shipping(cart, cost):\n    cart.total += cost\n    return cart\n';
  const verdict = evaluateEdit({ filePath: pyPath, newString, fullContent: '', hasSiblingLib: true });
  assert.equal(verdict.block, false);
});

test('Edit path: PASSES when the new code itself imports the real lib', () => {
  // Adding a record_tool_call wrapper that DELEGATES to ExperimentTelemetry is reuse, not parallel.
  const newString = 'def record_tool_call(self, name, args):\n    from runner import ExperimentTelemetry\n    self._tel.record_tool_call(name, arguments=args)\n';
  const verdict = evaluateEdit({ filePath: pyPath, newString, fullContent: '', hasSiblingLib: true });
  assert.equal(verdict.block, false);
});

test('Edit path: PASSES when no sibling lib is reachable', () => {
  const newString = 'turn_metrics = []\ndef record_tool_call(): pass\n';
  const verdict = evaluateEdit({ filePath: '/c/somewhere/else/app.py', newString, fullContent: '', hasSiblingLib: false });
  assert.equal(verdict.block, false);
});

test('Edit path: PASSES with the override token in the new code', () => {
  const newString = '# runner-logger-checked: this is domain glue\nturn_metrics = []\n';
  const verdict = evaluateEdit({ filePath: pyPath, newString, fullContent: '', hasSiblingLib: true });
  assert.equal(verdict.block, false);
});

test('Edit path: PASSES for a test file (test_ prefix)', () => {
  const newString = 'turn_metrics = []\n';
  const verdict = evaluateEdit({ filePath: 'C:/x/scripts/test_app.py', newString, fullContent: '', hasSiblingLib: true });
  assert.equal(verdict.block, false);
});

test('Edit path: fails open on empty input', () => {
  assert.equal(evaluateEdit({}).block, false);
  assert.equal(evaluateEdit({ filePath: '', newString: '', hasSiblingLib: true }).block, false);
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

// 2026-07-19 FALSE-BLOCK: a science worker whose ONLY strong/medium hits were inside a DISCLAIMING
// docstring ("this hand-rolls no retry/resume/teardown/telemetry") had its honest token voided and
// got blocked. A trigger word in a comment/docstring is documentation, not plumbing.
test('token + trigger words ONLY in a docstring/comment -> allowed (comment-scan false positive)', () => {
  const filePath = 'C:/Users/rmill/Desktop/programming/marcus/scripts/exp155_v2_spawn_check.py';
  const content = [
    '# runner-logger-checked',
    '"""exp155 v2 spawn check.',
    'The durable multi-seed sweep runs through the shared Runner in a separate file;',
    'this hand-rolls no retry/resume/teardown/telemetry/log format."""',
    'import torch',
    'def check_mask(size):',
    '    return torch.zeros(size, size)  # a static assert, no teardown of any pod',
  ].join('\n');
  assert.equal(evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: true }).block, false);
});

// REGRESSION: real hand-rolled plumbing in CODE (not a comment) still voids the token and blocks.
test('token + REAL ProcessPoolExecutor plumbing in code -> still blocks (token voided)', () => {
  const filePath = 'C:/Users/rmill/Desktop/programming/marcus/scripts/exp155_real_pool.py';
  const content = [
    '# runner-logger-checked',
    'from concurrent.futures import ProcessPoolExecutor',
    'def teardown(pod):',
    '    pod.stop()',
    'with ProcessPoolExecutor(max_workers=4) as pool:',
    '    pool.map(run, seeds)',
  ].join('\n');
  assert.equal(evaluate({ toolName: 'Write', filePath, content, hasSiblingLib: true }).block, true);
});

// codeOnly unit: strips a python docstring's trigger words but keeps a real call.
test('codeOnly strips docstring/comment trigger words but keeps code', () => {
  const stripped = codeOnly('x.py', '"""mentions teardown and retry"""\nteardown()  # retry here\n');
  assert.equal(/teardown|retry/.test(stripped.replace(/teardown\(\)/, 'CALL')), false, 'doc words gone');
  assert.ok(/CALL/.test(stripped.replace(/teardown\(\)/, 'CALL')), 'the real call survives');
});

console.log(`\n${passed} tests passed`);
