#!/usr/bin/env node
/**
 * hook-negative-case-required — Stop META-GUARD: a guard hook that can DENY/BLOCK must ship with a
 * test that proves it does NOT over-fire. Blocks stop when a hook with teeth was created/edited this
 * SESSION but its companion `*.test.mjs` has no NEGATIVE (must-allow / must-not-fire) cases.
 *
 * Why (Russell, 2026-07-01, after five guards false-fired in one session): every one of them shipped a
 * test with only POSITIVE cases — proof it FIRES, never proof it doesn't OVER-fire. A guard whose test
 * only asserts "this input is blocked" is blind to the legitimate inputs it wrongly blocks. The five
 * bugs (long-running-script-guard matching "train" inside "pretrained"; python-escape-guard scanning a
 * Windows path arg; no-push matching "git push" inside a commit message; no-backcompat matching its own
 * name in a doc; filename-guard flagging real words "train"/"modal" as typos) would ALL have surfaced if
 * a negative case were required. So: creating a guard commits you to testing what it must ALLOW.
 *
 * Detection window is the whole SESSION (a hook edited in turn N is tested in turn N+1). Scope is only
 * the guard hooks YOU changed this session. A pure context-injector (no deny/block/exit-2) can't
 * false-positive-block, so it's exempt. Override: `hook-negative-case-waived: <why>` in the reply.
 * Fail-open on any error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readTranscript, toolUsesOf, lastAssistantTextOf } from './lib/transcript.mjs';

const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const HOOK_SOURCE = /[\\/]hooks[\\/][^\\/]+\.mjs$/i;

// A hook "has teeth" (can produce a false-POSITIVE block) if it can deny/block/exit-2.
const HAS_TEETH = /permissionDecision|["']?decision["']?\s*:\s*["']block|process\.exit\(\s*2\s*\)/;

// A test proves it does NOT over-fire if it asserts an ALLOW / must-not-fire outcome, not just denials.
const NEGATIVE_CASE = new RegExp(
  [
    '!\\s*is(Denied|Blocked|Fired)',            // !isDenied(...) / !isBlocked(...)
    '\\ballow(s|ed)?\\b',                        // "allows a plain run"
    "does\\s?n['’]?t\\s+(fire|block|deny|match)",
    "should\\s?n['’]?t\\s+(fire|block|deny|match)",
    '\\bnot\\s+(denied|blocked|fired|flagged)\\b',
    'false[\\s-]?positive',
    'no-?op\\b',
    'stays\\s+quiet',
    'passes?\\s+(untouched|when|clean)',
    "stdout\\s*,\\s*['\"]{2}",                  // assert.equal(hookRun.stdout, '')
  ].join('|'),
  'i',
);

const OVERRIDE = /hook-negative-case-waived:/i;

/** Guard-hook source basenames created/edited across this session (deduped, tests excluded). */
export function changedGuardHooks(entries) {
  const changedPaths = new Set();
  for (const entry of entries) {
    for (const toolUse of toolUsesOf(entry)) {
      if (!MUTATING_TOOLS.has(toolUse.name)) continue;
      const filePath = toolUse.input?.file_path || '';
      if (HOOK_SOURCE.test(filePath) && !/\.test\.mjs$/i.test(filePath)) changedPaths.add(filePath);
    }
  }
  return [...changedPaths];
}

/** Which changed guard hooks lack a negative-case test. Injected fs makes it unit-testable. */
export function untestedForFalsePositives(hookPaths, fileExists, readFile) {
  const offenders = [];
  for (const hookPath of hookPaths) {
    let hookSource = '';
    try { hookSource = readFile(hookPath); } catch { continue; }
    if (!HAS_TEETH.test(hookSource)) continue;                 // a pure injector can't false-positive-block
    const testPath = hookPath.replace(/\.mjs$/i, '.test.mjs');
    let testSource = '';
    if (fileExists(testPath)) { try { testSource = readFile(testPath); } catch { testSource = ''; } }
    if (!NEGATIVE_CASE.test(testSource)) {
      offenders.push({ hook: hookPath.split(/[\\/]/).pop(), hasTest: Boolean(testSource) });
    }
  }
  return offenders;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'Stop') process.exit(0);
  if (event.stop_hook_active) process.exit(0);

  const transcriptPath = event.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

  const reply = lastAssistantTextOf(transcriptPath) || '';
  if (OVERRIDE.test(reply)) process.exit(0);

  const entries = readTranscript(transcriptPath);
  const guardHooks = changedGuardHooks(entries);
  if (guardHooks.length === 0) process.exit(0);

  const offenders = untestedForFalsePositives(guardHooks, existsSync, (path) => readFileSync(path, 'utf8'));
  if (offenders.length === 0) process.exit(0);

  const offenderLines = offenders
    .map((offender) => `  - ${offender.hook}${offender.hasTest ? ' (its test has only positive/deny cases)' : ' (no test file at all)'}`)
    .join('\n');

  const reason = `STOP — a guard hook you changed this session has no NEGATIVE (must-allow) test cases.

${offenderLines}

Russell's rule (2026-07-01): a hook that can DENY must prove it does NOT over-fire. A test with only
"this input is blocked" cases is blind to the legitimate inputs it wrongly blocks — that's exactly how
five guards false-fired in one session. Before stopping, add at least one case per hook that asserts an
ALLOW / must-not-fire outcome on a legitimate input (e.g. \`assert.equal(hookRun.stdout, '')\`, \`!isDenied(...)\`,
"allows ...", "does not fire on ..."). Cover the specific legitimate input the guard might wrongly match.

Override (rare — genuinely N/A): put \`hook-negative-case-waived: <why>\` in your reply.`;

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) main();
