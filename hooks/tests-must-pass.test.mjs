// tests-must-pass.test.mjs — regression net for the no-red-tests gate.
//
// The bug this pins (2026-06-22): the marker that a RED run drops could only be CLEARED by a literal
// `npm test`. But when npm.cmd is unavailable the suite is run as `node node_modules/vitest/vitest.mjs
// run --passWithNoTests`, and a GREEN one of those never cleared the marker — so the gate stuck across the
// rest of the session even though every test passed. Fix: a full (non-file-scoped) vitest run also clears.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'tests-must-pass.mjs');
const MARKER_RELATIVE = join('.claude', 'state', 'tests-failing.json');

function makeRepo() {
	const repoRoot = mkdtempSync(join(tmpdir(), 'red-test-gate-'));
	mkdirSync(join(repoRoot, '.git'), { recursive: true });
	writeFileSync(join(repoRoot, 'package.json'), '{}');
	return repoRoot;
}

function runHook(event) {
	const completed = spawnSync(process.execPath, [hookPath], { input: JSON.stringify(event), encoding: 'utf8' });
	return completed.stdout || '';
}

function postBash(repoRoot, command, runnerOutput) {
	return runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: runnerOutput }, cwd: repoRoot });
}

const redOutput = ' Test Files  1 failed (131)\n      Tests  1 failed | 1124 passed (1125)';
const greenOutput = ' Test Files  131 passed (131)\n      Tests  1125 passed (1125)';
const fullSuiteCommand = 'node node_modules/vitest/vitest.mjs run --passWithNoTests';
const scopedCommand = 'node node_modules/vitest/vitest.mjs run --passWithNoTests lib/contractCheck.test.js';

test('a RED vitest run drops the failing marker', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, fullSuiteCommand, redOutput);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), true, 'red run must arm the gate');
});

test('a GREEN full vitest run (direct node path) CLEARS the marker — the stuck-gate bug', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, fullSuiteCommand, redOutput); // arm it
	postBash(repoRoot, fullSuiteCommand, greenOutput); // green full run should disarm
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), false, 'green full vitest run must clear the gate');
});

test('a GREEN file-scoped run does NOT clear the marker (it did not run every test)', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, fullSuiteCommand, redOutput);
	postBash(repoRoot, scopedCommand, greenOutput);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), true, 'a partial green run must not clear a real failure');
});

test('Stop blocks while the marker exists, and passes once it is cleared', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, fullSuiteCommand, redOutput);
	const blockedStop = runHook({ hook_event_name: 'Stop', cwd: repoRoot });
	assert.match(blockedStop, /STOP-BLOCKED/, 'Stop must block with a live failing marker');
	postBash(repoRoot, fullSuiteCommand, greenOutput);
	const clearedStop = runHook({ hook_event_name: 'Stop', cwd: repoRoot });
	assert.equal(clearedStop.trim(), '', 'Stop must pass once the suite is green');
});

// 2026-07-16 BUG 1: a pytest / node-test repo had NO command that both runs the full suite AND matched
// the reset pattern, so a marker set by a TDD RED could never be cleared — the Stop gate wedged forever.
const pytestRed = '=== 1 failed, 3 passed in 0.4s ===';
const pytestGreen = '=== 5 passed in 0.4s ===';
test('a GREEN full pytest run clears the marker (the pytest-repo wedge)', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, 'node git-hygiene.test.mjs', redOutput);          // arm via a file-scoped red
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), true, 'red run must arm the gate');
	postBash(repoRoot, 'py -3 -m pytest', pytestGreen);                  // whole-suite pytest, green
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), false, 'a green full pytest run must clear the marker');
});
test('a GREEN file-scoped pytest run does NOT clear the marker', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, 'node git-hygiene.test.mjs', redOutput);
	postBash(repoRoot, 'py -3 -m pytest tests/test_foo.py::bar', pytestGreen);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), true, 'a file-scoped pytest run did not exercise every test');
});
test('a GREEN node --test run clears the marker', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, 'node foo.test.mjs', redOutput);
	postBash(repoRoot, 'node --test', greenOutput);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), false, 'a green node --test run must clear the marker');
});
test('a RED pytest run arms the marker', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, 'py -3 -m pytest', pytestRed);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), true, 'a red pytest run must arm the gate');
});

// 2026-07-16 BUG 2: the marker was filed at the SESSION cwd's git root, ignoring a leading `cd otherrepo`.
// A red test for repo A run from a repo-B session filed the marker into B — blocking B's Stop, and the
// reset would target the wrong repo. The marker must file at the repo the command actually cd'd into.
test('a `cd otherRepo && <test>` red run files the marker in otherRepo, not the session cwd', () => {
	const sessionRepo = makeRepo();
	const otherRepo = makeRepo();
	postBash(sessionRepo, `cd "${otherRepo}" && node x.test.mjs`, redOutput);
	assert.equal(existsSync(join(otherRepo, MARKER_RELATIVE)), true, 'marker belongs to the cd-target repo');
	assert.equal(existsSync(join(sessionRepo, MARKER_RELATIVE)), false, 'the session repo must NOT get the marker');
});

test('a green run from a NESTED package dir clears the git-root marker (nested-root bug)', () => {
	const repoRoot = makeRepo();
	const nestedDir = join(repoRoot, 'extension');
	mkdirSync(nestedDir, { recursive: true });
	writeFileSync(join(nestedDir, 'package.json'), '{}'); // nested package — its own findProjectRoot
	postBash(repoRoot, fullSuiteCommand, redOutput); // arm at the git root
	postBash(nestedDir, fullSuiteCommand, greenOutput); // green run from the nested package dir
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), false, 'a green run from a subdir must clear the git-root marker');
});

// 2026-07-21 BUG 3: a file-scoped TDD RED could only be released by a full-suite green run,
// even after the exact recorded command passed. A green scope may clear the marker when it covers
// every path that armed it, but a sibling scope must leave the marker armed.
const judgmentFile = 'scripts/test_exp167d_spawn_judgment_arms.py';
const siblingFile = 'scripts/test_exp167e_other.py';

test('a GREEN pytest run of the SAME file clears its file-scoped marker', () => {
	const repoRoot = makeRepo();
	const command = `cd "${repoRoot}" && py -3 -m pytest ${judgmentFile} -q`;
	postBash(repoRoot, command, pytestRed);
	postBash(repoRoot, command, pytestGreen);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), false, 'the exact recorded pytest scope passed');
});

test('a GREEN rerun of the exact selector-only command clears its marker', () => {
	const repoRoot = makeRepo();
	const command = 'py -3 -m pytest -m judgment -q';
	postBash(repoRoot, command, pytestRed);
	postBash(repoRoot, command, pytestGreen);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), false, 'the identical selected scope passed');
});

test('a GREEN pytest run of a DIFFERENT file does not clear the marker', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, `py -3 -m pytest ${judgmentFile} -q`, pytestRed);
	postBash(repoRoot, `py -3 -m pytest ${siblingFile} -q`, pytestGreen);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), true, 'a sibling file did not cover the red scope');
});

test('a GREEN parent-directory pytest run clears a child-file marker', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, `py -3 -m pytest .\\${judgmentFile} -q`, pytestRed);
	postBash(repoRoot, 'py -3 -m pytest scripts/ -q', pytestGreen);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), false, 'the directory run covered the red file');
});

test('a GREEN single-file pytest run does not clear a directory-scoped marker', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, 'py -3 -m pytest scripts/ -q', pytestRed);
	postBash(repoRoot, `py -3 -m pytest ${judgmentFile} -q`, pytestGreen);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), true, 'one file is narrower than the red directory');
});

test('a GREEN unrelated-directory pytest run does not clear the marker', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, `py -3 -m pytest ${judgmentFile} -q`, pytestRed);
	postBash(repoRoot, 'py -3 -m pytest tests/ -q', pytestGreen);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), true, 'an unrelated directory did not cover the red file');
});

test('a GREEN vitest run of the SAME file clears its file-scoped marker', () => {
	const repoRoot = makeRepo();
	postBash(repoRoot, scopedCommand, redOutput);
	postBash(repoRoot, scopedCommand, greenOutput);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), false, 'the exact recorded vitest scope passed');
});

test('a GREEN jest run of the SAME file clears its file-scoped marker', () => {
	const repoRoot = makeRepo();
	const command = 'npx jest lib/contractCheck.test.js --runInBand';
	postBash(repoRoot, command, redOutput);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), true, 'jest red must arm the gate');
	postBash(repoRoot, command, greenOutput);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), false, 'the exact recorded jest scope passed');
});

test('named failures from a full red run can be cleared by a green run covering their files', () => {
	const repoRoot = makeRepo();
	const namedRedOutput = `❌ ${judgmentFile}::test_judgment_arm\n${pytestRed}`;
	postBash(repoRoot, 'py -3 -m pytest', namedRedOutput);
	postBash(repoRoot, `py -3 -m pytest ${judgmentFile} -q`, pytestGreen);
	assert.equal(existsSync(join(repoRoot, MARKER_RELATIVE)), false, 'the green file covered every named failure');
});
