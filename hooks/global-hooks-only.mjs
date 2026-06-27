#!/usr/bin/env node
// =============================================================================
// global-hooks-only — hooks live in ~/.claude/, not in a project. Writing a hook
//   implementation or registering one in a PROJECT-LOCAL .claude is BLOCKED.
// =============================================================================
//
// Russell's rule (2026-06-27): "hooks should always be global unless I say otherwise."
// Discipline/guard hooks belong in ~/.claude/hooks (every project), registered in
// ~/.claude/settings.json — not a project-local .claude/hooks or .claude/settings.json.
//
// PreToolUse(Write|Edit|MultiEdit). BLOCKS (permissionDecision deny) when:
//   - the target is a hook IMPLEMENTATION file under a PROJECT `.claude/hooks/…(.mjs|.js|.cjs|.ts)`
//     (i.e. a `.claude/hooks/` path NOT under the home dir), or
//   - the target is a PROJECT `.claude/settings(.local).json` and the edit registers a hook
//     (carries a `"command"` entry under a hooks block).
//
// Override ("unless I say otherwise"): `local-hook-ok: <why>` in the edit, or LOCAL_HOOK_OK=1.
// Fails OPEN on any error.
// =============================================================================

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const OVERRIDE = /\blocal-hook-ok\s*:/i;

const norm = (anyPath) => String(anyPath || '').replace(/\\/g, '/').toLowerCase();

/** Is this path inside the GLOBAL ~/.claude tree? Pure. */
export function isUnderHomeClaude(filePath, homeDir) {
  return norm(filePath).startsWith(`${norm(homeDir)}/.claude/`);
}

/**
 * Verdict for a Write/Edit. Pure (homeDir + editText injected) so the test drives every branch.
 * Blocks a project-local hook implementation, or a project settings file registering a hook.
 */
export function verdictForWrite({ filePath, editText, homeDir }) {
  if (OVERRIDE.test(String(editText || ''))) return { block: false };
  const path = norm(filePath);
  const underHome = isUnderHomeClaude(filePath, homeDir);

  // A hook implementation file written into a PROJECT's .claude/hooks/.
  const isHookImpl = /\/\.claude\/hooks\/[^/]+\.(mjs|cjs|js|ts)$/.test(path);
  if (isHookImpl && !underHome) {
    return { block: true, kind: 'a hook implementation in a project-local .claude/hooks/' };
  }

  // A PROJECT settings file that registers a hook command.
  const isProjectSettings = /\/\.claude\/settings(\.local)?\.json$/.test(path) && !underHome;
  if (isProjectSettings && /"command"\s*:/.test(String(editText)) && /hook/i.test(String(editText))) {
    return { block: true, kind: 'a hook registration in a project-local .claude/settings.json' };
  }

  return { block: false };
}

function denial(kind, homeDir) {
  return `GLOBAL-HOOKS-ONLY — you are creating ${kind}.

Russell's rule (2026-06-27): hooks are GLOBAL by default — they live in ${homeDir.replace(/\\/g, '/')}/.claude/hooks
and are registered in ~/.claude/settings.json, so every project gets them. A project-local hook only fires in
that one repo and silently won't exist anywhere else.

Do this instead:
  - Write the hook to ~/.claude/hooks/<name>.mjs (+ its .test.mjs), register it in ~/.claude/settings.json, add a
    HOOKBOOK.md row.

Override only if Russell explicitly said this hook must be project-scoped:
  local-hook-ok: <why this one is intentionally local>   (in the edit), or LOCAL_HOOK_OK=1`;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); return; }

  if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') { process.exit(0); return; }
  if (!['Write', 'Edit', 'MultiEdit'].includes(event.tool_name)) { process.exit(0); return; }
  if (process.env.LOCAL_HOOK_OK === '1') { process.exit(0); return; }

  const input = event.tool_input || {};
  const filePath = input.file_path || input.path || '';
  const editText = input.content ?? input.new_string ?? '';

  const verdict = verdictForWrite({ filePath, editText, homeDir: homedir() });
  if (!verdict.block) { process.exit(0); return; }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denial(verdict.kind, homedir()),
    },
  }));
  process.exit(0);
}

// Entry-point guard so importing this for tests does not execute main().
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
