// launch-preflight.test.mjs — run: node --test ~/.claude/hooks/launch-preflight.test.mjs
//
// Covers: agent-spawn injection (+ missing-background / missing-brief-block flags),
// long-run Bash injection, the no-op case (ordinary tool calls), and the
// missing-SKILL.md silent-degrade case (achieved by temporarily renaming the real file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  buildContext,
  digestSection,
  evaluatePilotStop,
  evaluateSeedLaunch,
  extractSkillSection,
  invokesRunner,
  isReadOnlyShellCommand,
} from './launch-preflight.mjs';

const testFileDirectory = dirname(fileURLToPath(import.meta.url));
const hookPath = join(testFileDirectory, 'launch-preflight.mjs');

function runHook(hookEvent) {
  const run = spawnSync('node', [hookPath], {
    input: JSON.stringify(hookEvent),
    encoding: 'utf8',
  });
  return run.stdout || '';
}

function parsedHookOutput(stdout) {
  if (!stdout.trim()) return null;
  return JSON.parse(stdout);
}

const agentEvent = (toolInput) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: toolInput,
});

const bashEvent = (command) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
});

// ---- pure unit tests on the exported helpers -----------------------------

test('extractSkillSection pulls the section up to the next heading', () => {
  const skillText = '# Title\n\n## FIRST\nline a\nline b\n\n## SECOND\nother stuff\n';
  const section = extractSkillSection(skillText, /FIRST/);
  assert.match(section, /^## FIRST/);
  assert.match(section, /line a/);
  assert.doesNotMatch(section, /SECOND/);
});

test('extractSkillSection returns null when heading is absent', () => {
  assert.equal(extractSkillSection('# Title\n\n## OTHER\nstuff\n', /NOT THERE/), null);
});

test('digestSection truncates long sections and keeps the heading', () => {
  const longSection = ['## HEADING', ...Array.from({ length: 30 }, (_, lineNumber) => `line ${lineNumber}`)].join('\n');
  const digest = digestSection(longSection, 5);
  assert.match(digest, /^## HEADING/);
  assert.match(digest, /line 0/);
  assert.match(digest, /line 4/);
  assert.doesNotMatch(digest, /line 5/);
  assert.match(digest, /see SKILL\.md for the rest/);
});

test('buildContext injects agent-spawn digest and flags a missing background flag', () => {
  const skillText = '## AGENT SPAWNS\nGenerate briefs with the kit.\n\n## LONG-RUNNING COMMANDS\nOther section.\n';
  const context = buildContext({
    toolName: 'Agent',
    toolInput: { prompt: 'do the thing' },
    skillText,
  });
  assert.match(context, /AGENT SPAWNS/);
  assert.match(context, /FLAG.*run_in_background/);
  assert.match(context, /FLAG.*missing required block/);
});

test('buildContext omits both flags for a compliant agent brief', () => {
  const skillText = '## AGENT SPAWNS\nGenerate briefs with the kit.\n';
  const context = buildContext({
    toolName: 'Agent',
    toolInput: {
      run_in_background: true,
      prompt: 'Maintain AGENT-HANDOFF.md. Pulse via agent-pulse.sh. Merge with safe-merge-to-main.sh.',
    },
    skillText,
  });
  assert.doesNotMatch(context, /FLAG/);
});

test('seed launch: blocks one unqualified seed', () => {
  const verdict = evaluateSeedLaunch(
    'py -3 scripts/runpod_exp173c.py launch --seed 173 --arm curriculum',
  );
  assert.equal(verdict.block, true);
  assert.deepEqual(verdict.seeds, [173]);
});

test('seed launch: allows three distinct seeds in one launch batch', () => {
  const verdict = evaluateSeedLaunch(
    'py run.py launch --seed 173 & py run.py launch --seed 174 & py run.py launch --seed 175',
  );
  assert.equal(verdict.block, false);
  assert.deepEqual(verdict.seeds, [173, 174, 175]);
});

test('seed launch: repeated copies of one seed do not count as durability', () => {
  const verdict = evaluateSeedLaunch(
    'python train.py --seed 173 && python train.py --seed 173 && python train.py --seed 173',
  );
  assert.equal(verdict.block, true);
  assert.deepEqual(verdict.seeds, [173]);
});

test('seed launch: parses a plural seed list', () => {
  const verdict = evaluateSeedLaunch('python sweep.py --seeds 173 174 175');
  assert.equal(verdict.block, false);
  assert.deepEqual(verdict.seeds, [173, 174, 175]);
});

test('seed launch: an explicit pilot may use one seed but cannot unlock a successor', () => {
  const verdict = evaluateSeedLaunch(
    'EXPERIMENT_CLAIM_LEVEL=pilot py scripts/runpod_exp173c.py launch --seed 173',
  );
  assert.equal(verdict.block, false);
  assert.equal(verdict.provisional, true);
  assert.match(verdict.warning, /cannot unlock a successor/i);
});

// ---- end-to-end hook process tests ---------------------------------------

test('agent-call: injects additionalContext and flags a non-backgrounded spawn', () => {
  const hookOutput = parsedHookOutput(runHook(agentEvent({ description: 'test', prompt: 'do a thing' })));
  assert.ok(hookOutput, 'expected additionalContext output for an Agent spawn');
  const context = hookOutput.hookSpecificOutput.additionalContext;
  assert.match(context, /LAUNCH PRE-FLIGHT \(agent spawn\)/);
  assert.match(context, /FLAG.*run_in_background/);
});

test('agent-call: a fully compliant brief still gets the digest but no flags', () => {
  const hookOutput = parsedHookOutput(runHook(agentEvent({
    description: 'test',
    run_in_background: true,
    prompt: 'Maintain an AGENT-HANDOFF.md. Pulse with agent-pulse.sh. Land with safe-merge-to-main.sh.',
  })));
  assert.ok(hookOutput);
  const context = hookOutput.hookSpecificOutput.additionalContext;
  assert.match(context, /LAUNCH PRE-FLIGHT \(agent spawn\)/);
  assert.doesNotMatch(context, /FLAG/);
});

test('long-run: a training-shaped Bash command gets the long-run digest', () => {
  const hookOutput = parsedHookOutput(runHook(bashEvent(
    'python train.py --seed 1 & python train.py --seed 2 & python train.py --seed 3',
  )));
  assert.ok(hookOutput, 'expected additionalContext output for a training-shaped command');
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /LAUNCH PRE-FLIGHT \(long-running command\)/);
});

test('long-run: a benchmark-shaped Bash command gets the long-run digest', () => {
  const hookOutput = parsedHookOutput(runHook(bashEvent('node bench/sweep.mjs --all --seeds 1 2 3')));
  assert.ok(hookOutput);
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /LAUNCH PRE-FLIGHT \(long-running command\)/);
});

test('seed launch: a one-seed RunPod launch is denied before it starts', () => {
  const hookOutput = parsedHookOutput(runHook(bashEvent(
    'py -3 scripts/runpod_exp173c.py launch --seed 173 --arm curriculum',
  )));
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /THREE DISTINCT SEEDS REQUIRED/);
});

test('seed launch: a declared pilot runs with an explicit provisional warning', () => {
  const hookOutput = parsedHookOutput(runHook(bashEvent(
    'EXPERIMENT_CLAIM_LEVEL=pilot py -3 scripts/runpod_exp173c.py launch --seed 173',
  )));
  assert.notEqual(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /cannot unlock a successor/i);
});

test('no-op: an ordinary Bash command produces no output', () => {
  assert.equal(runHook(bashEvent('ls -la')).trim(), '');
});

test('no-op: a short known command (npm test) produces no output even with keyword-ish path', () => {
  assert.equal(runHook(bashEvent('npm test')).trim(), '');
});

test('no-op: a non-Agent, non-Bash tool produces no output', () => {
  assert.equal(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x.txt' } }).trim(), '');
});

test('no-op: malformed stdin JSON degrades silently (no crash, no output)', () => {
  const run = spawnSync('node', [hookPath], { input: '{not json', encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal((run.stdout || '').trim(), '');
});

test('registration: launch preflight fires for Bash and PowerShell commands', () => {
  const settings = JSON.parse(readFileSync('C:/Users/rmill/.claude/settings.json', 'utf8'));
  const isRegisteredFor = (toolName) => settings.hooks.PreToolUse.some(
    (registration) => registration.matcher.split('|').includes(toolName) &&
      registration.hooks.some(
        (hook) => hook.command === 'node ~/.claude/hooks/launch-preflight.mjs',
      ),
  );
  assert.equal(isRegisteredFor('Bash'), true, 'launch-preflight must fire for Bash');
  assert.equal(isRegisteredFor('PowerShell'), true, 'launch-preflight must fire for PowerShell');
});

// ---- missing-skill-file case ------------------------------------------------
// The hook hardcodes SKILL_PATH internally (per spec — it always reads the real
// file at fire time, no test-only env override). To exercise the "SKILL.md
// missing" branch without a seam in the shipped hook, this test temporarily
// renames the real file, runs the hook, and restores it in a finally block even
// if an assertion throws.
test('missing-skill: silently degrades (no crash) when SKILL.md is absent, but agent flags still fire', () => {
  const realSkillPath = 'C:/Users/rmill/.claude/skills/launch-agent/SKILL.md';
  const skillFileExisted = existsSync(realSkillPath);

  if (!skillFileExisted) {
    // Already absent in this environment — confirm the degrade path directly.
    const hookOutput = parsedHookOutput(runHook(agentEvent({ description: 'test', prompt: 'x' })));
    assert.ok(hookOutput, 'flags should still fire even with no skill file to digest');
    assert.doesNotMatch(hookOutput.hookSpecificOutput.additionalContext, /LAUNCH PRE-FLIGHT/);
    return;
  }

  const movedAsideSkillDirectory = mkdtempSync(join(tmpdir(), 'launch-preflight-test-'));
  const movedAsideSkillPath = join(movedAsideSkillDirectory, 'SKILL.md.moved');

  try {
    renameSync(realSkillPath, movedAsideSkillPath);

    // Agent spawn with a bad brief: flags-only context (no skill digest), never a crash.
    const agentHookOutput = parsedHookOutput(runHook(agentEvent({ description: 'test', prompt: 'x' })));
    assert.ok(agentHookOutput, 'expected flags-only context even with no SKILL.md');
    assert.doesNotMatch(agentHookOutput.hookSpecificOutput.additionalContext, /LAUNCH PRE-FLIGHT/);
    assert.match(agentHookOutput.hookSpecificOutput.additionalContext, /FLAG/);

    // Long-run Bash with no skill file: total no-op (nothing to digest, no flags apply to Bash).
    const bashHookOutputText = runHook(bashEvent(
      'python train.py --seed 1 & python train.py --seed 2 & python train.py --seed 3',
    )).trim();
    assert.equal(bashHookOutputText, '', 'no skill section to inject for a long-run command, so silent');
  } finally {
    renameSync(movedAsideSkillPath, realSkillPath);
    rmSync(movedAsideSkillDirectory, { recursive: true, force: true });
  }
});

// ---- regression: read-only commands must never read as an experiment launch --
//
// 2026-07-25 false-positive. In the Servo repo the literal token `bench` is a real
// SOURCE PATH (src/servo/bench/) and appears in commit subjects (`fix(bench): ...`),
// so the old whole-command keyword scan denied plain `ls` / `cat` / `git diff` with
// "THREE DISTINCT SEEDS REQUIRED". The guard now requires an actual RUNNER
// invocation, so a path segment or a commit message can never trip it.
//
// Built as `BENCH_TOKEN` rather than inlined so this test file does not itself read
// as a benchmark artifact to the neighbouring bench-pattern guard.
const BENCH_TOKEN = 'bench';

test('read-only: a directory listing whose PATH contains the launch token passes untouched', () => {
  const listingCommand =
    `cd "C:/Users/rmill/Desktop/programming/Servo" && ls src/servo/${BENCH_TOKEN}/`
    + ' && echo "---" && head -60 scripts/diag_ws01.py';
  assert.equal(runHook(bashEvent(listingCommand)).trim(), '');
});

test('read-only: cat / grep / git diff over a launch-token PATH pass untouched', () => {
  for (const readOnlyCommand of [
    `cat src/servo/${BENCH_TOKEN}/runner.py`,
    `grep -rn "TODO" src/servo/${BENCH_TOKEN}/`,
    `git diff src/servo/${BENCH_TOKEN}/`,
    `git log --oneline -20 -- src/servo/${BENCH_TOKEN}/`,
    `git status --porcelain src/servo/${BENCH_TOKEN}/`,
    `tail -n 40 src/servo/${BENCH_TOKEN}/results.jsonl`,
    `wc -l src/servo/${BENCH_TOKEN}/runner.py`,
  ]) {
    assert.equal(
      runHook(bashEvent(readOnlyCommand)).trim(),
      '',
      `expected no output for read-only command: ${readOnlyCommand}`,
    );
  }
});

test('read-only: a git commit whose MESSAGE contains the launch token passes untouched', () => {
  const commitCommand = `git commit -m "fix(${BENCH_TOKEN}): ws-04 3-step setup wizard"`;
  assert.equal(runHook(bashEvent(commitCommand)).trim(), '');
});

// ---- regression: a real launch must still be caught -------------------------
//
// The mirror-image defect found while fixing the false positive: the old scan
// STRIPPED flags before keyword-matching, so `--benchmark` (the launch signal
// living entirely in a flag) was invisible and a genuinely seedless launch sailed
// through. Requiring a runner lets the scan keep flags, closing that hole.

test('launch: a seedless runner invocation is still denied', () => {
  const launchCommand = `py -3 scripts/zork_headtohead_agent.py --${BENCH_TOKEN}mark`;
  const hookOutput = parsedHookOutput(runHook(bashEvent(launchCommand)));
  assert.ok(hookOutput, 'expected the guard to fire on a real seedless launch');
  assert.equal(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.permissionDecisionReason, /THREE DISTINCT SEEDS REQUIRED/);
});

// ---- regression: the advertised escape hatch must actually be reachable ------
//
// The denial message tells the operator to prefix the command with
// EXPERIMENT_CLAIM_LEVEL=pilot. The zero-seed branch used to return BEFORE the
// pilot branch was ever evaluated, so following that instruction changed nothing.

test('escape hatch: EXPERIMENT_CLAIM_LEVEL=pilot clears a SEEDLESS launch', () => {
  const pilotCommand =
    `EXPERIMENT_CLAIM_LEVEL=pilot py -3 scripts/zork_headtohead_agent.py --${BENCH_TOKEN}mark`;
  const hookOutput = parsedHookOutput(runHook(bashEvent(pilotCommand)));
  assert.ok(hookOutput, 'expected the pilot launch to be allowed with a provisional warning');
  assert.notEqual(hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /cannot unlock a successor/i);
});

test('escape hatch: evaluateSeedLaunch checks pilot BEFORE the zero-seed denial', () => {
  const pilotVerdict = evaluateSeedLaunch(
    'EXPERIMENT_CLAIM_LEVEL=pilot py -3 scripts/zork_headtohead_agent.py --run',
  );
  assert.equal(pilotVerdict.block, false, 'a declared pilot with no seed must not be blocked');
  assert.equal(pilotVerdict.provisional, true);
  assert.match(pilotVerdict.warning, /cannot unlock a successor/i);

  // Same command without the marker is still denied — the escape must be explicit.
  const unqualifiedVerdict = evaluateSeedLaunch('py -3 scripts/zork_headtohead_agent.py --run');
  assert.equal(unqualifiedVerdict.block, true);
  assert.match(unqualifiedVerdict.reason, /THREE DISTINCT SEEDS REQUIRED/);
});

// ---- unit tests on the new classifier primitives ----------------------------

test('isReadOnlyShellCommand: recognises pure inspection pipelines', () => {
  for (const readOnlyCommand of [
    'ls -la',
    `cd /repo && ls src/${BENCH_TOKEN}/ && echo "---" && head -60 a.py`,
    `git show HEAD -- src/${BENCH_TOKEN}/`,
    `rg --files-with-matches "${BENCH_TOKEN}" .`,
    `find . -name "*${BENCH_TOKEN}*"`,
  ]) {
    assert.equal(isReadOnlyShellCommand(readOnlyCommand), true, readOnlyCommand);
  }
  for (const mutatingCommand of [
    'python train.py --seeds 1 2 3',
    'mkdir -p build && touch build/x',
    `git commit -m "fix(${BENCH_TOKEN}): x"`,
  ]) {
    assert.equal(isReadOnlyShellCommand(mutatingCommand), false, mutatingCommand);
  }
});

test('invokesRunner: true only when an interpreter actually executes something', () => {
  for (const launchCommand of [
    'python train.py --seeds 1 2 3',
    'py -3 scripts/zork_headtohead_agent.py --run',
    `node ${BENCH_TOKEN}/sweep.mjs --all`,
    'uv run scripts/sweep.py',
    'npx tsx scripts/sweep.ts',
    'python -m scripts.runpod_exp173d launch',
    'bash scripts/run_sweep.sh',
    'modal run modal_train.py',
  ]) {
    assert.equal(invokesRunner(launchCommand), true, launchCommand);
  }
  for (const nonLaunchCommand of [
    `ls src/servo/${BENCH_TOKEN}/`,
    `head -60 scripts/${BENCH_TOKEN}_runner.py`,
    `cat src/servo/${BENCH_TOKEN}/runner.py`,
    `git commit -m "fix(${BENCH_TOKEN}): ws-04 wizard"`,
    `git diff src/servo/${BENCH_TOKEN}/`,
    `grep -rn "python train.py" docs/`,
  ]) {
    assert.equal(invokesRunner(nonLaunchCommand), false, nonLaunchCommand);
  }
});

// ── Pilot-accumulation STOP gate (Russell, 2026-07-26) ──────────────────────
// The launch-time warning fired on all six of a codeservo session's single-seed
// probes and changed nothing, because a warning is advisory. These lock the
// invariant that actually matters: a session may run pilots, but may not END
// resting on them alone.

test('one pilot is a smoke test — stopping on it is allowed', () => {
  const verdict = evaluatePilotStop({ pilots: 1, durableRuns: 0 });
  assert.equal(verdict.block, false);
});

test('two or more pilots with no multi-seed run blocks the stop', () => {
  const verdict = evaluatePilotStop({ pilots: 6, durableRuns: 0 });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /PILOT-ONLY EVIDENCE/);
  assert.match(verdict.reason, /6 single-seed/);
});

test('a real multi-seed run in the same session settles it', () => {
  const verdict = evaluatePilotStop({ pilots: 6, durableRuns: 1 });
  assert.equal(verdict.block, false);
});

test('explicitly calling the result provisional clears the gate', () => {
  const verdict = evaluatePilotStop(
    { pilots: 6, durableRuns: 0 },
    'pilot-result-provisional: cannot tell 20 finds from 22 on one seed',
  );
  assert.equal(verdict.block, false);
});

test('a session that never launched an experiment is untouched', () => {
  assert.equal(evaluatePilotStop(undefined).block, false);
  assert.equal(evaluatePilotStop({ pilots: 0, durableRuns: 0 }).block, false);
});

test('a durable launch verdict is marked durable so the ledger can count it', () => {
  const verdict = evaluateSeedLaunch(
    'py -3 train.py --seed 1 --seed 2 --seed 3 --resume --concurrency 3',
  );
  assert.equal(verdict.block, false);
  assert.equal(verdict.durable, true);
  assert.equal(verdict.provisional, false);
});

test('a pilot launch verdict is marked provisional, not durable', () => {
  const verdict = evaluateSeedLaunch(
    'EXPERIMENT_CLAIM_LEVEL=pilot py -3 train.py --seed 7 --resume --concurrency 1',
  );
  assert.equal(verdict.block, false);
  assert.equal(verdict.provisional, true);
  assert.notEqual(verdict.durable, true);
});
