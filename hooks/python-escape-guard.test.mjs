import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'python-escape-guard.mjs');

function runHook(toolName, toolInput) {
  const hookRun = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
  });
  return /"permissionDecision"\s*:\s*"deny"/.test(hookRun.stdout || '');
}

// --- ALLOW (the 2026-07-01 false-fire): a Windows PATH arg with \v is a separator, not a Python escape ---
test('allows a python run with a \\v Windows path argument (not inline code)', () => {
  assert.equal(runHook('Bash', { command: 'python "C:\\\\Users\\\\rmill\\\\validate\\\\pipeline.py" --sizes 20' }), false);
});

test('allows a python script run with a \\forms path (no inline -c code)', () => {
  assert.equal(runHook('Bash', { command: 'python C:\\\\proj\\\\forms\\\\run.py' }), false);
});

// --- BLOCK: a real \v inside inline -c code IS a corrupting Python escape ---
test('blocks \\v inside inline python -c code', () => {
  assert.equal(runHook('Bash', { command: `python -c "print('\\v1.0')"` }), true);
});

// --- BLOCK: a real \v in a written .py file's string literal ---
test('blocks \\v in a written .py file content', () => {
  assert.equal(runHook('Write', { file_path: 'patch.py', content: `content = data.replace('\\v1.0', '')` }), true);
});

// --- ALLOW: a raw string r'\v' in a .py file is safe ---
test('allows a raw string r\\v in a .py file', () => {
  assert.equal(runHook('Write', { file_path: 'patch.py', content: `pattern = r'\\video\\\\d+'` }), false);
});
