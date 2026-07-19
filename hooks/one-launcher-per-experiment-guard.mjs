#!/usr/bin/env node
// =============================================================================
// ONE-LAUNCHER-PER-EXPERIMENT-GUARD — PreToolUse(Write/Edit): a per-experiment
//   RunPod launcher `runpod_exp<N>.py` must reference ONLY its OWN experiment's
//   worker scripts — never bolt a sibling experiment's worker/arm onto it.
// =============================================================================
//
// new-hook-category: One-file-per-experiment discipline — nearest existing is
// experiment-manifest-guard (reproduction manifest present) and check-runner-logger
// (reuse shared infra). NEITHER checks that a NUMBERED launcher stays scoped to its own
// experiment. Different invariant: no cross-experiment arm bolting.
//
// THE MISTAKE (2026-07-19, Russell: "why is the script called 147? there should be a
// sep script for each exp"): `runpod_exp147.py` began as exp147's launcher, then grew
// `--arm tools`/`spawn`/`memento` bolted on for exp147c / exp147d / exp149 — FIVE
// experiments sharing one numbered launcher. It referenced `exp147c_qwen_tools.py`,
// `exp147d_qwen_spawn.py`, `exp149_qwen_memento.py` from a file named for exp147. That
// violates "one .py per experiment" (memory new-py-file-per-experiment). A learning +
// a skill rule already existed and STILL failed to stop it — so, structure.
//
// RULE: BLOCK a Write/Edit to a file named `runpod_exp<ID>.py` whose content references
// a science-worker script `exp<OTHER>_*.py` (or `scripts/exp<OTHER>_...`) where OTHER is
// a DIFFERENT experiment id than the file's own ID. The file's own workers are allowed;
// shared infra (exp146 transport/image, the generic runpod_experiment_launcher) is NOT a
// science worker and is exempt. Forces: pod machinery -> runner; per-exp arms -> its own
// runpod_exp<ID>.py from the shared launcher template.
//
// Override: launcher-scope-ok: <why this cross-experiment reference is correct> (rare —
// e.g. a genuine migration shim). Teeth: permissionDecision 'deny'. Fail-open.
// =============================================================================

import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_RE = /\blauncher-scope-ok\s*:/i;

// Shared infra experiment ids that any launcher may reference (transport/image base),
// NOT a per-experiment science worker.
const INFRA_IDS = new Set(['146']);

// A per-experiment launcher filename: runpod_exp<ID>.py  (ID = digits + optional letter).
const LAUNCHER_NAME_RE = /^runpod_exp(\d+[a-z]?)\.py$/i;

// A science-worker script reference in content: exp<ID>_<something>.py
const WORKER_REF_RE = /\bexp(\d+[a-z]?)_[A-Za-z0-9_]*\.py\b/gi;

// Pure detector: given the launcher's filename and its content, return the list of
// FOREIGN experiment ids it references (empty = clean). Exported for the test.
export function foreignExperimentIds(fileName, content) {
  const nameMatch = LAUNCHER_NAME_RE.exec(basename(fileName));
  if (!nameMatch) return [];               // not a per-experiment launcher — not our concern
  const ownId = nameMatch[1].toLowerCase();
  const foreign = new Set();
  for (const workerMatch of content.matchAll(WORKER_REF_RE)) {
    const refId = workerMatch[1].toLowerCase();
    if (refId === ownId) continue;         // own worker — fine
    if (INFRA_IDS.has(refId)) continue;    // shared transport/image infra — fine
    foreign.add(refId);
  }
  return [...foreign];
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0); // fail-open on unparseable input
  }
  const toolName = payload?.tool_name || '';
  if (toolName !== 'Write' && toolName !== 'Edit') process.exit(0);
  const toolInput = payload?.tool_input || {};
  const fileName = toolInput.file_path || toolInput.path || '';
  if (!LAUNCHER_NAME_RE.test(basename(fileName))) process.exit(0);

  // The content that will land: Write -> content; Edit -> new_string.
  const content = toolInput.content ?? toolInput.new_string ?? '';
  if (OVERRIDE_RE.test(content)) process.exit(0);

  const foreign = foreignExperimentIds(fileName, content);
  if (foreign.length === 0) process.exit(0);

  const own = LAUNCHER_NAME_RE.exec(basename(fileName))[1];
  const message =
    `ONE-LAUNCHER-PER-EXPERIMENT — ${basename(fileName)} (experiment ${own}) references a ` +
    `DIFFERENT experiment's worker: ${foreign.map((id) => `exp${id}_*.py`).join(', ')}.\n\n` +
    `A numbered launcher must run ONLY its own experiment's workers. Bolting a sibling ` +
    `experiment's arm onto it is the exp147-reuse mistake (Russell, 2026-07-19). Each ` +
    `experiment gets its OWN runpod_exp<ID>.py built from the shared launcher template ` +
    `(scripts/runpod_experiment_launcher.py: ExperimentLaunchConfig + run_experiment_cli); ` +
    `the pod machinery lives in runner, never re-forked per experiment.\n\n` +
    `Fix: move exp${foreign[0]}'s arm into runpod_exp${foreign[0]}.py. ` +
    `Override (rare migration shim): put "launcher-scope-ok: <why>" in the file content.`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    },
  }));
  process.exit(0);
}

// Only run main() when invoked directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
