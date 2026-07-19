#!/usr/bin/env node
// ross-perot-guard.test.mjs — locks the Ross Perot guard, including the new check Russell asked
// for (2026-06-16): when a turn ALREADY shipped code edits (builder mode) and the reply DEFERS an
// obvious fix ("I'd make that fix next") instead of just doing it, BLOCK. Must NOT fire on pure
// strategy advice in a discussion turn (no edits), and must keep the existing asking-permission and
// alternatives-without-recommendation blocks working.
//
// Run: node ross-perot-guard.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'ross-perot-guard.mjs');

// Build a transcript (user prompt + one assistant entry). withEdit adds an Edit tool_use block so the
// turn counts as "builder mode". Returns the path. The hook reads transcript_path from its payload.
let seq = 0;
function transcript(userText, assistantText, { withEdit = false, agentInFlight = false, agentBlocked = false } = {}) {
  const assistantBlocks = [];
  if (withEdit) assistantBlocks.push({ type: 'tool_use', name: 'Edit', input: {} });
  // A run_in_background Agent spawn with NO completing task-notification = an agent still in flight.
  if (agentInFlight) assistantBlocks.push({ type: 'tool_use', id: 'toolu_inflight1', name: 'Agent', input: { run_in_background: true, prompt: 'do work' } });
  // A spawn the harness DENIED (PreToolUse hook blocked it) — the paired tool_result is an error, so no
  // agent ever started; it must NOT be counted as in flight.
  if (agentBlocked) assistantBlocks.push({ type: 'tool_use', id: 'toolu_blocked1', name: 'Agent', input: { run_in_background: true, prompt: 'research' } });
  assistantBlocks.push({ type: 'text', text: assistantText });
  const lines = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText }] } },
    { type: 'assistant', message: { role: 'assistant', content: assistantBlocks } },
    ...(agentBlocked ? [{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_blocked1', is_error: true, content: 'Agent spawn BLOCKED — read-only research denied' }] } }] : []),
  ].map((e) => JSON.stringify(e)).join('\n');
  const path = join(tmpdir(), `recommend-test-${process.pid}-${seq++}.jsonl`);
  writeFileSync(path, lines);
  return path;
}
function isBlocked(path) {
  const run = spawnSync('node', [HOOK], { input: JSON.stringify({ transcript_path: path }), encoding: 'utf8' });
  return /"decision"\s*:\s*"block"/.test(run.stdout || '');
}
// Like isBlocked but with a project cwd (so the hook can read that project's HANDOFF.md priority queue).
function isBlockedInProject(path, projectDir) {
  const run = spawnSync('node', [HOOK], { input: JSON.stringify({ transcript_path: path, cwd: projectDir }), encoding: 'utf8' });
  return /"decision"\s*:\s*"block"/.test(run.stdout || '');
}
// Returns the block reason text (or '') so a test can assert the directive WORDING, not just that it blocked.
function blockReasonInProject(path, projectDir) {
  const run = spawnSync('node', [HOOK], { input: JSON.stringify({ transcript_path: path, cwd: projectDir }), encoding: 'utf8' });
  try { return JSON.parse(run.stdout || '{}').reason || ''; } catch { return ''; }
}
// Build a throwaway project dir; write HANDOFF.md only when handoffText is given (null = no queue file).
function projectWithHandoff(handoffText) {
  const projectDir = mkdtempSync(join(tmpdir(), 'rp-proj-'));
  if (handoffText != null) writeFileSync(join(projectDir, 'HANDOFF.md'), handoffText);
  return projectDir;
}
const HANDOFF_WITH_OPEN_QUEUE = '# HANDOFF\n\n### OWED / NEXT\n1. wire the relay launcher\n2. live-verify in Chrome\n';

const failures = [];
function check(label, condition) {
  if (condition) { console.log(`  ok  ${label}`); }
  else { console.log(`FAIL  ${label}`); failures.push(label); }
}

// NEW: builder turn that DEFERS an obvious fix is blocked (the exact thing Russell flagged).
check('blocks deferring an obvious fix in a builder turn',
  isBlocked(transcript('fix the guard', 'Done. The fix I’d make next: exempt test files in the other guard.', { withEdit: true })));
check('blocks "I’d make that fix next" in a builder turn',
  isBlocked(transcript('fix it', 'Shipped. I’d make that fix next so it stops tripping.', { withEdit: true })));

// Builder turn where the fix was actually DONE (no deferral language) passes.
check('passes a builder turn that just did the work',
  !isBlocked(transcript('fix it', 'Done — fixed and proven green. Both tests pass.', { withEdit: true })));

// Discussion turn (no edits) with future-tense advice is NOT a Ross Perot violation — it’s strategy.
check('does not fire on strategy advice in a discussion turn',
  !isBlocked(transcript('is my idea good?', 'I’d add a hybrid resolver next — it dominates the text-only version.')));

// Escape hatches: explicit override, and a genuine scope reason.
check('honors ross-perot-override token',
  !isBlocked(transcript('fix it', 'Done. I’d make that fix next. ross-perot-override: it needs a schema migration first.', { withEdit: true })));
check('allows a deferral with an explicit scope reason',
  !isBlocked(transcript('fix it', 'Done. I’d do the broader refactor next, but it’s out of scope for this change.', { withEdit: true })));

// NEW (2026-06-23): "offering choices / deferring the obvious next step to the user" forms Russell
// got today that the matcher MISSED. Each must now BLOCK. The bug: "your call:" / "your pick:" was
// being read as a recommendation ("my call:" pattern), and "which do you want" had no coverage.
check('blocks "Your call: I build X now, or we wrap here."',
  isBlocked(transcript('keep going', 'Your call: I build X now, or we wrap here.')));
check('blocks "Two ways forward, your pick: ... or ..."',
  isBlocked(transcript('keep going', 'Two ways forward, your pick: refactor the parser, or patch the call site.')));
check('blocks "or we wrap here and finish next session"',
  isBlocked(transcript('keep going', 'I can wire it up now, or we wrap here and finish next session.')));
check('blocks "I can X now, or Y — which do you want?"',
  isBlocked(transcript('keep going', 'I can refactor now, or add the test first — which do you want?')));
check('blocks "I can do X now, or Y — which do you want?"',
  isBlocked(transcript('keep going', 'I can do X now, or Y — which do you want?')));
check('blocks a menu of next steps with "where do you want to start?"',
  isBlocked(transcript('keep going', 'Next steps: 1) add caching 2) write docs 3) ship it. Where do you want to start?')));

// CONTROL: a genuinely-needs-the-user question (real money / irreversible) still PASSES — the
// existing legit carve-out must survive the widening.
check('passes a genuine irreversible call that truly needs the user',
  !isBlocked(transcript('clean up', 'This deletes the prod database and is irreversible — I need your explicit go-ahead before I run it.')));

// NEW (2026-06-23): ANNOUNCE-NEXT class — naming a concrete next dev action instead of doing it. The exact
// crack that slipped repeatedly: a bare gerund close ("Doing X next") with no commit word. Must BLOCK broadly.
check('blocks "Doing the warm-session wiring next."',
  isBlocked(transcript('keep going', 'Native voice shipped, 1494 green. Doing the warm-session wiring next.', { withEdit: true })));
check('blocks "next: wire the audio playback"',
  isBlocked(transcript('keep going', 'Committed. next: wire the audio playback into handleSend.', { withEdit: true })));
check('blocks "the next step is to build the controller"',
  isBlocked(transcript('keep going', 'Phase D done. The next step is to build the controller.', { withEdit: true })));
check('blocks "next I\'ll add the warm session"',
  isBlocked(transcript('keep going', 'Green and committed. Next I’ll add the warm session.', { withEdit: true })));
check('blocks "I’ll wire the player next session"',
  isBlocked(transcript('keep going', 'Done for now. I’ll wire the player next session.', { withEdit: true })));
// CONTROLS for the announce-next class: scope reason, override, genuine hardware-gate, and plain done all PASS.
check('announce-next allows an explicit scope reason',
  !isBlocked(transcript('keep going', 'Doing the migration next, but that’s out of scope for this change.', { withEdit: true })));
check('announce-next honors the override token',
  !isBlocked(transcript('keep going', 'Doing the warm session next. ross-perot-override: it needs a real-device voice test first.', { withEdit: true })));
check('announce-next does NOT fire on a plain done with no next action',
  !isBlocked(transcript('keep going', 'Done — native voice ships and all tests are green.', { withEdit: true })));
check('announce-next does NOT fire on a non-dev next (summary, not a build action)',
  !isBlocked(transcript('what changed?', 'Here’s the summary of what shipped. That’s everything for this change.')));

// REGRESSION: existing checks still fire.
check('still blocks asking-permission closers',
  isBlocked(transcript('do the thing', 'Looks good. Want me to wire it up?')));
check('still blocks alternatives without a recommendation',
  isBlocked(transcript('which approach?', 'Two options: A or B. Your call.')));

// NEW (2026-06-25): the bare closers that slipped THIS session — "Which next?" / "Say the word…".
check('blocks "Which next?" closer',
  isBlocked(transcript('do them all', 'Voicefix shipped, tests green. Which next?')));
check('blocks "Say the word and I’ll take the next one."',
  isBlocked(transcript('do them all', 'Done and verified. Say the word and I’ll take the next one.')));

// NEW (2026-06-25): QUEUE-AWARE keep-executing. HANDOFF.md is the priority queue; stopping with open work
// (and no stop from Russell) must BLOCK so the run keeps executing instead of asking.
check('queue-aware: stopping with an open HANDOFF queue blocks (keep executing)',
  isBlockedInProject(transcript('do them all in parallel', 'Done with the relay fix.'), projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));
check('queue-aware: NOT blocked when Russell explicitly says stop',
  !isBlockedInProject(transcript('stop for now', 'Done with the relay fix.'), projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));
check('queue-aware: NOT blocked when the user asked a question (answer it, do not force more work)',
  !isBlockedInProject(transcript('why did the socket close?', 'Because teardown ran first.'), projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));
check('queue-aware: NOT blocked when there is no HANDOFF.md',
  !isBlockedInProject(transcript('do them all', 'Done with the relay fix.'), projectWithHandoff(null)));
// HARDENED 2026-06-28 (Russell: "FIX THE HOOK SO YOU CANT SATISFY IT UNLESS I TELL YOU"): the override token is
// NO LONGER an escape for the queue gate — the assistant can't self-declare "blocked" to stop. Only Russell's
// stop signal / question, or an empty queue, ends the run. So with the override present the queue gate STILL blocks.
check('queue-aware: override token does NOT release the queue gate (only Russell can, 2026-06-28)',
  isBlockedInProject(transcript('keep going', 'Done. ross-perot-override: the 3 remaining items all need your Chrome reload.'), projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));
check('queue-aware: no false block when cwd is absent (other Stop-hook contexts)',
  !isBlocked(transcript('do them all', 'Done with the relay fix.')));

// NEW (2026-06-28, Russell: "when agents are in flight, review handoff + roadmap and launch parallel work").
// Idling while agents run ("holding here while it runs") must STILL block — and the directive must tell the
// orchestrator to fan out MORE parallel work from HANDOFF + the roadmap, not to wait.
check('queue-aware: blocks idling/"holding" while a background agent is in flight',
  isBlockedInProject(transcript('keep going', 'Holding here while it runs. I’ll integrate it when it lands.', { agentInFlight: true }),
    projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));
{
  const reason = blockReasonInProject(transcript('keep going', 'Holding here while it runs.', { agentInFlight: true }), projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE));
  check('queue-aware: in-flight directive says IN FLIGHT + launch parallel work',
    /IN FLIGHT/i.test(reason) && /parallel/i.test(reason) && /roadmap/i.test(reason));
}
check('queue-aware: still blocks idling with NO agents in flight (do the next item yourself)',
  isBlockedInProject(transcript('keep going', 'Holding here for now.'), projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));

// 2026-07-16 FALSE-POSITIVE: a spawn DENIED by a PreToolUse hook (errored tool_result) was counted as
// "in flight" — the Stop gate reported "3 agents IN FLIGHT" on a conversational turn with ZERO real
// agents. A blocked spawn never started an agent, so the in-flight directive must NOT fire.
{
  const reason = blockReasonInProject(transcript('keep going', 'Holding here for now.', { agentBlocked: true }), projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE));
  check('blocked spawn (errored tool_result) is NOT counted as an agent in flight',
    !/IN FLIGHT/i.test(reason));
}

// NEW (2026-06-25): LIST-AND-DEFER — enumerating divergences then dismissing them as "intentional/cosmetic"
// instead of fixing must BLOCK. The exact miss: "do all of them in parallel. why didn't you go onto them?"
const LIST_AND_DEFER = [
  'Differences between the guide and the build:',
  '- call_llm vs call_openrouter — cosmetic name',
  '- list[dict] vs typed model — guide is simpler',
  'The rest are deliberate teaching simplifications, not errors.',
].join('\n');
check('blocks listing divergences then dismissing them as teaching simplifications',
  isBlocked(transcript('does the guide match the build?', LIST_AND_DEFER)));
check('list-and-defer honors the override',
  !isBlocked(transcript('does it match?', LIST_AND_DEFER + '\nross-perot-override: these are intentional teaching abstractions Russell approved.')));
check('list-and-defer allows an enumerated divergence list with an explicit scope reason',
  !isBlocked(transcript('does it match?', LIST_AND_DEFER + '\nThe rest are out of scope for this change.')));
check('list-and-defer does NOT fire on a clean enumerated summary with no divergence/dismissal',
  !isBlocked(transcript('what changed?', '- Added export endpoints\n- Updated the guide\n- Wrote the post\nAll shipped and green.')));

// NEW (2026-06-25): META-QUOTE false-positive — quoting a trigger phrase in BACKTICKS while EXPLAINING the hook
// must NOT block. This is what false-blocked the session: "it's phrase-only (`want me to` / `should i`)".
check('does NOT block when the asking phrase appears only inside backticks (meta-explanation)',
  !isBlocked(transcript('why did the hook fire?', 'The guard is phrase-only — it matches `want me to` and `should i` literally, so my quote tripped it.')));
check('still blocks a real asking-permission closer that is NOT in backticks',
  isBlocked(transcript('do it', 'Looks good — want me to wire it up?')));

// NEW (2026-06-26): STRUCTURAL solicits-input check — "stop playing whack-a-mole with my language; just
// works." The point is NOVEL phrasings the old phrase-museum never listed must now block, purely because
// the turn ENDS by soliciting input (trailing "?" or a no-"?" hand-off closer). No new pattern per variant.
check('blocks Russell’s literal example "Want me to fix that next?"',
  isBlocked(transcript('fix the bug', 'Shipped and green. Want me to fix that next?', { withEdit: true })));
check('blocks a NOVEL "?" closer the old list never had: "Cool — wire it in?"',
  isBlocked(transcript('add the tool', 'Tool added and tested. Cool — wire it in?')));
check('blocks a bare "Proceed?"',
  isBlocked(transcript('do it', 'Plan looks right. Proceed?')));
check('blocks "Good to merge?"',
  isBlocked(transcript('review it', 'All green on the branch. Good to merge?')));
check('blocks a no-"?" hand-off closer the old list never had: "Ball’s in your court."',
  isBlocked(transcript('keep going', 'Relay fix shipped and verified. Ball’s in your court.')));
check('blocks "Up to you." closer',
  isBlocked(transcript('keep going', 'Both approaches work. Up to you.')));

// CONTROLS — must NOT block (the structural check has to be precise, not just aggressive).
check('does NOT block a declarative close (no "?" / no closer)',
  !isBlocked(transcript('do it', 'Shipped and green — both suites pass.')));
check('does NOT block a blocker STATED as a sentence (not asked)',
  !isBlocked(transcript('clean up', 'I won’t run the destructive migration without your explicit go-ahead — it drops the prod table.')));
check('does NOT block a mid-message "?" when the turn ends on a statement',
  !isBlocked(transcript('was it cached?', 'Was it cached? Yes — I cached it and the suite is green.')));
check('honors the override even when the turn ends with a "?"',
  !isBlocked(transcript('do it', 'Plan looks right. Proceed? ross-perot-override: needs your prod creds first.')));
check('does NOT block a trailing "?" in survey/think mode',
  !isBlocked(transcript('what do you think — just brainstorm', 'Two angles here. Which feels closer to your intent?')));
check('still passes a clean enumerated summary that ends on a statement',
  !isBlocked(transcript('what changed?', '- Added the tool\n- Wrote tests\n- Rebuilt the bundle\nAll shipped and green.')));

// NEW (2026-07-04): EITHER/OR false positive — outcome NARRATION is not a choice-offer. The old matcher
// /\beither\s+\S+.{0,40}\s+or\s+\S+/i blocked "the clone run will either catch it red-handed or eliminate
// it." — a description of an experiment's two possible RESULTS; nobody was handed a pick. Now either..or
// only counts as an alternatives-offer when a CHOICE FRAME is present: a you/we choice verb ("you could
// either", "we can either"), an imperative pick/choose, an explicit choice noun ("either option/way/…"),
// or the either..or sitting inside a question.
check('allows outcome narration: "the clone run will either catch it red-handed or eliminate it."',
  !isBlocked(transcript('root-cause it', 'Launched. The clone run will either catch it red-handed or eliminate it.')));
check('allows either/or narration of a diagnostic fork',
  !isBlocked(transcript('debug it', 'The probe will either reproduce the crash or rule out the cache.')));
check('still blocks choice-framed either/or: "we could either do A or B - which do you prefer?"',
  isBlocked(transcript('which approach?', 'We could either do A or B - which do you prefer?')));
check('still blocks a you/we-framed either/or even without a question mark',
  isBlocked(transcript('which approach?', 'You could either patch the parser or rewrite the tokenizer here.')));
check('still blocks "either option works, your call"',
  isBlocked(transcript('which approach?', 'Either option works, your call.')));
check('still blocks imperative "pick either A or B"',
  isBlocked(transcript('which approach?', 'Pick either the parser fix or the tokenizer rewrite.')));
// Addenda regressions: the guard's real catches must survive the narrowing.
check('still blocks "say the word" closer (either/or-fix regression)',
  isBlocked(transcript('keep going', 'Done and verified. Say the word.')));
check('still blocks "your call" closer (either/or-fix regression)',
  isBlocked(transcript('keep going', 'Both fixes are staged. Your call.')));
check('still blocks "want me to A or B?" (either/or-fix regression)',
  isBlocked(transcript('keep going', 'Want me to refactor the parser or patch the call site?')));

// ══ 2026-07-12 — WIND-DOWN + AFK hardening (the overnight failure: "standing by" / "needs your eyes" /
// "nothing left" ended an AFK run while the board had work; Russell: "make it as broad as possible"). ══

// Wind-down closers block while the queue has open work (Russell present, no stop signal).
check('wind-down: "standing by" blocked while queue open',
  isBlockedInProject(transcript('thanks', 'All committed and green. Standing by.'),
    projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));
check('wind-down: "the rest needs your eyes" blocked while queue open',
  isBlockedInProject(transcript('thanks', 'Summary above — the rest needs your eyes.'),
    projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));
check('wind-down: "nothing else mid-flight" blocked while queue open',
  isBlockedInProject(transcript('thanks', 'Everything is committed. Nothing else mid-flight.'),
    projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));

// AFK grant: wind-down blocked even with NO handoff file at all (the grant alone arms the guard).
check('afk: "sleep well" sign-off blocked under a going-to-bed grant (no HANDOFF needed)',
  isBlocked(transcript('yes do that and then work on other stuff. going to bed',
    'It is all committed and green. Sleep well.')));
// AFK voids the question-mark release: a pre-bed question is not engagement.
check('afk: pre-bed question does NOT release the queue gate',
  isBlockedInProject(transcript('going to bed — anything else you need?', 'All done, summary above.'),
    projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));
// Without a grant, Russell's question still releases the queue gate (conversation must breathe).
check('no-afk: a plain question + clean answer still passes',
  !isBlockedInProject(transcript('what did you get done overnight?', 'Here is the summary: exp134 landed, gate green.'),
    projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));

// Override rules: allowed when Russell is present (on a question-released turn — with an unreleased
// open queue the QUEUE gate blocks regardless, by its own no-self-override design); DEAD under AFK.
check('wind-down: override token works when Russell is present (question-released turn)',
  !isBlockedInProject(transcript('did the branch land?', 'Yes, landed and green. Standing by. ross-perot-override: Russell told me to hold this branch for review.'),
    projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));
check('afk: override token is DEAD under a grant',
  isBlocked(transcript('keep working, going to bed',
    'Standing by. ross-perot-override: everything is genuinely blocked.')));

// Echo exemption: Russell HIMSELF deferring an item is not the assistant dodging.
check('echo: confirming Russell\'s own "pick this up next session" passes',
  !isBlockedInProject(transcript('let\'s pick this up next session, ok?', 'Flagged — we will pick it up next session.'),
    projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));

// Broadened queue markers: the reworded-handoff dodge ("OPEN ITEMS (need YOU)") still arms the gate,
// and the question-release leak is covered by wind-down firing anyway.
check('markers: "TOP OPEN ITEMS (need YOU)" arms the gate; wind-down fires past a "?" release',
  isBlockedInProject(transcript('status?', 'All quiet. Holding here for now.'),
    projectWithHandoff('# HANDOFF\n\n**TOP OPEN ITEMS (need YOU):** review the explainer.\n')));
// Struck-through / ✅-DONE leftovers do NOT arm the gate (sanctioned release = pruning finished work).
check('markers: struck-through OWED and ✅ lines do not arm the gate',
  !isBlockedInProject(transcript('thanks', 'All wrapped and verified.'),
    projectWithHandoff('# HANDOFF\n\n~~OWED: old thing~~\n✅ DONE (was OWED): shipped it\n')));

// Release tightening: bare "call it …" and "update the handoff" are NOT stop signals any more.
check('release: "call it what you want" is not a stop signal',
  isBlockedInProject(transcript('call it what you want, that name is fine.', 'Holding here for now.'),
    projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));
check('release: "update the handoff and continue" is not a stop signal',
  isBlockedInProject(transcript('update the handoff and continue', 'Holding here for now.'),
    projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));
check('release: "write a handoff and pause" IS a stop signal — wind-down allowed',
  !isBlockedInProject(transcript('write a handoff and pause', 'Handoff written. Standing by.'),
    projectWithHandoff(HANDOFF_WITH_OPEN_QUEUE)));

// A short side request must not erase the active project task. The real Lej
// handoff used a plain "## Next - exp148 only" heading, which carried active
// work without any of the old queue-marker words.
check('interrupted-task return: plain Next heading keeps the active queue armed',
  isBlockedInProject(
    transcript(
      'add a global Git Bash rule',
      'Added globally: every shell command now uses Git Bash.',
      { withEdit: true },
    ),
    projectWithHandoff([
      '# Handoff',
      '',
      '## Next - exp148 only',
      '',
      'Build the fresh two-hop ruler and record the result.',
    ].join('\n')),
  ));

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll ross-perot-guard checks passed.');
