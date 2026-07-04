// pres-cycle-guard.test.mjs — run: node --test ~/.claude/hooks/pres-cycle-guard.mjs
//
// Covers the 8 required scenarios end-to-end (spawns the real hook process
// against a throwaway fixture repo) plus the pure-function units it's built
// from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
	planHasResearchNotesWithSource,
	isPlanMarkdownPath,
	looksLikeTrainingLaunch,
	isExemptSmokeTest,
	planIsRedTeamedWithResearch,
	repoOptsIntoPresCycle,
	findRepoRoot
} from './pres-cycle-guard.mjs';

const thisDirectory = dirname(fileURLToPath(import.meta.url));
const GUARD = join(thisDirectory, 'pres-cycle-guard.mjs');

const OPTED_IN_AGENTS_MD = `# AGENTS.md
14. ALWAYS review the research before planning: the References section
    of Truth-ledger.md FIRST, then a web check. A plan without a
    research-review section is not a plan.
`;

function makeFixtureRepo({ optedIn = true } = {}) {
	const repoRoot = mkdtempSync(join(tmpdir(), 'pres-cycle-guard-'));
	mkdirSync(join(repoRoot, '.git'));
	mkdirSync(join(repoRoot, 'plans'));
	if (optedIn) {
		writeFileSync(join(repoRoot, 'AGENTS.md'), OPTED_IN_AGENTS_MD);
	} else {
		writeFileSync(join(repoRoot, 'AGENTS.md'), '# AGENTS.md\nJust a normal repo, no /pres rules here.\n');
	}
	return repoRoot;
}

function writePlan(repoRoot, filename, planContent, { mtimeOffsetMs = 0 } = {}) {
	const planPath = join(repoRoot, 'plans', filename);
	writeFileSync(planPath, planContent);
	if (mtimeOffsetMs) {
		const targetTime = new Date(Date.now() + mtimeOffsetMs);
		utimesSync(planPath, targetTime, targetTime);
	}
	return planPath;
}

function runHook({ toolName, toolInput, workingDirectory }) {
	const childEnv = { ...process.env };
	delete childEnv.PRES_CYCLE_OK;
	const run = spawnSync('node', [GUARD], {
		input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: workingDirectory }),
		encoding: 'utf8',
		env: childEnv
	});
	return run.stdout || '';
}

function wasDenied(hookStdout) {
	return /"permissionDecision"\s*:\s*"deny"/.test(hookStdout);
}

function assertSilentPass(hookStdout) {
	assert.equal(wasDenied(hookStdout), false);
	assert.equal(hookStdout.trim(), '');
}

const PLAN_WITH_RESEARCH = `# Plan: Something

## Research notes (verified 2026-07-04, 2 primary sources)

- Truth-ledger.md References section covers this already.
- Web check: https://example.com/paper confirms current best practice.

## The problem
Something needs building.
`;

const PLAN_WITHOUT_RESEARCH = `# Plan: Something

## The problem
Something needs building, no research section at all.
`;

const PLAN_RED_TEAMED = `# Plan: Something

red-teamed: 2026-07-04

## Research notes (verified 2026-07-04, 2 primary sources)

- Truth-ledger.md References section covers this already.
- Web check: https://example.com/paper confirms current best practice.

## The problem
Something needs building.
`;

let sharedRepoRoot;

test('setup: build fixture repo', () => {
	sharedRepoRoot = makeFixtureRepo();
	assert.ok(repoOptsIntoPresCycle(sharedRepoRoot));
});

// -----------------------------------------------------------------------
// 1. Plan write without Research notes -> blocks
// -----------------------------------------------------------------------
test('plan write without Research notes section is blocked', () => {
	const hookStdout = runHook({
		toolName: 'Write',
		toolInput: { file_path: join(sharedRepoRoot, 'plans', 'plan-a.md'), content: PLAN_WITHOUT_RESEARCH },
		workingDirectory: sharedRepoRoot
	});
	assert.equal(wasDenied(hookStdout), true);
	assert.match(hookStdout, /rule 14/);
});

// -----------------------------------------------------------------------
// 2. Plan write with Research notes -> passes
// -----------------------------------------------------------------------
test('plan write with a Research notes section citing a primary source passes', () => {
	const hookStdout = runHook({
		toolName: 'Write',
		toolInput: { file_path: join(sharedRepoRoot, 'plans', 'plan-b.md'), content: PLAN_WITH_RESEARCH },
		workingDirectory: sharedRepoRoot
	});
	assert.equal(wasDenied(hookStdout), false);
});

// -----------------------------------------------------------------------
// 3. Training launch with unstamped newest plan -> blocks
// -----------------------------------------------------------------------
test('training launch is blocked when the newest plan lacks the red-teamed stamp', () => {
	writePlan(sharedRepoRoot, 'plan-unstamped.md', PLAN_WITH_RESEARCH, { mtimeOffsetMs: 5000 });
	const hookStdout = runHook({
		toolName: 'Bash',
		toolInput: { command: 'python modal_gate1.py --arms plain64 --seeds 1337 --steps 4000' },
		workingDirectory: sharedRepoRoot
	});
	assert.equal(wasDenied(hookStdout), true);
	assert.match(hookStdout, /rule 13/);
});

// -----------------------------------------------------------------------
// 4. Training launch with stamped plan -> passes
// -----------------------------------------------------------------------
test('training launch passes when the newest plan is red-teamed with research notes', () => {
	writePlan(sharedRepoRoot, 'plan-stamped.md', PLAN_RED_TEAMED, { mtimeOffsetMs: 10000 });
	const hookStdout = runHook({
		toolName: 'Bash',
		toolInput: { command: 'python modal_gate1.py --arms plain64 --seeds 1337 --steps 4000' },
		workingDirectory: sharedRepoRoot
	});
	assert.equal(wasDenied(hookStdout), false);
});

// -----------------------------------------------------------------------
// 5. --steps 60 smoke test -> passes
// -----------------------------------------------------------------------
test('a smoke-test launch with --steps 60 passes even without a stamped plan', () => {
	const repoRoot = makeFixtureRepo();
	writePlan(repoRoot, 'plan-unstamped.md', PLAN_WITH_RESEARCH);
	const hookStdout = runHook({
		toolName: 'Bash',
		toolInput: { command: 'python modal_gate1.py --arms plain64 --seeds 1337 --steps 60' },
		workingDirectory: repoRoot
	});
	assert.equal(wasDenied(hookStdout), false);
	rmSync(repoRoot, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// 6. PRES_CYCLE_OK -> passes (both check types)
// -----------------------------------------------------------------------
test('PRES_CYCLE_OK escape valve passes the plan-quality check', () => {
	const hookStdout = runHook({
		toolName: 'Write',
		toolInput: {
			file_path: join(sharedRepoRoot, 'plans', 'plan-override.md'),
			content: PLAN_WITHOUT_RESEARCH + '\n<!-- PRES_CYCLE_OK: reproducing RESULTS.md exp9 verbatim -->\n'
		},
		workingDirectory: sharedRepoRoot
	});
	assert.equal(wasDenied(hookStdout), false);
});

test('PRES_CYCLE_OK escape valve passes the training-launch check', () => {
	const hookStdout = runHook({
		toolName: 'Bash',
		toolInput: { command: 'python modal_gate1.py --steps 4000 # PRES_CYCLE_OK reproducing exp9' },
		workingDirectory: sharedRepoRoot
	});
	assert.equal(wasDenied(hookStdout), false);
});

// -----------------------------------------------------------------------
// 7. Non-opted-in repo -> silent pass
// -----------------------------------------------------------------------
test('a repo whose AGENTS.md does not opt in gets a silent pass on both checks', () => {
	const repoRoot = makeFixtureRepo({ optedIn: false });

	const planHookStdout = runHook({
		toolName: 'Write',
		toolInput: { file_path: join(repoRoot, 'plans', 'plan-x.md'), content: PLAN_WITHOUT_RESEARCH },
		workingDirectory: repoRoot
	});
	assertSilentPass(planHookStdout);

	const launchHookStdout = runHook({
		toolName: 'Bash',
		toolInput: { command: 'python modal_gate1.py --steps 4000' },
		workingDirectory: repoRoot
	});
	assertSilentPass(launchHookStdout);

	rmSync(repoRoot, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// 8. Malformed input -> silent pass
// -----------------------------------------------------------------------
test('malformed JSON on stdin is a silent pass', () => {
	const run = spawnSync('node', [GUARD], { input: '{not valid json', encoding: 'utf8' });
	assertSilentPass(run.stdout || '');
	assert.equal(run.status, 0);
});

test('empty stdin is a silent pass', () => {
	const run = spawnSync('node', [GUARD], { input: '', encoding: 'utf8' });
	assertSilentPass(run.stdout || '');
	assert.equal(run.status, 0);
});

test('cleanup: remove fixture repo', () => {
	rmSync(sharedRepoRoot, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// Pure-function unit tests
// -----------------------------------------------------------------------

test('planHasResearchNotesWithSource requires both the heading AND a citation', () => {
	assert.equal(planHasResearchNotesWithSource(PLAN_WITH_RESEARCH), true);
	assert.equal(planHasResearchNotesWithSource(PLAN_WITHOUT_RESEARCH), false);
	assert.equal(planHasResearchNotesWithSource('## Research notes\nNo citation here at all.'), false);
});

test('planHasResearchNotesWithSource does not count a citation outside the section', () => {
	const planWithSourceElsewhere = `# Plan\n\n## Research notes\nNothing here.\n\n## Other section\nSee https://example.com for details.\n`;
	assert.equal(planHasResearchNotesWithSource(planWithSourceElsewhere), false);
});

test('isPlanMarkdownPath matches plans/*.md only', () => {
	assert.equal(isPlanMarkdownPath('/repo/plans/plan-a.md', '/repo'), true);
	assert.equal(isPlanMarkdownPath('C:\\repo\\plans\\plan-a.md', 'C:\\repo'), true);
	assert.equal(isPlanMarkdownPath('/repo/RESULTS.md', '/repo'), false);
	assert.equal(isPlanMarkdownPath('/repo/plans/sub/plan-a.md', '/repo'), false);
	assert.equal(isPlanMarkdownPath('/repo/plans/plan-a.txt', '/repo'), false);
});

test('looksLikeTrainingLaunch recognizes the named launch shapes', () => {
	assert.equal(looksLikeTrainingLaunch('python modal_gate1.py --steps 4000'), true);
	assert.equal(looksLikeTrainingLaunch('python gate1.py --single --steps 4000'), true);
	assert.equal(looksLikeTrainingLaunch('python diag_isolate_sweep.py'), true);
	assert.equal(looksLikeTrainingLaunch('python seed_distribution.py'), true);
	assert.equal(looksLikeTrainingLaunch('git status'), false);
	assert.equal(looksLikeTrainingLaunch('node report.mjs'), false);
});

test('isExemptSmokeTest treats missing --steps as a full (gated) run', () => {
	assert.equal(isExemptSmokeTest('python modal_gate1.py --arms plain64'), false);
	assert.equal(isExemptSmokeTest('python modal_gate1.py --steps 60'), true);
	assert.equal(isExemptSmokeTest('python modal_gate1.py --steps 100'), true);
	assert.equal(isExemptSmokeTest('python modal_gate1.py --steps 101'), false);
	assert.equal(isExemptSmokeTest('python modal_gate1.py --steps 4000'), false);
});

test('planIsRedTeamedWithResearch requires both the stamp and the research section', () => {
	assert.equal(planIsRedTeamedWithResearch(PLAN_RED_TEAMED), true);
	assert.equal(planIsRedTeamedWithResearch(PLAN_WITH_RESEARCH), false); // no stamp
	assert.equal(planIsRedTeamedWithResearch('red-teamed: 2026-07-04\n\nNo research section.'), false);
});

test('findRepoRoot walks up to a directory with .git or AGENTS.md', () => {
	const repoRoot = makeFixtureRepo();
	const nestedDirectory = join(repoRoot, 'plans');
	assert.equal(findRepoRoot(nestedDirectory), repoRoot);
	rmSync(repoRoot, { recursive: true, force: true });
});

test('repoOptsIntoPresCycle is false for a repo with no matching AGENTS.md text', () => {
	const repoRoot = makeFixtureRepo({ optedIn: false });
	assert.equal(repoOptsIntoPresCycle(repoRoot), false);
	rmSync(repoRoot, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// Regression: two false positives confirmed live 2026-07-03 in the ledger repo
// -----------------------------------------------------------------------

// BUG A — the runner-token regex matched the "py" INSIDE a ".py" filename
// extension (the dot is a word boundary), so a read-only `wc -l` over .py
// files was classified as a training launch and denied.
test('bug A: read-only commands listing .py files are NOT training launches', () => {
	assert.equal(looksLikeTrainingLaunch('wc -l northstar-ledger.md evaluate.py gate1.py data.py'), false);
	assert.equal(looksLikeTrainingLaunch('grep -n foo train.py'), false);
});

test('bug A: real interpreter invocations are still training launches', () => {
	assert.equal(looksLikeTrainingLaunch('python gate1.py --single plain64 1337'), true);
	assert.equal(looksLikeTrainingLaunch('py train.py'), true);
	assert.equal(looksLikeTrainingLaunch('node sweep_runner.mjs'), true);
});

test('bug A end-to-end: wc -l over .py files passes even with an unstamped newest plan', () => {
	const repoRoot = makeFixtureRepo();
	writePlan(repoRoot, 'plan-unstamped.md', PLAN_WITH_RESEARCH);
	const hookStdout = runHook({
		toolName: 'Bash',
		toolInput: { command: 'wc -l northstar-ledger.md evaluate.py gate1.py data.py' },
		workingDirectory: repoRoot
	});
	assertSilentPass(hookStdout);
	rmSync(repoRoot, { recursive: true, force: true });
});

// BUG B — the launch gate read ONLY the single newest plan by mtime, so a
// sibling agent's unstamped plan that was milliseconds newer blocked a fully
// stamped plan's legitimate launch. New rule: the gate passes if ANY of the
// 5 newest plans modified within the last 14 days is red-teamed.
test('bug B: a stamped plan unlocks a launch even when an unstamped sibling plan is newer', () => {
	const repoRoot = makeFixtureRepo();
	writePlan(repoRoot, 'plan-stamped.md', PLAN_RED_TEAMED, { mtimeOffsetMs: 5000 });
	writePlan(repoRoot, 'plan-sibling-unstamped.md', PLAN_WITH_RESEARCH, { mtimeOffsetMs: 6000 });
	const hookStdout = runHook({
		toolName: 'Bash',
		toolInput: { command: 'python modal_gate1.py --arms plain64 --seeds 1337 --steps 4000' },
		workingDirectory: repoRoot
	});
	assert.equal(wasDenied(hookStdout), false);
	rmSync(repoRoot, { recursive: true, force: true });
});

test('bug B guard-rail: an ancient stamped plan (outside the 14-day window) does NOT unlock launches', () => {
	const repoRoot = makeFixtureRepo();
	writePlan(repoRoot, 'plan-ancient-stamped.md', PLAN_RED_TEAMED, { mtimeOffsetMs: -15 * 24 * 60 * 60 * 1000 });
	const hookStdout = runHook({
		toolName: 'Bash',
		toolInput: { command: 'python modal_gate1.py --arms plain64 --seeds 1337 --steps 4000' },
		workingDirectory: repoRoot
	});
	assert.equal(wasDenied(hookStdout), true);
	rmSync(repoRoot, { recursive: true, force: true });
});

test('bug B guard-rail: a stamped plan pushed out of the 5 newest no longer unlocks', () => {
	const repoRoot = makeFixtureRepo();
	writePlan(repoRoot, 'plan-stamped.md', PLAN_RED_TEAMED, { mtimeOffsetMs: 1000 });
	for (let siblingIndex = 0; siblingIndex < 5; siblingIndex++) {
		writePlan(repoRoot, `plan-sibling-${siblingIndex}.md`, PLAN_WITH_RESEARCH, { mtimeOffsetMs: 2000 + siblingIndex * 1000 });
	}
	const hookStdout = runHook({
		toolName: 'Bash',
		toolInput: { command: 'python modal_gate1.py --arms plain64 --seeds 1337 --steps 4000' },
		workingDirectory: repoRoot
	});
	assert.equal(wasDenied(hookStdout), true);
	rmSync(repoRoot, { recursive: true, force: true });
});
