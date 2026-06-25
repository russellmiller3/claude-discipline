#!/usr/bin/env node
/**
 * e2e-or-its-theatre — Stop gate with TEETH: a load-bearing source module that crosses a REAL EXTERNAL
 * BOUNDARY must have a real end-to-end test exercising that boundary — not just unit tests that MOCK it.
 * "Unit tests without e2e are theatre."
 *
 * THE TRIGGER (deterministic, tuned for low false positives) — BLOCK on Stop iff, IN THIS TURN, you:
 *   (1) edited a load-bearing source module — a non-test `.js/.mjs/.svelte` under `src/` or `lib/`
 *       (a browser-extension tree's `extension/lib`/`extension/src` is matched too) — whose OWN SOURCE shows a real external
 *       boundary: WASM (pyodide/wasm), network (fetch/WebSocket/EventSource/XMLHttpRequest/an http client),
 *       a DB (indexedDB/idb/sqlite/pglite), a Worker, or DOM serialization (document/jsdom/innerHTML/
 *       querySelector). A pure-logic module (no such signal) is EXEMPT — an e2e only makes sense where there's
 *       a real dependency to exercise end-to-end; AND
 *   (2) that module's ONLY tests MOCK the real boundary — a sibling `*.test.*` imports `vi.mock(` / `vi.fn(`
 *       / `vitest.mock(` / `jest.mock(` (i.e. the boundary is faked, so the test proves wiring, never that the
 *       real thing works); AND
 *   (3) there is NO real e2e for it — no `<module>.e2e.test.*` sibling, and no test in the tree tagged e2e
 *       (filename matches /e2e/i, or a describe/it title contains "e2e").
 *
 * Teeth: `decision: 'block'` — you cannot stop until you add a real e2e (e.g. a `<module>.e2e.test.js` that
 * loads the ACTUAL dependency — real WASM/DB/network — and asserts a value a JS mock physically cannot fake)
 * or explicitly exempt the change.
 *
 * Why: a unit test that mocks the runner proves the wiring, never that the real thing works. Mocked-boundary
 * modules pass green while the real dependency is never exercised; the bug a mock can't catch (the WASM bigint,
 * the real DOM serialization, the real DB round-trip) has no net.
 *
 * Override (rare — genuinely no headless e2e is possible, e.g. a real mic + socket + browser is required): put
 * the literal token `e2e-owed-live-gate: <why>` in the final reply (records it as an OWED live gate, not a pass),
 * or `e2e-skip: <why>` for a change with no real boundary the trigger misjudged. Fail open on any error.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const OVERRIDE_RE = /e2e-(owed-live-gate|skip)\s*:/i;

// A non-test load-bearing source module we police (NOT a test, NOT html/css/json/config).
export function isLoadBearingSource(filePath) {
  const path = String(filePath || '').replace(/\\/g, '/');
  if (/\.(test|spec|e2e)\.[a-z]+$/i.test(path)) return false;
  if (!/\.(js|mjs|svelte)$/i.test(path)) return false;
  // Prefer the extension tree; fall back to a generic src/ or lib/ for portability.
  return /(^|\/)(extension\/(lib|src)|src|lib)\/.+/i.test(path);
}

// Does this module's OWN source cross a real external boundary? (The thing an e2e would exercise.)
// Tuned so a pure-logic module — no WASM/network/DB/worker/DOM signal — is EXEMPT (no e2e makes sense there).
const BOUNDARY_SIGNALS = [
  { name: 'WASM runtime', re: /\b(pyodide|loadPyodide|WebAssembly|\.wasm\b|instantiateStreaming)\b/ },
  { name: 'network/HTTP', re: /\b(fetch\s*\(|WebSocket|EventSource|XMLHttpRequest|axios|got\(|undici|node-fetch|https?:\/\/[a-z])/i },
  { name: 'database', re: /\b(indexedDB|openDB\b|idb|IDBDatabase|sqlite|better-sqlite3|pglite|PGlite|\.execute\(|prepare\()/i },
  { name: 'worker', re: /\bnew\s+Worker\s*\(|Worker\(|postMessage\s*\(|onmessage\b|MessageChannel/i },
  { name: 'DOM serialization', re: /\b(document\.|jsdom|JSDOM|innerHTML|outerHTML|querySelector|createElement|getBoundingClientRect|new\s+DOMParser)\b/ },
];

export function boundaryOf(sourceCode) {
  const moduleSource = String(sourceCode || '');
  for (const signal of BOUNDARY_SIGNALS) if (signal.re.test(moduleSource)) return signal.name;
  return null;
}

// Does a test file MOCK the boundary? (vi.mock / vi.fn / vitest.mock / jest.mock — the boundary is faked.)
const MOCK_RE = /\b(vi|vitest|jest)\s*\.\s*(mock|fn|spyOn)\s*\(|\bvi\.mock\b|importMock\b/;
export function mocksBoundary(testSource) {
  return MOCK_RE.test(String(testSource || ''));
}

// Is a file a real e2e? (by name, or by an e2e-tagged describe/it title)
export function isE2eTest(filePath, testSource) {
  const path = String(filePath || '').replace(/\\/g, '/');
  if (/\.e2e\.test\.[a-z]+$/i.test(path) || /e2e/i.test(basename(path))) return true;
  return /\b(describe|it|test)\s*\(\s*['"`][^'"`]*\be2e\b/i.test(String(testSource || ''));
}

function readFileSafe(path) { try { return readFileSync(path, 'utf8'); } catch { return ''; } }

// All sibling test files for a module (same dir, name starts with the module's base name, ends *.test.*/*.spec.*).
function siblingTests(moduleAbsPath) {
  const moduleDir = dirname(moduleAbsPath);
  const stem = basename(moduleAbsPath).replace(/\.(js|mjs|svelte)$/i, '');
  let entries = [];
  try { entries = readdirSync(moduleDir); } catch { return []; }
  return entries
    .filter((name) => name.startsWith(stem) && /\.(test|spec|e2e)\.[a-z]+$/i.test(name))
    .map((name) => join(moduleDir, name));
}

/**
 * Pure verdict — given the facts about ONE edited module, should it block?
 * Block iff: it's a real boundary AND has mocked-boundary unit tests AND has NO e2e (sibling or tagged).
 */
export function evaluateModule({ boundary, hasMockedUnitTest, hasE2e }) {
  if (!boundary) return { block: false, reason: 'pure-logic module (no external boundary)' };
  if (!hasMockedUnitTest) return { block: false, reason: 'no mocked-boundary unit test' };
  if (hasE2e) return { block: false, reason: 'a real e2e already exists' };
  return { block: true, boundary, reason: 'real boundary, mocked unit tests, NO e2e — theatre' };
}

// ── transcript helpers (same shape as explainer-sync) ──────────────────────────
function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  try {
    return readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function roleOf(entry) { return entry.message?.role || entry.role || entry.type || ''; }
function contentBlocks(entry) {
  const blocks = entry.message?.content ?? entry.content ?? [];
  if (typeof blocks === 'string') return [{ type: 'text', text: blocks }];
  return Array.isArray(blocks) ? blocks : [];
}
function currentTurnEntries(entries) {
  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'assistant') { lastAssistant = i; break; } }
  if (lastAssistant < 0) return [];
  let turnStart = 0;
  for (let i = lastAssistant - 1; i >= 0; i--) { if (roleOf(entries[i]) === 'user') { turnStart = i; break; } }
  return entries.slice(turnStart);
}

// Walk the whole project tree once to know if ANY e2e exists for a given module stem (covers e2e files that
// don't sit next to the module). Bounded so Stop stays fast.
function treeHasE2eFor(root, stem) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.vite', 'coverage', '.next', 'out']);
  const queue = [root];
  let budget = 6000;
  while (queue.length && budget > 0) {
    const probeDir = queue.shift();
    let entries = [];
    try { entries = readdirSync(probeDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (budget-- <= 0) break;
      if (entry.isDirectory()) { if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) queue.push(join(probeDir, entry.name)); continue; }
      if (!/\.e2e\.test\.[a-z]+$/i.test(entry.name)) continue;
      if (entry.name.startsWith(stem)) return true;
    }
  }
  return false;
}

function onStop(hookEvent) {
  const repoRoot = hookEvent.cwd || process.cwd();
  const turnEntries = currentTurnEntries(readTranscript(hookEvent.transcript_path));
  if (turnEntries.length === 0) return;

  let override = false;
  const editedModulePaths = new Set();
  for (const entry of turnEntries) {
    for (const block of contentBlocks(entry)) {
      if (block.type === 'text' && OVERRIDE_RE.test(block.text || '')) override = true;
      if (block.type !== 'tool_use') continue;
      if (!CODE_EDIT_TOOLS.has(block.name || '')) continue;
      const filePath = (block.input || {}).file_path || (block.input || {}).path || '';
      if (isLoadBearingSource(filePath)) editedModulePaths.add(filePath);
    }
  }
  if (override || editedModulePaths.size === 0) return;

  const offenders = [];
  for (const modulePath of editedModulePaths) {
    // Resolve to an absolute on-disk path (the transcript may carry an absolute path already).
    const moduleAbs = existsSync(modulePath) ? modulePath : join(repoRoot, modulePath.replace(/^.*?((extension|src|lib)\/.*)$/i, '$1'));
    if (!existsSync(moduleAbs)) continue;
    const boundary = boundaryOf(readFileSafe(moduleAbs));
    if (!boundary) continue; // pure-logic module — exempt

    const tests = siblingTests(moduleAbs);
    let hasMockedUnitTest = false;
    let hasE2e = false;
    for (const testPath of tests) {
      const testSource = readFileSafe(testPath);
      if (isE2eTest(testPath, testSource)) hasE2e = true;
      else if (mocksBoundary(testSource)) hasMockedUnitTest = true;
    }
    // Also accept an e2e living elsewhere in the tree that names this module's stem.
    if (!hasE2e) {
      const stem = basename(moduleAbs).replace(/\.(js|mjs|svelte)$/i, '');
      if (treeHasE2eFor(repoRoot, stem)) hasE2e = true;
    }

    const verdict = evaluateModule({ boundary, hasMockedUnitTest, hasE2e });
    if (verdict.block) offenders.push({ module: basename(moduleAbs), boundary });
  }

  if (offenders.length === 0) return;

  const offenderLines = offenders.map((offender) => `  • ${offender.module}  (real boundary: ${offender.boundary})`).join('\n');
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      'E2E REQUIRED — you changed a load-bearing module that crosses a REAL external boundary, but its only',
      'tests MOCK that boundary and there is NO real end-to-end test. Mocked unit tests are theatre.',
      '',
      'Module(s) this turn with a mocked boundary and no e2e:',
      offenderLines,
      '',
      'The rule: "unit tests without e2e are theatre." A test that mocks the runner proves the wiring, never that',
      'the real thing works — the bug a mock physically cannot fake (the WASM bigint, the real DOM serialization,',
      'the real DB round-trip) has no net.',
      '',
      'Add a real e2e: a `<module>.e2e.test.js` that exercises the ACTUAL dependency end-to-end and asserts',
      'something a mock could not satisfy (e.g. load real WASM and check a value JS cannot represent). Re-run green.',
      '',
      'Override (rare): if a real e2e is genuinely infeasible headlessly (needs a real mic + socket + browser),',
      'say so with the literal token  e2e-owed-live-gate: <why>  (records it as an OWED live gate, NOT a pass).',
      'If the trigger misjudged a no-boundary change, use  e2e-skip: <why>.',
    ].join('\n'),
  }));
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
  if (eventName === 'Stop') onStop(hookEvent);
  process.exit(0);
}

// Only run when executed directly as a hook — importing (e.g. from the test) must NOT block on stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
