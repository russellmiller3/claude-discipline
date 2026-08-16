#!/usr/bin/env node
/**
 * compass-line-guard — Stop hook. Every fifth update emits an ADHD-friendly Roadmap Brief
 * grounded in the project's own roadmap artifact. The obsolete "Mission:" prefix is rejected.
 *
 * Russell, 2026-07-26: never label updates "Mission:". Updates are 2-3 high-level sentences;
 * every 4-5 updates they reconnect work to the North Star. That checkpoint is now a compact
 * Roadmap Brief: a scannable map, an evidence-backed YOU ARE HERE marker, literal current work,
 * proven/unproven boundary, and next gate. The agent chooses the authoritative roadmap artifact
 * from the project's own candidates; the hook never hard-codes one filename or document type.
 *   (3) PLAN CLARITY — every numbered-plan reference must also say what that plan does.
 *       This check runs on every reply, independent of the periodic compass cadence.
 *
 * History (superseded by the 2026-07-05 redesign, kept for the record): this hook was
 * created 2026-07-03 to force EVERY reply to open with a "compass" line, then widened the
 * same day to fire on all responses (working or chat). That every-message enforcement is
 * exactly what Russell reversed here.
 *
 * RULES:
 *   (1) No reply may open with the obsolete "Mission:" label.
 *   (2) On every fifth update, the reply must carry a compact Roadmap Brief grounded in the
 *       project's own roadmap artifact and explain how the active work advances the goal.
 *
 * TURN COUNTER (idempotent)
 *   A small state file (`~/.claude/state/compass-line-state.json`) tracks a turn counter
 *   and the number of human prompts already counted. The counter advances exactly ONCE
 *   per genuine turn (keyed off the human-prompt count in the transcript, which is
 *   monotonic — one per turn), so the anti-loop re-fire below (same turn, fired twice)
 *   never double-counts, and a crash/re-run is idempotent.
 *
 * ANTI-LOOP RAIL
 *   Mirrors ~15 sibling Stop hooks: Claude Code sets `stop_hook_active: true` on the
 *   re-invocation caused by this hook's OWN block. On that re-entrant pass we never block
 *   again (no infinite loop); the counter is not advanced a second time either.
 *
 * Fails open (exit 0, no output) on any malformed/missing transcript, parse error, or
 * unexpected exception — this hook must never be the reason ALL work grinds to a halt.
 */

import { roleOf, contentBlocks, isHumanPrompt } from './lib/transcript.mjs';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

// Kept for compatibility with older callers; it is no longer required in replies.
export const COMPASS_MARKER = String.fromCodePoint(0x1f9ed);

// How many updates between required North Star checkpoints. Every Nth update
// (counter % INTERVAL === 0) requires the connection. 5 = Russell's requested cadence.
export const COMPASS_TURN_INTERVAL = 5;

// Default state path is the shared per-user state dir; COMPASS_STATE_FILE overrides it (tests point
// this at a temp file so they never touch — or depend on — the real cross-session counter).
const STATE_FILE = process.env.COMPASS_STATE_FILE || resolve(homedir(), '.claude', 'state', 'compass-line-state.json');

/** The final assistant text message in the turn (the reply Russell actually reads). */
export function finalReplyText(turnEntries) {
  for (let i = turnEntries.length - 1; i >= 0; i--) {
    if (roleOf(turnEntries[i]) !== 'assistant') continue;
    const textBlocks = contentBlocks(turnEntries[i]).filter(
      (block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim()
    );
    if (textBlocks.length) return textBlocks.map((block) => block.text).join('\n');
  }
  return '';
}

/** The first non-whitespace line of a reply (what Russell's eye actually lands on first). */
export function firstNonBlankLine(replyText) {
  const lines = (replyText || '').split('\n');
  for (const line of lines) {
    if (line.trim()) return line.trim();
  }
  return '';
}

/** Does the reply naturally connect a named task/plan to the North Star? */
export function hasCompassOpening(replyText) {
  const reply = String(replyText || '');
  const namesNorthStar = /\bnorth\s*star\b/iu.test(reply);
  const namesWork = /\b(?:task|work|plan\s+#?\d+[a-z]?)\b/iu.test(reply);
  const explainsProgress = /\b(?:advance[sd]?|push(?:es|ed|ing)?|move[sd]?|moving|unlock(?:s|ed|ing)?|toward|because|so that)\b/iu.test(reply);
  return namesNorthStar && namesWork && explainsProgress;
}

/**
 * THE ANCHOR — Goal / Task / Doing now, at the top of every working message.
 *
 * Russell, 2026-08-16, verbatim: "I need you to always speak in terms of the higher level goal, as
 * a global rule. otherwise I lose my place." That day the standard was added to the every-turn
 * injection and nothing checked it, so it was ADVICE. Advice is exactly what got ignored: two
 * replies later he had to say "FOLLOW MY NARRATIVE RULE" in capitals. An injected rule with no
 * detector is a suggestion; this makes it a gate.
 *
 * Deliberately shape-only. It asks whether the three labels are present and near the top -- not
 * whether the Goal is the RIGHT goal, which no regex can judge. Cheap to satisfy honestly, and
 * impossible to satisfy by accident.
 */
const ANCHOR_GOAL_RE = /^\s*(?:[*_#>\s]*)goal\s*:/imu;
const ANCHOR_TASK_RE = /^\s*(?:[*_#>\s]*)task\s*:/imu;
const ANCHOR_DOING_RE = /^\s*(?:[*_#>\s]*)doing\s+now\s*:/imu;

/** How far into a reply the anchor may appear before it stops being an anchor. */
const ANCHOR_WINDOW_LINES = 8;

export function hasNarrativeAnchor(replyText) {
  const opening = String(replyText || '').split('\n').slice(0, ANCHOR_WINDOW_LINES).join('\n');
  return ANCHOR_GOAL_RE.test(opening) && ANCHOR_TASK_RE.test(opening) && ANCHOR_DOING_RE.test(opening);
}

const ROADMAP_EMOJI_RE = /\p{Extended_Pictographic}/u;
const ROADMAP_MAP_RE = /(?:^|\n)\s*(?:\d+[.)]|[-*+]\s)|[├└│]|(?:<-|->|→)/m;

/** Does a periodic update contain the compact, ADHD-friendly Roadmap Brief contract? */
export function hasRoadmapBrief(replyText) {
  const reply = String(replyText || '');
  const namesRoadmap = /\b(?:roadmap|you are here|current rung|where we are)\b/iu.test(reply);
  const marksCurrentRung = /\b(?:you are here|current rung)\b/iu.test(reply);
  const namesNorthStar = /\b(?:north\s*star|goal:)\b/iu.test(reply);
  const namesCurrentWork = /\b(?:what i am doing|current action|literally|right now)\b/iu.test(reply);
  const namesConcreteEvidence = /\b(?:concrete evidence|concrete fact)\b/iu.test(reply);
  const namesProven = /\bproven\b/iu.test(reply);
  const namesUnproven = /\b(?:unproven|not proven)\b/iu.test(reply);
  const namesNext = /\bnext\b/iu.test(reply);
  return namesRoadmap
    && marksCurrentRung
    && namesNorthStar
    && namesCurrentWork
    && namesConcreteEvidence
    && namesProven
    && namesUnproven
    && namesNext
    && ROADMAP_MAP_RE.test(reply)
    && ROADMAP_EMOJI_RE.test(reply);
}

/**
 * A reply short enough to be a direct factual answer is never asked to carry a grounding status —
 * not every session opens with work ("what port does the monitor use?" deserves "Port 8646.").
 */
export const MIN_GROUNDING_REPLY_WORDS = 60;

/** The four things a session-open grounding must state. Mechanical markers, not a semantic judge. */
const GROUNDING_MARKERS = [
  { part: 'the North Star / overarching goal', pattern: /\b(?:north\s*star|the goal\b|goal:)/iu },
  {
    part: 'where we are right now',
    pattern: /\b(?:where we are|currently|right now|so far|state of play|last session|as of|we (?:just|already|now)|status[:\s]|today\b|stands? at)/iu,
  },
  {
    part: "what's next",
    pattern: /\b(?:what(?:'s| is) next|next\b|then\b|after that|from here|the plan is|about to|upcoming)/iu,
  },
  {
    part: 'how what is next connects back to the goal',
    pattern: /\b(?:advance[sd]?|push(?:es|ed|ing)?|move[sd]?|moving|unlock(?:s|ed|ing)?|toward|because|so that|which means)/iu,
  },
];

/** Which grounding parts this reply is missing. Empty array = properly grounded. */
export function missingGroundingParts(replyText) {
  const reply = String(replyText || '');
  return GROUNDING_MARKERS.filter((marker) => !marker.pattern.test(reply)).map((marker) => marker.part);
}

/** Does the reply carry a full grounding status (goal, current state, next step, and the link)? */
export function hasGroundingStatus(replyText) {
  return missingGroundingParts(replyText).length === 0;
}

/**
 * Is this the FIRST turn of this session? The transcript is per-session, so its human-prompt count
 * is a session-scoped, stateless signal — unlike the persisted compass counter, which is
 * CROSS-session and therefore structurally unable to recognise a session opening.
 */
export function isFirstTurnOfSession(entries) {
  return humanPromptCount(entries || []) === 1;
}

/** Words in a reply, fenced code excluded (a pasted diff is not prose Russell has to read). */
export function replyWordCount(replyText) {
  return String(replyText || '').replace(/```[\s\S]*?```/g, '').trim().split(/\s+/).filter(Boolean).length;
}

export function hasMissionPrefix(replyText) {
  return /^(?:\s|\p{Emoji_Presentation})*(?:\*\*)?mission\s*:/iu.test(firstNonBlankLine(replyText));
}

const PLAN_REFERENCE_RE = /\bPlan\s+#?\d+[a-z]?\b/gi;

function descriptiveWordCount(text) {
  return (String(text || '').match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
}

/**
 * Return plan-number references that never say what the plan does.
 *
 * Accepted, deliberately explicit shapes:
 *   Plan 170 — the learned-route canary comparing Zork with ordinary tools
 *   the learned-route canary comparing Zork with ordinary tools (Plan 170)
 *
 * A bare label such as "Plan 170's blockers" fails. The number is bookkeeping; Russell needs
 * the purpose every time because several numbered plans can be active in one session.
 */
export function planReferencesWithoutPurpose(replyText) {
  const missing = [];
  for (const line of String(replyText || '').split('\n')) {
    for (const match of line.matchAll(PLAN_REFERENCE_RE)) {
      const reference = match[0];
      const start = match.index || 0;
      const before = line.slice(0, start);
      const after = line.slice(start + reference.length);

      const labeledSuffix = after.match(/^\s*(?:[—–:-]\s*|\(\s*)([^)\n.!?]{1,180})/);
      const appositiveSuffix = after.match(/^\s*,\s+(?:the|an?|our)\s+([^,.;!?]{1,180})(?:,|$)/i);
      const purposeFirst = /^\s*\)/.test(after)
        ? before.match(/([^.!?;:\n]{1,180})\(\s*$/)
        : null;

      const described = [labeledSuffix?.[1], appositiveSuffix?.[1], purposeFirst?.[1]]
        .some((description) => descriptiveWordCount(description) >= 3);
      if (!described) missing.push(reference);
    }
  }
  return missing;
}

/** How many genuine human prompts are in the transcript — monotonic, one per turn. */
export function humanPromptCount(entries) {
  let count = 0;
  for (const entry of entries) if (isHumanPrompt(entry)) count += 1;
  return count;
}

/**
 * Decide whether THIS turn must carry a North Star checkpoint.
 * turnCounter is 1-based (first ever turn = 1). counter % INTERVAL === 0 fires on updates 5, 10, 15…
 */
export function shouldRequireCompass({ turnCounter }) {
  if (turnCounter > 0 && turnCounter % COMPASS_TURN_INTERVAL === 0) return true;
  return false;
}

/** Read the persisted state; tolerate a missing/corrupt file (returns a fresh zero state). */
export function readState() {
  try {
    if (!existsSync(STATE_FILE)) return { turnCounter: 0, humanPromptCount: 0 };
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      turnCounter: Number(parsed.turnCounter) || 0,
      humanPromptCount: Number(parsed.humanPromptCount) || 0,
    };
  } catch {
    return { turnCounter: 0, humanPromptCount: 0 };
  }
}

/** Persist state. Best-effort — a write failure must never block the turn. */
export function writeState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    /* fail-open: state is an optimization, not a correctness requirement */
  }
}

/** Find a northstar file at/near the given root (root itself, then up to 3 parents). Returns its
 *  path or ''. `northstar-ledger.md` is preferred; any `*northstar*.md` also matches. */
export function findNorthstarFile(startDirectory) {
  let currentDirectory = resolve(startDirectory || process.cwd());
  for (let hop = 0; hop < 4; hop++) {
    try {
      const preferred = resolve(currentDirectory, 'northstar-ledger.md');
      if (existsSync(preferred)) return preferred;
      const named = readdirSync(currentDirectory).find((name) => /northstar/i.test(name) && /\.md$/i.test(name));
      if (named) return resolve(currentDirectory, named);
    } catch {
      /* unreadable dir — keep climbing */
    }
    const parentDirectory = resolve(currentDirectory, '..');
    if (parentDirectory === currentDirectory) break;
    currentDirectory = parentDirectory;
  }
  return '';
}

const ROADMAP_ARTIFACT_RE = /(?:roadmap|progress[-_ ]?map|northstar|truth|handoff)/i;

function roadmapArtifactPriority(name) {
  const lowered = name.toLowerCase();
  if (lowered.startsWith('roadmap-brief')) return 0;
  if (lowered.includes('roadmap')) return 1;
  if (lowered.includes('progress') && lowered.includes('map')) return 2;
  if (lowered.includes('northstar')) return 3;
  if (lowered.includes('truth')) return 4;
  return 5;
}

/**
 * Return likely roadmap artifacts without declaring one authoritative. Find the nearest project
 * boundary first, then search its root and docs directory. This accepts any regular file extension
 * so an agent can choose the actual source of truth whether it is Markdown, HTML, or another
 * format, while never leaking a neighboring project's stale roadmap into the candidate list.
 */
export function findRoadmapArtifacts(startDirectory) {
  const start = resolve(startDirectory || process.cwd());
  const collectArtifacts = (projectDirectory) => {
    const artifacts = [];
    const seen = new Set();
    for (const candidateDirectory of [projectDirectory, resolve(projectDirectory, 'docs')]) {
      try {
        const names = readdirSync(candidateDirectory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && ROADMAP_ARTIFACT_RE.test(entry.name))
          .map((entry) => entry.name)
          .sort((left, right) => roadmapArtifactPriority(left) - roadmapArtifactPriority(right)
            || left.localeCompare(right));
        for (const name of names) {
          const artifact = resolve(candidateDirectory, name);
          if (seen.has(artifact)) continue;
          seen.add(artifact);
          artifacts.push(artifact);
        }
      } catch {
        /* unreadable or absent directory — no candidate from this location */
      }
    }
    return artifacts;
  };

  const localArtifacts = collectArtifacts(start);
  if (localArtifacts.length > 0) return localArtifacts;

  let currentDirectory = start;
  for (let hop = 0; hop < 4; hop++) {
    if (existsSync(resolve(currentDirectory, '.git'))
        || existsSync(resolve(currentDirectory, 'AGENTS.md'))
        || existsSync(resolve(currentDirectory, 'CLAUDE.md'))
        || existsSync(resolve(currentDirectory, 'package.json'))
        || existsSync(resolve(currentDirectory, 'pyproject.toml'))) {
      return collectArtifacts(currentDirectory);
    }
    const parentDirectory = resolve(currentDirectory, '..');
    if (parentDirectory === currentDirectory) break;
    currentDirectory = parentDirectory;
  }
  return [];
}

export function compassGuidance(northstarFile) {
  const northstarHint = northstarFile
    ? `Your project has a Northstar file (${northstarFile}). Name the specific goal from it that this advances.`
    : `Name the overarching North Star goal this advances (no northstar-ledger.md found — state the goal in plain English).`;

  return `Use 2-3 natural, high-level sentences. Restate the North Star, name the active task or plan, and explain how this work advances that goal. Do not prefix the update with "Mission:". ${northstarHint}`;
}

export function roadmapBriefGuidance(artifacts) {
  const sourceHint = artifacts.length
    ? `Read the project's current roadmap source before writing. Candidates: ${artifacts.join(', ')}. Pick the document that actually owns the roadmap; a filename is a lead, not authority. Reconcile it against the handoff, current branch, and latest evidence.`
    : 'No roadmap artifact is discoverable nearby. Build a clearly labeled provisional 3-6 rung map from the current handoff, branch, and latest evidence; do not canonize it.';
  return `Write an ADHD-friendly Roadmap Brief, not a generic status. Use meaningful emoji and a compact ASCII or numbered map with an evidence-backed YOU ARE HERE marker. Then show: North Star; What I am doing - literally; one concrete evidence example; Proven versus unproven; and Next. ${sourceHint}`;
}

/**
 * PURE DETECTOR for the shared style governor (hooks/lib/style-verdict.mjs).
 * Returns [] (compliant / not a checkpoint turn) or ONE violation object. It never writes a
 * block itself — the governor merges this with every other style finding into one message.
 *
 * The turn counter still advances here, and is still idempotent: it only moves when the
 * monotonic human-prompt count exceeds the persisted one, so several delegating hook
 * processes in the same Stop event cannot double-count a turn.
 */
export function compassViolations({ payload = {}, entries = [], turnEntries = [], reply = '' } = {}) {
  if (!turnEntries.length) return [];
  if (!reply) return []; // no text reply to check (e.g. tool-only trailing message)

  const violations = [];

  // The anchor comes FIRST, ahead of every other compass check, because it is the thing Russell
  // reads before anything else. Without it he cannot tell a legitimate sub-step from a rabbit hole
  // and has to stop and ask -- which costs far more energy than the three lines ever do.
  if (!hasNarrativeAnchor(reply)) {
    violations.push({
      kind: 'missing the Goal / Task / Doing now anchor',
      measure: 'the reply does not open with all three anchor lines',
      guidance: 'Open with the anchor, in this order:\n'
        + '  Goal: <the OUTCOME Russell wants, in HIS words — never a component or ticket name>\n'
        + '  Task: <the one thing being worked right now, one plain line>\n'
        + '  Doing now:\n'
        + '    <emoji> <one short line>\n'
        + '    <emoji> <one short line>\n'
        + 'The Goal line never changes just because a sub-step did; if it would change, say that out '
        + 'loud instead of quietly rewriting it. Then teach when it helps ("This is like ...") and add '
        + 'a small emoji diagram whenever a shape, flow or contrast is the actual point.',
    });
  }

  if (hasMissionPrefix(reply)) {
    violations.push({
      kind: 'obsolete Mission prefix',
      measure: 'updates must start naturally, not with "Mission:"',
      guidance: 'Remove the "Mission:" label. Give 2-3 high-level sentences: the outcome, why it matters, and the next gate.',
    });
  }

  const barePlanReferences = planReferencesWithoutPurpose(reply);
  if (barePlanReferences.length) {
    violations.push({
      kind: 'plan number lacks purpose',
      measure: `${barePlanReferences.join(', ')} names bookkeeping but not what the plan does`,
      guidance: 'Name the purpose every time: “Plan 170 — the learned-route canary comparing Zork with ordinary tools” or “the learned-route canary comparing Zork with ordinary tools (Plan 170).” Never use only the number.',
    });
  }

  const state = readState();
  const promptCount = humanPromptCount(entries);
  const isNewTurn = promptCount > state.humanPromptCount;
  const turnCounter = isNewTurn ? state.turnCounter + 1 : state.turnCounter;
  if (isNewTurn) writeState({ turnCounter, humanPromptCount: promptCount });

  // SESSION-OPEN GROUNDING (Russell, 2026-07-31, verbatim): "every new session needs to start with
  // a grounding status of where we are vs the northstar goals and how whats next relates."
  // The every-5 cadence below cannot deliver this — `turnCounter` is CROSS-session, so a fresh
  // session's first turn is the one turn structurally guaranteed to be exempt. That is exactly
  // backwards: the opening turn is when Russell has the LEAST context and needs it most.
  // This is the stronger requirement, so when it fires the cadence checkpoint stays quiet — one
  // ask per turn, never two overlapping demands for the same paragraph.
  if (isFirstTurnOfSession(entries)
      && replyWordCount(reply) >= MIN_GROUNDING_REPLY_WORDS
      && !hasGroundingStatus(reply)) {
    violations.push({
      kind: 'missing session grounding',
      measure: `first reply of the session is missing: ${missingGroundingParts(reply).join('; ')}`,
      guidance: 'Open a session with the grounding status, before anything else: the North Star in '
        + 'plain English, where the work stands right now, what happens next, and how that next step '
        + 'advances the goal. Four short lines or bullets is enough. '
        + compassGuidance(findNorthstarFile(payload.cwd || process.cwd())),
    });
    return violations;
  }

  if (!shouldRequireCompass({ turnCounter })) return violations; // global wording rules still apply
  if (hasRoadmapBrief(reply)) return violations;

  const roadmapArtifacts = findRoadmapArtifacts(payload.cwd || process.cwd());
  violations.push({
    kind: 'missing Roadmap Brief',
    measure: `update ${turnCounter} is the every-${COMPASS_TURN_INTERVAL}-update checkpoint and lacks the map, evidence boundary, or next gate`,
    guidance: roadmapBriefGuidance(roadmapArtifacts),
  });
  return violations;
}

// This hook no longer blocks on its own. It delegates to the SHARED STYLE GOVERNOR, which runs
// every style checker and emits ONE combined verdict per turn — see hooks/lib/style-verdict.mjs
// for why (four hooks blocking sequentially made Russell read four stacked drafts, 2026-07-26).
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

// Entry-point guard: only read stdin and run when invoked directly as the hook process, never when
// this module is merely IMPORTED (e.g. by its own test file to reach the exported primitives) —
// importing must not block on a stdin read that will never arrive.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => process.exit(0));
}
