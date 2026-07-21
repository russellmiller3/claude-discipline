#!/usr/bin/env node
// getty-no-repeat-mistakes.test.mjs — locks the J. Paul Getty guard: "make any mistake once, never
// twice." The DIY-RLVR reward loop: when Russell CORRECTS me, force the learn-or-build-a-hook cycle
// before the turn can end. A REPEAT correction ("again", "you keep", "same mistake") escalates from
// "log a learning" to "you must build/strengthen a HOOK this turn" — a learning already failed once.
//
// Dual-event hook:
//   • UserPromptSubmit — detect a correction in Russell's message → drop a pending-marker + inject the
//     Getty checklist (grep learnings.md → repeat? → build a hook).
//   • Stop — if a marker is pending and this turn didn't satisfy it (added a learning, or for a repeat
//     built a hook), BLOCK. Override: `getty-override:`.
//
// Run: node getty-no-repeat-mistakes.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'getty-no-repeat-mistakes.mjs');

let seq = 0;
const nextMarker = () => join(tmpdir(), `getty-marker-${process.pid}-${seq++}.json`);

// Run the hook for either event. markerPath is injected via env so tests never touch real state.
function run(payload, markerPath) {
  const childEnv = { ...process.env, GETTY_MARKER_PATH: markerPath };
  const proc = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: childEnv });
  return (proc.stdout || '') + (proc.stderr || '');
}
const ups = (prompt, markerPath) => run({ hook_event_name: 'UserPromptSubmit', prompt }, markerPath);

// Build a transcript: a user msg + one assistant entry whose tool_use blocks "edit" the given paths,
// plus the final reply text. Lets a Stop test say "this turn edited learnings.md / a hook / nothing".
function transcript(replyText, editedPaths = []) {
  const blocks = editedPaths.map((p) => ({ type: 'tool_use', name: 'Edit', input: { file_path: p } }));
  blocks.push({ type: 'text', text: replyText });
  const lines = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'you keep doing that' }] } },
    { type: 'assistant', message: { role: 'assistant', content: blocks } },
  ].map((e) => JSON.stringify(e)).join('\n');
  const path = join(tmpdir(), `getty-tx-${process.pid}-${seq++}.jsonl`);
  writeFileSync(path, lines);
  return path;
}
function stopRun(replyText, editedPaths, markerPath) {
  const transcriptPath = transcript(replyText, editedPaths);
  return run({ hook_event_name: 'Stop', transcript_path: transcriptPath }, markerPath);
}
const isBlocked = (hookOutput) => /"decision"\s*:\s*"block"/.test(hookOutput);
// ts must be FRESH: with the 24h staleness TTL a ts of 1 is ancient and would be (rightly) discarded.
const writeMarker = (markerPath, repeat) => writeFileSync(markerPath, JSON.stringify({ repeat, correction: 'x', ts: Date.now() }));

const failures = [];
function check(label, condition) {
  if (condition) { console.log(`  ok  ${label}`); }
  else { console.log(`FAIL  ${label}`); failures.push(label); }
}

// --- UserPromptSubmit: correction detection (robust — many phrasings) ---
for (const correction of [
  'you should have checked that first',
  "why didn't you run the tests",
  'you forgot to update the docs',
  "that's not what I asked for",
]) {
  const marker = nextMarker();
  const hookOutput = ups(correction, marker);
  check(`detects correction: "${correction.slice(0, 28)}…"`, /getty/i.test(hookOutput) && existsSync(marker));
  if (existsSync(marker)) rmSync(marker);
}

// A REPEAT correction sets repeat=true in the marker.
{
  const marker = nextMarker();
  ups('you keep making the same mistake — again', marker);
  const repeatFlagged = existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).repeat === true;
  check('repeat correction flags repeat=true', repeatFlagged);
  if (existsSync(marker)) rmSync(marker);
}

// A normal request is NOT a correction — no marker, no injection.
{
  const marker = nextMarker();
  const hookOutput = ups('add a new feature to the parser', marker);
  check('normal request does not trigger Getty', !/getty/i.test(hookOutput) && !existsSync(marker));
}

// SYSTEM-INJECTED content (background-agent completion, harness reminder) lands in the user slot but is
// NOT Russell correcting me — even when it quotes correction-like wording. It must NOT arm the gate.
// (2026-06-19: a <task-notification> with an agent's design doc falsely armed Getty twice.)
for (const injected of [
  '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n<result>Done. You should have nested-body repair deferred; you skipped the loop case again on purpose.</result>\n</task-notification>',
  '<system-reminder>\nyou forgot to run the tests — this is a reminder, not Russell.\n</system-reminder>',
  'Summary: Agent "Design loop" came to rest. why didn\'t you build the hook',
  // 2026-07-01: the harness re-presenting THIS HOOK'S OWN prior denial text (which itself contains
  // "twice") back as the next prompt — a self-triggering loop, not Russell correcting anything.
  'Stop hook feedback:\nSTOP-BLOCKED — Getty rule: REPEAT mistake → ASK Russell before building a hook (J. Paul Getty: never make the same one twice).',
]) {
  const marker = nextMarker();
  const hookOutput = ups(injected, marker);
  check(`system-injected does NOT arm Getty: "${injected.slice(0, 22)}…"`, !/getty/i.test(hookOutput) && !existsSync(marker));
  if (existsSync(marker)) rmSync(marker);
}

// But a GENUINE Russell correction using the SAME words still fires (the skip is precise, not broad).
{
  const marker = nextMarker();
  const hookOutput = ups('you forgot to run the tests again', marker);
  check('real correction with same words still fires', /getty/i.test(hookOutput) && existsSync(marker));
  if (existsSync(marker)) rmSync(marker);
}

// --- Stop: enforcement ---
// No marker → never blocks.
check('no pending marker → allowed', !isBlocked(stopRun('all done', [], nextMarker())));

// First-time (repeat=false): a learning satisfies it.
{
  const marker = nextMarker(); writeMarker(marker, false);
  check('first-time + learning added → allowed', !isBlocked(stopRun('logged it', ['C:/Users/rmill/.claude/learnings.md'], marker)));
  check('first-time marker cleared after satisfy', !existsSync(marker));
}
// First-time: doing nothing → blocked.
{
  const marker = nextMarker(); writeMarker(marker, false);
  check('first-time + nothing done → blocked', isBlocked(stopRun('noted, moving on', [], marker)));
}
// Repeat (repeat=true): a learning ALONE is not enough — must build a hook.
{
  const marker = nextMarker(); writeMarker(marker, true);
  check('repeat + only a learning → blocked', isBlocked(stopRun('added a learning', ['C:/Users/rmill/.claude/learnings.md'], marker)));
}
// Repeat: building/strengthening a hook satisfies it.
{
  const marker = nextMarker(); writeMarker(marker, true);
  check('repeat + a hook built → allowed', !isBlocked(stopRun('built a hook', ['C:/Users/rmill/.claude/hooks/new-guard.mjs'], marker)));
}
// Override clears any pending marker.
{
  const marker = nextMarker(); writeMarker(marker, true);
  check('getty-override token → allowed', !isBlocked(stopRun('getty-override: this was a one-off typo, no rule needed', [], marker)));
}

// --- 2026-07-03 fix: AskUserQuestion asked + answered yes + dispatched satisfies a REPEAT, even
// though no hooks/*.mjs file was directly edited in this literal turn (a background Agent will do
// the edit later). Build a multi-entry transcript spanning several turns: the correction, the ask,
// Russell's yes, and the dispatch — mirroring how the real ceremony-loop bug played out.
function multiTurnTranscript(entries) {
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n');
  const path = join(tmpdir(), `getty-tx-multiturn-${process.pid}-${seq++}.jsonl`);
  writeFileSync(path, lines);
  return path;
}
const userText = (message) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: message }] } });
const assistantAsk = (question) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ header: 'Hook', question, options: [{ label: 'Yes' }, { label: 'No' }] }] } }] },
});
const userAnswer = (answerText) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: answerText }] } });
const assistantDispatch = (dispatchPrompt) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', input: { run_in_background: true, prompt: dispatchPrompt } }] },
});
const assistantSays = (replyText) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: replyText }] } });

{
  const marker = nextMarker(); writeMarker(marker, true);
  const transcriptPath = multiTurnTranscript([
    userText('you keep doing that — same mistake again'),
    assistantAsk('Should I build a hook for this?'),
    userAnswer('Yes'),
    assistantDispatch('Open ~/.claude/hooks/new-guard.mjs and build the fix, add a regression test.'),
  ]);
  const stopHookOutput = run({ hook_event_name: 'Stop', transcript_path: transcriptPath }, marker);
  check('repeat: AskUserQuestion asked + answered yes + dispatched → allowed (no direct file edit needed)', !isBlocked(stopHookOutput));
  check('repeat: ask+approve+dispatch marker cleared after satisfy', !existsSync(marker));
}

// Asked but NOT yet answered/dispatched — still pending, must keep blocking (no premature clear).
{
  const marker = nextMarker(); writeMarker(marker, true);
  const transcriptPath = multiTurnTranscript([
    userText('you keep doing that — same mistake again'),
    assistantAsk('Should I build a hook for this?'),
  ]);
  check('repeat: asked but not yet answered → still blocked', isBlocked(run({ hook_event_name: 'Stop', transcript_path: transcriptPath }, marker)));
}

// --- Persisted satisfaction across separate Stop invocations on the SAME growing transcript: once
// resolved, a LATER Stop (re-scanning from scratch, as the harness does every turn) must not re-block
// waiting for the ceremony to repeat. A NEW, distinct correction (fresh UserPromptSubmit) still arms
// its own fresh marker and fires independently.
{
  const marker = nextMarker();
  const armedAtEntryIndex = 0;
  writeFileSync(marker, JSON.stringify({ repeat: true, correction: 'you keep doing that', ts: Date.now(), armedAtEntryIndex }));
  const resolvedTranscriptPath = multiTurnTranscript([
    userText('you keep doing that — same mistake again'),
    assistantAsk('Should I build a hook for this?'),
    userAnswer('Yes'),
    assistantDispatch('Open ~/.claude/hooks/new-guard.mjs and build the fix.'),
    assistantSays('Dispatched. Moving on to the next task.'),
  ]);
  const firstStopOutput = run({ hook_event_name: 'Stop', transcript_path: resolvedTranscriptPath }, marker);
  check('persisted: first Stop after dispatch → allowed, marker cleared', !isBlocked(firstStopOutput) && !existsSync(marker));

  // A brand-new correction (unrelated) arms its OWN fresh marker and must fire independently — the
  // prior resolution must not blanket-suppress a genuinely new triggering event.
  const freshMarker = nextMarker();
  const freshCorrectionOutput = ups('you forgot to run the tests again', freshMarker);
  check('a NEW distinct repeat correction still arms + fires fresh', /getty/i.test(freshCorrectionOutput) && existsSync(freshMarker));
  const freshUnsatisfiedTranscriptPath = multiTurnTranscript([userText('you forgot to run the tests again'), assistantSays('noted, moving on')]);
  check('fresh marker still blocks with nothing done', isBlocked(run({ hook_event_name: 'Stop', transcript_path: freshUnsatisfiedTranscriptPath }, freshMarker)));
  if (existsSync(freshMarker)) rmSync(freshMarker);
}

// 2026-07-19 Fix A + B: a self-caught costly admission arms a GETTY-WORTHY marker (no Russell
// correction needed), and a Getty-worthy marker is cleared ONLY by a hook, never a learning.
{
  const marker = join(tmpdir(), `getty-selfcaught-${process.pid}-${seq++}.json`);
  if (existsSync(marker)) rmSync(marker);
  // (a) a self-caught admission in MY OWN reply arms the marker and blocks when no hook was built.
  const selfCaught = stopRun('I introduced a bug — my own mistake force-deleted a running pod, wasted a paid launch', [], marker);
  check('self-caught admission arms Getty + blocks with no hook built', isBlocked(selfCaught) && existsSync(marker));
  if (existsSync(marker)) rmSync(marker);
}
{
  // A pre-armed GETTY-WORTHY marker (self-caught), scanning from entry 0 so this turn's edit counts.
  const gettyWorthyMarker = () => {
    const marker = join(tmpdir(), `getty-worthy-${process.pid}-${seq++}.json`);
    writeFileSync(marker, JSON.stringify({ repeat: false, gettyWorthy: true, correction: 'my own bug killed a pod', ts: Date.now(), armedAtEntryIndex: 0 }));
    return marker;
  };
  // (b) a learnings.md edit alone does NOT clear a Getty-worthy marker.
  const learningOnly = gettyWorthyMarker();
  check('Getty-worthy marker NOT satisfied by a learnings.md edit alone', isBlocked(stopRun('added a learning', ['C:/Users/rmill/Desktop/programming/Macher/learnings.md'], learningOnly)));
  if (existsSync(learningOnly)) rmSync(learningOnly);
  // (b2) a CLAUDE.md edit also does NOT clear it (Fix B: advisory rules don't clear a Getty-worthy).
  const claudeMdOnly = gettyWorthyMarker();
  check('Getty-worthy marker NOT satisfied by a CLAUDE.md edit', isBlocked(stopRun('added a rule', ['C:/Users/rmill/.claude/CLAUDE.md'], claudeMdOnly)));
  if (existsSync(claudeMdOnly)) rmSync(claudeMdOnly);
  // (c) a hooks/*.mjs edit DOES clear it.
  const hookEdit = gettyWorthyMarker();
  check('Getty-worthy marker IS satisfied by a hooks/*.mjs edit', !isBlocked(stopRun('built the guard', ['C:/Users/rmill/.claude/hooks/new-guard.mjs'], hookEdit)) && !existsSync(hookEdit));
}
{
  // (d) a plain first-time (non-costly) correction still clears with a learning — no regression.
  const firstTime = join(tmpdir(), `getty-firsttime-${process.pid}-${seq++}.json`);
  writeFileSync(firstTime, JSON.stringify({ repeat: false, correction: 'you forgot to gloss a term', ts: Date.now(), armedAtEntryIndex: 0 }));
  check('first-time correction still clears with a learnings.md edit', !isBlocked(stopRun('captured the lesson', ['C:/Users/rmill/Desktop/programming/Macher/learnings.md'], firstTime)) && !existsSync(firstTime));
}
{
  // (e) fail-open on malformed input.
  const marker = join(tmpdir(), `getty-malformed-${process.pid}-${seq++}.json`);
  const proc = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, GETTY_MARKER_PATH: marker } });
  check('fail-open on malformed input', proc.status === 0 && (proc.stdout || '').trim() === '');
}

// --- 2026-07-21 fix: STALE cross-session/cross-project markers must never block. The live bug: a
// marker armed in a Macher session survived in the global state file, then a marcus session's Stop
// read it and blocked quoting Russell's Macher message. Markers are now stamped with the project
// root + session id at arm time and discarded on read when either mismatches, or after 24h.
// (`cwd`/`session_id` below are the harness's literal payload field names, not our naming.)
const MACHER_PROJECT_ROOT = 'C:/Users/rmill/Desktop/programming/Macher';
const MARCUS_PROJECT_ROOT = 'C:/Users/rmill/Desktop/programming/marcus';
function stopRunIn(replyText, editedPaths, markerPath, projectRoot, sessionId) {
  const transcriptPath = transcript(replyText, editedPaths);
  return run({ hook_event_name: 'Stop', transcript_path: transcriptPath, cwd: projectRoot, session_id: sessionId }, markerPath);
}
const staleMarker = (markerPath, fields) => writeFileSync(markerPath, JSON.stringify({ repeat: true, correction: 'Macher Phase 1.3 stuff', ts: Date.now(), armedAtEntryIndex: 0, ...fields }));

// (a) arm-side: UserPromptSubmit stamps the marker with the project root + session id.
{
  const marker = nextMarker();
  run({ hook_event_name: 'UserPromptSubmit', prompt: 'you keep doing that again', cwd: MACHER_PROJECT_ROOT, session_id: 'session-A' }, marker);
  const armedRecord = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : {};
  check('arm stamps marker with project root + sessionId', armedRecord.cwd === MACHER_PROJECT_ROOT && armedRecord.sessionId === 'session-A');
  if (existsSync(marker)) rmSync(marker);
}
// (b) the live bug: marker armed in Macher, Stop fires in marcus → allowed, marker discarded.
{
  const marker = nextMarker();
  staleMarker(marker, { cwd: MACHER_PROJECT_ROOT, sessionId: 'session-A' });
  const crossProjectOutput = stopRunIn('all done', [], marker, MARCUS_PROJECT_ROOT, 'session-B');
  check('cross-PROJECT stale marker → allowed + discarded', !isBlocked(crossProjectOutput) && !existsSync(marker));
}
// (c) same project, different session (e.g. a marker from yesterday's session) → allowed, discarded.
{
  const marker = nextMarker();
  staleMarker(marker, { cwd: MARCUS_PROJECT_ROOT, sessionId: 'session-A' });
  const crossSessionOutput = stopRunIn('all done', [], marker, MARCUS_PROJECT_ROOT, 'session-B');
  check('cross-SESSION stale marker (same project) → allowed + discarded', !isBlocked(crossSessionOutput) && !existsSync(marker));
}
// (d) TTL: a marker older than 24h ages out even with matching identity.
{
  const marker = nextMarker();
  staleMarker(marker, { cwd: MARCUS_PROJECT_ROOT, sessionId: 'session-A', ts: Date.now() - 25 * 60 * 60 * 1000 });
  const expiredOutput = stopRunIn('all done', [], marker, MARCUS_PROJECT_ROOT, 'session-A');
  check('marker older than 24h TTL → allowed + discarded', !isBlocked(expiredOutput) && !existsSync(marker));
}
// (e) legacy record (no identity fields — written by the pre-fix hook) while the harness DOES supply
// a session id: unattributable to this session → discarded, never enforced.
{
  const marker = nextMarker();
  writeFileSync(marker, JSON.stringify({ repeat: true, correction: 'x', ts: Date.now(), armedAtEntryIndex: 0 }));
  const legacyOutput = stopRunIn('all done', [], marker, MARCUS_PROJECT_ROOT, 'session-B');
  check('legacy identity-less marker + session-aware Stop → allowed + discarded', !isBlocked(legacyOutput) && !existsSync(marker));
}
// (f) TRUE POSITIVE preserved: matching project + session + fresh ts, nothing done → still blocks.
{
  const marker = nextMarker();
  staleMarker(marker, { cwd: MARCUS_PROJECT_ROOT, sessionId: 'session-A' });
  check('same-project same-session fresh marker still blocks', isBlocked(stopRunIn('noted, moving on', [], marker, MARCUS_PROJECT_ROOT, 'session-A')));
  if (existsSync(marker)) rmSync(marker);
}
// (g) path-separator robustness: the same project root written with backslashes still MATCHES.
{
  const marker = nextMarker();
  staleMarker(marker, { cwd: 'C:\\Users\\rmill\\Desktop\\programming\\marcus', sessionId: 'session-A' });
  check('backslash vs forward-slash project root still matches (blocks)', isBlocked(stopRunIn('noted, moving on', [], marker, MARCUS_PROJECT_ROOT, 'session-A')));
  if (existsSync(marker)) rmSync(marker);
}

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll getty-no-repeat-mistakes checks passed.');
