/**
 * style-verdict — the SHARED STYLE GOVERNOR. One combined verdict per turn, ever.
 *
 * THE BUG THIS EXISTS TO KILL (observed live, 2026-07-26): on ONE explaining turn, four
 * separate Stop hooks blocked SEQUENTIALLY — tests-must-pass, explain-as-you-work,
 * wall-text-guard, compass-line-guard. Each block forced a full rewrite, and Russell saw
 * EVERY draft stacked in the transcript: the same table and bullets three times over.
 * The stacking IS the defect. It is a hook-architecture problem, not a model problem.
 *
 * THE FIX (Russell's "build for the 10th experiment" rule — fix the CLASS in the shared
 * layer): every style/format checker is now a pure violation-DETECTOR. This governor runs
 * them all, merges their findings, and emits exactly ONE block message listing everything
 * at once — so Russell gets a single "here are the 3 things to fix", never a chain of four.
 *
 * TWO INDEPENDENT RAILS GUARANTEE "ONE":
 *   1. ONE PROCESS, ALL CHECKERS. hooks/style-governor.mjs is the registered Stop entry
 *      point and runs the whole registry in one process, so a turn with three violations
 *      produces one message with three items.
 *   2. AN ATOMIC PER-TURN CLAIM. Even if several style hooks stay registered (each of them
 *      now delegates here), the FIRST process to claim the turn — via an exclusive-create
 *      lock file, atomic on Windows and POSIX — is the only one that may speak. Every other
 *      process for that same turn returns null and exits silent. The claim also survives the
 *      model's re-stop after a rewrite, so one user prompt costs at most one style block.
 *
 * Fails OPEN everywhere. A governor that crashes must never be the reason all work stops.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readTranscript, currentTurnEntries, isHumanPrompt, roleOf, contentBlocks } from './transcript.mjs';
import { repeatedDraftViolations } from '../repeated-draft-guard.mjs';
import { overrideStated } from './quiet-overrides.mjs';

/** Where per-turn claims live. Tests override so they never touch the real state dir. */
export const STYLE_VERDICT_STATE_DIR =
  process.env.STYLE_VERDICT_STATE_DIR || resolve(homedir(), '.claude', 'state', 'style-verdict');

/** Claims older than this are swept (a turn is over long before then). */
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/** Env escape: waive ALL style gates for this stop. */
export const ENV_ESCAPE_VARS = ['STYLE_VERDICT_OK', 'NARRATION_CADENCE_OK'];

/**
 * Scope the governor to a subset of rules: STYLE_VERDICT_ONLY=prose-shape,compass-line.
 * Empty/unset means every registered rule runs. Each rule's own test uses this to exercise
 * ITS rule through the real hook process without a sibling rule's finding leaking into the
 * assertion — and it doubles as the operational way to run one rule in isolation.
 */
export function activeCheckers(checkers) {
  const scoped = String(process.env.STYLE_VERDICT_ONLY || '').trim();
  if (!scoped) return checkers || [];
  const allowedIds = new Set(scoped.split(',').map((id) => id.trim()).filter(Boolean));
  return (checkers || []).filter((checker) => allowedIds.has(checker?.id));
}

/** Reply-text escape tokens: waive ALL style gates for this turn. */
export const REPLY_ESCAPE_RE = /style-override:|explain-override:|NARRATION_OK/;

/** Count human prompts in a transcript — the monotonic turn number. */
export function humanPromptCount(entries) {
  let count = 0;
  for (const entry of entries || []) if (isHumanPrompt(entry)) count += 1;
  return count;
}

/** The stable identity of THIS turn: which transcript, which human prompt. */
export function turnKeyFor(payload, entries) {
  return `${payload?.transcript_path || ''}#${humanPromptCount(entries)}`;
}

/** The final assistant text of the turn — the reply Russell actually reads. */
export function finalReplyText(turnEntries) {
  for (let i = (turnEntries || []).length - 1; i >= 0; i--) {
    if (roleOf(turnEntries[i]) !== 'assistant') continue;
    const textBlocks = contentBlocks(turnEntries[i]).filter(
      (block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim()
    );
    if (textBlocks.length) return textBlocks.map((block) => block.text).join('\n');
  }
  return '';
}

function turnDigestFor(turnKey) {
  return createHash('sha1').update(turnKey).digest('hex').slice(0, 16);
}

/**
 * One claim file per (turn, REPLY TEXT). The reply digest is what makes both invariants hold at
 * once: every style hook process looking at the SAME reply collides on the same file, so Russell
 * still gets exactly one message per draft (the 2026-07-26 fix); but a REWRITE is different text,
 * so it gets its own file and is actually graded (the 2026-07-30 fix).
 */
function claimPathFor(turnKey, replyDigest = 'draft') {
  return join(STYLE_VERDICT_STATE_DIR, `turn-${turnDigestFor(turnKey)}.${replyDigest}.claim`);
}

function replyDigestFor(reply) {
  return createHash('sha1').update(String(reply || '')).digest('hex').slice(0, 12);
}

/** Best-effort sweep of expired claim files so the state dir never grows without bound. */
function sweepStaleClaims() {
  try {
    const cutoff = Date.now() - CLAIM_TTL_MS;
    for (const name of readdirSync(STYLE_VERDICT_STATE_DIR)) {
      if (!name.endsWith('.claim')) continue;
      const full = join(STYLE_VERDICT_STATE_DIR, name);
      try { if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * How many times one turn may be blocked on style.
 *
 * This used to be effectively ONE, and that was the bug Russell reported on 2026-07-30:
 * "the hook that prevents walls of text isn't working". It fired correctly, the reply got
 * rewritten — and the REWRITE was never looked at. A gate that grades the draft but never the
 * correction is a smoke alarm you silence by unplugging it. Two passes means the fix itself is
 * graded once; the cap is what stops an infinite Stop loop, so it must stay small and finite.
 */
export const MAX_TURN_BLOCKS = (() => {
  const configured = Number(process.env.STYLE_VERDICT_MAX_BLOCKS);
  return Number.isInteger(configured) && configured > 0 ? configured : 2;
})();

/**
 * Atomically claim one of this turn's allowed blocks.
 * Returns true while blocks remain, false once the turn has used its budget.
 * Exclusive-create ('wx') per attempt is atomic on Windows and POSIX — no lock-file race.
 */
export function claimTurn(turnKey, reply = '') {
  try {
    mkdirSync(STYLE_VERDICT_STATE_DIR, { recursive: true });
    sweepStaleClaims();
  } catch {
    return false; // cannot write state -> fail OPEN, never wedge the turn
  }
  if (turnBlockCount(turnKey) >= MAX_TURN_BLOCKS) return false; // anti-loop rail
  try {
    writeFileSync(
      claimPathFor(turnKey, replyDigestFor(reply)),
      JSON.stringify({ turnKey, ts: Date.now() }),
      { flag: 'wx' },
    );
    return true;
  } catch (error) {
    // EEXIST -> this exact reply already got its message; another hook process is looking at the
    // same draft. Any OTHER fs error must fail OPEN so a read-only state dir cannot wedge a turn.
    return false;
  }
}

/** How many style blocks this turn has already spent. (Read-only probe — does NOT claim.) */
export function turnBlockCount(turnKey) {
  try {
    const prefix = `turn-${turnDigestFor(turnKey)}.`;
    return readdirSync(STYLE_VERDICT_STATE_DIR)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.claim')).length;
  } catch {
    return 0;
  }
}

/** Has this turn used its whole block budget? (Read-only probe — does NOT claim.) */
export function turnAlreadyClaimed(turnKey) {
  return turnBlockCount(turnKey) >= MAX_TURN_BLOCKS;
}

/** Hard cap on items in one verdict. The block message must not itself be a wall of text. */
export const MAX_VERDICT_ITEMS = 6;

/**
 * Drop overlapping findings BEFORE they reach Russell's screen.
 *
 * Different rules legitimately notice the same offence — lib/prose-shape.mjs and the
 * narration guard both recognise "wall of text". Printing it twice is exactly the
 * redundancy this whole change exists to kill, just relocated into one message. So: the
 * first rule to report a given `kind` owns it; any later rule reporting the SAME kind is
 * dropped. Repeats of a kind WITHIN one rule survive (two different run-on sentences are
 * two real problems), and the whole list is capped so the verdict stays scannable.
 */
export function dedupeViolations(violations, cap = MAX_VERDICT_ITEMS) {
  const ownerOfKind = new Map();
  const kept = [];
  for (const violation of violations) {
    const kind = violation.kind || 'style';
    const owner = ownerOfKind.get(kind);
    if (owner === undefined) ownerOfKind.set(kind, violation.rule);
    else if (owner !== violation.rule) continue; // another rule already reported this kind
    kept.push(violation);
    if (kept.length >= cap) break;
  }
  return kept;
}

/**
 * Merge every checker's violations into ONE block message.
 * Violations are grouped by rule so the same rule never prints twice, and each rule's
 * guidance appears once at the end of its group.
 */
export function formatVerdict(violations, { isFinalPass = false } = {}) {
  const byRule = new Map();
  for (const violation of violations) {
    const rule = violation.rule || 'style';
    if (!byRule.has(rule)) byRule.set(rule, { label: violation.label || rule, items: [], guidance: [] });
    const group = byRule.get(rule);
    if (violation.label) group.label = violation.label;
    group.items.push(violation);
    // One rule can carry SEVERAL distinct guidance texts (the narration rule alone has separate
    // advice for cadence, ADHD prose and scannability). Keep every DISTINCT one — printing only
    // the first silently swallows the instructions for the other findings.
    if (violation.guidance && !group.guidance.includes(violation.guidance)) group.guidance.push(violation.guidance);
  }

  const problemCount = violations.length;
  const header = [
    `STOP — ${problemCount} style/format problem${problemCount === 1 ? '' : 's'} in this reply. `
      + (isFinalPass
        ? 'Your REWRITE still breaks these rules, and this is the LAST style check for this turn — '
          + 'whatever you send next reaches Russell unchecked.'
        : 'Fix ALL of them in one rewrite; the rewrite itself gets checked once.'),
    '',
    'Russell reads every draft you leave behind. Four hooks used to block one after another and he '
      + 'saw the same answer rewritten four times. Now they speak once, together. Rewrite ONCE.',
  ].join('\n');

  const sections = [];
  let index = 0;
  for (const [, group] of byRule) {
    const lines = [];
    for (const item of group.items) {
      index += 1;
      const measure = item.measure ? ` — ${item.measure}` : '';
      lines.push(`${index}. [${group.label}] ${item.kind}${measure}`);
      if (item.quote) lines.push(`     "${item.quote}"`);
    }
    for (const guidance of group.guidance) lines.push('', guidance);
    sections.push(lines.join('\n'));
  }

  const footer = [
    'Fix every item above in ONE rewrite, then stop again.',
    // Points at the SILENT channel, not at printing a token (2026-07-30). Telling the
    // assistant to write the token into the reply is what filled Russell's chat with
    // receipts in the first place; the escape still exists, it just stops being spoken.
    'Legitimate exception, declared silently: node ~/.claude/scripts/quiet-override.mjs style-override "<why>"',
  ].join('\n');

  return [header, ...sections, footer].join('\n\n');
}

/**
 * Run the whole style registry and produce at most ONE verdict.
 *
 * @param {object} payload  the raw Stop hook payload
 * @param {object} options
 * @param {Array}  options.checkers  [{ id, label, detect(context) -> violation[] }]
 * @returns {{decision:'block', reason:string}|null}
 */
export function runStyleGovernor(payload, { checkers } = {}) {
  try {
    const eventName = payload?.hook_event_name || payload?.hookEventName || '';
    if (eventName !== 'Stop') return null;
    // NOTE: `stop_hook_active` is deliberately NOT a bail-out. It is true on exactly the pass
    // that grades the REWRITE, so bailing there meant the corrected reply was never checked —
    // the reason Russell still saw walls of text after this hook "fired". MAX_TURN_BLOCKS is
    // the anti-loop rail now: bounded, deterministic, and it still terminates.
    for (const envVar of ENV_ESCAPE_VARS) if (process.env[envVar] === '1') return null;

    const entries = readTranscript(payload?.transcript_path);
    const turnEntries = currentTurnEntries(entries);
    if (!turnEntries || turnEntries.length === 0) return null; // malformed/empty -> fail open

    const reply = finalReplyText(turnEntries);
    // The escape is honored from EITHER channel: spoken in the reply (legacy, still works) or
    // declared silently via scripts/quiet-override.mjs. The silent path is the one the deny
    // message now advertises, because printing the token at Russell was the original complaint.
    if (REPLY_ESCAPE_RE.test(reply)) return null;
    if (overrideStated('style-override', '')) return null;

    const turnKey = turnKeyFor(payload, entries);
    const context = { payload, entries, turnEntries, reply, turnKey };

    // The repeated-draft check is special-cased OUTSIDE the registry below: its one job is to
    // police a RETRY that happens AFTER the turn's general claim is already taken (see
    // repeated-draft-guard.mjs's own header for the incident this exists to catch), so it must
    // run even when turnAlreadyClaimed(turnKey) is already true for every other checker. It gets
    // its own claim key so it, too, fires at most once per turn — never a third+ block.
    const repeatClaimKey = `${turnKey}::repeat`;
    if (!turnAlreadyClaimed(repeatClaimKey)) {
      const repeatViolations = repeatedDraftViolations(context);
      if (repeatViolations.length > 0 && claimTurn(repeatClaimKey)) {
        const named = repeatViolations.map((violation) => (
          { rule: 'repeated-draft', label: 'REPEATING YOUR OWN DRAFT', ...violation }
        ));
        return { decision: 'block', reason: formatVerdict(named) };
      }
    }

    // Cheap read-only probe first: if this turn already got its one verdict, stay silent and
    // do NOT create a second claim file.
    if (turnAlreadyClaimed(turnKey)) return null;

    const violations = [];
    for (const checker of activeCheckers(checkers)) {
      try {
        const found = checker?.detect?.(context);
        if (!Array.isArray(found)) continue;
        for (const violation of found) {
          violations.push({ rule: checker.id, label: checker.label || checker.id, ...violation });
        }
      } catch { /* one broken checker must never silence the rest, or block the turn */ }
    }
    const finalViolations = dedupeViolations(violations);
    if (finalViolations.length === 0) return null;

    // Atomic claim LAST: only take the turn if we actually have something to say, so a
    // clean turn never burns the claim that a later (re-)stop might legitimately need.
    const spentBefore = turnBlockCount(turnKey);
    if (!claimTurn(turnKey, reply)) return null;

    return {
      decision: 'block',
      reason: formatVerdict(finalViolations, {
        isFinalPass: spentBefore + 1 >= MAX_TURN_BLOCKS,
      }),
    };
  } catch {
    return null; // fail open, always
  }
}
