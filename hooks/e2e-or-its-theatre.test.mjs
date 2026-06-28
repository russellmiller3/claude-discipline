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
  commitShasFromToolResults, gitFilesForCommits, owedOverrideHonored,
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

// The blind spot that shipped the exa key fix untested: a settings UI that COLLECTS an api key has no fetch of
// its own (the key is sent by a downstream collaborator), so boundaryOf saw NONE and the gate never fired —
// even though the change's whole correctness was "does this key reach its service." A password input bound to a
// *Key/*Token/*Secret field IS a real external boundary (a credential that feeds an API).
check('boundaryOf: a settings component collecting an API key (password input → *Key) is credential wiring', () => {
  assert.equal(boundaryOf('<input class="fld" type="password" bind:value={exaKey} placeholder="exa-…" />'), 'credential/settings wiring');
  assert.equal(boundaryOf('<input type="password" bind:value={firecrawlKey} />'), 'credential/settings wiring');
  // a non-credential password field (a login form, no *Key) is NOT this boundary
  assert.equal(boundaryOf('<input type="password" bind:value={loginPassword} />'), null);
});

// The self-cert abuse this session: I typed `e2e-owed-live-gate:` with a reason like "it's just wiring / can't
// be tested headlessly" and slipped past the gate on a NETWORK boundary that WAS headlessly testable (proven —
// I later wrote exactly that harness). The owed override is only legitimate for a GENUINE human/hardware gate.
check('owedOverrideHonored: only a real human/hardware gate honors the owed override', () => {
  assert.equal(owedOverrideHonored('e2e-owed-live-gate: needs a real mic + WebRTC socket'), true);
  assert.equal(owedOverrideHonored('e2e-owed-live-gate: needs real headphones / audio playback'), true);
  assert.equal(owedOverrideHonored('e2e-owed-live-gate: requires interactive OAuth sign-in'), true);
  // the abuse shapes — no real human gate named → NOT honored, the gate must keep blocking
  assert.equal(owedOverrideHonored('e2e-owed-live-gate: debug-log wiring only, not a network-path change'), false);
  assert.equal(owedOverrideHonored("e2e-owed-live-gate: the real boundary can't be exercised headlessly"), false);
  assert.equal(owedOverrideHonored('e2e-owed-live-gate: in-app only'), false);
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

check('commitShasFromToolResults: pulls SHAs out of git commit/merge tool_result text', () => {
  const turnEntries = [
    { message: { role: 'user', content: [
      { type: 'tool_result', content: '[feature/x d2e7336] merge: Exa search + Firecrawl\n create mode 100644 lib/exa.js' },
    ] } },
    { message: { role: 'user', content: [
      { type: 'tool_result', content: [{ type: 'text', text: '[main 5552401] feat(gmail): attachments' }] },
    ] } },
  ];
  const shas = commitShasFromToolResults(turnEntries);
  assert.deepEqual(shas.sort(), ['5552401', 'd2e7336']);
});
check('commitShasFromToolResults: ignores prose that is not a commit line', () => {
  const turnEntries = [{ message: { role: 'user', content: [{ type: 'tool_result', content: 'nothing here, just abc1234 inline' }] } }];
  assert.deepEqual(commitShasFromToolResults(turnEntries), []);
});
check('gitFilesForCommits: diffs sha^1..sha (merge first-parent) via injected git, fails open', () => {
  const calls = [];
  const runGit = (args) => { calls.push(args); return 'extension/lib/exa.js\nextension/lib/exa.test.js\n'; };
  const files = gitFilesForCommits('/repo', ['d2e7336'], runGit);
  assert.deepEqual(files, ['extension/lib/exa.js', 'extension/lib/exa.test.js']);
  assert.deepEqual(calls[0], ['diff', '--name-only', 'd2e7336^1', 'd2e7336']);
  // throwing git → no files, never throws (fail-open)
  assert.deepEqual(gitFilesForCommits('/repo', ['bad'], () => { throw new Error('not a repo'); }), []);
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
      ...(override ? [{ type: 'text', text: `e2e-owed-live-gate: ${typeof override === 'string' ? override : 'needs a real mic'}` }] : []),
    ] } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  const transcriptPath = join(root, 'transcript.jsonl');
  writeFileSync(transcriptPath, transcriptEntries);
  return { root, transcriptPath };
}

function runHook(root, transcriptPath) {
  const event = JSON.stringify({ hook_event_name: 'Stop', cwd: root, transcript_path: transcriptPath });
  // Isolate the owed-gate ledger onto a per-run temp file — the `e2e-owed-live-gate` override now RECORDS to
  // the ledger, and without this the test would pollute the real ~/.claude ledger (it did once, firing a false
  // reminder). Each runHook gets a fresh ledger path inside the test's temp project.
  const gatesPath = join(root, `owed-gates-${Math.random().toString(36).slice(2)}.json`);
  try {
    const hookOutput = execFileSync('node', [HOOK_PATH], { input: event, encoding: 'utf8', env: { ...process.env, OWED_GATES_PATH: gatesPath } });
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

check('OVERRIDE: an owed-live-gate token naming a REAL human gate (mic) lets the turn stop', () => {
  const { root, transcriptPath } = makeRepo({ withE2e: false, override: true }); // default reason: "needs a real mic"
  const hookOutput = runHook(root, transcriptPath);
  assert.equal(hookOutput, '', `a genuine human-gate override should clear the block, got: ${hookOutput.slice(0, 200)}`);
  rmSync(root, { recursive: true, force: true });
});

check('OVERRIDE REJECTED: an owed token with no real human-gate reason STILL BLOCKS (the self-cert abuse)', () => {
  const { root, transcriptPath } = makeRepo({ withE2e: false, override: 'debug-log wiring only, not a network change' });
  const hookOutput = runHook(root, transcriptPath);
  assert.ok(hookOutput.includes('"decision":"block"'), `a bad-reason owed override must still block, got: ${hookOutput.slice(0, 200)}`);
  rmSync(root, { recursive: true, force: true });
});

// ── credential/settings wiring (the exa-key blind spot) ─────────────────────────
// A settings component that collects an api key (password input → *Key) is a real boundary, but the e2e proving
// the key reaches its service is named after the FLOW (researchKeyFromSettings.e2e), not the component — so it
// must be accepted by content, not stem. Build a settings-like module + a mocked unit test, and assert: BLOCK
// with no credential e2e anywhere; PASS once a credential e2e exists under a different name.
function makeCredentialRepo({ withCredentialE2e }) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-cred-'));
  const componentsDir = join(root, 'extension', 'src', 'lib', 'components');
  mkdirSync(componentsDir, { recursive: true });
  const componentPath = join(componentsDir, 'Settings.svelte');
  writeFileSync(componentPath, '<input class="fld" type="password" bind:value={exaKey} placeholder="exa-…" />\n');
  writeFileSync(join(componentsDir, 'Settings.test.js'), "import { vi } from 'vitest';\nconst onsave = vi.fn();\n");
  if (withCredentialE2e) {
    // Named after the flow, NOT the component — proves a settings key reaches the real service.
    writeFileSync(join(root, 'extension', 'src', 'lib', 'researchKeyFromSettings.e2e.test.js'),
      "it('a Settings exaKey reaches the real Exa API', async () => { const exaKey = process.env.EXA; });\n");
  }
  const transcriptEntries = [
    { type: 'user', message: { role: 'user', content: 'add the exa key field' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: componentPath } },
    ] } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  const transcriptPath = join(root, 'transcript.jsonl');
  writeFileSync(transcriptPath, transcriptEntries);
  return { root, transcriptPath };
}

check('TEETH (credential): a settings component collecting an api key with mocked tests + NO credential e2e BLOCKS', () => {
  const { root, transcriptPath } = makeCredentialRepo({ withCredentialE2e: false });
  const hookOutput = runHook(root, transcriptPath);
  assert.ok(hookOutput.includes('"decision":"block"'), `credential wiring with no e2e should block, got: ${hookOutput.slice(0, 200)}`);
  assert.ok(/credential\/settings wiring/.test(hookOutput), 'block reason should name the credential boundary');
  rmSync(root, { recursive: true, force: true });
});

check('PASS (credential): a flow-named credential e2e elsewhere in the tree clears the settings component', () => {
  const { root, transcriptPath } = makeCredentialRepo({ withCredentialE2e: true });
  const hookOutput = runHook(root, transcriptPath);
  assert.equal(hookOutput, '', `a credential e2e (different name) should clear the block, got: ${hookOutput.slice(0, 200)}`);
  rmSync(root, { recursive: true, force: true });
});

// ── merge-introduced module (the real blind spot) ───────────────────────────────
// A background agent's branch is merged in. Those files were NEVER a Write/Edit tool_use in this turn — they
// arrived via `git merge`. Build a real git repo, merge a branch carrying a mocked-boundary module with no e2e,
// put the merge SHA in a tool_result (as `git merge` really prints it), and assert the hook BLOCKS.
function git(root, args) {
  return execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
function makeMergedRepo({ withE2e }) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-merge-'));
  const libDir = join(root, 'extension', 'lib');
  mkdirSync(libDir, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'seed']);
  // agent branch: a NEW network-boundary module + a mocked-only unit test (+ optional e2e), committed off main.
  git(root, ['checkout', '-q', '-b', 'agent']);
  writeFileSync(join(libDir, 'exaLike.js'), 'export const search = (q) => fetch("https://api.exa.ai/search");\n');
  writeFileSync(join(libDir, 'exaLike.test.js'), "import { vi } from 'vitest';\nconst request = vi.fn();\n");
  if (withE2e) writeFileSync(join(libDir, 'exaLike.e2e.test.js'), "it('real fetch', async () => {});\n");
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'feat: exaLike']);
  // merge it into main (no-ff so there's a merge commit whose ^1 is main's prior HEAD).
  git(root, ['checkout', '-q', 'main']);
  git(root, ['merge', '--no-ff', '-q', '-m', 'merge: exaLike research tool', 'agent']);
  const mergeSha = git(root, ['rev-parse', '--short', 'HEAD']).trim();
  // A transcript: human prompt, assistant runs a Bash `git merge`, then the tool_result with git's real output.
  const transcriptEntries = [
    { type: 'user', message: { role: 'user', content: 'merge the agent branch' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'git merge --no-ff agent' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', content: `[main ${mergeSha}] merge: exaLike research tool\n 2 files changed` },
    ] } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  const transcriptPath = join(root, 'transcript.jsonl');
  writeFileSync(transcriptPath, transcriptEntries);
  return { root, transcriptPath };
}

check('TEETH (merge): blocks a mocked-boundary module that entered via git merge, not Write/Edit', () => {
  const { root, transcriptPath } = makeMergedRepo({ withE2e: false });
  const hookOutput = runHook(root, transcriptPath);
  assert.ok(hookOutput.includes('"decision":"block"'), `expected block for merged-in module, got: ${hookOutput.slice(0, 200)}`);
  assert.ok(/exaLike\.js/.test(hookOutput), 'block reason should name the merged-in module');
  rmSync(root, { recursive: true, force: true });
});

check('PASS (merge): a merged-in module WITH an e2e does not block', () => {
  const { root, transcriptPath } = makeMergedRepo({ withE2e: true });
  const hookOutput = runHook(root, transcriptPath);
  assert.equal(hookOutput, '', `merged-in module with e2e should pass, got: ${hookOutput.slice(0, 200)}`);
  rmSync(root, { recursive: true, force: true });
});

console.log(`\n${passedCount} checks passed.`);
