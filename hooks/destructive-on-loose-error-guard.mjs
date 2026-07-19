#!/usr/bin/env node
// =============================================================================
// DESTRUCTIVE-ON-LOOSE-ERROR-GUARD — PreToolUse(Write/Edit): never gate an
//   irreversible destroy on a LOOSE substring match of an error message.
// =============================================================================
//
// new-hook-category: Destructive-action correctness — nearest existing is no-core-delegation-guard (both about dangerous actions) but that guards WHO does the work (agents) at the Agent boundary; this guards a code PATTERN (a destroy gated on a fuzzy error test) at the Write/Edit boundary. Different trigger, different idea.
//
// The incident (2026-07-19, Getty): a "force-delete a CRASHED pod" branch fired on
// `if "exited" in str(error) or "still" in str(error): provider.delete_resource(...)`.
// The `"still"` ALSO matched the runner's OTHER error — "…is still ATTACHED — refusing to
// finalize a LIVE job" (job ALIVE, means WAIT) — so it force-deleted a RUNNING pod mid-run
// (pod gone, 0 result, wasted a paid launch). Russell: a Getty fix must be a STOP HOOK with
// teeth, not the advisory CLAUDE.md rule I wrote (which the model can ignore next time).
//
// RULE: BLOCK when new content adds, in proximity (same line or within ~6 lines / branch), BOTH
//   (1) a LOOSE substring-in-error condition (`if "x" in str(error)` / `in error` / `in exc.args`
//       / `error.message.includes("x")`), AND
//   (2) a destructive/irreversible verb (delete/terminate/teardown/kill/drop/force-delete/rm -rf/
//       Remove-Item -Recurse).
// A loose substring can match a benign/alive/"wait" error as well as the real failure, so the
// destroy fires on the wrong case. Enumerate EVERY error the function raises; act on the EXACT
// failure token; default to NOT destroying when the signal is ambiguous.
//
// Override: LOOSE_ERROR_DESTROY_OK: <why the substring is provably the sole failure token>.
// Teeth: permissionDecision 'deny'. Fail-open on any error.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_RE = /\bLOOSE_ERROR_DESTROY_OK\s*:/i;
// A loose substring test against an error/exception value — Python `"x" in str(error)` / `"x" in e.args`,
// or JS `error.message.includes("x")` / `.indexOf("x")` on an error-named value.
const LOOSE_ERROR_COND_RE = /["'][^"']+["']\s+in\s+(?:str\s*\(\s*)?\w*(?:error|err|exc|exception)\w*|(?:error|err|exc|exception)\w*(?:\.\w+)*\s*\.\s*(?:includes|indexOf)\s*\(\s*["']|["'][^"']+["']\s+in\s+e\b/i;
// A destructive / irreversible action.
const DESTRUCTIVE_VERB_RE = /\b(?:delete(?:_resource|_when_safe|_pod)?|terminate|teardown|kill|stop_process|destroy|drop|force[-_]?delete|remove_resource|remove_pod)\s*\(|\brm\s+-rf\b|\bRemove-Item\b[^\n]*-Recurse/i;

const CODE_EXT = /\.(py|mjs|cjs|js|ts|jsx|tsx|go|rs|rb|java|ps1|sh)$/i;
const PROXIMITY_LINES = 6;

// Pure detector: does the content gate a destructive action on a loose error-substring test?
export function flagsDestructiveOnLooseError(fileContent) {
  const contentText = String(fileContent || '');
  if (OVERRIDE_RE.test(contentText)) return false;
  const lines = contentText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!LOOSE_ERROR_COND_RE.test(lines[index])) continue;
    const window = lines.slice(index, index + PROXIMITY_LINES + 1).join('\n');
    if (DESTRUCTIVE_VERB_RE.test(window)) return true;
  }
  return false;
}

const DENY_REASON = `DESTRUCTIVE action gated on a LOOSE error-substring — this destroys on the WRONG case.

2026-07-19: \`"still" in str(error)\` force-deleted a LIVE pod because the runner's "…is still ATTACHED — refusing to finalize a LIVE job" (job ALIVE, means WAIT) also contains "still". Pod gone, 0 result, a paid launch wasted.

A loose substring matches a benign / alive / "wait" error as well as the real failure. Fix it:
  - Enumerate EVERY error string the function raises.
  - Branch on the EXACT failure token (or a structured status/exception TYPE), not a fuzzy \`in\`/\`includes\`.
  - Default to NOT destroying when the signal is ambiguous — a missed cleanup is recoverable; a wrong delete is not.

Override (only when the substring is provably the SOLE failure token): put
LOOSE_ERROR_DESTROY_OK: <why> in the file content.`;

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') process.exit(0);
  const toolName = event.tool_name || '';
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') process.exit(0);

  const filePath = event.tool_input?.file_path || event.tool_input?.path || '';
  if (filePath && !CODE_EXT.test(extname(filePath) ? filePath : '')) process.exit(0); // only gate code files
  // The added content: Write carries `content`; Edit carries `new_string`.
  const addedContent = event.tool_input?.content ?? event.tool_input?.new_string ?? '';

  let flagged;
  try { flagged = flagsDestructiveOnLooseError(addedContent); } catch { process.exit(0); } // fail-open
  if (!flagged) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON,
    },
  }));
  process.exit(0);
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
