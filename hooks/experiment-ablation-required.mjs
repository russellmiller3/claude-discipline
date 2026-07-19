#!/usr/bin/env node
// =============================================================================
// EXPERIMENT-ABLATION-REQUIRED — an experiment that enumerates arms must include
// a CONTROL/ABLATION arm, not just treatments.
// =============================================================================
//
// new-hook-category: Control tower — nearest existing hooks are
// experiment-manifest-guard (checks a reproduction MANIFEST doc exists) and
// experiment-monitor-required (checks a live Monitor before launch). Neither
// inspects the experiment's ARM SET for scientific rigor: a run can have a
// perfect manifest + monitor and still be treatment-only with no control. This
// guards a different invariant (a causal claim needs a matched removed-mechanism
// control arm), on a different signal (the arm CHOICES in worker source), so it
// can't be folded into either without making a god-hook.
//
// WHY (Russell, 2026-07-19): exp147b (the Qwen 1.5B walled-substrate run) was
// built with only a TREATMENT arm + within-model ablation GATES — no separately
// TRAINED control (a no-wall arm that should FAIL, proving the wall structure is
// load-bearing). "should be a hook that stops / requires ablation arms. did that
// hook not fire? does it not exist?" — it didn't exist. This is it.
//
// A causal/load-bearing claim needs a matched condition where the mechanism is
// REMOVED and is expected to fail. exp147a did this (no-wall / single-agent /
// random-mask arms, 9/9 FAIL). An experiment that lists a menu of arms with only
// treatments has no such control.
//
// HOW IT WORKS
// ============
// Fires PreToolUse on Write of an experiment WORKER (a file whose name matches
// exp<N>_*.py) that ENUMERATES arms — an argparse arg named arm/mode/variant/
// condition/treatment/mask-mode with a `choices=[...]`, OR an `arms`/`ARMS` list
// literal. It collects the arm names and BLOCKS if NONE of them signal a control
// or ablation (ablation/control/no-wall/baseline/shuffle/random/single-agent/
// negative/placebo/sham/scramble/no-tool/off).
//
// SCOPE (honest): it catches the ENUMERATED-arms case — a worker that declares a
// set of arms and forgot the control. It deliberately does NOT fire on:
//   - dispatchers/launchers (runpod_*/modal_*) — their arm menus span many
//     experiments and controls live in the workers they call;
//   - smoke/plumbing/test/runner files — not claim-making;
//   - a single hard-coded-arm worker with no `choices`/`arms` declaration — that
//     needs human judgment about whether the claim is causal, which a regex
//     can't supply. Use /red-team-plan for those.
//
// TEETH: permissionDecision 'deny'. Escape: EXPERIMENT_ABLATION_REQUIRED_OK in
// the file content or env (a genuinely arm-less / non-causal experiment).
// FAILS OPEN on any error.
// =============================================================================

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_OVERRIDE = 'EXPERIMENT_ABLATION_REQUIRED_OK';
const TOKEN = 'EXPERIMENT_ABLATION_REQUIRED_OK';

// A worker for an experiment by identity: scripts/exp<N>_*.py (NOT runpod_/modal_
// dispatchers, NOT *smoke*, NOT test/runner files).
const EXPERIMENT_WORKER = /(^|[\\/])exp\d+[a-z]?_[a-z0-9_]+\.py$/i;
const IS_DISPATCHER = /(^|[\\/])(runpod|modal)_/i;
const IS_SMOKE_OR_TEST = /smoke|(^|[\\/])test_|_test\.py$|_runner\.py$/i;

// An arm name (or any file token) that signals a control / ablation arm.
const CONTROL_SIGNAL =
  /ablat|control|\bno[_-]?wall\b|nowall|baseline|shuffle|random|single[_-]?agent|negative|placebo|\bsham\b|scramble|no[_-]?tool|notool|\bablated\b|\bplain\b/i;

// argparse args whose choices enumerate experimental arms (not --device/--seed).
const ARM_ARG = /arm|mode|variant|condition|treatment/i;

// Pull quoted string literals out of a bracketed list body.
function quotedStrings(listBody) {
  const found = [];
  const stringLiteral = /["']([^"']+)["']/g;
  let match;
  while ((match = stringLiteral.exec(listBody)) !== null) found.push(match[1]);
  return found;
}

// Collect the arm names an experiment worker enumerates, from two sources:
//  (a) an argparse arg named arm/mode/variant/condition with choices=[...]
//  (b) an `arms`/`ARMS` list literal (the exp147a / bench arms-declaration shape)
export function collectArmNames(content) {
  const names = [];
  // (a) add_argument("--mask-mode", ..., choices=[...])
  const addArgumentChoices = /add_argument\(\s*["']--?([a-z0-9_-]+)["'][\s\S]{0,240}?choices\s*=\s*\[([^\]]*)\]/gi;
  let match;
  while ((match = addArgumentChoices.exec(content)) !== null) {
    const argumentName = match[1];
    if (ARM_ARG.test(argumentName)) names.push(...quotedStrings(match[2]));
  }
  // (b) arms = [ ... ]  /  ARMS = [ ... ]   (list of names or {key:...} dicts)
  const armsListLiteral = /\b(arms|ARMS)\s*=\s*\[([\s\S]*?)\]/g;
  while ((match = armsListLiteral.exec(content)) !== null) {
    names.push(...quotedStrings(match[2]));
  }
  return names;
}

// PURE core — returns { block, armNames }.
export function evaluate({ toolName, filePath, content }) {
  if (toolName !== 'Write') return { block: false };
  if (!filePath || !/\.py$/i.test(filePath)) return { block: false };
  if (!content) return { block: false };
  if (IS_DISPATCHER.test(filePath) || IS_SMOKE_OR_TEST.test(filePath)) return { block: false };
  if (!EXPERIMENT_WORKER.test(filePath)) return { block: false };
  if (content.includes(TOKEN)) return { block: false };

  const armNames = collectArmNames(content);
  // No enumerated arm set → nothing to judge (single-arm workers need human
  // review, not a regex — fail open).
  if (armNames.length === 0) return { block: false };

  // A control/ablation arm present anywhere in the enumerated set → good.
  const hasControl = armNames.some((name) => CONTROL_SIGNAL.test(name));
  if (hasControl) return { block: false };

  return { block: true, armNames };
}

function main() {
  try {
    if (process.env[ENV_OVERRIDE] === '1') { process.exit(0); }
    const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const toolName = payload.tool_name || '';
    const input = payload.tool_input || {};
    const verdict = evaluate({
      toolName, filePath: input.file_path || '', content: input.content || '',
    });
    if (!verdict.block) { process.exit(0); }

    const reason = `EXPERIMENT MISSING A CONTROL/ABLATION ARM — ${basename(input.file_path)}.

This experiment enumerates arms (${verdict.armNames.join(', ')}) but NONE of them is a
control or ablation — every arm is a treatment. A causal / load-bearing claim needs a matched
condition where the mechanism is REMOVED and is EXPECTED to fail (that failure is the proof the
mechanism is what buys the result).

exp147a did this right: no-wall / single-agent / random-mask arms that fail 9/9. exp147b shipped
with only a treatment arm + within-model ablation GATES and Russell caught it: "should be a hook
that requires ablation arms."

Add a control arm before writing — e.g. a "no-wall" / "no-tool" / "shuffled" / "baseline" arm that
trains the SAME setup with the mechanism removed, and record that its gates FAIL.

If this experiment is genuinely non-causal (a pure measurement / a plumbing smoke), add the token
\`${TOKEN}\` in a comment near the top and Write again. Env escape: ${ENV_OVERRIDE}=1.`;

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
