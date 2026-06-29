#!/usr/bin/env node
/**
 * widget-ux-not-cli — gate hook that DENIES an Agent spawn whose brief sets out to
 * "expose / surface UX" for a feature but whose only surface is a `py -m`/CLI, when
 * the project actually has a widget (a `widget.html`). The product's user-facing
 * surface is the widget, not a command line.
 *
 * Why this rule exists (2026-06-29, Russell — 3rd recurrence):
 * Asked to "make sure everything has UX exposed," the orchestrator kept adding
 * `python -m skaffen_desktop.chat` / `memory` / `history` CLIs and calling it done;
 * the filebrain agent deferred its widget panel as "needs a bridge SD lacks." Both
 * wrong: a desktop product's UX is the voice widget (`claude-voice/scripts/widget.html`
 * + `widget.py`), and the bridge is NOT missing — pywebview exposes Python to JS via a
 * `js_api` object (`window.pywebview.api.<method>()`). A CLI is a dev convenience, never
 * the user-facing surface. The weak prior rule ("clickable > shell commands") failed
 * across 3 sessions, so this enforces the OUTCOME.
 *
 * Teeth: permissionDecision:'deny'. Fires only when ALL hold:
 *   - the brief expresses UX-exposure INTENT (expose/surface UX, "user-facing UX"),
 *   - it builds a CLI surface (`py -m` / `python -m` / `__main__` / argparse),
 *   - it does NOT mention the widget (widget.html / pywebview / js_api),
 *   - a `widget.html` actually exists somewhere under the session's project tree.
 * Override: UX_CLI_OK (a genuinely dev-only tool) or WIDGET_UX_RUSSELL_OK.
 *
 * Fail-open on any unexpected error.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** True if a `widget.html` exists within `maxDepth` levels under `rootDir`. */
export function hasWidgetHtml(rootDir, maxDepth = 3) {
  if (!rootDir || !existsSync(rootDir)) return false;
  const stack = [[rootDir, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
      if (name.toLowerCase() === 'widget.html') return true;
      if (depth < maxDepth) {
        const child = join(dir, name);
        try { if (statSync(child).isDirectory()) stack.push([child, depth + 1]); } catch {}
      }
    }
  }
  return false;
}

/**
 * Decide on one PreToolUse Agent event. Returns a deny-decision object, or null to
 * allow. Pure: caller injects `widgetExists` (the fs check is done in main()).
 */
export function decideWidgetUxGate(event, { widgetExists }) {
  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'PreToolUse') return null;
  if ((event.tool_name || '') !== 'Agent') return null;

  const input = event.tool_input || {};
  const prompt = input.prompt || '';
  const description = input.description || '(unnamed)';

  if (/\bUX_CLI_OK\b/.test(prompt) || /\bWIDGET_UX_RUSSELL_OK\b/.test(prompt)) return null;

  // UX-exposure INTENT: "expose/surface ... ux" (either order) or "user-facing ux".
  const uxIntent =
    /\b(expos\w*|surfac\w*)\b[^.\n]{0,40}\bux\b/i.test(prompt) ||
    /\bux\b[^.\n]{0,40}\b(expos\w*|surfac\w*)\b/i.test(prompt) ||
    /\buser[- ]facing\b[^.\n]{0,20}\bux\b/i.test(prompt);
  if (!uxIntent) return null;

  // Builds a CLI surface.
  const buildsCli =
    /\bpy(thon)?\s+-m\b/i.test(prompt) ||
    /\b__main__\b/.test(prompt) ||
    /\bargparse\b/i.test(prompt) ||
    /\bcommand[- ]line\b/i.test(prompt) ||
    /\bCLI\b/.test(prompt);
  if (!buildsCli) return null;

  // Mentions the widget — then it's doing the right thing, allow.
  const mentionsWidget = /widget\.html|widget\.py|pywebview|js_api|window\.pywebview/i.test(prompt);
  if (mentionsWidget) return null;

  if (!widgetExists) return null; // no widget in this project — a CLI may be the only surface

  const reason = `Agent spawn BLOCKED — "${description}" claims to EXPOSE UX via a CLI, but this project has a widget.

Russell's rule (2026-06-29): a desktop product's user-facing UX is the WIDGET (\`widget.html\` + \`widget.py\`), NOT a \`py -m\`/CLI. The pywebview bridge is NOT missing — the widget calls Python via \`window.pywebview.api.<method>()\` (a \`js_api\` object on the Python window). A CLI is a dev convenience; it does not count as "UX exposed."

Fix: have the brief build the UX as a WIDGET panel wired through pywebview \`js_api\`, with a SCREENSHOT as proof. A CLI alongside is fine — but the widget is the deliverable.
Override: UX_CLI_OK (this really is a dev-only tool, no user surface) · WIDGET_UX_RUSSELL_OK (Russell approved CLI-only here).`;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** Walk up from a dir to the nearest ancestor containing a `.git` (the project root). */
function findProjectRoot(startDir) {
  let current = startDir;
  while (current) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }
  const projectRoot = findProjectRoot(event.cwd || process.cwd()) || event.cwd || process.cwd();
  const decision = decideWidgetUxGate(event, { widgetExists: hasWidgetHtml(projectRoot) });
  if (decision) process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

const invokedAsScript =
  process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1]);
if (invokedAsScript) main();
