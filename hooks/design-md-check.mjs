#!/usr/bin/env node
// PreToolUse (Write|Edit) — when a UI/style file is being written or edited, surface
// programming/context/design.md (Russell's design system) so the change follows the house style.
// Non-blocking: injects the design rules as additionalContext. Russell's intent (2026-06-13):
// "a global place for all the style info, and a hook to check it when designing."

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';

// Design system now lives in the agent-agnostic shared-context folder (moved out of ~/.claude
// 2026-06-30 so any tool/agent can read it). Fall back to the legacy ~/.claude path if present.
const SHARED_DESIGN_PATH = resolvePath(homedir(), 'Desktop', 'programming', 'context', 'design.md');
const LEGACY_DESIGN_PATH = resolvePath(homedir(), '.claude', 'design.md');
const DESIGN_PATH = existsSync(SHARED_DESIGN_PATH) ? SHARED_DESIGN_PATH : LEGACY_DESIGN_PATH;
// Files that ARE the UI. (.svelte/.vue/.jsx/.tsx count too — they carry markup + styles.)
const STYLE_FILE_RE = /\.(css|scss|sass|less|html?|svg|svelte|vue|jsx|tsx)$/i;
// Editing a JS/TS file that's clearly building UI (inline styles, classList, DOM creation).
const STYLE_IN_CODE_RE = /style\.cssText|\.style\.|classList|createElement|getBoundingClientRect|innerHTML|document\.body\.appendChild/;

function readEvent() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function main() {
  const hookEvent = readEvent();
  if (!['Write', 'Edit', 'MultiEdit'].includes(hookEvent.tool_name)) return;

  const filePath = hookEvent.tool_input?.file_path || hookEvent.tool_input?.path || '';
  const newText = hookEvent.tool_input?.content
    || hookEvent.tool_input?.new_string
    || (Array.isArray(hookEvent.tool_input?.edits) ? hookEvent.tool_input.edits.map((edit) => edit.new_string || '').join('\n') : '')
    || '';

  const isStyleFile = STYLE_FILE_RE.test(filePath);
  const isStyleCode = STYLE_IN_CODE_RE.test(newText);
  if (!isStyleFile && !isStyleCode) return;

  if (!existsSync(DESIGN_PATH)) return;
  const designDoc = readFileSync(DESIGN_PATH, 'utf8');

  const outputLines = [
    `=== DESIGN SYSTEM (${DESIGN_PATH}) — follow this for any UI/style change ===`,
    '',
    designDoc.trim(),
    '',
    '↑ Match the house style. If this change teaches a new design lesson, append it to the',
    `Design learnings section of ${DESIGN_PATH}.`,
  ];
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: outputLines.join('\n') },
  }));
}

main();
