#!/usr/bin/env node
// look-before-asking.test.mjs — locks the "look before asking" Stop guard.
//
// The rule: search before you ask. When the assistant ASKS the user for a DISCOVERABLE fact (where a
// file/key/value lives, "paste your path/key/env var", "is X in <file>", "do you have", "where is",
// "what's the path") but in the SAME TURN ran ZERO searches/reads (no Read/Grep/Glob/Bash-search tool
// calls that could have answered it), the Stop is BLOCKED — search the filesystem first, only ask if
// you genuinely can't find it.
//
// Conservative: a genuine DESIGN-FORK question ("should we use X or Y approach") is NOT a locate-a-fact
// ask and must pass. Override phrase "asked-after-looking" suppresses the block.
//
// Run: node look-before-asking.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'look-before-asking.mjs');
let seq = 0;

function run(payload) {
  const proc = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  return (proc.stdout || '') + (proc.stderr || '');
}

// Build a single-turn transcript: a user prompt, then ONE assistant turn whose tool_use blocks are the
// listed search/read tools (each {name,input}) plus the final reply text. `searchTools` is a list of
// { name, input } objects so we can mix Read / Grep / Glob / Bash.
function transcript({ searchTools = [], reply = 'done', userText = 'set up the gemini integration' }) {
  const blocks = searchTools.map((tool) => ({ type: 'tool_use', name: tool.name, input: tool.input || {} }));
  blocks.push({ type: 'text', text: reply });
  const lines = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText }] } },
    { type: 'assistant', message: { role: 'assistant', content: blocks } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  const path = join(tmpdir(), `lba-tx-${process.pid}-${seq++}.jsonl`);
  writeFileSync(path, lines);
  return path;
}

const stopOn = (opts) => run({ hook_event_name: 'Stop', transcript_path: transcript(opts) });
const isBlocked = (out) => /"decision"\s*:\s*"block"/.test(out);

const failures = [];
const check = (label, ok) => { if (ok) console.log(`  ok  ${label}`); else { console.log(`FAIL  ${label}`); failures.push(label); } };

// (a) Asks where the gemini key is / is it in .env, with ZERO reads this turn → BLOCKED.
check(
  'asks "where is the gemini key / is it in .env" with 0 reads → blocked',
  isBlocked(stopOn({ searchTools: [], reply: "Where is your Gemini API key? Is it in .env?" })),
);
// Differently-worded positives — the regex must catch a class, not one phrase.
check(
  'asks "can you paste the path to your config" with 0 reads → blocked',
  isBlocked(stopOn({ searchTools: [], reply: "Can you paste the path to your config file so I can wire it up?" })),
);
check(
  'asks "do you have an OPENROUTER_API_KEY env var" with 0 reads → blocked',
  isBlocked(stopOn({ searchTools: [], reply: "Do you have an OPENROUTER_API_KEY env var set anywhere?" })),
);

// (b) SAME ask but the turn DID look (a Read / a Grep) → ALLOWED.
check(
  'same ask but with a Read this turn → allowed',
  !isBlocked(stopOn({ searchTools: [{ name: 'Read', input: { file_path: 'C:/proj/.env' } }], reply: "Where is your Gemini API key? Is it in .env? I checked .env and didn't find it." })),
);
check(
  'same ask but with a Grep this turn → allowed',
  !isBlocked(stopOn({ searchTools: [{ name: 'Grep', input: { pattern: 'GEMINI' } }], reply: "Where is your Gemini API key? I grepped for it and came up empty." })),
);
check(
  'same ask but with a Bash search (grep/find) this turn → allowed',
  !isBlocked(stopOn({ searchTools: [{ name: 'Bash', input: { command: "grep -ri 'GEMINI' /c/proj" } }], reply: "Where is your Gemini API key? I searched the repo and found nothing." })),
);

// (c) A genuine DESIGN-FORK question ("build X or Y?") → ALLOWED (not a locate-a-fact ask).
check(
  'design-fork question (build X or Y?) → allowed',
  !isBlocked(stopOn({ searchTools: [], reply: "Should we build this as a Stop hook or a PreToolUse hook? I'd go with Stop." })),
);
check(
  'design-fork "which approach do you prefer" → allowed',
  !isBlocked(stopOn({ searchTools: [], reply: "Two approaches here. Do you want the regex-based one or the AST one?" })),
);

// (d) Non-Stop event → ALLOWED (hook only handles Stop).
check(
  'non-Stop event → allowed',
  !isBlocked(run({ hook_event_name: 'PreToolUse', transcript_path: transcript({ searchTools: [], reply: "Where is your Gemini API key?" }) })),
);

// (e) stop_hook_active → ALLOWED (no infinite stop loop).
check(
  'stop_hook_active → allowed (no loop)',
  !isBlocked(run({ hook_event_name: 'Stop', stop_hook_active: true, transcript_path: transcript({ searchTools: [], reply: "Where is your Gemini API key?" }) })),
);

// Override phrase suppresses even a 0-look locate-a-fact ask.
check(
  '"asked-after-looking" override suppresses the block',
  !isBlocked(stopOn({ searchTools: [], reply: "Where is your Gemini API key? asked-after-looking — it's behind a hardware MFA I can't read." })),
);

// A normal completion reply that asks NOTHING → allowed (no false positive on ordinary work).
check(
  'plain "done" reply with no ask → allowed',
  !isBlocked(stopOn({ searchTools: [], reply: "Done — wired up the integration and tests pass." })),
);

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll look-before-asking checks passed.');
