#!/usr/bin/env node
/**
 * explainer-sync — Stop gate: when NEW ARCHITECTURE WORK lands (a commit this turn that edited feature
 * source under extension/lib or extension/src), the interactive HTML explainers under docs/explainers/ MUST
 * be updated too — otherwise they rot and lie about how the system works. This is enforcement, not a nudge:
 * it BLOCKS the turn (decision: block) until an explainer is touched or the change is explicitly exempt.
 *
 * Russell's rule (2026-06-22): "add a hook that forces you to update the html explainers when new work lands."
 * The explainers are the readable map of the architecture; a feature that changes the architecture without
 * updating its explainer leaves the map wrong.
 *
 * Scope: only fires when the repo actually HAS a docs/explainers/ tree (so it's a no-op in every other project)
 * AND this turn both (a) edited architecture source and (b) committed. Override: put `explainer-skip: <why>` in
 * the final reply (for a change with no architectural surface — a test-only tweak, a typo, a dep bump). Fail
 * open on any error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTranscript, roleOf, contentBlocks, currentTurnEntries } from './lib/transcript.mjs';

const COMMIT_RE = /\bgit\b[\s\S]*\bcommit\b/;
const OVERRIDE_RE = /explainer-skip\s*:/i;
const CODE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// Architecture source = the JS/Svelte that defines how Jarvis works (NOT tests, NOT the html explainers).
export function isArchitectureSource(filePath) {
  const path = String(filePath || '').replace(/\\/g, '/');
  if (/\.test\.[a-z]+$/i.test(path)) return false;
  if (/\.html?$/i.test(path)) return false;
  return /(^|\/)extension\/(lib|src)\/.+\.(js|mjs|svelte)$/i.test(path);
}

// An explainer page (the thing that must stay in sync).
export function isExplainer(filePath) {
  const path = String(filePath || '').replace(/\\/g, '/');
  return /(^|\/)docs\/explainers\/.+\.html?$/i.test(path);
}

// Pure decision so the rule is unit-testable: block iff work landed (committed + architecture edited) but no
// explainer was touched and there's no override.
export function shouldBlock({ committed, editedArchitecture, editedExplainer, override }) {
  return Boolean(committed && editedArchitecture && !editedExplainer && !override);
}

function onStop(hookEvent) {
  const turnEntries = currentTurnEntries(readTranscript(hookEvent.transcript_path));
  if (turnEntries.length === 0) return;

  let committed = false, editedArchitecture = false, editedExplainer = false, override = false;
  let repoDirectory = hookEvent.cwd || process.cwd();

  for (const entry of turnEntries) {
    for (const block of contentBlocks(entry)) {
      if (block.type === 'text' && OVERRIDE_RE.test(block.text || '')) override = true;
      if (block.type !== 'tool_use') continue;
      const toolName = block.name || '';
      const toolInput = block.input || {};
      if (CODE_EDIT_TOOLS.has(toolName)) {
        const filePath = toolInput.file_path || toolInput.path || '';
        if (isArchitectureSource(filePath)) editedArchitecture = true;
        if (isExplainer(filePath)) editedExplainer = true;
      }
      if (toolName === 'Bash' || toolName === 'PowerShell') {
        const command = toolInput.command || '';
        if (COMMIT_RE.test(command)) {
          committed = true;
          if (/explainer/i.test(command)) editedExplainer = true; // an explainer-named commit counts
        }
        const explicitRepo = command.match(/\bgit\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))/);
        if (explicitRepo) repoDirectory = explicitRepo[2] || explicitRepo[3] || explicitRepo[4] || repoDirectory;
      }
    }
  }

  // No-op unless this project actually keeps an explainers tree.
  if (!existsSync(join(repoDirectory, 'docs', 'explainers'))) return;
  if (!shouldBlock({ committed, editedArchitecture, editedExplainer, override })) return;

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      'EXPLAINER UPDATE REQUIRED — you landed architecture work this turn (a commit that edited',
      'extension/lib or extension/src) but never touched docs/explainers/.',
      '',
      "Russell's rule (2026-06-22): the HTML explainers are the readable map of how Jarvis works — when new",
      'work lands, the relevant explainer must be updated so the map never lies.',
      '',
      'Do ONE of:',
      '  1. Update the matching docs/explainers/*.html page(s) for what changed (the diagram nodes, the',
      '     step-through, the file references, any new capability) and commit it.',
      '  2. If this change genuinely has no architectural surface (test-only, typo, dep bump), say so with',
      '     the literal token:  explainer-skip: <why no explainer change is needed>',
    ].join('\n'),
  }));
}

function main() {
  let hookEvent;
  try { hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || '';
  if (eventName === 'Stop') onStop(hookEvent);
  process.exit(0);
}

// Only run when executed directly as a hook — importing (e.g. from the test) must NOT block on stdin.
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
