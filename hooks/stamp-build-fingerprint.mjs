#!/usr/bin/env node
/**
 * stamp-build-fingerprint — GLOBAL, PostToolUse(Bash). When a build command runs successfully, record
 * a CONTENT fingerprint of the source it was built from (the "baseline") for every buildable project
 * touched. That baseline is what the freshness hooks compare against — so "is dist stale?" is answered
 * by source-hash equality, never by timestamps (which a git merge/checkout scrambles).
 *
 * Success gate: a failed build leaves dist old but source unchanged, so stamping it would falsely read
 * "fresh". We stamp only when the output shows a success marker (or at least no failure marker) — when
 * unsure we DON'T stamp, leaving the project 'unknown' (the freshness check then falls back to mtime,
 * which is safe). Never blocks. Fail-open.
 */

import { readFileSync } from 'node:fs';
import { isBuildCommand, buildProjectsUnder, sourceFingerprint, recordBaseline, distExists } from './lib/buildFingerprint.mjs';

const SUCCESS_MARKER = /built in|✓ built|build complete|compiled successfully|done in|gzip:|bundle(s)? generated|created .* in \d|transformed/i;
const FAILURE_MARKER = /\b(npm|pnpm|yarn) ERR!|error during build|build failed|ERR_|command not found|is not recognized|exit code [1-9]|Error:\s|SyntaxError|Cannot find module/i;

function outputText(hookEvent) {
  const buildToolResponse = hookEvent.tool_response ?? hookEvent.toolResponse ?? '';
  if (typeof buildToolResponse === 'string') return buildToolResponse;
  return [buildToolResponse?.stdout, buildToolResponse?.stderr, buildToolResponse?.output, buildToolResponse?.content]
    .filter((part) => typeof part === 'string').join('\n');
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((hookEvent.tool_name || hookEvent.toolName) !== 'Bash') process.exit(0);

  const command = hookEvent.tool_input?.command || hookEvent.toolInput?.command || '';
  if (!isBuildCommand(command)) process.exit(0);

  const buildOutput = outputText(hookEvent);
  if (FAILURE_MARKER.test(buildOutput)) process.exit(0);          // obvious failure → don't stamp
  if (!SUCCESS_MARKER.test(buildOutput) && buildOutput.length > 0) process.exit(0); // can't confirm success → safe: stay 'unknown'

  const root = hookEvent.cwd || process.cwd();
  const nowIso = (hookEvent.timestamp || hookEvent.time || '');
  let stampedAny = false;
  for (const projectDirectory of buildProjectsUnder(root)) {
    if (!distExists(projectDirectory)) continue; // a build that produced no dist isn't a bundle build
    if (recordBaseline(projectDirectory, sourceFingerprint(projectDirectory), nowIso)) stampedAny = true;
  }
  if (stampedAny) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Recorded a content fingerprint of the just-built source (dist freshness is now tracked by hash, not mtime).' },
    }));
  }
  process.exit(0);
}

main();
