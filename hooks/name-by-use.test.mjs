// name-by-use.test.mjs — run: node --test ~/.claude/hooks/name-by-use.test.mjs
//
// Regression net for the name-by-use hook. Covers the 2026-07-03 false positive:
// Python keyword-argument names at CALL SITES (subprocess.run(..., cwd=HERE,
// text=True)) are the callee's API, not new identifiers — they must NOT be
// flagged. Genuine assignments (cwd = ..., text = ...) and def parameters
// (including multi-line def signatures) must STILL be flagged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'name-by-use.mjs');

function hookDenies(fileName, sourceCode) {
  const hookRun = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: fileName, content: sourceCode },
    }),
    encoding: 'utf8',
  });
  return /"permissionDecision"\s*:\s*"deny"/.test(hookRun.stdout || '');
}

// --- ALLOW: model-size designators (7B/1.5B/15B/70B) are part of the model's literal product name
// (Qwen2.5-Coder-7B), NOT cryptic vowelless abbreviations. Spelling them out would make names worse. ---
test('allows a model-config assignment whose name ends in 7B (parameter-count suffix)', () => {
  assert.equal(hookDenies('exp154_model_config.py', 'QWEN25_CODER_7B = ModelConfig(revision="main")'), false);
});
test('allows a 15B / 1_5B model-size designator', () => {
  assert.equal(hookDenies('exp154_model_config.py', 'QWEN25_CODER_15B = ModelConfig(revision="main")'), false);
  assert.equal(hookDenies('exp154_model_config.py', 'LLAMA_1_5B = ModelConfig(revision="main")'), false);
});
// REGRESSION: a genuinely cryptic vowelless name must still be flagged.
test('still blocks a real cryptic abbreviation (btn_txt)', () => {
  assert.equal(hookDenies('ui.py', 'btn_txt = 1'), true);
});

// --- ALLOW: the triggering incident — multi-line call with stdlib kwargs on their own lines ---
test('allows kwargs on continuation lines of a multi-line subprocess.run call', () => {
  const incidentSnippet = [
    'smoke = subprocess.run(',
    '    [sys.executable, "smoke.py"],',
    '    cwd=HERE,',
    '    capture_output=True,',
    '    text=True,',
    '    timeout=300,',
    '    env=smoke_env,',
    ')',
  ].join('\n');
  assert.equal(hookDenies('test_countreg_wiring.py', incidentSnippet), false);
});

// --- ALLOW: same call on a single line (kwargs mid-line were never assignments) ---
test('allows a single-line call with cwd= and text= kwargs', () => {
  const singleLineCall =
    'completed = subprocess.run([sys.executable, "smoke.py"], cwd=HERE, capture_output=True, text=True, timeout=300, env=smoke_env)\n';
  assert.equal(hookDenies('wiring.py', singleLineCall), false);
});

// --- ALLOW: kwargs inside a nested multi-line call (dict argument spanning lines) ---
test('allows kwargs on continuation lines of a nested call', () => {
  const nestedCall = [
    'reply = client.post(',
    '    build_url("jobs"),',
    '    json=payload,',
    '    timeout=30,',
    ')',
  ].join('\n');
  assert.equal(hookDenies('wiring.py', nestedCall), false);
});

// --- BLOCK: a genuine assignment to a cryptic acronym still fires ---
test('blocks a real assignment cwd = os.getcwd()', () => {
  assert.equal(hookDenies('wiring.py', 'cwd = os.getcwd()\n'), true);
});

// --- BLOCK: a genuine assignment to a type-named identifier still fires ---
test('blocks a real assignment text = handle.read()', () => {
  assert.equal(hookDenies('wiring.py', 'text = handle.read()\n'), true);
});

// --- BLOCK: def parameters are new identifiers and stay flagged ---
test('blocks a type-named def parameter on one line', () => {
  assert.equal(hookDenies('wiring.py', 'def render(text):\n    return text.upper()\n'), true);
});

// --- BLOCK: def parameters on continuation lines of a multi-line signature stay flagged ---
test('blocks a type-named parameter in a multi-line def signature', () => {
  const multiLineSignature = [
    'def render(',
    '    text=None,',
    '):',
    '    return text',
  ].join('\n');
  assert.equal(hookDenies('wiring.py', multiLineSignature), true);
});

// --- BLOCK: a bracket inside a string must not fool the call-site detector ---
test('blocks an assignment after a string literal containing an open paren', () => {
  const trickySnippet = [
    'banner = "(pending)"',
    'cwd = os.getcwd()',
  ].join('\n');
  assert.equal(hookDenies('wiring.py', trickySnippet), true);
});

// --- ALLOW: unrelated clean python is untouched ---
test('allows clean python with use-named variables', () => {
  const cleanSnippet = [
    'open_tasks = fetch_open_tasks()',
    'for task_row in open_tasks:',
    '    archive(task_row)',
  ].join('\n');
  assert.equal(hookDenies('wiring.py', cleanSnippet), false);
});

// =============================================================================
// pytest BUILT-IN fixtures (fix 2026-07-04): pytest injects fixtures BY
// PARAMETER NAME — `def test_x(tmp_path)` asks pytest for its built-in
// tmp_path fixture, so the parameter name is the framework's API; renaming
// it breaks the injection. In test files (test_*.py / *_test.py /
// conftest.py) built-in fixture names are exempt AS PARAMETERS only.
// Assignments to those names still block everywhere.
// =============================================================================

// --- ALLOW: the triggering incident — tmp_path as a test-function parameter ---
test('allows tmp_path as a parameter of a test function in a test_*.py file', () => {
  const fixtureParamSnippet = [
    'def test_reads_saved_config(tmp_path):',
    '    config_file = tmp_path / "settings.json"',
    '    assert not config_file.exists()',
  ].join('\n');
  assert.equal(hookDenies('test_config.py', fixtureParamSnippet), false);
});

// --- ALLOW: every built-in fixture name as parameters in conftest.py ---
test('allows all pytest built-in fixture names as parameters in conftest.py', () => {
  const conftestSnippet = [
    'def capture_everything(tmp_path, tmpdir, capsys, monkeypatch, caplog):',
    '    pass',
    '',
    'def wire_workspace(capfd, tmp_path_factory, request, pytestconfig):',
    '    pass',
  ].join('\n');
  assert.equal(hookDenies('conftest.py', conftestSnippet), false);
});

// --- ALLOW: fixture params on continuation lines of a multi-line def in *_test.py ---
test('allows tmp_path on a continuation line of a multi-line def in a _test.py file', () => {
  const multiLineFixtureSignature = [
    'def test_snapshot_roundtrip(',
    '    tmp_path,',
    '    monkeypatch,',
    '):',
    '    pass',
  ].join('\n');
  assert.equal(hookDenies('snapshot_test.py', multiLineFixtureSignature), false);
});

// --- BLOCK: same parameter name outside a test file is NOT fixture injection ---
test('still blocks tmp_path as a def parameter outside test files', () => {
  assert.equal(hookDenies('wiring.py', 'def render(tmp_path):\n    return tmp_path\n'), true);
});

// --- BLOCK: an ordinary assignment to a fixture name is a lazy name, even in a test file ---
test('still blocks an assignment to tmp_path inside a test file', () => {
  assert.equal(hookDenies('test_config.py', 'tmp_path = build_workspace()\n'), true);
});

// --- BLOCK: a type-named parameter that is NOT a built-in fixture stays flagged in test files ---
test('still blocks a type-named non-fixture parameter inside a test file', () => {
  const bannedParamSnippet = 'def test_render(text):\n    assert text\n';
  assert.equal(hookDenies('test_config.py', bannedParamSnippet), true);
});
