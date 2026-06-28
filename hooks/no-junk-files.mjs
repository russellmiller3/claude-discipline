#!/usr/bin/env node
// Stop hook — block stopping while throwaway/scratch files are sitting in the project.
//
// Russell, 2026-06-14: "the filebrain folder is full of junk." Past sessions left 40+
// `tmp-claude-*.png` screenshots, `tmp-*.mjs` probes, `scan-*.mjs` one-offs, and `.git/COMMIT_*.txt`
// scratch scattered in the repo. This hook fires at Stop, lists the junk, and blocks until each file
// is either DELETED (the default for scratch) or kept deliberately — so junk never accumulates again.
//
// The fix is also behavioral: write scratch to the OS temp dir, not the repo. If a throwaway file
// MUST live in the repo for a moment, prefix it `tmp-` and delete it before stopping.
//
// Override (rare — you truly mean to keep a tmp-named file): put "keep-junk: <reason>" in the reply.
// Fail-open on any error — never brick Stop.

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Junk filename patterns (matched against the basename). Scratch by convention, never shipped.
const JUNK_PATTERNS = [
  /^tmp-/i,            // tmp-claude-*.png, tmp-*.mjs — the throwaway prefix
  /^scan-/i,           // scan-zero-assert.mjs and friends
  /^nbt-/i,            // ad-hoc test harnesses
  /^scratch/i,
  /-scratch\./i,
  /\.tmp$/i,
  /^probe[-.]/i,
];
// In .git/, these are scratch I drop while committing (message files, one-off scripts).
const GIT_JUNK_PATTERNS = [/^COMMIT_.*\.txt$/i, /\.(mjs|cjs)$/i];

import { lastAssistantTextOf } from './lib/transcript.mjs';

function junkInDir(dir, patterns) {
  if (!existsSync(dir)) return [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isFile() && patterns.some((re) => re.test(entry.name)))
    .map((entry) => entry.name);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { payload = {}; }
  const cwd = payload.cwd || process.cwd();

  // Honor an explicit keep override.
  if (/keep-junk:/i.test(lastAssistantTextOf(payload.transcript_path))) { process.exit(0); return; }

  const rootJunk = junkInDir(cwd, JUNK_PATTERNS);
  const gitJunk = junkInDir(join(cwd, '.git'), GIT_JUNK_PATTERNS).map((name) => `.git/${name}`);
  const junk = [...rootJunk, ...gitJunk];
  if (junk.length === 0) { process.exit(0); return; }

  const shown = junk.slice(0, 25);
  const more = junk.length > shown.length ? `\n  …and ${junk.length - shown.length} more` : '';
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `STOP-BLOCKED — throwaway/scratch files left in the project (Russell: "full of junk").

Found ${junk.length} scratch file(s) in ${cwd}:
  ${shown.join('\n  ')}${more}

Decide save-or-delete before stopping:
  • DELETE the throwaway ones (default): rm them. Screenshots/probes/one-off scripts are scratch.
  • KEEP one deliberately? Move it out of "tmp-*"/"scan-*" naming and git-add it, OR reply with "keep-junk: <reason>".

Going forward: write scratch to the OS temp dir ($TEMP / os.tmpdir()), not the repo. If a temp file must
live here briefly, prefix it "tmp-" and delete it in the same turn.`,
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
