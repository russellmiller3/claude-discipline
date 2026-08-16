#!/usr/bin/env node
// compass-line-guard.test.mjs — locks the REDESIGNED rule (Russell, 2026-07-05 and 2026-07-26):
// the obsolete Mission prefix is rejected on every reply. Every 5 updates, an ADHD-friendly
// Roadmap Brief must connect the current rung to the North Star. Substantial landings do not add
// extra checkpoints between those intervals. Every numbered-plan reference must name
// what the plan does on every reply, regardless of that cadence.
// The prior every-message enforcement (2026-07-03) is what this redesign reverses.
//
// Run: node --test compass-line-guard.test.mjs
//
// Hermetic: each end-to-end case points COMPASS_STATE_FILE at a fresh temp file (so it never touches
// or depends on the real cross-session counter) and sets cwd to a non-repo temp dir (so the git-HEAD
// probe fails silent instead of reading this actual repo's HEAD).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  COMPASS_TURN_INTERVAL,
  hasNarrativeAnchor,
  finalReplyText,
  firstNonBlankLine,
  findRoadmapArtifacts,
  hasCompassOpening,
  hasGroundingStatus,
  hasMissionPrefix,
  hasRoadmapBrief,
  humanPromptCount,
  planReferencesWithoutPurpose,
  roadmapBriefGuidance,
  shouldRequireCompass,
} from './compass-line-guard.mjs';

const hookDir = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(hookDir, 'compass-line-guard.mjs');
const scratchDir = mkdtempSync(join(tmpdir(), 'compass-line-guard-test-'));

let transcriptSeq = 0;
// Build a transcript with `humanTurns` distinct human prompts (so the turn counter can be steered),
// the LAST assistant message carrying `assistantReply` + optional tool uses (the reply under test).
// Earlier turns are trivial user/assistant pairs purely to advance the human-prompt count.
function transcriptWith(userMessage, assistantReply, { toolUses = [], humanTurns = 1, toolResults = [] } = {}) {
  const lines = [];
  for (let priorTurn = 1; priorTurn < humanTurns; priorTurn++) {
    lines.push({ message: { role: 'user', content: [{ type: 'text', text: `prior prompt ${priorTurn}` }] } });
    lines.push({ message: { role: 'assistant', content: [{ type: 'text', text: `prior reply ${priorTurn}` }] } });
  }
  const blocks = toolUses.map((toolUse) => ({ type: 'tool_use', name: toolUse.name, input: toolUse.input || {} }));
  blocks.push({ type: 'text', text: assistantReply });
  lines.push({ message: { role: 'user', content: [{ type: 'text', text: userMessage }] } });
  for (const toolResult of toolResults) {
    lines.push({ message: { role: 'user', content: [{ type: 'tool_result', content: toolResult }] } });
  }
  lines.push({ message: { role: 'assistant', content: blocks } });
  const transcriptPath = join(scratchDir, `transcript-${process.pid}-${transcriptSeq++}.jsonl`);
  writeFileSync(transcriptPath, lines.map((entry) => JSON.stringify(entry)).join('\n'));
  return transcriptPath;
}

function combinedOutputOf(spawnResult) {
  return (spawnResult.stdout || '') + (spawnResult.stderr || '');
}

// Each run gets its OWN fresh temp state file, so state does not leak between tests.
function runHookWithRawInput(rawInput, { stateSeed = null } = {}) {
  const stateFile = join(scratchDir, `state-${process.pid}-${transcriptSeq++}.json`);
  if (stateSeed) writeFileSync(stateFile, JSON.stringify(stateSeed));
  const childEnv = { ...process.env, COMPASS_STATE_FILE: stateFile };
  const hookRun = spawnSync('node', [HOOK_PATH], { input: rawInput, encoding: 'utf8', env: childEnv });
  return { output: combinedOutputOf(hookRun), stateFile };
}

function runHook(payload, options = {}) {
  return runHookWithRawInput(JSON.stringify(payload), options);
}

function stopOn(transcriptPath, extraPayloadFields = {}, options = {}) {
  return runHook(
    { hook_event_name: 'Stop', transcript_path: transcriptPath, cwd: scratchDir, ...extraPayloadFields },
    options
  ).output;
}

const isBlocked = (hookOutput) => /"decision"\s*:\s*"block"/.test(hookOutput);

// --- unit-level checks on the exported primitives -------------------------------------------

test('firstNonBlankLine: skips leading blank lines', () => {
  assert.equal(firstNonBlankLine('\n\n  \nhello world\nmore text'), 'hello world');
});

test('hasCompassOpening: true for a natural North Star, task, and progress connection', () => {
  assert.equal(
    hasCompassOpening('The North Star is reliable owner conversations. This task advances that goal by closing the null-token crash.'),
    true,
  );
});

test('hasCompassOpening: false for a TL;DR header without the required connection', () => {
  assert.equal(hasCompassOpening('## TL;DR\n\nWe shipped the thing.'), false);
});

test('hasCompassOpening: false for a plain reply with no North Star connection', () => {
  assert.equal(hasCompassOpening('I edited the file to fix the bug.'), false);
});

test('findRoadmapArtifacts: returns Markdown and HTML candidates without declaring either authoritative', () => {
  const projectRoot = mkdtempSync(join(scratchDir, 'roadmap-artifacts-'));
  const docsDirectory = join(projectRoot, 'docs');
  mkdirSync(docsDirectory);
  const markdownRoadmap = join(projectRoot, 'ROADMAP.md');
  const htmlProgressMap = join(docsDirectory, 'progress-map.html');
  writeFileSync(markdownRoadmap, '# Roadmap\n');
  writeFileSync(htmlProgressMap, '<main>Progress map</main>');

  assert.deepEqual(findRoadmapArtifacts(projectRoot), [markdownRoadmap, htmlProgressMap]);
});

test('findRoadmapArtifacts: keeps a foreign parent roadmap out of a nested project search', () => {
  const workspaceRoot = mkdtempSync(join(scratchDir, 'roadmap-boundary-'));
  const foreignRoadmap = join(workspaceRoot, 'ROADMAP.md');
  const projectRoot = join(workspaceRoot, 'owned-project');
  const nestedDirectory = join(projectRoot, 'src');
  const docsDirectory = join(projectRoot, 'docs');
  const projectRoadmap = join(docsDirectory, 'roadmap-brief.html');
  mkdirSync(nestedDirectory, { recursive: true });
  mkdirSync(docsDirectory);
  writeFileSync(foreignRoadmap, '# Foreign roadmap\n');
  writeFileSync(join(projectRoot, 'AGENTS.md'), '# Project boundary\n');
  writeFileSync(projectRoadmap, '<main>Owned roadmap</main>');

  const candidates = findRoadmapArtifacts(nestedDirectory);
  assert.deepEqual(candidates, [projectRoadmap]);
  assert.equal(candidates.includes(foreignRoadmap), false);
});

const SCANNABLE_ROADMAP_BRIEF = [
  '🧭 **Roadmap**',
  '1. Build the guarded workspace',
  '2. Prove the paired result  <- YOU ARE HERE',
  '- **North Star:** make repository work safer and measurably better.',
  '- 📍 **YOU ARE HERE:** the paired result is the next unblocked rung.',
  '- 🛠 **What I am doing - literally:** close the next shared reliability gap.',
  '- 🔎 **Concrete evidence:** the last focused test passed with a durable receipt.',
  '- ✅ **Proven:** the prior gate passed with a durable receipt.',
  '- ⚠️ **Unproven:** the broader comparison has not run.',
  '- 🎯 **Next:** run the focused proof so the next decision rests on evidence.',
].join('\n');

test('hasRoadmapBrief: requires an ADHD-friendly map, evidence boundary, and next step', () => {
  assert.equal(hasRoadmapBrief(SCANNABLE_ROADMAP_BRIEF), true);
  assert.equal(
    hasRoadmapBrief('The North Star is safer work. This task advances it. Next: run the test.'),
    false,
  );
});

test('hasRoadmapBrief: requires an explicit current rung and concrete evidence', () => {
  assert.equal(hasRoadmapBrief(SCANNABLE_ROADMAP_BRIEF.replaceAll('YOU ARE HERE', 'CURRENT STEP')), false);
  assert.equal(
    hasRoadmapBrief(SCANNABLE_ROADMAP_BRIEF.replace('- 🔎 **Concrete evidence:** the last focused test passed with a durable receipt.\n', '')),
    false,
  );
});

test('hasRoadmapBrief: requires both proven and unproven boundaries', () => {
  assert.equal(
    hasRoadmapBrief(SCANNABLE_ROADMAP_BRIEF.replace('- ✅ **Proven:** the prior gate passed with a durable receipt.\n', '')),
    false,
  );
  assert.equal(
    hasRoadmapBrief(SCANNABLE_ROADMAP_BRIEF.replace('- ⚠️ **Unproven:** the broader comparison has not run.\n', '')),
    false,
  );
});

test('roadmapBriefGuidance: gives candidates to the agent without choosing authority for it', () => {
  const guidance = roadmapBriefGuidance([
    'C:/project/docs/roadmap.html',
    'C:/project/TRUTH.md',
  ]);
  assert.match(guidance, /Pick the document that actually owns the roadmap/);
  assert.match(guidance, /roadmap\.html/);
  assert.match(guidance, /TRUTH\.md/);
});

test('hasMissionPrefix: rejects the obsolete label but accepts natural prose', () => {
  assert.equal(hasMissionPrefix('**Mission:** Ship reliable owner conversations.'), true);
  assert.equal(hasMissionPrefix('The North Star is reliable owner conversations.'), false);
});

test('plan reference: bare Plan 170 purpose-free label is rejected', () => {
  assert.deepEqual(
    planReferencesWithoutPurpose('Next: finish Plan 170’s three known blockers, then hand it to Terra.'),
    ['Plan 170'],
  );
});

test('plan reference: Plan 170 followed by what it does is accepted', () => {
  assert.deepEqual(
    planReferencesWithoutPurpose('Next: finish Plan 170 — the learned-route canary comparing Zork with ordinary tools.'),
    [],
  );
});

test('plan reference: purpose-first wording followed by the number is accepted', () => {
  assert.deepEqual(
    planReferencesWithoutPurpose('Next: finish the learned-route canary comparing Zork with ordinary tools (Plan 170).'),
    [],
  );
});

test('finalReplyText: returns the last assistant text block, skipping tool-only entries', () => {
  const turnEntries = [
    { message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'first thought' }, { type: 'tool_use', name: 'Edit', input: {} }] } },
    { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'final reply text' }] } },
  ];
  assert.equal(finalReplyText(turnEntries), 'final reply text');
});

test('humanPromptCount: counts genuine human prompts, ignoring tool_result user messages', () => {
  const entries = [
    { message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
    { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }, // NOT a human prompt
    { message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
    { message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'reply2' }] } },
  ];
  assert.equal(humanPromptCount(entries), 2);
});

// --- shouldRequireCompass ------------------------------------------------------------------------

test('shouldRequireCompass: true at the interval turn (counter % INTERVAL === 0)', () => {
  assert.equal(COMPASS_TURN_INTERVAL, 5);
  assert.equal(shouldRequireCompass({ turnCounter: COMPASS_TURN_INTERVAL, substantialLanding: false }), true);
});

test('shouldRequireCompass: false on an ordinary off-interval turn with nothing substantial', () => {
  assert.equal(shouldRequireCompass({ turnCounter: COMPASS_TURN_INTERVAL - 1, substantialLanding: false }), false);
});

test('shouldRequireCompass: false off-interval even when something substantial landed', () => {
  assert.equal(shouldRequireCompass({ turnCounter: 2, substantialLanding: true }), false);
});

// --- end-to-end Stop-hook behavior: the redesigned contract --------------------------------------

test('REDESIGN: ordinary mid-work turn off-interval does not require a North Star checkpoint', () => {
  const transcriptPath = transcriptWith(
    'keep tweaking the loader',
    'Tweaked the null check — no user-facing change yet.',
    { toolUses: [{ name: 'Edit', input: { file_path: 'src/loader.js' } }], humanTurns: 2 } // counter lands on 2, not a multiple of 5
  );
  assert.equal(isBlocked(stopOn(transcriptPath)), false);
});

test('Mission prefix BLOCKS even off the North Star checkpoint interval', () => {
  const transcriptPath = transcriptWith(
    'continue',
    'Mission: finish the email work. The next gate is the live proof.',
    { humanTurns: 2 },
  );
  const hookOutput = stopOn(transcriptPath);
  assert.equal(isBlocked(hookOutput), true);
  assert.match(hookOutput, /Mission prefix/i);
});

test('plan reference: bare number BLOCKS even off the compass interval', () => {
  const transcriptPath = transcriptWith(
    'now what',
    'Next: finish Plan 170’s three known blockers, then hand it to Terra.',
    { humanTurns: 2 },
  );
  const hookOutput = stopOn(transcriptPath);
  assert.equal(isBlocked(hookOutput), true);
  assert.match(hookOutput, /what the plan does/i);
});

test('REDESIGN: a turn at the 5-update interval without a checkpoint blocks with a North Star demand', () => {
  // The counter tracks hook INVOCATIONS across turns, not transcript length. Seed it just below the
  // interval (4 turns already processed) so this genuinely-new 5th turn advances the counter to
  // exactly COMPASS_TURN_INTERVAL — the interval boundary — with nothing substantial landing.
  const transcriptPath = transcriptWith(
    'continue',
    'Made another small edit.',
    { toolUses: [{ name: 'Edit', input: {} }], humanTurns: COMPASS_TURN_INTERVAL } // 5 human prompts -> a new turn vs. the seed
  );
  const seed = { turnCounter: COMPASS_TURN_INTERVAL - 1, humanPromptCount: COMPASS_TURN_INTERVAL - 1, lastHead: '' };
  const hookOutput = stopOn(transcriptPath, {}, { stateSeed: seed });
  assert.equal(isBlocked(hookOutput), true);
  assert.match(hookOutput, /northstar/i);
});

test('REDESIGN: a substantial landing off-interval does not demand another checkpoint', () => {
  const transcriptPath = transcriptWith(
    'ship it',
    'Committed the change.',
    { toolUses: [{ name: 'Bash', input: { command: 'git commit -m "feat: ship"' } }], humanTurns: 2 } // off-interval, but a commit landed
  );
  const hookOutput = stopOn(transcriptPath);
  assert.equal(isBlocked(hookOutput), false);
});

test('ROADMAP BRIEF: a plain North Star checkpoint BLOCKS at the interval', () => {
  const transcriptPath = transcriptWith(
    'continue',
    'The North Star is reliable owner conversations across every channel. This task closes the last null-token crash and advances that goal; the next gate is the live email proof.',
    { toolUses: [{ name: 'Edit', input: {} }], humanTurns: COMPASS_TURN_INTERVAL }
  );
  const seed = { turnCounter: COMPASS_TURN_INTERVAL - 1, humanPromptCount: COMPASS_TURN_INTERVAL - 1 };
  assert.equal(isBlocked(stopOn(transcriptPath, {}, { stateSeed: seed })), true);
});

test('ROADMAP BRIEF: a scannable brief PASSES at the interval', () => {
  const transcriptPath = transcriptWith(
    'continue',
    SCANNABLE_ROADMAP_BRIEF,
    { toolUses: [{ name: 'Edit', input: {} }], humanTurns: COMPASS_TURN_INTERVAL }
  );
  const seed = { turnCounter: COMPASS_TURN_INTERVAL - 1, humanPromptCount: COMPASS_TURN_INTERVAL - 1 };
  const hookOutput = stopOn(transcriptPath, {}, { stateSeed: seed });
  assert.equal(isBlocked(hookOutput), false, hookOutput);
});

test('ROADMAP BRIEF: a plain North Star checkpoint still BLOCKS after a substantial landing', () => {
  const transcriptPath = transcriptWith(
    'ship it',
    'The North Star is reliable owner conversations across every channel. This task advances that goal by landing the auth fix; the next gate is production proof.',
    { toolUses: [{ name: 'Bash', input: { command: 'git commit -m "fix"' } }], humanTurns: COMPASS_TURN_INTERVAL }
  );
  const seed = { turnCounter: COMPASS_TURN_INTERVAL - 1, humanPromptCount: COMPASS_TURN_INTERVAL - 1 };
  assert.equal(isBlocked(stopOn(transcriptPath, {}, { stateSeed: seed })), true);
});

test('REDESIGN: a TL;DR header alone does not satisfy a required checkpoint', () => {
  const transcriptPath = transcriptWith(
    '/bigpicture',
    '## TL;DR\n\nWe shipped the new update hook and it works.',
    { toolUses: [{ name: 'Write', input: { file_path: 'C:/proj/SUMMARY.md' } }], humanTurns: COMPASS_TURN_INTERVAL }
  );
  const seed = { turnCounter: COMPASS_TURN_INTERVAL - 1, humanPromptCount: COMPASS_TURN_INTERVAL - 1 };
  assert.equal(isBlocked(stopOn(transcriptPath, {}, { stateSeed: seed })), true);
});

// --- session-open grounding (Russell, 2026-07-31) ------------------------------------------------
// "every new session needs to start with a grounding status of where we are vs the northstar goals
// and how what's next relates." The every-5-updates cadence structurally CANNOT deliver that: its
// counter is cross-session, so a fresh session's first turn is the one turn guaranteed to be exempt.

const GROUNDED_OPENER = [
  'North star: an agent completes ordinary repository work through the gateway instead of touching',
  'the filesystem directly. Where we are: the sealed unit closed 1/1 last night, the first time the',
  'harness survived a whole task. What is next: record the provider termination reason, because the',
  'audit currently infers truncation from token arithmetic. That advances the goal by replacing a',
  'guess with a receipt, which unlocks the broad verdict we cannot honestly claim today.',
].join(' ');

const UNGROUNDED_OPENER = [
  'I read the handoff and verified the branch head, then listed the plan files and confirmed the',
  'next free number. The working tree is stale so the real content lives in the main ref. I checked',
  'the audit script and the driver loop, located the turn-completion sites, and inspected the usage',
  'helper. The termination code is available in the backend but never written into the stream.',
].join(' ');

test('hasGroundingStatus accepts a reply carrying goal, current state, next step, and the link', () => {
  assert.ok(hasGroundingStatus(GROUNDED_OPENER));
});

test('hasGroundingStatus rejects a competent status that never names the goal', () => {
  assert.equal(hasGroundingStatus(UNGROUNDED_OPENER), false);
});

test('hasGroundingStatus rejects a reply that names the goal but never says what is next', () => {
  assert.equal(
    hasGroundingStatus('North star: ship the gateway. Where we are: the sealed unit passed because the harness held.'),
    false,
  );
});

test('hasGroundingStatus rejects a reply that names the goal but never says where we are', () => {
  assert.equal(
    hasGroundingStatus('North star: ship the gateway. Next I will record the reason so that the audit stops guessing.'),
    false,
  );
});

test('session open: a substantial ungrounded first reply is blocked', () => {
  const transcriptPath = transcriptWith('g', UNGROUNDED_OPENER, {
    toolUses: [{ name: 'Read', input: {} }],
    humanTurns: 1,
  });
  assert.ok(isBlocked(stopOn(transcriptPath)));
});

test('session open: a grounded first reply passes', () => {
  const transcriptPath = transcriptWith('g', GROUNDED_OPENER, {
    toolUses: [{ name: 'Read', input: {} }],
    humanTurns: 1,
  });
  assert.equal(isBlocked(stopOn(transcriptPath)), false);
});

test('session open: a SHORT factual first reply stays exempt (not every session opens with work)', () => {
  const transcriptPath = transcriptWith('what port does the monitor use?', 'Port 8646.', {
    toolUses: [],
    humanTurns: 1,
  });
  assert.equal(isBlocked(stopOn(transcriptPath)), false);
});

test('session open: the requirement is FIRST-turn only, not every turn', () => {
  const transcriptPath = transcriptWith('keep going', UNGROUNDED_OPENER, {
    toolUses: [{ name: 'Read', input: {} }],
    humanTurns: 2,
  });
  assert.equal(isBlocked(stopOn(transcriptPath)), false);
});

// --- idempotency / anti-loop ---------------------------------------------------------------------

test('anti-loop: re-entrant pass on a required turn without a checkpoint allows', () => {
  const transcriptPath = transcriptWith(
    'continue',
    'Still no North Star checkpoint.',
    { toolUses: [{ name: 'Edit', input: {} }], humanTurns: COMPASS_TURN_INTERVAL }
  );
  assert.equal(isBlocked(stopOn(transcriptPath, { stop_hook_active: true })), false);
});

test('idempotent counter: re-firing the SAME turn does not advance the counter (seeded state)', () => {
  // Seed state as if turn 4 already processed (humanPromptCount 4). A transcript with 4 human turns is
  // the SAME turn re-fired: promptCount(4) is NOT > state.humanPromptCount(4), so the counter stays 4,
  // which is off-interval -> not required -> not blocked. If the counter had wrongly advanced to 5 it
  // would block. This proves the anti-loop re-fire never double-counts.
  const transcriptPath = transcriptWith(
    'continue',
    'A reply with no North Star checkpoint on a re-fire.',
    { toolUses: [{ name: 'Edit', input: {} }], humanTurns: COMPASS_TURN_INTERVAL - 1 }
  );
  const seed = {
    turnCounter: COMPASS_TURN_INTERVAL - 1,
    humanPromptCount: COMPASS_TURN_INTERVAL - 1,
    lastHead: '',
  };
  assert.equal(isBlocked(stopOn(transcriptPath, {}, { stateSeed: seed })), false);
});

test('counter advances on a genuinely new turn: the 5th update lands on the interval -> BLOCKS', () => {
  const transcriptPath = transcriptWith(
    'continue',
    'A reply with no North Star checkpoint on a brand-new turn.',
    { toolUses: [{ name: 'Edit', input: {} }], humanTurns: COMPASS_TURN_INTERVAL }
  );
  const seed = {
    turnCounter: COMPASS_TURN_INTERVAL - 1,
    humanPromptCount: COMPASS_TURN_INTERVAL - 1,
    lastHead: '',
  };
  assert.equal(isBlocked(stopOn(transcriptPath, {}, { stateSeed: seed })), true);
});

// --- fail-open / no-op boundaries (preserved from the original) ----------------------------------

test('malformed transcript (missing file) -> silent PASS', () => {
  const hookOutput = stopOn('C:/definitely/does/not/exist/transcript.jsonl');
  assert.equal(isBlocked(hookOutput), false);
  assert.equal(hookOutput.trim(), '');
});

test('malformed transcript (garbage JSON payload) -> silent PASS', () => {
  const { output } = runHookWithRawInput('not json at all {{{');
  assert.equal(output.trim(), '');
});

test('non-Stop event -> silent PASS (no-op)', () => {
  const transcriptPath = transcriptWith('go', 'no North Star checkpoint here', { toolUses: [{ name: 'Edit', input: {} }], humanTurns: COMPASS_TURN_INTERVAL });
  const { output } = runHook({ hook_event_name: 'UserPromptSubmit', transcript_path: transcriptPath, cwd: scratchDir });
  assert.equal(output.trim(), '');
});
