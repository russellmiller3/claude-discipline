#!/usr/bin/env node
/**
 * plan-core-journey-guard — PLAN-TIME gate. When a plan is written, force it to be checked
 * against the product's ONE core end-to-end journey, so we never keep shipping isolated
 * COMPONENTS while the thing the product exists to do stays unwired.
 *
 * Why this exists (2026-06-29, Russell — floored): I built skaffen-desktop's engine (acts),
 * brain (chats), bridges, conversation layer, and UI — each green, each merged — but NEVER
 * wired the brain to the engine, so the product (an agent that OPERATES your desktop) could
 * not actually act. The README stated the core job clearly; what was missing was a step that
 * CHECKS each plan against it. Russell: "shouldn't the hook fire at plan time not at ship
 * time?" — yes: by ship time the isolation is already baked in.
 *
 * Mechanism:
 *  - A project declares its core journey in NORTH_STAR.md at the repo root:
 *      core_journey: <one sentence — the user-facing thing the product must do end-to-end>
 *      proof: <path to the integration test/file that proves the WHOLE journey works>
 *  - First plan in a project with NO NORTH_STAR.md → BLOCK: declare the core journey first,
 *    so every plan can be checked against it.
 *  - A plan written while the proof path is MISSING (core unwired) and the plan does NOT
 *    address the core journey → BLOCK: this plan must include the phase that wires the whole,
 *    or you must explicitly defer (NORTH_STAR_DEFER_OK + Russell's sign-off).
 *
 * Teeth: permissionDecision:'deny'. Override: NORTH_STAR_DEFER_OK in the plan content.
 * Fail-open on any unexpected error.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A plan file: under a plans/ dir, or a `plan-*`/`*-plan.md` markdown file. */
export function isPlanPath(filePath) {
  if (!filePath) return false;
  const normalized = String(filePath).replace(/\\/g, '/').toLowerCase();
  if (!normalized.endsWith('.md')) return false;
  return /(?:^|\/)plans?\//.test(normalized) || /(?:^|\/)plan[-_][^/]*\.md$/.test(normalized) ||
    /[-_]plan\.md$/.test(normalized);
}

/** Parse NORTH_STAR.md content → { coreJourney, proof } (both optional). */
export function parseNorthStar(northStarText) {
  const coreJourney = (northStarText.match(/^\s*core[_\s-]?journey\s*:\s*(.+)$/im) || [])[1]?.trim() || '';
  const proof = (northStarText.match(/^\s*proof\s*:\s*(.+)$/im) || [])[1]?.trim() || '';
  return { coreJourney, proof };
}

/**
 * Decide on one PreToolUse Write/Edit event. Pure: callers inject `projectRoot`,
 * `readNorthStar(root) -> content|null`, and `fileExists(absPath) -> bool`.
 */
export function decidePlanGate(event, { projectRoot, readNorthStar, fileExists, readFile }) {
  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'PreToolUse') return null;
  const toolName = event.tool_name || event.toolName || '';
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return null;

  const input = event.tool_input || event.toolInput || {};
  const filePath = input.file_path || input.path || '';
  if (!isPlanPath(filePath)) return null;

  // The text of THIS write/edit (Write = full content; Edit/MultiEdit = the new fragment(s)).
  const editText = String(
    input.content || input.new_string || (Array.isArray(input.edits) ? input.edits.map((edit) => edit.new_string || '').join('\n') : '') || ''
  );
  // Judge the WHOLE plan, not just this fragment. A plan is authored section-by-section
  // (the write-plan skill MANDATES incremental Edits), so an individual Edit's new_string
  // rarely names the core journey even when the plan as a whole does. For an Edit/MultiEdit
  // to an existing plan, fold in the file's current content so the keyword checks below see
  // the full plan; a Write already carries the full content. (Fail-safe: if the file can't
  // be read, fall back to the fragment alone.)
  const existingPlan = (toolName !== 'Write' && typeof readFile === 'function') ? (readFile(filePath) || '') : '';
  const planContent = `${existingPlan}\n${editText}`;
  if (/\bNORTH_STAR_DEFER_OK\b/.test(planContent)) return null;

  const northStarText = readNorthStar(projectRoot);
  if (!northStarText) {
    return deny(
      `Plan BLOCKED — declare the product's CORE JOURNEY first.\n\n` +
      `Russell's rule (2026-06-29): before planning more COMPONENTS, state the ONE end-to-end thing the product must do for a user — so every plan is checked against it (the failure this prevents: shipping parts that each pass tests while the whole stays inert).\n\n` +
      `Create NORTH_STAR.md at the repo root:\n` +
      `  core_journey: <one sentence — the user-facing thing it must do end to end>\n` +
      `  proof: <path to the integration test that exercises the WHOLE journey>\n\n` +
      `Then re-write this plan. (Override for a genuinely non-product repo: NORTH_STAR_DEFER_OK in the plan.)`
    );
  }

  const { coreJourney, proof } = parseNorthStar(northStarText);
  if (!proof) return null; // north-star exists but declares no proof path — nothing to check

  const proofAbs = isAbsolute(proof) ? proof : resolve(projectRoot, proof);
  const coreIsWired = fileExists(proofAbs);
  if (coreIsWired) return null; // the whole already works — plan freely

  // Core journey is UNWIRED. Does THIS plan address it (name the proof, the journey, or wire/integration intent)?
  const lowerPlan = planContent.toLowerCase();
  const proofBase = basename(proof).toLowerCase().replace(/\.[^.]+$/, '');
  const addressesCore =
    lowerPlan.includes(proof.toLowerCase()) ||
    (proofBase.length > 3 && lowerPlan.includes(proofBase)) ||
    /\bend[-\s]?to[-\s]?end\b|\be2e\b|\bcore journey\b|\bintegrat(e|ion|ing)\b|\bwire(s|d|\s+the)?\b.*\b(engine|brain|together|whole)\b/.test(lowerPlan);
  if (addressesCore) return null;

  return deny(
    `Plan BLOCKED — the core journey is still UNWIRED and this plan doesn't address it.\n\n` +
    `NORTH_STAR core journey: ${coreJourney || '(see NORTH_STAR.md)'}\n` +
    `Its end-to-end proof (${proof}) does NOT exist yet — so the product can't actually do its one job.\n\n` +
    `Russell's rule: don't plan yet another isolated COMPONENT while the whole is inert. This plan must either:\n` +
    `  - include the phase that WIRES the core journey end-to-end (and creates that proof), OR\n` +
    `  - explicitly defer it with Russell's sign-off: add NORTH_STAR_DEFER_OK to the plan + say why the component comes first.`
  );
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/** Walk up to the nearest ancestor containing a `.git` (the project root). */
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
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); return; }
  const input = event.tool_input || event.toolInput || {};
  const filePath = input.file_path || input.path || '';
  const startDir = filePath ? dirname(isAbsolute(filePath) ? filePath : resolve(event.cwd || process.cwd(), filePath)) : (event.cwd || process.cwd());
  const projectRoot = findProjectRoot(startDir) || event.cwd || process.cwd();
  const decision = decidePlanGate(event, {
    projectRoot,
    readNorthStar: (root) => { try { return readFileSync(join(root, 'NORTH_STAR.md'), 'utf8'); } catch { return null; } },
    fileExists: (candidate) => existsSync(candidate),
    readFile: (candidate) => { try { return readFileSync(candidate, 'utf8'); } catch { return null; } },
  });
  if (decision) process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

const invokedAsScript = process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1]);
if (invokedAsScript) main();
