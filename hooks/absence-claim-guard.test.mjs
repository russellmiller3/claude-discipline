import assert from 'node:assert/strict';
import {
  makesAbsenceClaim, ranRepoWideSearch, absenceClaimViolation,
} from './absence-claim-guard.mjs';

let passed = 0;
function test(name, caseBody) { caseBody(); passed++; console.log(`  ✓ ${name}`); }

const singleFileGrep = [{ name: 'Bash', input: { command: 'grep -n "run_recipe" scripts/codeservo_tools.py' } }];
const singleFileGrepTool = [{ name: 'Grep', input: { pattern: 'run_recipe', path: 'scripts/codeservo_tools.py' } }];

// ── positives: absence-claim about a capability + NO repo-wide search → violation ──
test('positive 1: "no X method" + single-file bash grep blocks', () => {
  assert.ok(absenceClaimViolation("There's no run_recipe method in the adapter.", singleFileGrep));
});
test('positive 2: "net-new / no existing engine" + no search blocks', () => {
  assert.ok(absenceClaimViolation('This is net-new — no existing replay engine.', []));
});
test('positive 3: "API doesn\'t exist" + single-file Grep tool blocks', () => {
  assert.ok(absenceClaimViolation('The rollback API doesn’t exist yet.', singleFileGrepTool));
});
test('positive 4: "missing a capability" + narrow grep blocks', () => {
  assert.ok(absenceClaimViolation('CodeServo is missing a recipe capability.', singleFileGrep));
});
test('positive 5: "isn\'t implemented" phrasing blocks', () => {
  assert.ok(absenceClaimViolation('That verb isn’t implemented.', singleFileGrep));
});

// ── negatives: a repo-wide search this turn clears the claim ──
test('negative: absence-claim + repo-wide Grep (no path) allows', () => {
  const wideSearch = [{ name: 'Grep', input: { pattern: 'run_recipe' } }];
  assert.equal(absenceClaimViolation("There's no run_recipe method.", wideSearch), false);
});
test('negative: absence-claim + bash grep -r allows', () => {
  const wideSearch = [{ name: 'Bash', input: { command: 'grep -rn "run_recipe" scripts/' } }];
  assert.equal(absenceClaimViolation('net-new, no replay engine.', wideSearch), false);
});
test('negative: absence-claim + ripgrep allows', () => {
  const wideSearch = [{ name: 'Bash', input: { command: 'rg "run_recipe" .' } }];
  assert.equal(absenceClaimViolation('The recipe API does not exist.', wideSearch), false);
});
test('negative: absence-claim + Glob allows', () => {
  const wideSearch = [{ name: 'Glob', input: { pattern: '**/*recipe*.py' } }];
  assert.equal(absenceClaimViolation('no recipe module here.', wideSearch), false);
});
test('negative: absence-claim + Grep with directory path allows', () => {
  const wideSearch = [{ name: 'Grep', input: { pattern: 'recipe', path: 'scripts' } }];
  assert.equal(absenceClaimViolation("there's no recipe engine.", wideSearch), false);
});

// ── escape hatch ──
test('escape: "absence-verified:" allows even with narrow search', () => {
  assert.equal(
    absenceClaimViolation('No replay API. absence-verified: grepped the whole repo, only recipes.py.', singleFileGrep),
    false);
});

// ── no absence-claim → never a violation ──
test('no claim: a normal progress reply passes', () => {
  assert.equal(absenceClaimViolation('I refactored the loader; the tests pass.', singleFileGrep), false);
});

// ── false-positive guards: innocent negations must NOT be absence-claims ──
test('fp: "there\'s no need to refactor" is not an absence-claim', () => {
  assert.equal(makesAbsenceClaim("There's no need to refactor this."), false);
});
test('fp: "no problem" is not an absence-claim', () => {
  assert.equal(makesAbsenceClaim('No problem, that works.'), false);
});
test('fp: a missing FILE (not a capability noun) is not an absence-claim', () => {
  assert.equal(makesAbsenceClaim('The config file does not exist at that path.'), false);
});

// ── ranRepoWideSearch unit truth table ──
test('unit: single-file grep is NOT repo-wide', () => {
  assert.equal(ranRepoWideSearch(singleFileGrep), false);
  assert.equal(ranRepoWideSearch(singleFileGrepTool), false);
});
test('unit: git grep and find -name count as repo-wide', () => {
  assert.ok(ranRepoWideSearch([{ name: 'Bash', input: { command: 'git grep foo' } }]));
  assert.ok(ranRepoWideSearch([{ name: 'Bash', input: { command: 'find . -name "*.py"' } }]));
});

// ── fail-open ──
test('fail-open: null inputs are not a violation', () => {
  assert.equal(absenceClaimViolation(null, null), false);
  assert.equal(makesAbsenceClaim(null), false);
  assert.equal(ranRepoWideSearch(null), false);
});

console.log(`\n${passed} tests passed`);
