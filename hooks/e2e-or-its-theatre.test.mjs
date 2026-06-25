#!/usr/bin/env node
/**
 * Tests for e2e-or-its-theatre.mjs — proves the TEETH:
 *   - BLOCKS when a real-boundary module's only tests mock the boundary and there's no e2e.
 *   - PASSES when a real e2e exists.
 *   - Does NOT false-positive on a pure-logic module (no boundary).
 *   - Honors the override token.
 * Run: node e2e-or-its-theatre.test.mjs
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isLoadBearingSource, boundaryOf, mocksBoundary, isE2eTest, evaluateModule,
} from './e2e-or-its-theatre.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(HERE, 'e2e-or-its-theatre.mjs');
let passedCount = 0;
const check = (label, fn) => { fn(); passedCount++; console.log(`  ok  ${label}`); };

// ── pure unit checks ───────────────────────────────────────────────────────────
check('isLoadBearingSource: extension/lib source is policed', () => {
  assert.equal(isLoadBearingSource('extension/lib/codeBackend.js'), true);
  assert.equal(isLoadBearingSource('C:/x/extension/src/App.svelte'), true);
});
check('isLoadBearingSource: tests + html are NOT policed', () => {
  assert.equal(isLoadBearingSource('extension/lib/codeBackend.test.js'), false);
  assert.equal(isLoadBearingSource('extension/lib/foo.e2e.test.js'), false);
  assert.equal(isLoadBearingSource('docs/explainers/index.html'), false);
});

check('boundaryOf: detects WASM / network / DB / worker / DOM', () => {
  assert.equal(boundaryOf('const py = await loadPyodide();'), 'WASM runtime');
  assert.equal(boundaryOf('await fetch("https://api.x")'), 'network/HTTP');
  assert.equal(boundaryOf('const handle = await openDB("x")'), 'database');
  assert.equal(boundaryOf('const worker = new Worker(url)'), 'worker');
  assert.equal(boundaryOf('el.innerHTML = snapshot'), 'DOM serialization');
});
check('boundaryOf: a pure-logic module has NO boundary (exempt)', () => {
  assert.equal(boundaryOf('export const add = (a, b) => a + b;'), null);
  assert.equal(boundaryOf('export function slugify(name){ return name.toLowerCase(); }'), null);
});

check('mocksBoundary: detects vi.mock / vi.fn / jest.mock', () => {
  assert.equal(mocksBoundary('vi.mock("./runner")'), true);
  assert.equal(mocksBoundary('const runner = vi.fn()'), true);
  assert.equal(mocksBoundary('jest.mock("./db")'), true);
  assert.equal(mocksBoundary('expect(add(1,2)).toBe(3)'), false);
});

check('isE2eTest: by name or by e2e-tagged title', () => {
  assert.equal(isE2eTest('foo.e2e.test.js', ''), true);
  assert.equal(isE2eTest('foo.test.js', "describe('foo e2e — real thing', () => {})"), true);
  assert.equal(isE2eTest('foo.test.js', "describe('foo unit', () => {})"), false);
});

check('evaluateModule: the core verdict table', () => {
  // real boundary + mocked unit test + NO e2e  → BLOCK (theatre)
  assert.equal(evaluateModule({ boundary: 'WASM runtime', hasMockedUnitTest: true, hasE2e: false }).block, true);
  // real boundary + mocked unit test + HAS e2e  → pass
  assert.equal(evaluateModule({ boundary: 'WASM runtime', hasMockedUnitTest: true, hasE2e: true }).block, false);
  // pure-logic module → pass (no boundary)
  assert.equal(evaluateModule({ boundary: null, hasMockedUnitTest: true, hasE2e: false }).block, false);
  // real boundary but tests DON'T mock it → pass (not theatre)
  assert.equal(evaluateModule({ boundary: 'database', hasMockedUnitTest: false, hasE2e: false }).block, false);
});

// ── end-to-end stdin checks (the real teeth) ────────────────────────────────────
// Build a throwaway repo with a real-boundary module + a mocked unit test, write a transcript that "edited"
// it this turn, pipe a Stop event in, and assert the hook BLOCKS. Then add an e2e and assert it PASSES.

function makeRepo({ withE2e, pureLogic, override }) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-theatre-'));
  const libDir = join(root, 'extension', 'lib');
  mkdirSync(libDir, { recursive: true });
  const modulePath = join(libDir, 'codeBackend.js');
  writeFileSync(modulePath, pureLogic
    ? 'export const add = (a, b) => a + b;\n'
    : 'export async function run(code){ const py = await loadPyodide(); return py.runPython(code); }\n');
  // The unit test mocks the boundary.
  writeFileSync(join(libDir, 'codeBackend.test.js'),
    "import { vi } from 'vitest';\nvi.mock('./runner');\nconst runner = vi.fn();\n");
  if (withE2e) {
    writeFileSync(join(libDir, 'codeBackend.e2e.test.js'),
      "import { loadPyodide } from 'pyodide';\nit('real', async () => {});\n");
  }
  // A transcript with one turn: user prompt, assistant edits the module.
  const transcriptEntries = [
    { type: 'user', message: { role: 'user', content: 'do the thing' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: modulePath } },
      ...(override ? [{ type: 'text', text: 'e2e-owed-live-gate: needs a real mic' }] : []),
    ] } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  const transcriptPath = join(root, 'transcript.jsonl');
  writeFileSync(transcriptPath, transcriptEntries);
  return { root, transcriptPath };
}

function runHook(root, transcriptPath) {
  const event = JSON.stringify({ hook_event_name: 'Stop', cwd: root, transcript_path: transcriptPath });
  try {
    const hookOutput = execFileSync('node', [HOOK_PATH], { input: event, encoding: 'utf8' });
    return hookOutput.trim();
  } catch (err) {
    return (err.stdout || '').toString().trim();
  }
}

check('TEETH: blocks when a real-boundary module has mocked tests and NO e2e', () => {
  const { root, transcriptPath } = makeRepo({ withE2e: false });
  const hookOutput = runHook(root, transcriptPath);
  assert.ok(hookOutput.includes('"decision":"block"'), `expected block, got: ${hookOutput.slice(0, 200)}`);
  assert.ok(/theatre/i.test(hookOutput), 'block reason should mention theatre');
  assert.ok(/codeBackend\.js/.test(hookOutput), 'block reason should name the offending module');
  rmSync(root, { recursive: true, force: true });
});

check('PASS: a real e2e sibling clears the block', () => {
  const { root, transcriptPath } = makeRepo({ withE2e: true });
  const hookOutput = runHook(root, transcriptPath);
  assert.equal(hookOutput, '', `expected no output (pass), got: ${hookOutput.slice(0, 200)}`);
  rmSync(root, { recursive: true, force: true });
});

check('NO FALSE POSITIVE: a pure-logic module is exempt', () => {
  const { root, transcriptPath } = makeRepo({ withE2e: false, pureLogic: true });
  const hookOutput = runHook(root, transcriptPath);
  assert.equal(hookOutput, '', `pure-logic module should not block, got: ${hookOutput.slice(0, 200)}`);
  rmSync(root, { recursive: true, force: true });
});

check('OVERRIDE: the owed-live-gate token lets the turn stop', () => {
  const { root, transcriptPath } = makeRepo({ withE2e: false, override: true });
  const hookOutput = runHook(root, transcriptPath);
  assert.equal(hookOutput, '', `override token should clear the block, got: ${hookOutput.slice(0, 200)}`);
  rmSync(root, { recursive: true, force: true });
});

console.log(`\n${passedCount} checks passed.`);
