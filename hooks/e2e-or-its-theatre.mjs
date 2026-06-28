#!/usr/bin/env node
/**
 * e2e-or-its-theatre — Stop gate with TEETH: a load-bearing source module that crosses a REAL EXTERNAL
 * BOUNDARY must have a real end-to-end test exercising that boundary — not just unit tests that MOCK it.
 * "Unit tests without e2e are theatre" (Russell, 2026-06-24).
 *
 * THE TRIGGER (deterministic, tuned for low false positives) — BLOCK on Stop iff, IN THIS TURN, you:
 *   (1) edited a load-bearing source module — a non-test `.js/.mjs/.svelte` under `extension/lib` or
 *       `extension/src` (or any `src/`/`lib/` if no extension tree) — whose OWN SOURCE shows a real external
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
 * Teeth: `decision: 'block'` — you cannot stop until you add a real e2e (see the reference
 * extension/lib/pyodideTransform.e2e.test.js: loads ACTUAL Pyodide and asserts a value a JS mock physically
 * cannot fake) or explicitly exempt the change.
 *
 * Why: the codeBackend unit tests mock the Python runner — they prove the wiring, never that Python runs. That
 * gap is exactly "theatre." Mocked-boundary modules pass green while the real dependency is never exercised; the
 * bug a mock can't catch (the WASM bigint, the real DOM serialization, the real DB round-trip) has no net.
 *
 * Override (rare — genuinely no headless e2e is possible, e.g. a real mic + socket + browser is required): put
 * the literal token `e2e-owed-live-gate: <why>` in the final reply (records it as an OWED live gate, not a pass),
 * or `e2e-skip: <why>` for a change with no real boundary the trigger misjudged. Fail open on any error.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordGate, clearGate, defaultGatesPath } from './lib/owedLiveGates.mjs';

const CODE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
// Two distinct overrides: `e2e-skip:` is a true pass (the trigger misjudged a no-boundary change); but
// `e2e-owed-live-gate:` is NOT a free pass any more — it RECORDS an owed gate (owedLiveGates ledger) that a
// per-turn reminder nags about until the live e2e runs green. Russell 2026-06-26.
const SKIP_RE = /e2e-skip\s*:/i;
const OWED_RE = /e2e-owed-live-gate\s*:/i;

// The owed-live-gate override is ONLY legitimate when the boundary genuinely CANNOT be exercised headlessly —
// a real microphone, a live WebRTC/audio socket, a camera, dedicated hardware, or an interactive browser/OAuth
// step. A network/HTTP, database, or credential boundary IS headlessly testable (node + real fetch, a real DB, a
// key from .env), so "I'll owe it" there is the self-cert abuse that shipped untested wiring THIS session (I owed
// a network boundary I later proved testable). So the override is honored ONLY if its reason NAMES a real
// human/hardware gate; a vague "it's just wiring" / "can't be tested headlessly" does NOT qualify and the gate
// keeps blocking. Pure + exported so the test pins the exact abuse shapes.
const HUMAN_GATE_RE = /\b(mic|microphone|audio|sound|webrtc|web ?rtc|camera|webcam|speakers?|headphones?|hardware|physical device|usb|bluetooth|real browser|headed browser|interactive (?:oauth|login|sign-?in|consent)|oauth (?:consent|popup)|\bmfa\b|\b2fa\b|captcha)\b/i;
export function owedOverrideHonored(reasonText) {
  return HUMAN_GATE_RE.test(String(reasonText || ''));
}

// A module STEM (basename, no extension) whose live e2e RAN GREEN in this turn — that's the "you did it"
// signal that clears its owed gate. We read it off a Bash run of `<stem>.e2e.test…` whose result reports a
// passing vitest/node summary and NO failure. Deterministic, low-false-positive: requires both the e2e
// filename in the command AND a green result in the same tool_result region of the turn.
export function e2eGreenRunStems(turnEntries) {
  const stems = new Set();
  const e2eName = /([A-Za-z0-9_.-]+)\.e2e\.test\.[a-z]+/g;
  const greenSummary = /(\b\d+\s+passed\b|Tests?\s+\d+\s+passed)/i;
  const failureSummary = /\bfailed\b|\bFAIL\b|\d+\s+failed/;
  for (const entry of turnEntries) {
    for (const block of contentBlocks(entry)) {
      const resultText = toolResultText(block);
      if (!resultText || !greenSummary.test(resultText) || failureSummary.test(resultText)) continue;
      e2eName.lastIndex = 0;
      let match;
      while ((match = e2eName.exec(resultText))) stems.add(match[1]);
    }
  }
  return stems;
}

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
  // CREDENTIAL/SETTINGS WIRING — a UI that COLLECTS an api key/token/secret has no fetch of its own (a downstream
  // collaborator sends it), so the other signals miss it. But its whole correctness is "does this key reach its
  // service" — exactly the bug that shipped the exa key fix untested (the Settings UI saved exaKey but nothing
  // proved it reached the Exa API). Signal: a password input bound to a *Key/*Token/*Secret field. The two-sided
  // regex catches either order (attribute before or after the binding). A non-credential password (a login form,
  // no *Key) does NOT match — keeps false positives low.
  { name: 'credential/settings wiring', re: /type=["']password["'][\s\S]{0,200}\b\w*(Key|Token|Secret)\b|\b\w*(Key|Token|Secret)\b[\s\S]{0,200}type=["']password["']/i },
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

import {
  readTranscript, roleOf, contentBlocks, toolResultText, isHumanPrompt, currentTurnEntries,
} from './lib/transcript.mjs';

// Pull git commit/merge SHAs out of this turn's Bash tool_result text. `git commit` AND `git merge` both print
// `[<branch> <sha>] <message>` — so a turn that MERGED a background agent's branch (or committed) leaves the SHA
// here even though no Write/Edit tool_use touched those files. This is how the gate SEES merge-introduced code,
// the blind spot that let a subagent's mocked-boundary module ship with no e2e.
export function commitShasFromToolResults(turnEntries) {
  const shas = new Set();
  const shaLine = /^\[[^\]]*?\s([0-9a-f]{7,40})\]/gm;
  for (const entry of turnEntries) {
    for (const block of contentBlocks(entry)) {
      const resultText = toolResultText(block);
      if (!resultText) continue;
      shaLine.lastIndex = 0;
      let match;
      while ((match = shaLine.exec(resultText))) shas.add(match[1]);
    }
  }
  return [...shas];
}

// Files each commit introduced relative to its FIRST parent. For a merge commit, `sha^1` is our prior HEAD, so
// `diff sha^1 sha` is exactly what the merged branch brought in (the agent's new files). `runGit` is injected for
// testing. Fail-open: any git error yields no files (never block on a git hiccup).
export function gitFilesForCommits(repoRoot, shas, runGit) {
  const exec = runGit || ((args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const files = new Set();
  for (const sha of shas) {
    let diffOutput = '';
    try { diffOutput = exec(['diff', '--name-only', `${sha}^1`, sha]); }
    catch { try { diffOutput = exec(['diff', '--name-only', `${sha}^`, sha]); } catch { continue; } }
    for (const line of String(diffOutput).split(/\r?\n/)) { const file = line.trim(); if (file) files.add(file); }
  }
  return [...files];
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

// A credential/settings-wiring boundary (a UI collecting an api key) is covered by ANY real e2e that proves a
// credential reaches its service — that e2e is named after the SERVICE/flow it proves (e.g. researchKeyFromSettings),
// not after the component, so the stem match above can't find it. Accept any `*.e2e.test.*` whose source handles a
// *Key/*Token/*Secret. This keeps a routine settings tweak from blocking forever once a credential e2e exists,
// while still requiring that SUCH an e2e exists at all. Bounded walk (Stop must stay fast).
const CREDENTIAL_IN_SOURCE = /\b\w*(Key|Token|Secret)\b/;
function treeHasCredentialE2e(root) {
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
      if (CREDENTIAL_IN_SOURCE.test(readFileSafe(join(probeDir, entry.name)))) return true;
    }
  }
  return false;
}

function onStop(hookEvent) {
  const repoRoot = hookEvent.cwd || process.cwd();
  const turnEntries = currentTurnEntries(readTranscript(hookEvent.transcript_path));
  if (turnEntries.length === 0) return;

  const project = basename(repoRoot);
  // Clear any owed gate whose live e2e RAN GREEN this turn — the "you actually did it" signal. Runs even on a
  // turn with no edits (you came back just to run the owed e2e), so the reminder stops the moment it passes.
  for (const stem of e2eGreenRunStems(turnEntries)) clearGate(defaultGatesPath(), stem, project);

  let skipOverride = false;     // `e2e-skip:` — a true pass (trigger misjudged a no-boundary change)
  let owedReasonText = null;    // the text of the block carrying `e2e-owed-live-gate:` — its reason is checked below
  const editedModulePaths = new Set();
  for (const entry of turnEntries) {
    for (const block of contentBlocks(entry)) {
      if (block.type === 'text') {
        if (SKIP_RE.test(block.text || '')) skipOverride = true;
        if (OWED_RE.test(block.text || '')) owedReasonText = block.text;
      }
      if (block.type !== 'tool_use') continue;
      if (!CODE_EDIT_TOOLS.has(block.name || '')) continue;
      const filePath = (block.input || {}).file_path || (block.input || {}).path || '';
      if (isLoadBearingSource(filePath)) editedModulePaths.add(filePath);
    }
  }

  // ALSO collect code that entered the tree via a commit/merge THIS turn (e.g. a background agent's worktree
  // branch merged in) — those files were never a Write/Edit tool_use, so the scan above is blind to them. Without
  // this, a subagent's mocked-boundary module merges in with no e2e and stops clean. Fail-open on any git error.
  const turnCommitShas = commitShasFromToolResults(turnEntries);
  if (turnCommitShas.length) {
    for (const filePath of gitFilesForCommits(repoRoot, turnCommitShas)) {
      if (isLoadBearingSource(filePath)) editedModulePaths.add(filePath);
    }
  }

  // `e2e-skip:` is a true pass; the owed override still falls through so its offenders get RECORDED below.
  if (skipOverride || editedModulePaths.size === 0) return;

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
    // A credential/settings-wiring boundary is covered by ANY credential e2e in the tree (named after the flow it
    // proves, not the component) — so a routine settings edit doesn't block once such an e2e exists.
    if (!hasE2e && boundary === 'credential/settings wiring' && treeHasCredentialE2e(repoRoot)) hasE2e = true;

    const verdict = evaluateModule({ boundary, hasMockedUnitTest, hasE2e });
    if (verdict.block) offenders.push({ module: basename(moduleAbs), stem: basename(moduleAbs).replace(/\.(js|mjs|svelte)$/i, ''), boundary });
  }

  if (offenders.length === 0) return;

  // `e2e-owed-live-gate:` — honored ONLY when its reason names a GENUINE human/hardware gate (mic/WebRTC/camera/
  // hardware/interactive browser). Then record each offender as an OWED gate (the reminder nags until its live
  // e2e runs green) and let this stop PROCEED. A vague reason ("just wiring" / "can't be tested headlessly") is
  // the self-cert abuse — the boundary IS headlessly testable, so the override is REJECTED and the block stands.
  const owedHonored = owedReasonText != null && owedOverrideHonored(owedReasonText);
  if (owedHonored) {
    for (const offender of offenders) recordGate(defaultGatesPath(), { moduleStem: offender.stem, why: offender.boundary, project });
    return;
  }
  const owedRejected = owedReasonText != null && !owedHonored; // a token was present but its reason had no real gate

  const offenderLines = offenders.map((offender) => `  • ${offender.module}  (real boundary: ${offender.boundary})`).join('\n');
  const owedRejectedNote = owedRejected
    ? ['', 'Your `e2e-owed-live-gate:` was REJECTED — its reason named no genuine human/hardware gate (mic, WebRTC,',
       'camera, hardware, interactive browser/OAuth). These boundaries ARE headlessly testable, so "owe it" is not',
       'allowed here — write + RUN the real e2e (a key from .env + node + real fetch is enough), or if this change',
       'truly has no boundary, use `e2e-skip: <why>`.', '']
    : [];
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      'E2E REQUIRED — you changed a load-bearing module that crosses a REAL external boundary, but its only',
      'tests MOCK that boundary and there is NO real end-to-end test. Mocked unit tests are theatre.',
      '',
      'Module(s) this turn with a mocked boundary and no e2e:',
      offenderLines,
      ...owedRejectedNote,
      '',
      "Russell's rule (2026-06-24): \"unit tests without e2e are theatre.\" A test that mocks the runner proves",
      'the wiring, never that the real thing works — the bug a mock physically cannot fake (the WASM bigint, the',
      'real DOM serialization, the real DB round-trip) has no net.',
      '',
      'Add a real e2e (see extension/lib/pyodideTransform.e2e.test.js): a `<module>.e2e.test.js` that exercises',
      'the ACTUAL dependency end-to-end and asserts something a mock could not satisfy. Then re-run it green.',
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
