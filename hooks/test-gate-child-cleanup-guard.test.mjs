import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateProcessGateOwnership } from './test-gate-child-cleanup-guard.mjs';

const safeGateSource = `
import { spawn } from 'node:child_process';
const deadlineTimer = setTimeout(() => terminateProcessTree(childProcess), 60_000);
function terminateProcessTree(childProcess) { return childProcess.kill('SIGTERM'); }
const childProcess = spawn('npm', ['test']);
`;

const forcedCancellationTest = `
test('terminates the child tree after a timeout', async () => {
  await runWithDeadline({ onTimeout: terminateProcessTree });
});
`;

function evaluate(changedPaths, sourceByPath) {
  return evaluateProcessGateOwnership({
    changedPaths,
    fileExists: (filePath) => sourceByPath.has(filePath),
    readSource: (filePath) => sourceByPath.get(filePath) || '',
  });
}

test('allows ordinary application code that happens to launch a child process', () => {
  const verdict = evaluate(['src/render-preview.mjs'], new Map([
    ['src/render-preview.mjs', "import { spawn } from 'node:child_process';\nspawn('open', ['preview.html']);"],
  ]));

  assert.deepEqual(verdict, { block: false, offendingGates: [] });
});

test('blocks a changed verification gate that launches children without self-cleanup', () => {
  const verdict = evaluate(['scripts/verify-receipt.mjs'], new Map([
    ['scripts/verify-receipt.mjs', "import { spawn } from 'node:child_process';\nconst childProcess = spawn('npm', ['test']);"],
  ]));

  assert.equal(verdict.block, true);
  assert.deepEqual(verdict.offendingGates, [{ path: 'scripts/verify-receipt.mjs', missing: ['deadline', 'tree cleanup', 'forced-cancel test'] }]);
});

test('blocks a cleaned-up gate when this change has no forced-cancel proof', () => {
  const verdict = evaluate(['scripts/verify-receipt.mjs'], new Map([
    ['scripts/verify-receipt.mjs', safeGateSource],
  ]));

  assert.equal(verdict.block, true);
  assert.deepEqual(verdict.offendingGates, [{ path: 'scripts/verify-receipt.mjs', missing: ['forced-cancel test'] }]);
});

test('allows a bounded gate with descendant cleanup and a changed forced-cancel test', () => {
  const verdict = evaluate([
    'scripts/verify-receipt.mjs',
    'scripts/verify-receipt.test.mjs',
  ], new Map([
    ['scripts/verify-receipt.mjs', safeGateSource],
    ['scripts/verify-receipt.test.mjs', forcedCancellationTest],
  ]));

  assert.deepEqual(verdict, { block: false, offendingGates: [] });
});

// --- 2026-07-27 FALSE-FIRE: `gateway.ts` (a Cloudflare Worker request handler that cannot spawn a
// process at all) was flagged as an un-owned process gate. TWO independent over-matches:
//   1. the bare word `exec` matched `/regex/.exec(signature)` — RegExp.prototype.exec;
//   2. the filename keyword "gate" matched as a SUBSTRING of "gateway".
// Detection now identifies the process API by its MODULE, and gate keywords must be whole
// filename segments. A real gate must still be caught.
test('a Worker handler using RegExp.exec is not a process gate', () => {
  const verdict = evaluateProcessGateOwnership({
    changedPaths: ['cloudflare/retell-gateway/src/gateway.ts'],
    fileExists: () => true,
    readSource: () => `const match = /^v=(\d+),d=([a-f0-9]{64})$/.exec(signature ?? '');\nexport function handle() { return match; }`,
  });
  assert.equal(verdict.block, false);
});

test('application filenames that merely CONTAIN a gate keyword are ignored', () => {
  for (const applicationPath of ['src/gateway.ts', 'src/checkout.ts', 'src/reconcile.ts', 'src/buildings.ts']) {
    const verdict = evaluateProcessGateOwnership({
      changedPaths: [applicationPath],
      fileExists: () => true,
      readSource: () => `import { execSync } from 'node:child_process';\nexecSync('echo hi');`,
    });
    assert.equal(verdict.block, false, `${applicationPath} should not read as a test gate`);
  }
});

test('real gate filenames are still recognised, including separators and camelCase', () => {
  for (const gatePath of ['scripts/verify-deploy.mjs', 'scripts/run_checks.py', 'scripts/ciPipeline.ts', 'scripts/test-gate.sh']) {
    const verdict = evaluateProcessGateOwnership({
      changedPaths: [gatePath],
      fileExists: () => true,
      readSource: () => `import { execSync } from 'node:child_process';\nexecSync('npm test');`,
    });
    assert.equal(verdict.block, true, `${gatePath} should still be gated`);
  }
});

test('a bare exec( counts once the file really imports a process module', () => {
  const verdict = evaluateProcessGateOwnership({
    changedPaths: ['scripts/verify-things.mjs'],
    fileExists: () => true,
    readSource: () => `import { exec } from 'node:child_process';\nexec('npm test');`,
  });
  assert.equal(verdict.block, true);
});
