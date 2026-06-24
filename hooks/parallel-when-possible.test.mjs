#!/usr/bin/env node
// parallel-when-possible.test.mjs — locks the "Work In Parallel By Default" guard, BOTH modes:
//   • Mode A (queue/plan-driven): exactly 1 background agent alive while parallel-safe phases wait.
//     (Depends on external queue/plan state, so it's exercised lightly — only that an empty turn doesn't block.)
//   • Mode B (the strengthening): a single turn that GRINDS through independent work in the MAIN thread —
//     many edits across many files with ZERO subagents spawned. The failure this guards: a fully-serial
//     0-agent turn that an agent-only check would let slip through.
//
// Run: node parallel-when-possible.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'parallel-when-possible.mjs');
let seq = 0;

function run(payload) {
  const proc = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  return (proc.stdout || '') + (proc.stderr || '');
}

// Build a JSONL transcript: a user prompt, then one assistant turn whose tool_use blocks edit `editFiles`
// (one Edit per entry), read `readFiles` (one Read per entry), search `searchPatterns` (one Grep per entry),
// and optionally spawn `agents` subagents, plus the final reply text.
function transcript({ editFiles = [], readFiles = [], searchPatterns = [], agents = 0, reply = 'done' }) {
  const blocks = editFiles.map((file) => ({ type: 'tool_use', name: 'Edit', input: { file_path: file } }));
  for (const file of readFiles) blocks.push({ type: 'tool_use', name: 'Read', input: { file_path: file } });
  for (const pattern of searchPatterns) blocks.push({ type: 'tool_use', name: 'Grep', input: { pattern } });
  for (let i = 0; i < agents; i++) blocks.push({ type: 'tool_use', name: 'Agent', input: { description: `worker ${i}` } });
  blocks.push({ type: 'text', text: reply });
  const lines = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do all the roadmap items' }] } },
    { type: 'assistant', message: { role: 'assistant', content: blocks } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  const path = join(tmpdir(), `pwp-tx-${process.pid}-${seq++}.jsonl`);
  writeFileSync(path, lines);
  return path;
}

// Build a MULTI-TURN transcript: an EARLIER turn (with its own user prompt + assistant reply text) followed
// by a CURRENT turn (fresh user prompt + assistant tool_use blocks). Used to prove suppression is scoped to
// the current turn, not the whole session.
function multiTurnTranscript({ earlierReply = 'done', current = {} }) {
  const { editFiles = [], readFiles = [], searchPatterns = [], agents = 0, reply = 'done' } = current;
  const curBlocks = editFiles.map((file) => ({ type: 'tool_use', name: 'Edit', input: { file_path: file } }));
  for (const file of readFiles) curBlocks.push({ type: 'tool_use', name: 'Read', input: { file_path: file } });
  for (const pattern of searchPatterns) curBlocks.push({ type: 'tool_use', name: 'Grep', input: { pattern } });
  for (let i = 0; i < agents; i++) curBlocks.push({ type: 'tool_use', name: 'Agent', input: { description: `worker ${i}` } });
  curBlocks.push({ type: 'text', text: reply });
  const lines = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'earlier ask' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: earlierReply }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'now do all the roadmap items' }] } },
    { type: 'assistant', message: { role: 'assistant', content: curBlocks } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  const path = join(tmpdir(), `pwp-tx-${process.pid}-${seq++}.jsonl`);
  writeFileSync(path, lines);
  return path;
}
const stopOn = (opts) => run({ hook_event_name: 'Stop', transcript_path: transcript(opts) });
const isBlocked = (hookOutput) => /"decision"\s*:\s*"block"/.test(hookOutput);

// A turn touching many files (one each) so distinct-file + edit-count both clear the bar.
const manyFiles = Array.from({ length: 8 }, (_, i) => `C:/proj/lib/module${i}.js`);
const manyEdits = (perFile) => manyFiles.flatMap((file) => Array.from({ length: perFile }, () => file));

// A read/explore grind: 14 reads across 8 distinct files (clears both read + distinct-target bars for Mode C).
const manyReadFiles = Array.from({ length: 8 }, (_, i) => `C:/proj/src/file${i}.js`);
const manyReads = manyReadFiles.flatMap((file, i) => (i < 6 ? [file, file] : [file])); // 6*2 + 2 = 14 reads, 8 distinct

const failures = [];
const check = (label, ok) => { if (ok) console.log(`  ok  ${label}`); else { console.log(`FAIL  ${label}`); failures.push(label); } };

// PROACTIVE (the primary): SessionStart injects the assess-parallelizability prompt (not a block — context).
{
  const sessionStartOutput = run({ hook_event_name: 'SessionStart', source: 'startup' });
  check('SessionStart injects the parallel-first prompt', /parallel/i.test(sessionStartOutput) && /subagent/i.test(sessionStartOutput) && /Agent tool/i.test(sessionStartOutput));
  check('SessionStart never blocks (it is advisory context)', !isBlocked(sessionStartOutput));
}

// Mode B fires: 8 files, ~24 edits, 0 agents → serial grind, blocked.
check('serial grind across many files with 0 subagents → blocked', isBlocked(stopOn({ editFiles: manyEdits(3) })));

// Delegated: the same volume but with subagents spawned → NOT blocked.
check('same volume WITH subagents spawned → allowed', !isBlocked(stopOn({ editFiles: manyEdits(3), agents: 2 })));

// Under threshold: a small, coupled turn (few files) → NOT blocked (no false positive on normal work).
check('small turn (2 files) → allowed', !isBlocked(stopOn({ editFiles: ['C:/proj/a.js', 'C:/proj/a.js', 'C:/proj/b.js'] })));

// Suppression: an explicit "serial only" in the reply quiets the hook even over threshold.
check('"serial only" suppresses the block', !isBlocked(stopOn({ editFiles: manyEdits(3), reply: 'serial only — these files are coupled' })));

// --- Bug-fix 1: suppression must be scoped to the CURRENT TURN, not the whole session. ---
// (a) A stale "serial only" in an EARLIER turn must NOT suppress a current-turn grind.
check('stale "serial only" in a PRIOR turn does NOT suppress a current-turn grind',
  isBlocked(run({ hook_event_name: 'Stop', transcript_path: multiTurnTranscript({ earlierReply: 'serial only — that old task was coupled', current: { editFiles: manyEdits(3) } }) })));
// (d) "serial only" in the CURRENT turn still suppresses.
check('"serial only" in the CURRENT turn still suppresses',
  !isBlocked(run({ hook_event_name: 'Stop', transcript_path: multiTurnTranscript({ earlierReply: 'done', current: { editFiles: manyEdits(3), reply: 'serial only — coupled' } }) })));

// --- Bug-fix 2: Mode C — catch a READ/EXPLORE grind (many reads/searches across many targets, 0 subagents). ---
// (b) A read-heavy current turn (14 reads across 8 files, 0 agents) must block.
check('read/explore grind (14 reads across 8 files, 0 subagents) → blocked',
  isBlocked(stopOn({ readFiles: manyReads })));
// (c) A small read turn must NOT block (no false positive on normal work).
check('small read turn (4 reads across 4 files) → allowed',
  !isBlocked(stopOn({ readFiles: ['C:/proj/a.js', 'C:/proj/b.js', 'C:/proj/c.js', 'C:/proj/d.js'] })));
// Read grind WITH a subagent spawned → allowed (already delegated).
check('read grind WITH a subagent spawned → allowed',
  !isBlocked(stopOn({ readFiles: manyReads, agents: 1 })));
// "serial only" suppresses a read grind too.
check('"serial only" suppresses a read grind',
  !isBlocked(stopOn({ readFiles: manyReads, reply: 'serial only — sequential dependency' })));

// Re-entrancy: stop_hook_active must never re-block (no infinite stop loop).
check('stop_hook_active → allowed (no loop)', !isBlocked(run({ hook_event_name: 'Stop', stop_hook_active: true, transcript_path: transcript({ editFiles: manyEdits(3) }) })));

// Wrong event: only Stop is handled.
check('non-Stop event → allowed', !isBlocked(run({ hook_event_name: 'PreToolUse', transcript_path: transcript({ editFiles: manyEdits(3) }) })));

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll parallel-when-possible checks passed.');
