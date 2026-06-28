#!/usr/bin/env node
// hookbook-sync.test.mjs — proves the Stop hook demands a HOOKBOOK.md update whenever a HOOK changes,
// INCLUDING hooks registered in settings.json that live OUTSIDE ~/.claude/hooks/ (e.g.
// claude-voice/hooks/silent-mode.mjs). That out-of-dir case used to slip through silently — Russell
// hit it 2026-06-16 ("whenever I add or modify a hook you update hookbook").
//
// Run: node hookbook-sync.test.mjs   (exits non-zero on failure)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'hookbook-sync.mjs');

// Build a transcript JSONL whose single turn edits the given files, then run the Stop hook on it.
function runStopOnEdits(editedPaths) {
  const entries = [{ type: 'user', message: { role: 'user', content: 'change a hook' } }];
  entries.push({
    type: 'assistant',
    message: { role: 'assistant', content: editedPaths.map((file_path) => ({ type: 'tool_use', name: 'Edit', input: { file_path } })) },
  });
  const dir = mkdtempSync(join(tmpdir(), 'hookbook-test-'));
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join('\n'));
  const run = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
    encoding: 'utf8',
  });
  return (run.stdout || '') + (run.stderr || '');
}

const failures = [];
const check = (label, condition) => { console.log(`${condition ? '  ok' : 'FAIL'}  ${label}`); if (!condition) failures.push(label); };

// 1. A registered hook OUTSIDE ~/.claude/hooks/ (the gap) must trigger the requirement.
const voiceHook = 'C:/Users/rmill/Desktop/programming/claude-voice/hooks/silent-mode.mjs';
check('editing an out-of-dir REGISTERED hook demands a HOOKBOOK update',
  /HOOKBOOK UPDATE REQUIRED/.test(runStopOnEdits([voiceHook])));

// 2. The classic case: a hook IN ~/.claude/hooks/ still triggers.
check('editing a ~/.claude/hooks hook demands a HOOKBOOK update',
  /HOOKBOOK UPDATE REQUIRED/.test(runStopOnEdits([join(here, 'name-by-use.mjs')])));

// 3. If HOOKBOOK.md was edited in the SAME turn, no block.
check('editing the hook AND HOOKBOOK.md together → no block',
  !/HOOKBOOK UPDATE REQUIRED/.test(runStopOnEdits([voiceHook, join(here, 'HOOKBOOK.md')])));

// 4. Editing an unrelated non-hook file does NOT trigger.
check('editing a normal source file does NOT demand a HOOKBOOK update',
  !/HOOKBOOK UPDATE REQUIRED/.test(runStopOnEdits(['C:/Users/rmill/Desktop/programming/jarvis/extension/lib/recipes.js'])));

if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll hookbook-sync checks passed.');
