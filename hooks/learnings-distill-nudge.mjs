#!/usr/bin/env node
/**
 * learnings-distill-nudge — SessionStart context injector. When raw gotchas have piled up in a
 * learnings.md since the last first-principles distillation, it nudges you to run /distill-learnings
 * (cluster by root cause → first-principles → consolidate → propose an ENFORCED hook/rule for repeats).
 *
 * new-hook-category: Learnings system — nearest existing hook is learnings-to-hooks-nudge; it does NOT
 * cover this because that one fires per-Read and nudges ONE lesson at a time with no backlog/watermark/
 * threshold concept, and never triggers a periodic BATCH first-principles consolidation. This is the
 * "the raw notes have piled up — time to refine the whole batch" trigger, a different job on a different
 * event (SessionStart, not PostToolUse:Read). The counting math is shared via lib/learningsWatermark.mjs.
 *
 * ADVISORY_ONLY_OK — this hook has NO TEETH by design, and that is the whole point. The heavy pass is
 * a first-principles reasoning task; running it automatically would be slow, costly, and (worse) would
 * mean a hook spawning the distillation agent — exactly the auto-agent behaviour ~/.claude/CLAUDE.md
 * forbids. So this only SURFACES that a distill is due; a human triggers the skill. Nudge, never run.
 *
 * The "when is it due?" math lives in lib/learningsWatermark.mjs (shared with the skill's --mark CLI so
 * the read side and write side can't drift). The weekly backstop is a staleness clause in that math —
 * no cron needed. Fail-open: any error → exit 0, silent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dueFiles } from './lib/learningsWatermark.mjs';

function main() {
  try { readFileSync(0, 'utf8'); } catch { /* SessionStart may pass an event on stdin; we don't need it */ }

  const workingDirectory = process.env.CLAUDE_DISTILL_CWD || process.cwd();
  const overrides = {};
  if (Number(process.env.LEARNINGS_DISTILL_THRESHOLD)) overrides.threshold = Number(process.env.LEARNINGS_DISTILL_THRESHOLD);
  if (Number(process.env.LEARNINGS_DISTILL_STALE_DAYS)) overrides.staleDays = Number(process.env.LEARNINGS_DISTILL_STALE_DAYS);

  const due = dueFiles(workingDirectory, overrides).filter((entry) => existsSync(entry.file));
  if (due.length === 0) process.exit(0);

  const backlogLines = due.map((entry) => {
    const plural = entry.newCount === 1 ? '' : 's';
    const why = entry.reason === 'stale' ? 'sitting un-distilled past the staleness window' : 'past the distill threshold';
    return `  • ${entry.file} — ${entry.newCount} undistilled lesson${plural} (${why})`;
  });

  console.log([
    '=== LEARNINGS DISTILL DUE ===',
    'Raw gotchas have accumulated since the last first-principles pass. Run /distill-learnings to mine them:',
    'cluster the loose lessons by ROOT CAUSE, run first-principles on each cluster, consolidate the file,',
    'and — for anything that recurred — propose an ENFORCED hook or CLAUDE.md rule so it cannot happen again.',
    ...backlogLines,
    'This is a nudge, not a task: run it when you have a moment. Nothing auto-runs (no agent is spawned).',
  ].join('\n'));
  process.exit(0);
}

main();
