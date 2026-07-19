import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { flagsHeredocFileWrite } from './heredoc-file-content-guard.mjs';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'heredoc-file-content-guard.mjs');

// ── BLOCK: a code/markup heredoc redirected to a FILE ────────────────────────
test('BLOCKS a CSS heredoc written to a file', () => {
  assert.equal(flagsHeredocFileWrite("cat > x.css <<'CSS'\n.a{content:'x'}\nCSS"), true);
});

test('BLOCKS the exact Macher MemphisLanding repro', () => {
  const repro = [
    "head -n 389 src/lib/MemphisLanding.svelte > src/lib/MemphisLanding.tmp && cat >> src/lib/MemphisLanding.tmp << 'STYLE'",
    '<style>',
    "  .price-card-pro:before { content: 'Most popular'; }",
    '  :global(body) { font-family: "Helvetica Neue", Arial; }',
    'STYLE',
    'cp src/lib/MemphisLanding.tmp src/lib/MemphisLanding.svelte',
  ].join('\n');
  assert.equal(flagsHeredocFileWrite(repro), true);
});

test('BLOCKS a 3+ line body appended to a .svelte file', () => {
  assert.equal(flagsHeredocFileWrite('cat >> file.svelte <<STYLE\nline one\nline two\nline three\nSTYLE'), true);
});

// ── ALLOW: stdin heredocs and trivial config ────────────────────────────────
test('ALLOWS git commit -F- (stdin to git, not a file)', () => {
  assert.equal(flagsHeredocFileWrite("git commit -F- <<'MSG'\nfix: x\nMSG"), false);
});

test('ALLOWS a python heredoc (stdin to a program)', () => {
  assert.equal(flagsHeredocFileWrite("python <<'PY'\nprint('hi')\nPY"), false);
});

test('ALLOWS a one-line quote-free config heredoc to a file', () => {
  assert.equal(flagsHeredocFileWrite("cat > flag.txt <<'T'\nok\nT"), false);
});

test('ALLOWS any command containing HEREDOC_OK', () => {
  assert.equal(flagsHeredocFileWrite("HEREDOC_OK cat > x.css <<'CSS'\n.a{content:'x'}\nCSS"), false);
});

test('ALLOWS a plain command with no heredoc at all', () => {
  assert.equal(flagsHeredocFileWrite('git status && npm test'), false);
});

// ── End-to-end: the hook process denies via stdin ────────────────────────────
function runHook(command) {
  const run = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  return run.stdout || '';
}
const denied = (stdout) => /"permissionDecision"\s*:\s*"deny"/.test(stdout);

test('end-to-end: DENIES a CSS-to-file heredoc, ALLOWS a git-commit heredoc', () => {
  assert.equal(denied(runHook("cat > x.css <<'CSS'\n.a{content:'x'}\nCSS")), true);
  assert.equal(runHook("git commit -F- <<'MSG'\nfix: y\nMSG").trim(), '');
});
