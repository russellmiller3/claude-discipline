#!/usr/bin/env node
// =============================================================================
// DESTRUCTIVE-SAFE-BY-DEFAULT-GUARD — PreToolUse(Write/Edit): a script that CAN
//   destroy real resources must default OFF and require an explicit confirm.
// =============================================================================
//
// new-hook-category: Safe-by-default destructive design — nearest existing is destructive-on-loose-error-guard (both about destructive code) but that guards HOW a destroy is triggered (an exact error token, not a fuzzy substring); this guards WHETHER a destroy can run at all with no confirmation. Different invariant: safe-by-default + explicit opt-in.
//
// The incident (2026-07-19, Getty, Russell "NEVER MAKE THIS MISTAKE AGAIN. STRUCTURALLY."): a scratchpad
// `teardown_check.py` LISTED live pods AND THEN deleted ALL of them unconditionally; run as a "check"
// (grepping only its "LIVE PODS" line) it silently DELETED 3 running paid pods, killing the science
// mid-flight. A tool whose NAME says "check" but whose default is irreversible mass-deletion is a loaded
// gun. A learning ("be careful") can't prevent it — only STRUCTURE: the destructive power must be OFF by
// default and require an explicit, unambiguous opt-in flag.
//
// RULE: BLOCK new script content that BOTH (1) performs an irreversible destructive op (delete/terminate/
// remove/destroy/drop/rm -rf/rmtree/os.remove/DROP TABLE/DELETE FROM/force-push/branch -D/Remove-Item
// -Recurse) AND (2) runs it UNCONDITIONALLY — no explicit confirm/dry-run gate anywhere in the content
// (`--confirm`/`--yes`/`--force`/`--confirm-delete`/`--dry-run`/`--list`/`CONFIRM=`/`args.confirm`). So the
// reflexive "let me just run it to check" can NEVER destroy.
//
// Override: destructive-default-ok: <why unconditional destroy is correct here> (rare — e.g. a test-only
// teardown of a throwaway fixture). Teeth: permissionDecision 'deny'. Fail-open.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_RE = /\bdestructive-default-ok\s*:/i;

// An irreversible destructive op on real resources.
const DESTRUCTIVE_OP_RE = new RegExp([
  /\b(?:delete_resource|delete_when_safe|delete_pod|remove_pod|delete_all\w*)\s*\(/.source,
  /\.\s*(?:delete|terminate|destroy)\s*\(/.source,   // resource.delete() / pod.terminate()
  /\bterminate_\w+\s*\(/.source,
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/.source, // rm -rf / -fr
  /\bRemove-Item\b[^\n]*-Recurse/.source,
  /\bshutil\.rmtree\s*\(/.source,
  /\bos\.(?:remove|unlink|rmdir)\s*\(/.source,
  /\bDROP\s+(?:TABLE|DATABASE)\b/.source,
  /\bDELETE\s+FROM\b/.source,
  /\bgit\s+push\b[^\n]*--force|\bgit\s+push\b[^\n]*\s-f\b/.source,
  /\bgit\s+branch\s+-D\b/.source,
  /\bgit\s+update-ref\s+-d\b/.source,
].join('|'), 'i');

// An explicit confirm / dry-run / list opt-in — the presence of ANY of these means the destroy is (or can
// be) gated, so the safe-by-default invariant is plausibly met and we don't block.
const CONFIRM_GATE_RE = /--confirm(?:-delete)?\b|--yes\b|--force\b|--dry-run\b|--list\b|--no-dry-run\b|\bconfirm[_-]?delete\b|\bCONFIRM\b|\bDRY[_-]?RUN\b|\bargs?\.(?:confirm|yes|force|dry_run|dryrun|no_dry_run)\b|\b--i-mean-it\b|\b--really\b/i;

const CODE_EXT = /\.(py|mjs|cjs|js|ts|jsx|tsx|go|rs|rb|php|sh|ps1)$/i;

// Pure detector: content that can destroy with no confirm/dry-run gate.
export function flagsDestructiveByDefault(content) {
  const contentText = String(content || '');
  if (OVERRIDE_RE.test(contentText)) return false;
  if (!DESTRUCTIVE_OP_RE.test(contentText)) return false;
  if (CONFIRM_GATE_RE.test(contentText)) return false; // an explicit opt-in gate exists → plausibly safe
  return true;
}

const DENY_REASON = `DESTRUCTIVE-BY-DEFAULT BLOCKED — this script destroys resources with no explicit confirm gate.

A tool that CAN delete/terminate/drop real resources must DEFAULT to list / dry-run (running it with no flag can NEVER destroy) and require an explicit opt-in to actually destroy — ideally targeting SPECIFIC ids, not "all".

2026-07-19: a "check" script that deleted-all killed 3 RUNNING paid pods mid-flight. A learning can't prevent that — only structure can.

Fix the DESIGN:
  - Default behavior (no flag) = LIST / dry-run / read-only.
  - Gate the destroy behind an explicit flag read from argv/env: \`if "--confirm-delete" in sys.argv:\` /
    \`--yes\` / \`--force\` / \`CONFIRM=1\` — and prefer specific ids over a blanket loop.

Override (rare — a test-only teardown of a throwaway fixture): put destructive-default-ok: <why> in the content.`;

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') process.exit(0);
  const toolName = event.tool_name || '';
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') process.exit(0);

  const filePath = event.tool_input?.file_path || event.tool_input?.path || '';
  if (filePath && !CODE_EXT.test(filePath)) process.exit(0); // only gate code/scripts
  const addedContent = event.tool_input?.content ?? event.tool_input?.new_string ?? '';

  let flagged;
  try { flagged = flagsDestructiveByDefault(addedContent); } catch { process.exit(0); } // fail-open
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
