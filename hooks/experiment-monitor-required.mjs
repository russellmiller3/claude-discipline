#!/usr/bin/env node
// =============================================================================
// EXPERIMENT-MONITOR-REQUIRED — a live Monitor must exist BEFORE a launch runs
// =============================================================================
//
// new-hook-category: Benchmark / long-run discipline — nearest existing is pod-launch-durability-guard; it does NOT cover this because it fires on WRITING launcher code, not on RUNNING a launch, and never requires a live Monitor.
//
// WHY (Russell, 2026-07-16, verbatim): "I want the monitor created BEFORE the
// experiment launches" + "it should be a GLOBAL hook."
//
// THE GAP: starting an experiment by RUNNING a Bash command (runpod_exp153.py
// launch, `modal run`, `python .../modal_*.py`) had NO enforcement that a live
// Monitor was attached. pod-launch-durability-guard only fires when launcher CODE
// is WRITTEN — it never sees a launch actually RUN, and never requires a Monitor.
// A paid pod/experiment could therefore start with nobody watching it, and a
// death (or a silent stall) went unnoticed for a whole session.
//
// HOW IT WORKS
// ============
//   PRIMARY TEETH — PreToolUse on Bash: if the command is an experiment LAUNCH
//   and NO Monitor tool-use exists yet in the transcript, DENY. This enforces
//   monitor-BEFORE-launch: you must start a Monitor first, then launch.
//
//   BACKSTOP — Stop: if a launch happened this session and the last Monitor is
//   BEFORE the last launch (or there is no Monitor at all), BLOCK. This catches a
//   launch that ran some other way, or a re-launch whose Monitor went stale — the
//   invariant "every launch is covered by a live Monitor" is asserted on the
//   resulting STATE, not just at the moment of the launch action.
//
//   LINK REQUIREMENT (Russell, 2026-07-16, verbatim: "when you create monitor you
//   must give me link"): a chat-only Monitor isn't enough. When a launch + Monitor
//   exist, Stop ALSO BLOCKS unless a watch LINK (an http(s) URL, localhost:PORT, or a
//   *-live.html watch page) was given to Russell this session — so he always has a
//   browser page to WATCH the paid run, not just terminal notifications.
//
// TEETH: PreToolUse permissionDecision 'deny'; Stop decision 'block'.
// Launch detection is precise (see isLaunchCommand) so prose/finalize/help/reads
// never false-positive. Escape: EXPERIMENT_MONITOR_REQUIRED_OK=1 in env, or the
// literal token EXPERIMENT_MONITOR_REQUIRED_OK in the reply/command. Respects
// stop_hook_active (never loops). FAILS OPEN on any error. basename entry-guard.
//
// EXTENSION (Russell, 2026-07-21, verbatim: "why doesnt hook and skill FORCE you
// to use monitor template. what is this shite you built" -- his 6th correction on
// this exact repeat mistake): every prior version of this hook only told the
// assistant, in the DENY/NO-LINK message TEXT, to build the monitor from
// Russell's standard template -- but NOTHING checked that the resulting file
// actually WAS the template. Pure Rule 1.6 violation: advice with teeth
// missing. A hand-rolled *-live.html satisfied the "give Russell a link" Stop
// check just as well as a real template-derived one, so the assistant kept
// building bespoke pages and the hook never caught it. NEW PreToolUse[Write]
// TEETH: writing a NEW file matching *-live.html is DENIED unless its content
// contains the standard template's fingerprint (the CONFIG-block marker
// comment + `const CONFIG = {`) -- see isMonitorLiveFilePath/
// looksLikeStandardTemplate/templateFingerprintCheck below. This is a STATE
// check (the file's actual bytes), not a claim -- the only way to satisfy it
// is to genuinely start from ~/.claude/skills/live-watch/watch-template.html.
//
// EXTENSION (Russell, 2026-07-21, verbatim: "add hook that you cant launch an
// experiment without referencing the skill"): the FIRST prerequisite on any
// launch — runpod/modal/training AND local `scripts/exp*.py` runs — is that the
// ml-experiment skill was actually REFERENCED this session (a Skill tool-use of
// `ml-experiment`, or its SKILL.md read). Rule 1.6: this gates on the verifiable
// STATE (the skill's content entered context), never a self-asserted token.
// Local exp*.py runs are gated on the skill reference ONLY — the pod-grade
// monitor/stream/checkpoint cascade stays scoped to paid/remote launches (the
// skill itself owns the monitor-default-on rule for local runs, with Russell's
// opt-out).
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, toolUsesOf, lastAssistantText } from './lib/transcript.mjs';

const ENV_OVERRIDE = 'EXPERIMENT_MONITOR_REQUIRED_OK';
const ESCAPE_TOKEN = /\bEXPERIMENT_MONITOR_REQUIRED_OK\b/;
const MONITOR_TOOL = 'Monitor';
// A watch LINK Russell can open: an http(s) URL, a localhost:PORT, or a *-live.html
// watch page. Russell's rule (2026-07-16): a Monitor must come with a link.
const LINK_RE = /(https?:\/\/\S+)|(?:localhost|127\.0\.0\.1):\d+|[\w.-]+-live\.html/i;

// Russell's rule (2026-07-17, verbatim: "you're supposed to stream results and actual
// data from trials i can watch. make that a rule ... SET IN EXPERIMENT HOOK"): a monitor
// that shows no LIVE interim trial data is useless. Before a launch, evidence must exist
// that interim data will stream home — a refresher/feeder that pulls or writes the live
// and/or think JSONL the dashboard reads. Detected as any tool-use command referencing
// the live/think feed or a refresher/feeder.
const INTERIM_STREAM_RE = /_live\.jsonl|_think\.jsonl|live[_-]?refresher|live[_-]?feeder|--stream-interim|scp[\s\S]*(?:_live|_think)\.jsonl/i;

// Russell's rule (2026-07-17, the $13 exp154 bleed): "a pod-lifecycle watcher must probe JOB
// liveness (remote process / log freshness), not just POD desiredStatus." A RUNNING pod with a
// DEAD job looks identical to a slow one on a status-only feeder — that blind spot let a
// crashed run bleed $12.74 over 3 hours. Evidence a JOB-liveness probe exists: an ssh that runs
// a remote process check (ps/pgrep/pkill -0/nvidia-smi) or tails the remote job log, OR an
// explicit hang/freshness/job-alive detector. A pod-STATUS check (desiredStatus/get pod) does
// NOT count — that is exactly the thing that under-measured.
const JOB_LIVENESS_RE = /\bssh\b[\s\S]*(?:\bps\b|pgrep|pkill\s*-0|nvidia-smi|tail[\s\S]*(?:nohup|stdout|job|\.log))|job[_-]?liveness|hang[_-]?detect(?:or|ion)?|log[_-]?freshness|process[_-]?alive|job[_-]?alive|no[_ -]update[_ -]in/i;

// A launch is one of: a runpod launcher run with the `launch` verb; a `modal run`;
// or a python invocation of a modal_*.py job script.
// Forward order only — the runpod launcher is INVOKED then handed the `launch`
// subcommand (`python runpod_exp153.py launch`). Requiring file-then-launch avoids
// matching a `grep launch runpod_exp153.py` that merely searches the file.
const RUNPOD_LAUNCH = /runpod_\w*\.py\b[\s\S]*\blaunch\b/;
const MODAL_RUN = /\bmodal\s+run\b/;
const PYTHON_MODAL = /\b(?:python[0-9.]*|py)\b[\s\S]*\bmodal_\w*\.py\b/;

// Anything that is NOT a real spend-and-run: help, dry runs, smoke tests, listings,
// and the finalize/teardown step (which runs AFTER a launch, not a new launch).
const NOT_A_LAUNCH = /\bfinalize\b|--help\b|(?:^|\s)-h(?:\s|$)|--dry-run\b|--smoke\b|--check\b|--list\b/;

// Russell's rule (2026-07-17): "experiment hook should block launching without checkpoint
// setup." A TRAINING launch (long, paid, stateful) that isn't wired for step-level
// checkpointing loses ALL in-progress work to a crash / network hiccup / preempted pod.
// A TRAINING launch = a python run of a full-seed / train_* script, OR a launcher launch
// carrying a real training marker (--decision-epochs / --mask-steps / full-seed). It is NOT
// a race/eval launch (nothing to checkpoint), a 10-step capacity/overfit smoke, a pytest run
// of a test_*.py, or finalize/reads.
const TRAINING_SCRIPT_RE = /(?:^|[\/\\\s])(?:run_\w*_full_seed|train_\w+)\.py\b/;
const PYTEST_RE = /\bpytest\b|(?:^|[\/\\\s])test_\w+\.py\b/;
const TRAINING_SMOKE_RE = /--capacity[_-]?smoke\b|\boverfit_smoke\b|--max-steps\s+\d\b/i;
const LAUNCH_TRAINING_MARKER = /full[_-]seed|--decision-epochs|--mask-steps/i;
// Evidence that step-level checkpointing IS wired: a checkpoint flag on the launch, the
// Runner checkpoint-cadence API, a resume flag, or a persistent-volume checkpoint target.
const CHECKPOINT_SETUP_RE = /checkpoint_if_due|CheckpointPolicy|CheckpointCadence|resume_step|publish_checkpoint|--checkpoint[_-]?(?:every|steps|interval|seconds)|checkpoint[_-]?every[_-]?steps|--resume\b|network[_-]?volume/i;

/**
 * True when a Bash command actually STARTS an experiment/pod/training run.
 * Precise on purpose: excludes finalize/help/dry-run/smoke/check/list and plain
 * reads of a launcher file, so prose and inspection never trip the guard.
 */
export function isLaunchCommand(command) {
  if (!command || typeof command !== 'string') return false;
  if (NOT_A_LAUNCH.test(command)) return false;
  return RUNPOD_LAUNCH.test(command) || MODAL_RUN.test(command) || PYTHON_MODAL.test(command);
}

// A LOCAL experiment run: the interpreter as a command token running a scripts/exp*.py
// worker (Russell's cross-repo convention). pytest/py_compile/reads never match; the
// NOT_A_LAUNCH escapes (--smoke/--dry-run/--check/--list/--help/finalize) apply.
// \b (not "start-of-string or whitespace") so a launch embedded inside a QUOTED argument
// still matches -- e.g. `-RunCommand "py -3 scripts/exp167d_....py ..."` has "py" preceded
// by a quote character, not whitespace. This is exactly the shape detached_run.ps1's
// -RunCommand string produces (Russell, 2026-07-21: a real PowerShell-tool launch missed
// detection here). \b matches at ANY word/non-word transition (quote, paren, whitespace,
// start-of-string), matching the more robust pattern already used by PYTHON_MODAL above.
const LOCAL_EXPERIMENT_RE = /\b(?:python[0-9.]*|py)\b\s+(?:-3\s+)?\S*scripts[\/\\]exp\w+\.py\b/;

/**
 * True when a command runs a LOCAL experiment worker (scripts/exp*.py). These are
 * gated on the ml-experiment skill reference only — not the pod monitor cascade.
 */
export function isLocalExperimentRun(command) {
  if (!command || typeof command !== 'string') return false;
  if (NOT_A_LAUNCH.test(command)) return false;
  if (PYTEST_RE.test(command)) return false;
  if (/py_compile/.test(command)) return false;
  return LOCAL_EXPERIMENT_RE.test(command);
}

// The ml-experiment skill was actually REFERENCED this session: a Skill tool-use of
// `ml-experiment`, a Read of its SKILL.md, or a shell read of the skill path. This is
// the verifiable STATE (content entered context) — never a self-asserted token.
const SKILL_PATH_RE = /skills[\/\\]ml-experiment/i;
export function referencedExperimentSkill(toolUses) {
  return (toolUses || []).some((toolUse) =>
    (toolUse?.name === 'Skill' && /^ml-experiment$/i.test(toolUse?.skill || ''))
    || SKILL_PATH_RE.test(toolUse?.filePath || '')
    || SKILL_PATH_RE.test(toolUse?.command || ''));
}

// ---- TEMPLATE-FIRST enforcement (Write-time TEETH, Russell's 6th correction) ----

// A monitor page: any NEW file matching *-live.html. Scoped to filename, not
// directory, so it catches docs/<exp>-live.html regardless of project layout.
const MONITOR_LIVE_FILE_RE = /[^\/\\]*-live\.html$/i;
export function isMonitorLiveFilePath(filePath) {
  return typeof filePath === 'string' && MONITOR_LIVE_FILE_RE.test(filePath);
}

// The standard template's fingerprint: the CONFIG-block marker comment AND the
// CONFIG object declaration. Both must be present — a file that merely mentions
// "CONFIG" in passing (a bespoke page renamed to look compliant) still needs the
// literal marker comment, which only exists in the real template.
const TEMPLATE_MARKER_RE = /CONFIG\s*[—-]\s*the ONLY block you edit per experiment/i;
const TEMPLATE_CONFIG_OBJECT_RE = /const\s+CONFIG\s*=\s*\{/;
export function looksLikeStandardTemplate(fileContent) {
  const content = String(fileContent || '');
  return TEMPLATE_MARKER_RE.test(content) && TEMPLATE_CONFIG_OBJECT_RE.test(content);
}

const NOT_TEMPLATE_REASON = `MONITOR PAGE IS NOT DERIVED FROM RUSSELL'S STANDARD TEMPLATE — blocked.

Russell's rule (2026-07-16, re-stated furiously 2026-07-21 after 6 repeat violations): "never a
hand-rolled page" for a live monitor. This hook's OWN deny/no-link messages have said that for
weeks — but nothing ever checked the file's actual content, so a hand-rolled *-live.html always
slipped through. That gap is now closed: this file does not contain the template's fingerprint
(the CONFIG-block marker comment + \`const CONFIG = {\`).

Fix, in order:
  1. Copy the template AS-IS: cp ~/.claude/skills/live-watch/watch-template.html <this path>
  2. Edit ONLY the CONFIG block (exp name, title, feeds, arms, seeds, metric) for this experiment.
  3. If the worker has no per-step JSONL feed yet, that is the worker's gap to fix (wire the
     live/think JSONL per the ml-experiment skill's interim-streaming HARD RULE) — it is NOT a
     reason to abandon the template for a bespoke page.

Escape (genuinely not a monitor page — e.g. a one-off report, not a live-watch dashboard):
EXPERIMENT_MONITOR_REQUIRED_OK=1 in env, or the token EXPERIMENT_MONITOR_REQUIRED_OK in the reply.`;

/** PreToolUse(Write) check: a NEW *-live.html file must be template-derived. */
export function templateFingerprintCheck({ filePath, content, envOk = false, replyText = '' } = {}) {
  if (envOk) return { block: false };
  if (ESCAPE_TOKEN.test(replyText || '')) return { block: false };
  if (!isMonitorLiveFilePath(filePath)) return { block: false };
  if (looksLikeStandardTemplate(content)) return { block: false };
  return { block: true, mode: 'deny', reason: NOT_TEMPLATE_REASON };
}

/**
 * True when a command STARTS a real model-TRAINING run — the thing that must be wired
 * for step-level checkpointing. Excludes race/eval launches (nothing to checkpoint), a
 * 10-step capacity/overfit smoke, a pytest run of a test_*.py, and finalize/reads.
 */
export function isTrainingLaunch(command) {
  if (!command || typeof command !== 'string') return false;
  if (NOT_A_LAUNCH.test(command)) return false;
  if (PYTEST_RE.test(command)) return false;         // running the trainer's tests, not training
  if (TRAINING_SMOKE_RE.test(command)) return false; // a ~10-step smoke has nothing durable to save
  // The interpreter as a COMMAND token (followed by args) — not the ".py" file extension,
  // so `cat run_x_full_seed.py` (the "py" in ".py") never counts as running the trainer.
  const runsTrainingScript = /(?:^|\s)(?:python[0-9.]*|py)\s+/.test(command) && TRAINING_SCRIPT_RE.test(command);
  const launchesTraining = isLaunchCommand(command) && LAUNCH_TRAINING_MARKER.test(command);
  return runsTrainingScript || launchesTraining;
}

// Flatten a transcript into its tool-uses in order: [{ name, command }]. `command`
// is only meaningful for Bash tool-uses (used to spot launches in history).
function toolUsesInOrder(entries) {
  const toolUses = [];
  for (const entry of entries || []) {
    for (const block of toolUsesOf(entry)) {
      toolUses.push({
        name: block?.name || '',
        command: block?.input?.command || '',
        skill: block?.input?.skill || '',
        filePath: block?.input?.file_path || '',
      });
    }
  }
  return toolUses;
}

// Concatenate every assistant TEXT block (not tool-uses) so we can check whether a
// watch link was given anywhere this session. Handles both the raw transcript shape
// and the test's plain {role, content:[{type:'text',text}]} entries.
function allAssistantText(entries) {
  let assistantText = '';
  for (const entry of entries || []) {
    const role = entry?.role || entry?.message?.role;
    if (role !== 'assistant') continue;
    const content = entry?.content ?? entry?.message?.content ?? [];
    if (typeof content === 'string') { assistantText += ' ' + content; continue; }
    for (const block of content || []) {
      if (typeof block === 'string') assistantText += ' ' + block;
      else if (block?.type === 'text' && block?.text) assistantText += ' ' + block.text;
    }
  }
  return assistantText;
}

const DENY_REASON = `EXPERIMENT LAUNCH BLOCKED — no live Monitor is attached yet.

Russell's rule (2026-07-16): "I want the monitor created BEFORE the experiment launches."
A paid pod / training run that starts with nobody watching can die (or stall silently) and
not be noticed for a whole session — exactly how exp150 lost 3 reader checkpoints.

Do this BEFORE launching, in order:
  1. Build the browser monitor from Russell's STANDARD template — copy
     ~/.claude/skills/live-watch/watch-template.html to <repo>/docs/<exp>-live.html and edit ONLY
     its CONFIG block (arms, seeds, metric, the purpose cards). Do NOT hand-roll a bespoke page.
  2. Serve it and give Russell the clickable link.
  3. Start a Monitor (the Monitor tool) for the liveness/finalize loop.
  4. THEN launch.

If this genuinely does not need a Monitor (a smoke/dry-run, or you are re-attaching after the
Monitor already exists), add the token ${ENV_OVERRIDE} to your reply, or set ${ENV_OVERRIDE}=1.`;

const STOP_REASON = `LAUNCH WITHOUT A LIVE MONITOR — an experiment/pod launch ran this session but no Monitor
is watching it (the last Monitor is before the last launch, or there is none).

A launch must be covered by a live Monitor (liveness poll + finalize/teardown loop) through its
whole lifecycle, so a death or stall is seen in real time instead of a session later. Attach a
Monitor to the launch now (or finalize/teardown it if it is already done).

If the run is already finalized and torn down, put ${ENV_OVERRIDE} in your reply to clear this.`;

const NO_LINK_REASON = `MONITOR WITHOUT A LINK — an experiment launched with a Monitor, but no watch LINK
was given to Russell this session.

Russell's rule (2026-07-16): "when you create a monitor you must give me a link." A chat-only
Monitor isn't enough — Russell wants a URL he can open to WATCH the run: a served watch page
(e.g. http://localhost:PORT/....html) or a *-live.html watch page. The page MUST be built from the
STANDARD template (~/.claude/skills/live-watch/watch-template.html, CONFIG edited only) — not hand-rolled.

Give Russell the watch link, then stop. Escape: ${ENV_OVERRIDE} in your reply, or ${ENV_OVERRIDE}=1.`;

const NO_INTERIM_REASON = `MONITOR STREAMS NO LIVE TRIAL DATA — the run will launch but nothing feeds the
dashboard REAL interim results.

Russell's rule (2026-07-17, verbatim): "you're supposed to stream results and actual data from
trials i can watch. make that a rule." A monitor whose bars fill only at the END — or that shows
status/0/null instead of real per-step trial data — is FORBIDDEN.

Before launching, wire the interim stream:
  1. The trainer must eval a fast SUBSAMPLE every ~25 steps and write a REAL metric to a
     (pod-local, for remote) runs/<exp>_live.jsonl, AND emit think rows every ~100 steps with the
     exact tool call, its result, right/wrong, and WHY-wrong (measured[].call/result/why — the
     format the standard template now renders). A decode-gate-only metric computed at the end is NOT enough.
  2. Start a REFRESHER (reference: marcus/scripts/exp153_live_refresher.py) that scp-pulls the
     pod's <exp>_live.jsonl + <exp>_think.jsonl home continuously, so the served page shows the
     numbers climbing live.

If the trainer only scores at the end, fix THAT first (add the subsample eval + think emit).
Escape (rare — a genuinely metric-less run): ${ENV_OVERRIDE} in your reply, or ${ENV_OVERRIDE}=1.`;

const NO_JOB_LIVENESS_REASON = `MONITOR PROBES POD STATUS, NOT JOB LIVENESS — a launch is running but nothing
checks whether the JOB is actually alive.

The $13 lesson (exp154, 2026-07-17): the full 7B run OOM-crashed minutes in, but the POD stayed
RUNNING (pod alive != job alive), CPU 88% idle, no python process — and because the monitor fed on
pod \`desiredStatus\` only, it looked like "still training" for 3 HOURS while 3 pods bled $12.74 doing
nothing. A status-only feeder cannot tell a dead job from a slow one.

Wire a JOB-liveness probe (not a pod-status poll):
  1. Probe the remote PROCESS: ssh the pod and \`pgrep -f <trainer>\` / \`ps\` / \`nvidia-smi\` — or tail the
     remote job log (nohup.out / stdout / the job's .log) and check its FRESHNESS (mtime moving).
  2. A hang detector on the live feed: "no update in 45s -> job dead" flags it in under a minute
     instead of 3 hours.
A pod \`desiredStatus\`/\`get pod\` check does NOT satisfy this — that is exactly the blind spot.

Escape (the run already finished / genuinely can't be probed): ${ENV_OVERRIDE} in your reply, or ${ENV_OVERRIDE}=1.`;

const NO_CHECKPOINT_REASON = `TRAINING LAUNCH WITHOUT CHECKPOINT SETUP — a paid training run is starting but nothing
saves its progress mid-run.

Russell's rule (2026-07-17): "the experiment hook should block launching without checkpoint setup."
A long training run that only saves at the end loses EVERYTHING to a crash, a network hiccup, or a
preempted spot pod — the exact in-progress-seed loss step-level checkpointing exists to stop.

Runner already owns the durable pieces — wire them in before launching:
  1. In the training loop, checkpoint on a cadence:
     CheckpointPolicy(every_steps=N, every_seconds=T) + lifecycle.checkpoint_if_due(step=..., cadence=...)
     (the time cadence is the network-hiccup safety net — a slow-step run still rescues on a wall clock).
  2. On relaunch, resume_step(lifecycle, identity) restarts one past the last verified checkpoint.
  3. Point checkpoints at a persistent Network Volume (survives pod death), not the pod's ephemeral disk.
Then pass the checkpoint knobs on the launch (e.g. --checkpoint-every-steps N) so this run is durable.

Escape (a genuinely un-checkpointable run, or a short bounded run): ${ENV_OVERRIDE} in your reply, or ${ENV_OVERRIDE}=1.`;

const NO_SKILL_REFERENCE_REASON = `EXPERIMENT LAUNCH BLOCKED — the ml-experiment skill was not referenced this session.

Russell's rule (2026-07-21): no experiment launches until the ml-experiment skill's contract is
in context — it owns the durability checklist (retry/resume/concurrency/pulses), the LIVE
interim-streaming requirement, and the HTML-monitor-DEFAULT-ON rule. Launching without it is how
runs end up unwatched, unresumable, or lost to an app restart.

Fix (one step): invoke the skill — Skill tool, name "ml-experiment" — or Read
~/.claude/skills/ml-experiment/SKILL.md. Then relaunch this exact command.

Escape (rare — Russell explicitly waived it): ${ENV_OVERRIDE} in your reply, or ${ENV_OVERRIDE}=1.`;

// Shared: does any run this session stream interim trial data home? (a refresher/feeder that
// pulls or writes the live/think JSONL the dashboard reads). Russell's rule, 2026-07-17.
function streamsInterimData(toolUses) {
  return (toolUses || []).some((toolUse) => INTERIM_STREAM_RE.test(toolUse?.command || ''));
}

// Shared: does any tool-use this session probe JOB liveness (remote process / log freshness /
// hang detector), not just pod status? The $13 exp154 bleed: a status-only feeder showed a dead
// job as "RUNNING" for 3 hours. Russell's rule, 2026-07-17: probe the JOB, not the pod.
function probesJobLiveness(toolUses) {
  return (toolUses || []).some((toolUse) => JOB_LIVENESS_RE.test(toolUse?.command || ''));
}

// Shared: is step-level checkpointing wired for this training launch? Evidence in the launch
// command itself, any tool-use command this session, or the assistant's reply text. Russell's
// rule, 2026-07-17: a training launch without checkpoint setup loses everything to an interruption.
function hasCheckpointSetup(toolUses, command, replyText) {
  if (CHECKPOINT_SETUP_RE.test(command || '')) return true;
  if (CHECKPOINT_SETUP_RE.test(replyText || '')) return true;
  return (toolUses || []).some((toolUse) => CHECKPOINT_SETUP_RE.test(toolUse?.command || ''));
}

/**
 * PURE core. `entries` is the parsed transcript (array). Returns
 * { block, mode?, reason? }. Never throws on malformed input.
 */
export function evaluate({ event, command = '', entries = [], replyText = '', stopHookActive = false, envOk = false } = {}) {
  if (envOk) return { block: false };
  if (ESCAPE_TOKEN.test(command || '') || ESCAPE_TOKEN.test(replyText || '')) return { block: false };

  const toolUses = toolUsesInOrder(entries);

  if (event === 'PreToolUse') {
    // FIRST prerequisite (Russell, 2026-07-21): ANY experiment launch — pod, modal,
    // training, or a LOCAL scripts/exp*.py run — requires the ml-experiment skill
    // referenced this session. The skill teaches everything the later denials demand.
    const isAnyExperimentLaunch = isLaunchCommand(command) || isTrainingLaunch(command)
      || isLocalExperimentRun(command);
    if (isAnyExperimentLaunch && !referencedExperimentSkill(toolUses)) {
      return { block: true, mode: 'deny', reason: NO_SKILL_REFERENCE_REASON };
    }
    // Local exp*.py runs are gated on the skill reference only — the pod-grade
    // monitor cascade below stays scoped to paid/remote/training launches.
    if (!isLaunchCommand(command) && !isTrainingLaunch(command)) return { block: false };
    const hasMonitor = toolUses.some((toolUse) => toolUse.name === MONITOR_TOOL);
    if (!hasMonitor) return { block: true, mode: 'deny', reason: DENY_REASON };
    // Monitor exists — but does interim trial data actually stream? (Russell 2026-07-17)
    if (!streamsInterimData(toolUses) && !INTERIM_STREAM_RE.test(command || '')) {
      return { block: true, mode: 'deny', reason: NO_INTERIM_REASON };
    }
    // A TRAINING launch must be wired for step-level checkpointing (Russell 2026-07-17).
    if (isTrainingLaunch(command) && !hasCheckpointSetup(toolUses, command, replyText)) {
      return { block: true, mode: 'deny', reason: NO_CHECKPOINT_REASON };
    }
    return { block: false };
  }

  if (event === 'Stop') {
    if (stopHookActive) return { block: false };
    let lastLaunchIndex = -1;
    let lastMonitorIndex = -1;
    toolUses.forEach((toolUse, index) => {
      if (toolUse.name === MONITOR_TOOL) lastMonitorIndex = index;
      if (toolUse.name === 'Bash' && (isLaunchCommand(toolUse.command) || isTrainingLaunch(toolUse.command))) {
        lastLaunchIndex = index;
      }
    });
    if (lastLaunchIndex < 0) return { block: false };
    if (lastMonitorIndex < lastLaunchIndex) {
      return { block: true, mode: 'stop', reason: STOP_REASON };
    }
    // The Monitor covers the launch — but was a watch LINK given to Russell?
    if (!LINK_RE.test(allAssistantText(entries))) {
      return { block: true, mode: 'stop', reason: NO_LINK_REASON };
    }
    // And does interim trial data actually stream home? (Russell 2026-07-17)
    if (!streamsInterimData(toolUses)) return { block: true, mode: 'stop', reason: NO_INTERIM_REASON };
    // And does anything probe JOB liveness (not just pod status)? (Russell 2026-07-17, the $13 bleed)
    if (!probesJobLiveness(toolUses)) return { block: true, mode: 'stop', reason: NO_JOB_LIVENESS_REASON };
    // And if the launch was a TRAINING run, was step-level checkpointing wired? (Russell 2026-07-17)
    const lastLaunchCommand = toolUses[lastLaunchIndex]?.command || '';
    if (isTrainingLaunch(lastLaunchCommand) && !hasCheckpointSetup(toolUses, lastLaunchCommand, allAssistantText(entries))) {
      return { block: true, mode: 'stop', reason: NO_CHECKPOINT_REASON };
    }
    return { block: false };
  }

  return { block: false };
}

function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') process.exit(0);
    const payload = readPayload();
    const event = payload.hook_event_name || payload.hookEventName || '';
    const transcriptPath = payload.transcript_path || payload.transcriptPath || '';
    const entries = readTranscript(transcriptPath);
    const replyText = lastAssistantText(entries);

    if (event === 'PreToolUse') {
      const toolName = payload.tool_name || payload.toolName || '';
      const input = payload.tool_input || {};

      if (toolName === 'Write') {
        const templateVerdict = templateFingerprintCheck({
          filePath: input.file_path || '',
          content: input.content || '',
          replyText,
        });
        if (!templateVerdict.block) process.exit(0);
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: templateVerdict.reason,
          },
        }));
        process.exit(0);
      }

      const command = input.command || '';
      const verdict = evaluate({ event, command, entries, replyText });
      if (!verdict.block) process.exit(0);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      }));
      process.exit(0);
    }

    if (event === 'Stop') {
      if (payload.stop_hook_active) process.exit(0);
      const verdict = evaluate({ event, entries, replyText, stopHookActive: false });
      if (!verdict.block) process.exit(0);
      process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }));
      process.exit(0);
    }

    process.exit(0);
  } catch {
    process.exit(0); // fail open — never brick a legitimate command or stop
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
