// Tests for experiment-monitor-required.mjs — a live Monitor must exist BEFORE an
// experiment/pod/training LAUNCH runs. Red-first: written before the hook.
//
//   node --test hooks/experiment-monitor-required.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLaunchCommand, isTrainingLaunch, isLocalExperimentRun,
  referencedExperimentSkill, evaluate,
  isMonitorLiveFilePath, looksLikeStandardTemplate, templateFingerprintCheck,
} from './experiment-monitor-required.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── transcript builders ──────────────────────────────────────────────────────
const bash = (command) => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] });
const monitor = () => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Monitor', input: {} }] });
const say = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const LAUNCH = 'python runpod_exp153.py launch --rows --gate';
const LINK = 'watch it live: http://localhost:8153/docs/exp153-3seed-live.html';
// a refresher/feeder that streams interim trial data home (Russell 2026-07-17)
const stream = () => bash('python scripts/exp153_live_refresher.py --pull runs/exp153_live.jsonl');
// a JOB-liveness probe: ssh the pod, check the remote process + tail the job log (Russell 2026-07-17, the $13 bleed)
const liveness = () => bash('ssh root@1.2.3.4 "pgrep -f train_exp154 && tail -3 /workspace/jobs/seed-7/nohup.out"');
// the ml-experiment skill referenced this session (Russell 2026-07-21: required before ANY launch)
const skillRef = () => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'ml-experiment' } }] });
// a launch run via the PowerShell tool, not Bash (Russell 2026-07-21: the hook missed this class —
// registered under a Bash-only settings.json matcher, so a `detached_run.ps1` PowerShell launch
// never triggered PreToolUse at all)
const POWERSHELL_LAUNCH = 'powershell -File C:/Users/rmill/Desktop/programming/runner/detached_run.ps1 -RunCommand "py -3 scripts/exp167d_spawn_judgment_arms.py --arm notebook --seed 1 --steps 1000 --out runs/exp167d/n1.json" -LogPath "runs/exp167d/n1.log"';

// ── isLaunchCommand: precise detection, no false positives ───────────────────
test('isLaunchCommand: runpod launch is a launch', () => {
  assert.equal(isLaunchCommand('python runpod_exp153.py launch --rows'), true);
});
test('isLaunchCommand: modal run is a launch', () => {
  assert.equal(isLaunchCommand('modal run experiments/modal_train.py'), true);
});
test('isLaunchCommand: python modal_*.py is a launch', () => {
  assert.equal(isLaunchCommand('python jobs/modal_sweep.py --seeds 5'), true);
});
test('isLaunchCommand: finalize is NOT a launch', () => {
  assert.equal(isLaunchCommand('python runpod_exp153.py finalize'), false);
});
test('isLaunchCommand: --help is NOT a launch', () => {
  assert.equal(isLaunchCommand('modal run modal_train.py --help'), false);
  assert.equal(isLaunchCommand('python runpod_exp153.py launch -h'), false);
});
test('isLaunchCommand: --dry-run / --smoke / --check / --list are NOT launches', () => {
  assert.equal(isLaunchCommand('python runpod_exp153.py launch --dry-run'), false);
  assert.equal(isLaunchCommand('python runpod_exp153.py launch --smoke'), false);
  assert.equal(isLaunchCommand('modal run modal_train.py --check'), false);
  assert.equal(isLaunchCommand('python runpod_exp153.py launch --list'), false);
});
test('isLaunchCommand: reading/grepping a launcher file is NOT a launch', () => {
  assert.equal(isLaunchCommand('cat runpod_exp153.py'), false);
  assert.equal(isLaunchCommand('grep launch runpod_exp153.py'), false);
});
test('isLaunchCommand: malformed / empty input fails safe (not a launch)', () => {
  assert.equal(isLaunchCommand(''), false);
  assert.equal(isLaunchCommand(null), false);
  assert.equal(isLaunchCommand(undefined), false);
});
// 2026-07-17 FALSE-BLOCK (marcus exp151): a READ-ONLY command that merely NAMES a launch-named file —
// a py_compile syntax check, a grep — was blocked as an experiment launch (the old detector keyed on
// the word "launch" in a filename). The precise detector fires on EXECUTION intent (runpod_*.py launch /
// modal run / modal_*.py), so naming a launch_*.py file in a syntax check or grep is not a launch.
test('isLaunchCommand: a py_compile syntax check of a launch-named file is NOT a launch', () => {
  assert.equal(isLaunchCommand('py -3 -m py_compile launch_exp151_qwen.py run_exp151_qwen_remote.py'), false);
  assert.equal(isLaunchCommand('cd scripts && py -3 -m py_compile launch_exp151_qwen.py && grep -nE foo x.py'), false);
});
test('isLaunchCommand: grepping a run_exp*-named file is NOT a launch', () => {
  assert.equal(isLaunchCommand('grep -n xyz run_exp151_qwen_remote.py'), false);
});
test('isTrainingLaunch: a py_compile of a launch-named file is NOT a training launch', () => {
  assert.equal(isTrainingLaunch('py -3 -m py_compile launch_exp151_qwen.py'), false);
});

// ── PreToolUse: DENY a launch with no prior Monitor ──────────────────────────
test('PreToolUse: DENY launch when no Monitor exists yet', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [skillRef()] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'deny');
  assert.match(verdict.reason, /Monitor/);
});

// ── PreToolUse: ALLOW a launch when a Monitor AND an interim stream precede it ─
test('PreToolUse: ALLOW launch when a Monitor + interim stream precede it', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [skillRef(), monitor(), stream()] });
  assert.equal(verdict.block, false);
});

// ── PreToolUse: DENY a launch that has a Monitor but NO interim stream ─────────
test('PreToolUse: DENY launch with a Monitor but no live interim stream', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [skillRef(), monitor()] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'deny');
  assert.match(verdict.reason, /interim|stream|trial data/i);
});

// ── PreToolUse: do NOT fire on non-launch commands (finalize/help/reads) ──────
test('PreToolUse: does NOT fire on finalize even with no Monitor', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: 'python runpod_exp153.py finalize', entries: [] });
  assert.equal(verdict.block, false);
});
test('PreToolUse: does NOT fire on a plain file read', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: 'cat runpod_exp153.py', entries: [] });
  assert.equal(verdict.block, false);
});

// ── Stop backstop: block launch-then-no-monitor ──────────────────────────────
test('Stop: BLOCK when a launch happened and no Monitor followed it', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH)] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
});
test('Stop: ALLOW when a Monitor follows the last launch AND a watch link was given', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor(), stream(), liveness(), say(LINK)] });
  assert.equal(verdict.block, false);
});

// ── Stop backstop: a Monitor must come with a LINK Russell can open ───────────
test('Stop: BLOCK when launch + Monitor but NO watch link was given', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor()] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
  assert.match(verdict.reason, /link/i);
});
test('Stop: ALLOW with a localhost link', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor(), stream(), liveness(), say('open http://127.0.0.1:8153/docs/x.html')] });
  assert.equal(verdict.block, false);
});
test('Stop: ALLOW with a *-live.html watch page reference', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor(), stream(), liveness(), say('see docs/exp153-race-live.html')] });
  assert.equal(verdict.block, false);
});
test('Stop: no-link block does NOT fire when there was no launch', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash('ls'), monitor()] });
  assert.equal(verdict.block, false);
});
// ── ALL unmet requirements reported at once (Russell, 2026-07-22: "stop hook
// fighting") ──────────────────────────────────────────────────────────────────
// Reporting one failure per block turned a single launch into five sequential
// block→fix→retry round-trips. One block must name everything that is missing.
test('PreToolUse: a launch missing skill+monitor+stream reports ALL of them in ONE block', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [] });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /ml-experiment/i);   // skill requirement
  assert.match(verdict.reason, /Monitor/i);         // monitor requirement
  assert.match(verdict.reason, /interim|stream/i);  // live-data requirement
});
test('PreToolUse: the combined block counts the unmet requirements', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [] });
  assert.match(verdict.reason, /3 REQUIREMENTS UNMET/i);
});
test('PreToolUse: one remaining gap reports only that gap', () => {
  const verdict = evaluate({
    event: 'PreToolUse', command: LAUNCH,
    entries: [skillRef(), monitor()],
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /interim|stream/i);
  assert.doesNotMatch(verdict.reason, /REQUIREMENTS UNMET/i); // single gap: no roll-up header
});

// ── Pre-armed Monitor coverage (Russell, 2026-07-22: this ordering rule cost an
// hour of block→stop-monitor→re-arm→relaunch cycles in ONE session) ────────────
// Arming the Monitor BEFORE the launch is the CORRECT pattern — it leaves no
// coverage gap at all — but the old rule ("last Monitor must come after the last
// launch") flagged it as a violation. Coverage, not ordering, is the invariant.
test('Stop: ALLOW when a fresh Monitor was armed just BEFORE the launch (pre-armed)', () => {
  const verdict = evaluate({
    event: 'Stop',
    entries: [skillRef(), monitor(), bash(LAUNCH), stream(), liveness(), say(LINK)],
  });
  assert.equal(verdict.block, false);
});
test('Stop: BLOCK when the only Monitor is STALE (far before the launch)', () => {
  // A Monitor from much earlier in the session was watching some OTHER run; it is
  // not covering this launch. Teeth must survive the fix above.
  const staleGap = Array.from({ length: 15 }, () => bash('ls -la'));
  const verdict = evaluate({
    event: 'Stop',
    entries: [monitor(), ...staleGap, bash(LAUNCH), stream(), liveness(), say(LINK)],
  });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
});
test('Stop: BLOCK when a launch ran and there is NO Monitor at all', () => {
  const verdict = evaluate({
    event: 'Stop',
    entries: [bash(LAUNCH), stream(), liveness(), say(LINK)],
  });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
});
test('Stop: ALLOW when no launch happened this session', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash('ls -la'), monitor()] });
  assert.equal(verdict.block, false);
});
test('Stop: never loops when stop_hook_active', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH)], stopHookActive: true });
  assert.equal(verdict.block, false);
});

// ── Escape hatches ───────────────────────────────────────────────────────────
test('escape: env override lets a monitorless launch through', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [], envOk: true });
  assert.equal(verdict.block, false);
});
test('escape: literal token in the reply lets a monitorless launch through', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [], replyText: 'skipping: EXPERIMENT_MONITOR_REQUIRED_OK for a smoke test' });
  assert.equal(verdict.block, false);
});

// ── Fail open on malformed payload ───────────────────────────────────────────
test('fails open on malformed/empty evaluate input', () => {
  assert.equal(evaluate({}).block, false);
  assert.equal(evaluate({ event: 'PreToolUse' }).block, false);
  assert.equal(evaluate({ event: 'Stop' }).block, false);
  assert.equal(evaluate({ event: 'PreToolUse', command: null, entries: null }).block, false);
});
test('does not fire on unrelated events', () => {
  assert.equal(evaluate({ event: 'PostToolUse', command: LAUNCH, entries: [] }).block, false);
});


// ── Stop: BLOCK a launch+monitor+link that never streamed interim trial data ──
test('Stop: BLOCK when launch+monitor+link but no interim stream at Stop', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor(), say(LINK)] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
  assert.match(verdict.reason, /interim|stream|trial data/i);
});

// ── Checkpoint setup required on a TRAINING launch (Russell 2026-07-17) ──────
const TRAIN = 'python scripts/run_exp154_full_seed.py --seed 7 --decision-epochs 25';
const TRAIN_WITH_CHECKPOINT = TRAIN + ' --checkpoint-every-steps 50';
// a prior tool-use that wires step-level checkpointing into the trainer
const checkpointWiring = () => bash('grep -n checkpoint_if_due scripts/train_exp153_bundles.py');

test('isTrainingLaunch: a full-seed training launch is a training launch', () => {
  assert.equal(isTrainingLaunch(TRAIN), true);
  assert.equal(isTrainingLaunch('python runpod_exp154.py launch --decision-epochs 25'), true);
});
test('isTrainingLaunch: a race / eval launch is NOT a training launch', () => {
  assert.equal(isTrainingLaunch('python exp153_bundle_race.py --bundle-root x'), false);
  assert.equal(isTrainingLaunch('python runpod_exp153.py launch --rows --gate'), false);
});
test('isTrainingLaunch: a capacity smoke is NOT a training launch (10 steps, no durable ckpt)', () => {
  assert.equal(isTrainingLaunch('python scripts/run_exp154_full_seed.py --capacity-smoke --max-steps 10'), false);
});
test('isTrainingLaunch: running the trainer TEST file is NOT a training launch', () => {
  assert.equal(isTrainingLaunch('python -m pytest scripts/test_train_exp153_bundles.py -q'), false);
});
test('isTrainingLaunch: finalize / reads are NOT training launches', () => {
  assert.equal(isTrainingLaunch('python runpod_exp154.py finalize'), false);
  assert.equal(isTrainingLaunch('cat scripts/run_exp154_full_seed.py'), false);
  assert.equal(isTrainingLaunch(''), false);
});

test('PreToolUse: DENY a training launch with a monitor+interim but NO checkpoint setup', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: TRAIN, entries: [skillRef(), monitor(), stream()] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'deny');
  assert.match(verdict.reason, /checkpoint/i);
});
test('PreToolUse: ALLOW a training launch that carries a checkpoint flag', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: TRAIN_WITH_CHECKPOINT, entries: [skillRef(), monitor(), stream()] });
  assert.equal(verdict.block, false);
});
test('PreToolUse: ALLOW a training launch when a prior tool-use wired checkpointing', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: TRAIN, entries: [skillRef(), checkpointWiring(), monitor(), stream()] });
  assert.equal(verdict.block, false);
});
test('PreToolUse: a NON-training launch is not checkpoint-gated (race/eval)', () => {
  // runpod_exp153 launch is not training → checkpoint check skipped; monitor+interim still required
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [skillRef(), monitor(), stream()] });
  assert.equal(verdict.block, false);
});

// ── skill-reference prerequisite (Russell, 2026-07-21) ───────────────────────
test('isLocalExperimentRun: py -3 scripts/exp*.py is a local experiment run', () => {
  assert.equal(isLocalExperimentRun('py -3 scripts/exp167d_spawn_judgment_arms.py --arm regular --seed 1 --steps 1000 --out runs/exp167d/r.json'), true);
  assert.equal(isLocalExperimentRun('python scripts/exp147a_inception_toy.py --seed 0'), true);
});
test('isLocalExperimentRun: a live-refresher/feeder/monitor support script is NOT a new launch', () => {
  // Regression pin (2026-07-21): this exact string previously matched LOCAL_EXPERIMENT_RE,
  // which corrupted Stop's launch-index tracking -- calling the refresher mid-run looked
  // like a SECOND local launch and made an already-monitored run appear stale/unmonitored.
  assert.equal(isLocalExperimentRun('python scripts/exp153_live_refresher.py --pull runs/exp153_live.jsonl'), false);
  assert.equal(isLocalExperimentRun('py -3 scripts/exp150_live_feeder.py'), false);
  assert.equal(isLocalExperimentRun('python scripts/exp167d_monitor.py --watch'), false);
});
test('isLocalExperimentRun: pytest / py_compile / reads / smoke are NOT gated', () => {
  assert.equal(isLocalExperimentRun('py -3 -m pytest scripts/test_exp167d_spawn_judgment_arms.py -q'), false);
  assert.equal(isLocalExperimentRun('py -3 -m py_compile scripts/exp167d_spawn_judgment_arms.py'), false);
  assert.equal(isLocalExperimentRun('cat scripts/exp167d_spawn_judgment_arms.py'), false);
  assert.equal(isLocalExperimentRun('py -3 scripts/exp167d_spawn_judgment_arms.py --smoke'), false);
});
test('PreToolUse: DENY a LOCAL exp run when the skill was never referenced', () => {
  const verdict = evaluate({
    event: 'PreToolUse',
    command: 'py -3 scripts/exp167d_spawn_judgment_arms.py --arm notebook --seed 2 --steps 1000 --out runs/exp167d/n2.json',
    entries: [monitor(), stream()],
  });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'deny');
  assert.match(verdict.reason, /ml-experiment/);
});
test('PreToolUse: skill reference alone is NOT enough for a local run — still needs Monitor+interim (2026-07-21 fix)', () => {
  const verdict = evaluate({
    event: 'PreToolUse',
    command: 'py -3 scripts/exp167d_spawn_judgment_arms.py --arm notebook --seed 2 --steps 1000 --out runs/exp167d/n2.json',
    entries: [skillRef()],
  });
  assert.equal(verdict.block, true, 'local runs must ALSO have a Monitor — skill reference alone used to wrongly pass');
});
test('PreToolUse: ALLOW a LOCAL exp run once skill + Monitor + interim stream are ALL present', () => {
  const verdict = evaluate({
    event: 'PreToolUse',
    command: 'py -3 scripts/exp167d_spawn_judgment_arms.py --arm notebook --seed 2 --steps 1000 --out runs/exp167d/n2.json',
    entries: [skillRef(), monitor(), stream()],
  });
  assert.equal(verdict.block, false);
});
test('PreToolUse: a Read of the SKILL.md also counts as referencing the skill, but Monitor+interim are still required', () => {
  const readSkill = { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:/Users/rmill/.claude/skills/ml-experiment/SKILL.md' } }] };
  const verdict = evaluate({
    event: 'PreToolUse',
    command: 'py -3 scripts/exp167d_spawn_judgment_arms.py --arm regular --seed 1 --out runs/exp167d/r1.json',
    entries: [readSkill, monitor(), stream()],
  });
  assert.equal(verdict.block, false);
});
test('PreToolUse: DENY a POD launch without the skill reference (before the monitor check)', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: LAUNCH, entries: [monitor(), stream()] });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /ml-experiment/);
});
test('referencedExperimentSkill: fails safe on malformed input', () => {
  assert.equal(referencedExperimentSkill(null), false);
  assert.equal(referencedExperimentSkill([{}]), false);
});

// ── TEMPLATE-FIRST enforcement (Russell, 2026-07-21, his 6th correction) ─────
// A hand-rolled *-live.html monitor previously satisfied every check in this file
// (Monitor tool-use + a watch link) with zero content verification -- exactly the
// gap that let a bespoke page ship 6 times. These pin the NEW Write-time check.

test('isMonitorLiveFilePath: matches any *-live.html regardless of directory', () => {
  assert.equal(isMonitorLiveFilePath('docs/exp167d-durability-live.html'), true);
  assert.equal(isMonitorLiveFilePath('C:/repo/docs/exp150-live.html'), true);
  assert.equal(isMonitorLiveFilePath('docs/some-report.html'), false);
  assert.equal(isMonitorLiveFilePath('scripts/exp167d_worker.py'), false);
});

test('looksLikeStandardTemplate: the REAL template file passes', () => {
  const templatePath = join(homedir(), '.claude', 'skills', 'live-watch', 'watch-template.html');
  const templateContent = readFileSync(templatePath, 'utf8');
  assert.equal(looksLikeStandardTemplate(templateContent), true);
});

test('looksLikeStandardTemplate: a hand-rolled page (no CONFIG marker) fails', () => {
  const handRolled = '<!doctype html><html><body><script>const ARMS=["a"];function refresh(){}</script></body></html>';
  assert.equal(looksLikeStandardTemplate(handRolled), false);
});

test('looksLikeStandardTemplate: mentioning "CONFIG" without the real marker still fails', () => {
  const fakeout = '<script>// CONFIG for my page\nconst CONFIG = {};</script>';
  assert.equal(looksLikeStandardTemplate(fakeout), false);
});

test('templateFingerprintCheck: DENY writing a new *-live.html with no template fingerprint', () => {
  const verdict = templateFingerprintCheck({
    filePath: 'docs/exp167d-durability-live.html',
    content: '<!doctype html><body>hand-rolled</body></html>',
  });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'deny');
  assert.match(verdict.reason, /standard template/i);
});

test('templateFingerprintCheck: ALLOW writing a *-live.html that IS the template', () => {
  const templatePath = join(homedir(), '.claude', 'skills', 'live-watch', 'watch-template.html');
  const templateContent = readFileSync(templatePath, 'utf8');
  const verdict = templateFingerprintCheck({
    filePath: 'docs/exp999-live.html',
    content: templateContent,
  });
  assert.equal(verdict.block, false);
});

test('templateFingerprintCheck: does NOT fire on a non-live.html file', () => {
  const verdict = templateFingerprintCheck({
    filePath: 'docs/exp167d-METHODS.md',
    content: 'anything at all',
  });
  assert.equal(verdict.block, false);
});

test('templateFingerprintCheck: escape token in reply clears the block', () => {
  const verdict = templateFingerprintCheck({
    filePath: 'docs/exp167d-durability-live.html',
    content: '<!doctype html><body>hand-rolled</body></html>',
    replyText: 'building a quick one-off, EXPERIMENT_MONITOR_REQUIRED_OK',
  });
  assert.equal(verdict.block, false);
});

// ── PowerShell-tool launches (Russell, 2026-07-21: the real gap that shipped) ─
// evaluate()'s command-content matching is tool-agnostic, but the gap that actually
// bit was settings.json registering this hook ONLY under a Bash-matcher PreToolUse
// block -- a PowerShell tool_use never reached PreToolUse at all, so no launch
// command string was ever evaluated. These pin the CONTENT-LEVEL detection so a
// regression there is caught; the registration itself is pinned in
// experiment-monitor-required.settings.test.mjs (reads the real settings.json).
test('isLocalExperimentRun: detects a local exp run embedded inside a PowerShell -RunCommand string', () => {
  assert.equal(isLocalExperimentRun(POWERSHELL_LAUNCH), true);
});
test('PreToolUse: DENY a PowerShell-tool exp launch with no skill reference (content-level)', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: POWERSHELL_LAUNCH, entries: [] });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /ml-experiment/);
});
test('PreToolUse: a PowerShell-tool exp launch with ONLY the skill referenced still needs Monitor+interim', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: POWERSHELL_LAUNCH, entries: [skillRef()] });
  assert.equal(verdict.block, true);
});
test('PreToolUse: ALLOW a PowerShell-tool exp launch once skill + Monitor + interim are ALL present', () => {
  const verdict = evaluate({ event: 'PreToolUse', command: POWERSHELL_LAUNCH, entries: [skillRef(), monitor(), stream()] });
  assert.equal(verdict.block, false);
});
test('Stop: BLOCK a training launch that ran with no checkpoint setup', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(TRAIN), monitor(), stream(), liveness(), say(LINK)] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
  assert.match(verdict.reason, /checkpoint/i);
});
test('Stop: ALLOW a training launch with checkpoint setup wired', () => {
  const verdict = evaluate({ event: 'Stop', entries: [checkpointWiring(), bash(TRAIN), monitor(), stream(), liveness(), say(LINK)] });
  assert.equal(verdict.block, false);
});

// ── Stop: JOB-liveness required, not just pod status (Russell 2026-07-17, the $13 bleed) ──
test('Stop: BLOCK when launch+monitor+link+interim but NO job-liveness probe', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor(), stream(), say(LINK)] });
  assert.equal(verdict.block, true);
  assert.equal(verdict.mode, 'stop');
  assert.match(verdict.reason, /job.?liveness|pod alive|dead job|process/i);
});
test('Stop: ALLOW when a job-liveness probe (ssh pgrep + tail job log) is present', () => {
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor(), stream(), liveness(), say(LINK)] });
  assert.equal(verdict.block, false);
});
test('Stop: a pod-STATUS poll does NOT satisfy job-liveness', () => {
  const podStatusPoll = bash('curl -s https://api.runpod.io/graphql -d \'{"query":"{myself{pods{desiredStatus}}}"}\'');
  const verdict = evaluate({ event: 'Stop', entries: [bash(LAUNCH), monitor(), stream(), podStatusPoll, say(LINK)] });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /job.?liveness|pod alive|process/i);
});
