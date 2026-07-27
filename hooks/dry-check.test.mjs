#!/usr/bin/env node
// dry-check.test.mjs — locks Check 3 (duplicated-LOGIC detection). Check 1/2 (name + noun collisions)
// predate this test; the gap Russell flagged 2026-06-26 was copy-pasted EXPRESSIONS with fresh local names
// (kv_append re-inlining kv_set's reducer) sailing through, because Check 1 only sees colliding NAMES.
// Run: node dry-check.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'dry-check.mjs');

const failures = [];
const check = (label, condition) => { if (condition) console.log(`  ok  ${label}`); else { console.log(`FAIL  ${label}`); failures.push(label); } };
const cleanups = [];
function tempFileWith(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'drycheck-'));
  cleanups.push(dir);
  const path = join(dir, 'recipeExec.js');
  writeFileSync(path, contents);
  return path;
}

function runTool(toolName, filePath, oldString, newString) {
  const toolInput = toolName === 'Write'
    ? { file_path: filePath, content: newString }
    : { file_path: filePath, old_string: oldString, new_string: newString };
  const proc = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
  });
  // Check 3 (verbatim copy-paste) DENIES; Checks 1/2/4 stay advisory. Return both channels joined so
  // an assertion reads the hook's full say, whichever way it spoke.
  try {
    const hookSaid = JSON.parse(proc.stdout || '{}')?.hookSpecificOutput || {};
    return [hookSaid.additionalContext || '', hookSaid.permissionDecisionReason || ''].filter(Boolean).join('\n');
  } catch { return ''; }
}

/** The permissionDecision itself — 'deny' only when a real copy-paste was found. */
function runToolDecision(toolName, filePath, oldString, newString, extraEnvironment) {
  const toolInput = toolName === 'Write'
    ? { file_path: filePath, content: newString }
    : { file_path: filePath, old_string: oldString, new_string: newString };
  const proc = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, ...(extraEnvironment || {}) },
  });
  try { return JSON.parse(proc.stdout || '{}')?.hookSpecificOutput?.permissionDecision || ''; }
  catch { return ''; }
}

// The distinctive reducer EXPRESSION — defined ONCE here so this test file itself holds no literal duplicate
// (else Check 3 would flag its own source). Each fixture binds it to a different name.
const reducerExpr = `String(step.from).split('.').reduce((node, key) => (node == null ? node : node[key]), context)`;
const FILE_WITH_REDUCER = [
  'function kvSet(step, context) {',
  `  const valueToStore = ${reducerExpr};`,
  '  return valueToStore;',
  '}',
  '// PLACEHOLDER_MARKER',
  '',
].join('\n');

// 1) Edit: catches a copy-pasted expression even with a FRESH local name (rowToAppend vs valueToStore).
{
  const filePath = tempFileWith(FILE_WITH_REDUCER);
  const added = [
    'function kvAppend(step, context) {',
    `  const rowToAppend = ${reducerExpr};`,
    '  return [rowToAppend];',
    '}',
  ].join('\n');
  const warningText = runTool('Edit', filePath, '// PLACEHOLDER_MARKER', added);
  check('Edit: flags duplicated LOGIC when a distinctive expression is copy-pasted with a fresh name', /DRY VIOLATION/.test(warningText));
}

// 2) Edit: no false positive on genuinely NEW logic not present in the file.
{
  const filePath = tempFileWith(FILE_WITH_REDUCER);
  const added = `  const totals = rows.filter((row) => row.active).map((row) => row.amount).reduce((sum, amount) => sum + amount, 0);`;
  const warningText = runTool('Edit', filePath, '// PLACEHOLDER_MARKER', added);
  check('Edit: does NOT flag novel logic that is not already in the file', !/DRY VIOLATION/.test(warningText));
}

// 3) Edit: no false positive on short / non-logic guard lines repeated by design.
{
  const guardFile = ['function a(step){', `  if (!step.key) throw new Error('needs a key.');`, '}', '// MARK', ''].join('\n');
  const filePath = tempFileWith(guardFile);
  const warningText = runTool('Edit', filePath, '// MARK', `  if (!step.key) throw new Error('needs a key.');`);
  check('Edit: does NOT flag a short non-logic guard line (no logic markers / under length floor)', !/DRY VIOLATION/.test(warningText));
}

// 4) Edit: in-place edit guard — a line that is part of what is being REMOVED is not "a duplicate".
{
  const filePath = tempFileWith(FILE_WITH_REDUCER);
  const reducerLine = `const valueToStore = ${reducerExpr};`;
  const warningText = runTool('Edit', filePath, reducerLine, reducerLine);
  check('Edit: does NOT flag the very line being replaced (removed-line guard)', !/DRY VIOLATION/.test(warningText));
}

// 5) Write: flags a distinctive line duplicated 2+ times WITHIN one written file...
{
  const filePath = tempFileWith('');
  const written = [
    'function kvSet(step, context) {',
    `  const valueToStore = ${reducerExpr};`,
    '  return valueToStore;',
    '}',
    'function kvAppend(step, context) {',
    `  const valueToStore = ${reducerExpr};`,
    '  return [valueToStore];',
    '}',
  ].join('\n');
  const warningText = runTool('Write', filePath, '', written);
  check('Write: flags a distinctive expression duplicated within the written file', /DRY VIOLATION/.test(warningText));
}

// 6) Write: no self-match false positive — a distinctive line that appears ONCE is not a duplicate.
{
  const filePath = tempFileWith('');
  const written = [
    'function kvSet(step, context) {',
    `  const valueToStore = ${reducerExpr};`,
    '  return valueToStore;',
    '}',
  ].join('\n');
  const warningText = runTool('Write', filePath, '', written);
  check('Write: does NOT flag a distinctive line that appears only once (no self-match)', !/DRY VIOLATION/.test(warningText));
}

// ── Check 4: import-time singleton wiring (god-module) ──────────────────────

const godModule = [
  `import { a } from 'a';`,
  `const toolRegistry = createToolRegistry();`,
  `const bridge = createPageBridge();`,
  `const kvStore = createKvStore(storage);`,
  `const sinks = createSinks();`,
  `registerPageTools(toolRegistry, { bridge });`,
  `registerRecipeTools(toolRegistry, { recipeStore });`,
  `registerGmailTools(toolRegistry, { gmail });`,
  `registerCalendarTools(toolRegistry, { calendar });`,
  `installSeedRecipes(recipeStore);`,
  `export const brain = createSkaffenBrain({ toolRegistry });`,
].join('\n');

// 7) Write: a module wiring many services at top level is flagged for factory extraction.
{
  const filePath = tempFileWith('');
  const warningText = runTool('Write', filePath, '', godModule);
  check('Write: flags import-time wiring sprawl (>= threshold top-level create/register calls)', /Import-time wiring sprawl/.test(warningText));
}

// 8) Write: a lean module with a couple of factory calls is NOT flagged.
{
  const leanModule = [`import { x } from 'x';`, `const store = createStore();`, `export function go(){ return store; }`].join('\n');
  const filePath = tempFileWith('');
  const warningText = runTool('Write', filePath, '', leanModule);
  check('Write: does NOT flag a lean module with few top-level factory calls', !/Import-time wiring sprawl/.test(warningText));
}

// 9) Edit: ADDING another wiring line to an already-sprawling module is flagged.
{
  const filePath = tempFileWith(godModule);
  const warningText = runTool('Edit', filePath, 'export const brain = createSkaffenBrain({ toolRegistry });',
    'export const brain = createSkaffenBrain({ toolRegistry });\nregisterDriveTools(toolRegistry, { drive });');
  check('Edit: flags adding yet another top-level wiring statement to a god-module', /Import-time wiring sprawl/.test(warningText));
}

// 10) Edit: an UNRELATED edit to a sprawling module does not nag (no wiring line added).
{
  const filePath = tempFileWith(godModule);
  const warningText = runTool('Edit', filePath, `import { a } from 'a';`, `import { a } from 'a';\nconst label = 'hi';`);
  check('Edit: does NOT nag on an unrelated edit that adds no wiring statement', !/Import-time wiring sprawl/.test(warningText));
}

// 11) A test file is exempt — wiring fixtures in a test are not a god-module.
{
  const dir = mkdtempSync(join(tmpdir(), 'drycheck-'));
  cleanups.push(dir);
  const testPath = join(dir, 'brain.test.js');
  writeFileSync(testPath, '');
  const warningText = runTool('Write', testPath, '', godModule);
  check('exempts *.test.* files from the wiring-sprawl check', !/Import-time wiring sprawl/.test(warningText));
}

// ── TEETH (2026-07-27). Russell: "the goal is to create a hook to make my coding DRY."
// This hook detected duplication for a year and ended every message with "soft warning, not a
// block... the edit proceeds either way" — so every copy-paste it caught was waved through. Check 3
// now DENIES. Checks 1/2/4 stay advisory (heuristics; Check 1 flags ordinary function PARAMETERS).

// 12) A copy-pasted expression is DENIED, not merely mentioned.
{
  const filePath = tempFileWith(FILE_WITH_REDUCER);
  const added = `  const rowToAppend = ${reducerExpr};`;
  check('DENIES a copy-pasted expression (teeth, not advice)',
    runToolDecision('Edit', filePath, '// PLACEHOLDER_MARKER', added) === 'deny');
}

// 13) The DRY_OK token in the content releases a deliberate duplicate.
{
  const filePath = tempFileWith(FILE_WITH_REDUCER);
  const added = `  const rowToAppend = ${reducerExpr}; // DRY_OK intentional fixture`;
  check('escape token in the content releases the block',
    runToolDecision('Edit', filePath, '// PLACEHOLDER_MARKER', added) !== 'deny');
}

// 14) The DRY_OK env var releases it too, with the duplicate still present.
{
  const filePath = tempFileWith(FILE_WITH_REDUCER);
  const added = `  const rowToAppend = ${reducerExpr};`;
  check('DRY_OK=1 env releases the block while the condition still fails',
    runToolDecision('Edit', filePath, '// PLACEHOLDER_MARKER', added, { DRY_OK: '1' }) !== 'deny');
}

// 15) Novel logic is never denied — the false-positive rail.
{
  const filePath = tempFileWith(FILE_WITH_REDUCER);
  const added = `  const activeTotal = rows.filter((row) => row.active).map((row) => row.amount).reduce((sum, amount) => sum + amount, 0);`;
  check('does NOT deny genuinely new logic', runToolDecision('Edit', filePath, '// PLACEHOLDER_MARKER', added) !== 'deny');
}

// 16) A name collision alone (Check 1) must NEVER deny — it flags plain function parameters.
{
  const filePath = tempFileWith(FILE_WITH_REDUCER);
  check('a Check-1 name collision stays advisory, never a block',
    runToolDecision('Edit', filePath, '// PLACEHOLDER_MARKER', 'function kvSet(step, context) { return 1; }') !== 'deny');
}

// 17) Fails OPEN on malformed stdin — a broken payload must never brick an edit.
{
  const proc = spawnSync('node', [HOOK], { input: '{not json', encoding: 'utf8' });
  check('fails open on malformed stdin (no deny, exit 0)',
    proc.status === 0 && !/"permissionDecision"\s*:\s*"deny"/.test(proc.stdout || ''));
}

// ── RED-TEAM FINDING (2026-07-27): proven live — a second test case in a .test.js file
// legitimately recomputing an "expected value" via the same expression got DENIED. That is a
// routine, self-contained test-writing pattern, not the drift hazard this check targets in
// production logic. Test/spec files now stay advisory (still detected, never blocked).

// 18) A .test.js file repeating a computation across two `it()` blocks is NEVER denied.
{
  const dir = mkdtempSync(join(tmpdir(), 'drycheck-'));
  cleanups.push(dir);
  const testPath = join(dir, 'orders.test.js');
  const before = [
    "describe('order totals', () => {",
    "  it('sums active line items for a small cart', () => {",
    '    const total = orderRows.filter((row) => row.active).reduce((sum, row) => sum + row.price, 0);',
    '    expect(total).toBe(42);',
    '  });',
    '});',
    '// MARK',
    '',
  ].join('\n');
  writeFileSync(testPath, before);
  const added = [
    '',
    "  it('computes the same total for a large cart', () => {",
    '    const total = orderRows.filter((row) => row.active).reduce((sum, row) => sum + row.price, 0);',
    '    expect(total).toBe(9001);',
    '  });',
  ].join('\n');
  const decisionProc = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: testPath, old_string: '// MARK', new_string: added } }),
    encoding: 'utf8',
  });
  const decisionOutput = JSON.parse(decisionProc.stdout || '{}')?.hookSpecificOutput || {};
  check('a repeated computation across two it() blocks is never denied',
    decisionOutput.permissionDecision !== 'deny');
  check('...but the duplicate is still surfaced advisory (detection is not lost, only the block)',
    /DRY-CHECK WARNING/.test(decisionOutput.additionalContext || ''));
}

// 19) REGRESSION — the SAME duplicate in a real .js (production) file still DENIES.
{
  const filePath = tempFileWith(FILE_WITH_REDUCER);
  const added = `  const rowToAppend = ${reducerExpr};`;
  check('the identical duplicate in a non-test source file still denies (fix stays scoped to tests)',
    runToolDecision('Edit', filePath, '// PLACEHOLDER_MARKER', added) === 'deny');
}

for (const path of cleanups) { try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ } }

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll dry-check best-practices tests passed.');
