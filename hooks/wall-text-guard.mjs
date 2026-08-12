#!/usr/bin/env node
/**
 * wall-text-guard — Stop hook entry point for Russell's wall-of-text rule.
 *
 * Russell, 2026-07-25: "I'm disgusted with the wall of text. The claude narrative
 * hook should enforce that." The rule lives in ~/.claude/CLAUDE.md (Voice & Format):
 * "NEVER a wall of text. Hard cap: 2 short paragraphs OR a tight bullet list/table.
 * No paragraph >3 lines. A 3rd paragraph on an explaining turn = you failed." Plus
 * "<=2 short paragraphs per reply unless I ask for more."
 *
 * 2026-07-26 — TWO STRUCTURAL FIXES, both about Russell reading STACKED DRAFTS:
 *
 *   1. THE RULE IS IMPLEMENTED ONCE. This file used to carry its own paragraph
 *      counter and its own thresholds, while explain-as-you-work.mjs carried a
 *      SECOND implementation of the same CLAUDE.md rule with different thresholds
 *      and different wording. Both blocked independently, so one over-long reply
 *      got rewritten twice for one offence. The rule now lives in exactly one
 *      module — hooks/lib/prose-shape.mjs — which this file re-exports. There is
 *      no second copy and no shim: callers use analyzeProseShape directly.
 *
 *   2. IT NO LONGER BLOCKS ON ITS OWN. Every style/format checker now reports its
 *      findings to the shared governor (hooks/lib/style-verdict.mjs), which emits
 *      ONE combined verdict per turn listing everything at once. On 2026-07-26 four
 *      Stop hooks blocked sequentially on a single turn and Russell saw the same
 *      table and bullets three times over in his transcript. That stacking was the
 *      defect this fixes.
 *
 * Fails open (exit 0, no output) on anything unexpected — this hook must never be
 * the reason all work grinds to a halt.
 */

import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

// The rule itself. This hook owns NO thresholds and NO analysis of its own.
export {
  analyzeProseShape,
  proseShapeViolations,
  classifyLine,
  TEACHING_REQUEST_RE,
  MAX_PROSE_PARAGRAPHS,
  MAX_PARAGRAPH_LINES,
  WALL_PARAGRAPH_WORDS,
  EXPLAIN_WORD_BUDGET,
  SHIP_WORD_BUDGET,
} from './lib/prose-shape.mjs';
export { finalReplyText } from './lib/style-verdict.mjs';

// Delegate to the shared governor. Whichever style hook Claude Code invokes first for a turn
// runs the whole registry and emits the single combined message; every other style hook process
// for that same turn finds the turn already claimed and exits silent.
// The registry import is DYNAMIC so the hook -> registry -> hook module cycle resolves cleanly.
async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try { payload = JSON.parse(input); } catch { return; }

  const { runStyleGovernor } = await import('./lib/style-verdict.mjs');
  const { STYLE_CHECKERS } = await import('./lib/style-checkers.mjs');
  const verdict = runStyleGovernor(payload, { checkers: STYLE_CHECKERS });
  if (verdict) process.stdout.write(JSON.stringify(verdict));
}

// Entry-point guard (basename comparison — stable across MSYS `/c/...` vs `C:\...` spellings):
// only read stdin when invoked directly as the hook process, never when merely imported.
if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main().catch(() => process.exit(0));
}
