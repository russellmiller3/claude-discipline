#!/usr/bin/env node
// =============================================================================
// EXPERIMENT-STATISTICAL-RIGOR-GUARD — a toy/small-scale experiment worker must
// be STATISTICALLY capable of supporting the claim it's built to make.
// =============================================================================
//
// new-hook-category: statistical rigor — nearest existing hooks are
// experiment-ablation-required (checks the ARM SET has a control) and
// experiment-manifest-guard (checks a reproduction MANIFEST doc exists).
// Neither checks whether the experiment's SAMPLE SIZES can actually support a
// generalization claim: a worker can have a control arm and a perfect manifest
// and still measure its "does this generalize" gate off a single held-out item
// or lock a seed with no way to vary it. This guards a different invariant (can
// the design possibly detect what it claims to detect), on a different signal
// (literal sample-size constants + CLI seed exposure in worker source).
//
// WHY (Russell, 2026-07-21 postmortem, exp167d): a held-out generalization gate
// was shipped and initially trusted with a held-out set of ONE token per
// category. Russell only caught it by asking "do we have enough foreign
// words." Root cause: with an untrained held-out embedding, the measured rate
// is driven by random-init luck — the SAME held-out token's spawn rate spanned
// 0.047->0.712 across 3 seeds on an unchanged task (nearly the whole possible
// range, from re-rolling dice once). Primary-source grounding for the fix:
//   - Colas, Sigaud & Oudeyer 2018 ("How Many Random Seeds? Statistical Power
//     Analysis in Deep RL Experiments", arXiv:1806.08295): a bootstrap CI test
//     should not be used below N=20; use a pilot of N>=20 to estimate std dev
//     before trusting a power calculation; ALWAYS use more samples than the
//     power analysis prescribes as a safety margin.
//   - Henderson, Islam, Bachman, Pineau, Precup & Meger 2018 ("Deep
//     Reinforcement Learning that Matters", arXiv:1709.06560): explicitly
//     flags N<5 trials as a widespread and MISLEADING reporting practice —
//     same hyperparameters, different seed groups of 5, produced a
//     "statistically significant" difference (t=-9.09, p=0.0016) from seed
//     variance ALONE.
//   - scikit-learn "Common pitfalls" docs (Controlling randomness): a
//     reproducible/comparable result requires an explicit, threaded random
//     seed — never a bare unparameterized RNG.
// This hook can't verify statistical power (that needs domain judgment — see
// the ml-experiment skill's Statistical Rigor Checklist for the full bar). It
// catches the two MECHANICALLY checkable floors: a held-out/eval sample-size
// constant of size <=1, and a stochastic (torch-based) CLI worker with no
// --seed knob at all (which makes seed-durability checking impossible from
// the start).
//
// HOW IT WORKS
// ============
// Fires PreToolUse on Write|Edit of an experiment WORKER (exp<N>_*.py, same
// identity regex as experiment-ablation-required.mjs — excludes dispatchers,
// smoke files, test files). BLOCKS when either:
//   (a) a HELD_OUT*/held_out* list or tuple literal has <=1 element, OR
//   (b) the file imports torch and exposes an argparse CLI (add_argument) but
//       has no --seed argument anywhere.
//
// SCOPE (honest): static-content regex, not real static analysis. It catches
// the LITERAL-CONSTANT case (a) and the MISSING-FLAG case (b). It does NOT
// (and structurally can't) verify that a chosen N is high enough for real
// statistical power, that seeds are actually threaded into every RNG call, or
// that a "generalizes" claim in prose is backed by >=3 seeds — those need the
// ml-experiment skill's Statistical Rigor Checklist and human/red-team
// judgment, not a regex.
//
// TEETH: permissionDecision 'deny'. Escape: EXPERIMENT_STATS_RIGOR_OK in the
// file content or env (a genuinely single-item design, e.g. a smoke test).
// FAILS OPEN on any error.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_OVERRIDE = 'EXPERIMENT_STATS_RIGOR_OK';
const TOKEN = 'EXPERIMENT_STATS_RIGOR_OK';

// Same experiment-worker identity as experiment-ablation-required.mjs.
const EXPERIMENT_WORKER = /(^|[\\/])exp\d+[a-z]?_[a-z0-9_]+\.py$/i;
const IS_DISPATCHER = /(^|[\\/])(runpod|modal)_/i;
const IS_SMOKE_OR_TEST = /smoke|(^|[\\/])test_|_test\.py$|_runner\.py$/i;

// A name binding whose LHS mentions HELD_OUT/held_out and whose RHS is a
// literal list/tuple (not a derived expression like `[*A, *B]` concatenation
// of two already-checked names, and not a plain identifier alias).
const HELD_OUT_LITERAL = /\b([A-Za-z_]*HELD_OUT[A-Za-z_]*)\s*=\s*([\[\(])/gi;

// Split a bracket body on top-level commas (depth-aware, so nested
// brackets/braces/parens in one element don't get miscounted as separators).
export function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(body || '')) {
    if ('[({'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

// Find the matching close bracket for an open bracket at `openIndex`, and
// return the body between them (depth-aware, so it does not stop at the
// first nested close).
function extractBracketBody(content, openIndex, openChar) {
  const closeChar = openChar === '[' ? ']' : ')';
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    if (content[i] === openChar) depth++;
    else if (content[i] === closeChar) { depth--; if (depth === 0) return content.slice(openIndex + 1, i); }
  }
  return null; // unterminated — malformed/truncated snippet, skip rather than guess
}

// Collect every HELD_OUT*-named literal list/tuple's element COUNT found in
// the content. A concatenation expression like `[*A, *B]` still gets counted
// by element (2 spread entries) — deliberately conservative: this hook only
// judges the LITERAL element count actually written, not the resolved size.
export function heldOutListSizes(content) {
  const sizes = [];
  let match;
  HELD_OUT_LITERAL.lastIndex = 0;
  while ((match = HELD_OUT_LITERAL.exec(content)) !== null) {
    const name = match[1];
    const openChar = match[2];
    const openIndex = match.index + match[0].length - 1;
    const body = extractBracketBody(content, openIndex, openChar);
    if (body === null) continue;
    sizes.push({ name, count: splitTopLevel(body).length });
  }
  return sizes;
}

// A stochastic (torch-based) CLI worker with argparse but no --seed flag.
function missingSeedFlag(content) {
  if (!/\bimport\s+torch\b/.test(content)) return false;
  if (!/add_argument\(/.test(content)) return false;
  return !/--seed\b/.test(content);
}

// PURE core — returns { block, reasonKind, ...details }.
export function evaluate({ toolName, filePath, content }) {
  if (toolName !== 'Write' && toolName !== 'Edit') return { block: false };
  if (!filePath || !/\.py$/i.test(filePath)) return { block: false };
  if (!content) return { block: false };
  if (IS_DISPATCHER.test(filePath) || IS_SMOKE_OR_TEST.test(filePath)) return { block: false };
  if (!EXPERIMENT_WORKER.test(filePath)) return { block: false };
  if (content.includes(TOKEN)) return { block: false };

  const undersized = heldOutListSizes(content).filter((entry) => entry.count <= 1);
  if (undersized.length > 0) return { block: true, reasonKind: 'undersized-held-out', undersized };

  if (missingSeedFlag(content)) return { block: true, reasonKind: 'no-seed-flag' };

  return { block: false };
}

function undersizedReason(filePath, undersized) {
  const names = undersized.map((entry) => `${entry.name} (${entry.count} element${entry.count === 1 ? '' : 's'})`).join(', ');
  return `HELD-OUT SET TOO SMALL TO SUPPORT A GENERALIZATION CLAIM — ${basename(filePath)}.

Found: ${names}. A held-out/generalization gate measured off a SINGLE item is one coin flip on
that item's random-init position, not a generalization signal.

The exact incident this catches (exp167d, 2026-07-21): a held-out gate shipped and was initially
trusted at n=1 per category. The same held-out token's measured rate spanned 0.047->0.712 across
3 seeds on an unchanged task — nearly the full possible range, from re-rolling dice once. Russell
caught it by asking "do we have enough foreign words" — this hook exists so that question doesn't
have to be asked again.

Primary-source grounding:
  - Colas, Sigaud & Oudeyer 2018 (arXiv:1806.08295): a bootstrap CI test needs N>=20; use a pilot
    of N>=20 to estimate variance before trusting any power calculation; always pad N above what
    the power analysis prescribes.
  - Henderson et al 2018 (arXiv:1709.06560): N<5 trials is flagged as a widespread, MISLEADING
    reporting practice in deep learning — seed variance alone can produce a "significant" result.

Fix: grow the held-out/eval set to >=2 items per category (the current project floor — still
below a real power-backed N, so state the chosen N and a one-line justification in the METHODS
doc), or better, report the full per-item spread alongside the average, not just the mean.

If this is genuinely a single-item smoke/plumbing check with no generalization claim attached,
add the token \`${TOKEN}\` in a comment near the top and write again. Env escape: ${ENV_OVERRIDE}=1.`;
}

function noSeedReason(filePath) {
  return `STOCHASTIC WORKER HAS NO --seed FLAG — ${basename(filePath)}.

This worker imports torch and exposes a CLI (argparse) but has no --seed argument anywhere. That
makes it structurally impossible to durability-check this design across multiple random seeds —
exactly the check that caught exp167d's held-out gate failing on seed 1 while passing on seeds 0
and 2. A single-seed result from a worker with no seed knob can never be more than a first pass.

Fix: add \`parser.add_argument("--seed", type=int, default=0)\` and thread it into every RNG call
(torch.manual_seed, numpy's RandomState, Python's random) — see scikit-learn's "Controlling
randomness" guidance: an explicit, threaded seed, never a bare unparameterized RNG.

If this worker is genuinely deterministic (no stochastic training/init), add the token
\`${TOKEN}\` in a comment near the top and write again. Env escape: ${ENV_OVERRIDE}=1.`;
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') { process.exit(0); }
    const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const toolName = payload.tool_name || '';
    const input = payload.tool_input || {};
    const filePath = input.file_path || '';
    const content = input.new_string || input.content || '';
    const verdict = evaluate({ toolName, filePath, content });
    if (!verdict.block) { process.exit(0); }

    const reason = verdict.reasonKind === 'undersized-held-out'
      ? undersizedReason(filePath, verdict.undersized)
      : noSeedReason(filePath);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0); // fail open — never brick a legitimate write
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) main();
