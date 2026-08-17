#!/usr/bin/env node
/**
 * PreToolUse hook — block `git reset --soft <ref>` when <ref> is not the branch's merge-base
 * (i.e. <ref> has moved ahead of the fork point), the exact mechanism that stages every file
 * the ref gained since the fork as a DELETION or REVERT.
 *
 * new-hook-category: Git safety — nearest existing hook is staged-revert-detector; it does NOT
 * cover this because it fires at `git commit` and only matches a staged tree that exactly
 * reconstructs ONE specific recent commit's parent tree. The reset-to-a-moved-ref shape almost
 * never equals any single commit's exact parent (it's the merge-base's tree applied under a
 * branch's OLD index, which spans however many commits landed on the ref since the fork) — so it
 * generally will not trip that detector at all. This hook intercepts the earliest possible
 * moment, the `reset --soft` command itself, via merge-base analysis instead of tree-matching.
 *
 * THE INCIDENT (2026-08-09, cost a whole feature; NEAR-MISS REPEAT 2026-08-17, caught by hand
 * only because the staged file list was read before committing): `learnings.md` had already
 * logged "never `reset --soft main` in a worktree older than main" right next to a squash
 * RECIPE that itself said `git reset --soft main` — the recipe contradicted the warning beside
 * it, and a stale branch landed the contradiction as a staged deletion of files main had gained
 * since the fork (a fairness gate, a pre-commit config, a dozen more). Two incidents of the
 * identical mechanism is the Getty "twice" trigger: this can no longer be a paragraph in
 * learnings.md that has to be remembered at the right moment — it has to be impossible to run
 * blind.
 *
 * THE MECHANISM: `git reset --soft <ref>` moves HEAD (and the branch pointer) to <ref> but
 * leaves the INDEX untouched — the index still matches the branch's OLD tip. If <ref> is an
 * ancestor of (or equal to) HEAD, that old tip already contains everything <ref> has, so the
 * diff is empty or purely additive: safe. If <ref> has advanced PAST the fork point (a
 * teammate's landing, a prior session's merge, anything main gained after this branch forked),
 * the index vs. the new HEAD now shows every file <ref> gained as staged work to UNDO — a
 * revert wearing the clothes of a squash.
 *
 * THE CHECK: safe iff `git rev-parse <ref>` === `git merge-base <ref> HEAD`. When <ref> is an
 * ancestor of HEAD (own earlier commit, or a <ref> that hasn't moved since the fork), the merge
 * base IS <ref> itself. When <ref> has diverged ahead, the merge base sits further back — that
 * gap is exactly the silently-staged revert.
 *
 * `git reset --soft $(git merge-base <ref> HEAD)` — the anchor a caller should use instead — is
 * recognized and let through untouched: it is already correct by construction, so this hook
 * never shells out to second-guess it.
 *
 * Escape hatch: put SOFT_RESET_ANCHOR_OK anywhere in the command (a deliberate reset onto a
 * moved ref — e.g. intentionally discarding local commits to catch up to <ref>), or
 * SOFT_RESET_ANCHOR_OVERRIDE=1 in the environment.
 *
 * Fail-open: any git failure, non-repo, unresolvable ref, or unexpected shape -> exit 0 (never
 * brick a normal reset). A false negative costs one reviewable `git status` before committing; a
 * false positive that bricks resets costs the whole session.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MAX_SAMPLE_FILES = 10;

function parseHookInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return null;
  }
}

// Every `git reset --soft <ref>` invocation in the command, ref token verbatim (unquoted).
function extractSoftResetRefs(command) {
  const refs = [];
  // The quotes are OPTIONAL and stripped, never part of the ref. The first draft excluded quote
  // characters from the class without allowing them around it, so `git reset --soft "main"` matched
  // zero characters, failed the `+`, and was never extracted — the guard silently allowed the exact
  // command it exists to stop. Found by self-review before this shipped. A guard that no-ops on a
  // trivially-quoted variant is not a guard.
  const re = /\bgit\s+reset\s+--soft\s+(?:["'])?([^\s;&|)"']+)(?:["'])?/g;
  let match;
  while ((match = re.exec(command))) {
    const ref = match[1].replace(/^["'`]|["'`]$/g, '');
    if (!ref || ref === 'HEAD') continue;
    // \$(git merge-base ...) (or any command substitution) computes the anchor dynamically —
    // that IS the correct recipe; nothing to resolve or second-guess.
    if (ref.startsWith('$(') || ref.startsWith('`')) continue;
    refs.push(ref);
  }
  return refs;
}

function git(args, repoDirectory) {
  const spawned = spawnSync('git', args, { cwd: repoDirectory, encoding: 'utf8' });
  if (spawned.status !== 0) return null;
  return spawned.stdout.trim();
}

// Returns null (fail-open / can't judge) or { safe: bool, refSha, mergeBaseSha, atRiskFiles }.
function judgeReset(ref, repoDirectory) {
  const refSha = git(['rev-parse', '--verify', `${ref}^{commit}`], repoDirectory);
  if (!refSha) return null;
  const headSha = git(['rev-parse', '--verify', 'HEAD'], repoDirectory);
  if (!headSha) return null;
  if (refSha === headSha) return { safe: true };

  const mergeBaseSha = git(['merge-base', ref, 'HEAD'], repoDirectory);
  if (!mergeBaseSha) return null; // unrelated history / can't resolve — don't guess

  if (mergeBaseSha === refSha) return { safe: true };

  const atRiskRaw = git(['diff', '--name-only', mergeBaseSha, refSha], repoDirectory);
  const atRiskFiles = atRiskRaw ? atRiskRaw.split('\n').filter(Boolean) : [];
  return { safe: false, refSha, mergeBaseSha, atRiskFiles };
}

function deny(ref, verdict) {
  const sample = verdict.atRiskFiles.slice(0, MAX_SAMPLE_FILES);
  const overflowCount = verdict.atRiskFiles.length - sample.length;
  const lines = [
    `BLOCKED — \`git reset --soft ${ref}\` targets a ref that has moved AHEAD of this branch's fork point.`,
    '',
    `  \`${ref}\` @ ${verdict.refSha.slice(0, 12)}  vs.  fork point ${verdict.mergeBaseSha.slice(0, 12)}`,
    "  The reset keeps the index at this branch's old tip but moves HEAD to a ref that has since",
    `  gained work — everything ${ref} picked up after the fork stages as a DELETION or REVERT`,
    '  the moment you commit.',
    '',
  ];
  if (sample.length) {
    lines.push(`  At risk (${verdict.atRiskFiles.length} file(s)${overflowCount > 0 ? `, showing ${sample.length}` : ''}):`);
    for (const filePath of sample) lines.push(`    ${filePath}`);
    if (overflowCount > 0) lines.push(`    ... and ${overflowCount} more`);
    lines.push('');
  }
  lines.push(
    'Use the merge-base as the anchor instead — always correct, forked-yesterday or forked-a-week-ago:',
    `    git reset --soft $(git merge-base ${ref} HEAD)`,
    '',
    `If you genuinely mean to discard this branch's history back onto ${ref} (deliberate, not a squash):`,
    '  re-run with SOFT_RESET_ANCHOR_OK in the command.',
  );
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: lines.join('\n'),
    },
  }));
}

function main() {
  if (process.env.SOFT_RESET_ANCHOR_OVERRIDE === '1') process.exit(0);

  const event = parseHookInput();
  if (!event) process.exit(0);
  if (event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') process.exit(0);

  const command = (event.tool_input && event.tool_input.command) || '';
  if (typeof command !== 'string' || !command) process.exit(0);

  if (/SOFT_RESET_ANCHOR_OK/.test(command)) process.exit(0);
  if (/\bSOFT_RESET_ANCHOR_OVERRIDE=1\b/.test(command)) process.exit(0);

  const refs = extractSoftResetRefs(command);
  if (!refs.length) process.exit(0);

  const repoDirectory = event.cwd || process.cwd();
  if (!git(['rev-parse', '--git-dir'], repoDirectory)) process.exit(0);

  for (const ref of refs) {
    const verdict = judgeReset(ref, repoDirectory);
    if (!verdict || verdict.safe) continue;
    deny(ref, verdict);
    process.exit(0);
  }

  process.exit(0);
}

// Pure helpers exported for unit testing.
export { extractSoftResetRefs, judgeReset };

import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
// COMPARE BASENAMES, never whole paths (2026-08-17, found by a live probe — this hook was DEAD).
// The harness and the PreToolUse registry invoke hooks with a forward-slash path, while
// `fileURLToPath` returns Windows backslashes. A strict full-path equality therefore never matched,
// `main()` never ran, and the guard silently allowed every `git reset --soft` it was written to
// stop — its unit tests passed the whole time, because they import the pure helpers and never
// execute the module the way the harness does. Its siblings already use the basename form.
if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  try { main(); } catch { process.exit(0); }
}
