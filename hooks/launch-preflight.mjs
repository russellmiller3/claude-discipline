#!/usr/bin/env node
/**
 * launch-preflight — PreToolUse. Injects the `launch-agent` skill's relevant
 * checklist section BEFORE an Agent spawn or a training/benchmark command fires.
 * It also enforces the one mechanically checkable experiment-launch invariant:
 * a durability claim needs at least three DISTINCT seeds in the submitted batch.
 *
 * Scope, deliberately narrow:
 *   - DENIES only under-seeded experiment launches. A one/two-seed smoke or
 *     plumbing run remains available through the explicit
 *     EXPERIMENT_CLAIM_LEVEL=pilot marker, which injects a warning that the result
 *     is provisional and cannot unlock a successor experiment. That marker is
 *     evaluated BEFORE any denial, including the zero-seed one (fixed 2026-07-25 —
 *     it used to sit behind the zero-seed return, so the escape the block message
 *     advertises could never actually be taken).
 *   - A command only counts as a LAUNCH when it actually executes a runner: an
 *     interpreter (python / py / node / npx / uv run / bash …) handed a script, a
 *     `-m module`, or a package target. Read-only inspection (ls, cat, head, tail,
 *     grep, rg, find, wc, stat, git status|log|diff|show|ls-files) is exempt
 *     outright, and a keyword living only in a PATH segment or a quoted commit
 *     message never trips the gate (fixed 2026-07-25 — `ls src/servo/bench/` in the
 *     Servo repo was denied with "THREE DISTINCT SEEDS REQUIRED"). The same
 *     precision gate guards the monitor-required check.
 *   - Reads SKILL.md fresh off disk (cached per PROCESS only, so a single hook
 *     invocation never re-reads it twice, but the next tool call re-reads — skill
 *     edits propagate immediately, never a stale in-memory copy across calls).
 *   - Silently degrades (exits 0, no output) if SKILL.md is missing, unreadable, or
 *     the JSON payload doesn't parse — never blocks work over a docs file.
 *
 * Reuses long-running-script-guard's exported PRIMITIVES (`executableText`,
 * `keywordScannable`, `containsKeyword`, `isKnownShortCommand`) instead of
 * duplicating the quote-stripping / flag-stripping / word-boundary regex logic.
 * NOTE (duplication flagged for later merge): that file's own top-level
 * classifier (`looksLikeLongScript`) and its keyword list are NOT exported, only
 * the primitives are — so this hook recomposes an equivalent classifier from
 * those primitives using its own copy of the keyword list below. If
 * long-running-script-guard.mjs later exports `looksLikeLongScript` directly,
 * swap this recomposition for a straight call and delete the local keyword list.
 * That file is owned by a concurrent fix in this same session, so it is not
 * touched here; if even the primitives fail to import (mid-edit), this file
 * falls back further to `hasOwnLongRunHeuristic`, a minimal inline heuristic.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const SKILL_PATH = 'C:/Users/rmill/.claude/skills/launch-agent/SKILL.md';
const AGENT_BRIEF_SCRIPT = 'node ~/.claude/scripts/agent-kit/agent-brief.mjs';
const MIN_DURABILITY_SEEDS = 3;
const CLAIM_LEVEL_NAME = 'EXPERIMENT_CLAIM_LEVEL';

// ── Pilot-accumulation STOP gate (Russell, 2026-07-26) ──────────────────────
// The launch-time warning was never enough. In one codeservo session six
// consecutive single-seed pilots were launched (~$24), each one's number read
// as signal, and two rounds of tuning were done against what a variance table
// later showed was noise — totals of 22/20/22 that were indistinguishable. The
// PreToolUse warning fired every single time and changed nothing, because a
// warning is advisory and the escape hatch is one prefix away.
//
// So the invariant moves to STOP: a session may run pilots freely, but it may
// not END having stacked up pilot-only evidence without either a real
// multi-seed run or an explicit acknowledgement that nothing here is durable.
// Per the monitoring meta-lesson, the detection WINDOW must match the
// invariant's LIFETIME — "did this session over-rely on pilots?" is a
// whole-session question, so it is checked at Stop, not per tool call.
const PILOT_STATE_PATH = 'C:/Users/rmill/.claude/state/pilot-launches.json';
const PILOT_STOP_THRESHOLD = 2;   // one pilot is a smoke test; two is a habit
const PILOT_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const PILOT_ACK_TOKEN = 'pilot-result-provisional:';

// Monitor-required gate (set 2026-07-25 by Russell after a RunPod launch went
// up with no monitor, so the live-watch rule had no mechanical enforcer). The
// live-watch skill says a monitor is DEFAULT-ON for any run >1min; this hook
// makes that enforceable instead of aspirational. Fires for paid/long launches
// (RunPod experiment launches, Modal jobs) and BLOCKS unless a local monitor
// server is already listening on the configured port — so the operator can
// watch the run from t=0 instead of finding out it died blind.
const MONITOR_PORT_DEFAULT = 8173;
const MONITOR_PORT_ENV = 'MARCUS_MONITOR_PORT';
export function configuredMonitorPort() {
  const raw = process.env[MONITOR_PORT_ENV];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : MONITOR_PORT_DEFAULT;
}

// Blocks a brief must contain to have come out of (or match) the generator's
// output — mirrors agent-brief.mjs's own --selftest marker list, kept in sync by
// hand (both are short, stable, and reviewed together on change).
const REQUIRED_BRIEF_MARKERS = [
  'AGENT-HANDOFF.md',
  'agent-pulse.sh',
  'safe-merge-to-main.sh',
];

// Per-process cache: read SKILL.md at most once per hook invocation. A fresh node
// process is spawned per PreToolUse call, so this does not risk serving a stale
// copy across calls — it only avoids a pointless double-read within one call.
let cachedSkillText;
let cachedSkillReadAttempted = false;

function readSkillText() {
  if (cachedSkillReadAttempted) return cachedSkillText;
  cachedSkillReadAttempted = true;
  try {
    if (!existsSync(SKILL_PATH)) return (cachedSkillText = null);
    cachedSkillText = readFileSync(SKILL_PATH, 'utf8');
  } catch {
    cachedSkillText = null;
  }
  return cachedSkillText;
}

// Pull one named section out of SKILL.md by its `## HEADING` marker, up to the
// next `##` heading (or end of file). Returns null if the heading isn't found, so
// callers can degrade silently rather than inject an empty block.
export function extractSkillSection(skillText, headingPattern) {
  if (!skillText) return null;
  const skillLines = skillText.split('\n');
  let sectionStart = -1;
  for (let lineIndex = 0; lineIndex < skillLines.length; lineIndex++) {
    if (/^##\s+/.test(skillLines[lineIndex]) && headingPattern.test(skillLines[lineIndex])) {
      sectionStart = lineIndex;
      break;
    }
  }
  if (sectionStart === -1) return null;

  let sectionEnd = skillLines.length;
  for (let lineIndex = sectionStart + 1; lineIndex < skillLines.length; lineIndex++) {
    if (/^##\s+/.test(skillLines[lineIndex])) {
      sectionEnd = lineIndex;
      break;
    }
  }
  return skillLines.slice(sectionStart, sectionEnd).join('\n').trim();
}

// Compact a section down to a digest: keep the heading + first ~12 non-blank
// lines. The full skill file stays authoritative; this is a pre-flight nudge, not
// a copy of the whole doc (keeps the injection fast + cheap to read mid-turn).
export function digestSection(sectionText, maxLines = 12) {
  if (!sectionText) return null;
  const sectionLines = sectionText.split('\n');
  const heading = sectionLines[0];
  const bodyLines = sectionLines.slice(1).filter((line) => line.trim().length > 0);
  const keptLines = bodyLines.slice(0, maxLines);
  const wasTruncated = bodyLines.length > maxLines;
  return [heading, '', ...keptLines, wasTruncated ? '…(see SKILL.md for the rest)…' : null]
    .filter((line) => line !== null)
    .join('\n');
}

// ---- operation classification -------------------------------------------------

function isAgentSpawn(toolName) {
  return toolName === 'Agent';
}

function isShellTool(toolName) {
  // Accept every shell-tool name Devin/Claude Code may send. 'Bash' + 'PowerShell'
  // are the documented matchers; 'shell_command' is the legacy name; 'Exec'/'exec'
  // are the literal tool name in some Devin environments. Missing one of these
  // silently no-ops the whole hook (the load-bearing pre-mortem finding, 2026-07-25:
  // the matcher was 'Bash'-only on a Windows/PowerShell host).
  const name = String(toolName || '');
  return name === 'Bash' || name === 'PowerShell' || name === 'shell_command'
    || name === 'Exec' || name === 'exec';
}

// Fallback long-run heuristic — intentionally minimal, used ONLY if
// long-running-script-guard.mjs can't be imported (e.g. mid-edit by the
// concurrent fix in this session). Flagged as a known duplication, not a design
// choice: prefer the real guard's detector whenever it loads successfully.
function hasOwnLongRunHeuristic(command) {
  const loweredCommand = String(command || '').toLowerCase();
  return /\b(bench|benchmark|sweep|eval|backfill|migrate|migration|train|batch|bulk|generate|reindex|recompute|ingest|sync|harvest|rebuild)\b/.test(loweredCommand) ||
    /\s(--all|--full|--everything|--entire|--batch|--sweep)\b/i.test(loweredCommand);
}

// Mirrors the keyword list inside long-running-script-guard.mjs's (unexported)
// looksLikeLongScript — duplicated here only because the list itself isn't
// exported; the SCANNING logic (quote/flag stripping, word-boundary matching) is
// the real reused primitive, imported below, not reimplemented.
const LONG_RUN_KEYWORDS = [
  'bench', 'benchmark', 'sweep', 'eval', 'backfill', 'migrate', 'migration',
  'import', 'export', 'crawl', 'scrape', 'train', 'batch', 'bulk', 'generate',
  'reindex', 'recompute', 'ingest', 'sync', 'harvest', 'rebuild',
];

// LAUNCH-INTENT FLAGS — the launch signal sometimes lives entirely in a flag
// (`--benchmark`, `--sweep`, `--train`). keywordScannable STRIPS flags before
// matching, so those were invisible to the keyword scan and a genuinely seedless
// launch sailed straight through the seed gate (the false NEGATIVE found while
// fixing the 2026-07-25 false positive). Matched on the WHOLE flag name only, so
// `--export-dir` / `--batch-size` (ordinary options that merely start with a
// keyword) are not mistaken for a launch verb.
const LAUNCH_INTENT_FLAG =
  /(?:^|\s)--(?:all|full|everything|entire|batch|bench|benchmark|sweep|train|eval|experiment|backfill|crawl|scrape|ingest|reindex|recompute|harvest)(?=$|[\s=])/i;

let longRunDetector = hasOwnLongRunHeuristic;
let usingFallbackDetector = true;
// Quote/heredoc blanker. Prefer long-running-script-guard's battle-tested
// `executableText` (it also blanks heredoc bodies, PowerShell here-strings and
// inline `-c` code); fall back to a plain quote blanker if that module can't load.
let executableStructure = (command) =>
  String(command || '').replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
try {
  const longScriptGuardModule = await import('./long-running-script-guard.mjs');
  const { keywordScannable, containsKeyword, isKnownShortCommand, executableText } = longScriptGuardModule;
  if (typeof executableText === 'function') executableStructure = executableText;
  if (
    typeof keywordScannable === 'function' &&
    typeof containsKeyword === 'function' &&
    typeof isKnownShortCommand === 'function'
  ) {
    longRunDetector = (command) => {
      if (isKnownShortCommand(command)) return false;
      const scannableKeywordText = keywordScannable(command).toLowerCase();
      return LONG_RUN_KEYWORDS.some((keyword) => containsKeyword(scannableKeywordText, keyword)) ||
        LAUNCH_INTENT_FLAG.test(executableStructure(command));
    };
    usingFallbackDetector = false;
  }
} catch {
  // long-running-script-guard.mjs missing/broken mid-edit — stay on the fallback.
}

// =============================================================================
// TRIGGER PRECISION (fixed 2026-07-25)
// -----------------------------------------------------------------------------
// The gate used to be a naive keyword scan of the whole command line. In the
// Servo repo the token `bench` is a real SOURCE PATH (`src/servo/bench/`) and
// appears in commit subjects (`fix(bench): …`), so plain `ls src/servo/bench/`,
// `cat src/servo/bench/runner.py` and `git diff src/servo/bench/` were all denied
// with "THREE DISTINCT SEEDS REQUIRED" — a read-only listing told to declare
// three seeds. The gate now demands evidence the command actually EXECUTES a
// runner, so a keyword sitting in a path segment or a commit message can never
// trip it. Two independent filters, both must agree:
//   1. isReadOnlyShellCommand — every segment is a pure inspection verb → exempt.
//   2. invokesRunner — an interpreter must actually be handed something to run.
// =============================================================================

// Pure inspection verbs. `cd`/`echo`/`pwd` are neutral glue that appears in every
// compound listing, so they count as read-only rather than breaking the chain.
const READ_ONLY_LEADER =
  /^(?:ls|dir|cat|bat|head|tail|grep|egrep|fgrep|rg|ag|ack|find|fd|wc|stat|file|tree|du|df|pwd|cd|echo|printf|which|where|less|more|realpath|basename|dirname|readlink|printenv|env|date|whoami|hostname|uname|sort|uniq|cut|column|jq|yq|diff|cmp|md5sum|sha1sum|sha256sum|true|nl|tac|xxd|od|hexdump)$/i;

// git subcommands that only READ the repository. Anything not on this list
// (commit, push, checkout, merge…) simply falls through to the runner check,
// which is where `git commit -m "fix(bench): …"` gets cleared: its message is a
// quoted string, so the blanker removes it and no runner remains.
const READ_ONLY_GIT_SUBCOMMAND =
  /^(?:status|log|diff|show|ls-files|ls-tree|ls-remote|branch|rev-parse|rev-list|blame|describe|shortlog|reflog|cat-file|grep|whatchanged|count-objects|check-ignore|var|help|remote|tag|worktree|config|stash)$/i;

const SHELL_SEGMENT_SEPARATOR = /(?:\|\||&&|[;|\n]|(?<!\\)&)/;

/** Strip leading `FOO=bar` env assignments so the real verb is the first token. */
function commandVerbTokens(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let firstTokenIndex = 0;
  while (firstTokenIndex < tokens.length && /^[A-Za-z_][\w]*=/.test(tokens[firstTokenIndex])) {
    firstTokenIndex += 1;
  }
  return tokens.slice(firstTokenIndex);
}

/**
 * True when EVERY segment of the command is a pure inspection verb — the class of
 * command that must never be mistaken for an experiment launch no matter what
 * keywords its paths contain. One non-read-only segment makes the whole command
 * non-read-only (conservative: an `ls && python train.py` chain still gets scanned).
 */
export function isReadOnlyShellCommand(command) {
  const structure = executableStructure(command);
  const segments = structure.split(SHELL_SEGMENT_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '(' && segment !== ')');
  if (segments.length === 0) return false;

  return segments.every((segment) => {
    const tokens = commandVerbTokens(segment);
    if (tokens.length === 0) return true; // pure env assignment / empty — neutral
    const verb = (tokens[0].split(/[\\/]/).pop() || '').replace(/\.(exe|cmd|bat)$/i, '');
    if (/^git$/i.test(verb)) {
      // Skip git's global `-c key=value` / `-C dir` options to reach the subcommand.
      let subcommandIndex = 1;
      while (subcommandIndex < tokens.length && /^-/.test(tokens[subcommandIndex])) subcommandIndex += 2;
      const subcommand = tokens[subcommandIndex] || '';
      return READ_ONLY_GIT_SUBCOMMAND.test(subcommand);
    }
    return READ_ONLY_LEADER.test(verb);
  });
}

// Interpreters/launchers that can actually START a job.
const RUNNER_EXECUTABLE =
  /(?:^|[\s;&|(])(?:[\w.:\\/~+-]*[\\/])?(python(?:3(?:\.\d+)?)?|py|node|bun|deno|npx|npm|pnpm|yarn|tsx|ts-node|uv|uvx|poetry|pipenv|conda|bash|sh|zsh|pwsh|powershell|modal|accelerate|torchrun|deepspeed)(?:\.exe|\.cmd)?(?=\s)/gi;

// argv shapes that prove the interpreter was handed real work.
const SCRIPT_ARGUMENT = /(?:^|[\s"'=([])[\w.:\\/~+-]*\.(?:py|mjs|cjs|js|ts|tsx|sh|ps1|ipynb)(?=$|[\s"';:,&|)\]])/i;
const MODULE_ARGUMENT = /(?:^|\s)-m(?:\s+|=)[\w.]+/;
const SUBCOMMAND_LAUNCHERS = {
  modal: /^\s*(?:run|deploy|launch|exec|submit)\b/i,
  uv: /^\s*run\s+\S/i,
  uvx: /^\s*\S/,
  poetry: /^\s*run\s+\S/i,
  pipenv: /^\s*run\s+\S/i,
  conda: /^\s*run\b[\s\S]*?\s\S/i,
  npm: /^\s*(?:run(?:-script)?|exec)\s+\S/i,
  pnpm: /^\s*(?:run|exec|dlx)\s+\S/i,
  yarn: /^\s*(?:run|dlx)?\s*\S/i,
  npx: /^\s*\S/,
};

/**
 * True when the command actually EXECUTES something — an interpreter (or a
 * launcher subcommand like `modal run` / `uv run` / `npx …`) paired with a script,
 * a `-m module`, or a package target. A bare mention of a runner inside a path, a
 * quoted string or a filename is NOT a launch: `head -60 scripts/bench_runner.py`
 * names a python file but never runs it, and `grep -rn "python train.py" docs/`
 * only searches for the text.
 */
export function invokesRunner(command) {
  const structure = executableStructure(command);
  RUNNER_EXECUTABLE.lastIndex = 0;
  let runnerMatch;
  while ((runnerMatch = RUNNER_EXECUTABLE.exec(structure)) !== null) {
    const executableName = runnerMatch[1].toLowerCase();
    // argv = everything up to the next command separator.
    const argv = structure.slice(runnerMatch.index + runnerMatch[0].length).split(/[;&|\n]/)[0];
    const subcommandPattern = SUBCOMMAND_LAUNCHERS[executableName];
    if (subcommandPattern && subcommandPattern.test(argv)) return true;
    if (SCRIPT_ARGUMENT.test(argv) || MODULE_ARGUMENT.test(argv)) return true;
  }
  return false;
}

function isLongRunBash(toolName, command) {
  if (!isShellTool(toolName)) return false;
  if (!command) return false;
  // Precision gate: a read-only inspection, or a command that never hands an
  // interpreter anything to run, is not a launch — whatever its paths say.
  if (isReadOnlyShellCommand(command)) return false;
  if (!invokesRunner(command)) return false;
  return longRunDetector(command);
}

function isRunPodExperimentLaunch(toolName, command) {
  if (!isShellTool(toolName)) return false;
  if (isReadOnlyShellCommand(command)) return false;
  // Scan the executable STRUCTURE, not the raw line: `grep "runpod_exp173c.py … launch"`
  // must not read as the launch it is searching for.
  return /(?:^|[\\/\s])runpod_exp\d+[a-z]?\.py\b[^\r\n]*\blaunch\b/i.test(executableStructure(command));
}

// A launch that runs long enough to need a live monitor (the live-watch rule,
// made enforceable). RunPod experiment launches + Modal GPU/CPU jobs — both
// spend money and run >1min, so the operator must be able to watch from t=0.
// NOT applied to generic long-run bash (would block `npm run build`); only the
// paid/long launch shapes the live-watch skill names.
export function isMonitorableLaunch(toolName, command) {
  if (!isShellTool(toolName)) return false;
  // Same precision gate as the seed trigger: a read-only inspection that merely
  // MENTIONS a launcher (`cat modal_train.py`, `grep -rn "modal run" docs/`) is
  // not a launch and must not be told to stand up a monitor. Scan the executable
  // STRUCTURE so a quoted string never reads as the command's own shape.
  if (isReadOnlyShellCommand(command)) return false;
  const launchStructure = executableStructure(command);
  return (
    // RunPod experiment launcher — match the script with OR without .py so
    // module-form invocation (`python -m scripts.runpod_exp173d launch`) and
    // bare-name invocation don't bypass the gate. The prefix class includes
    // `.` so `scripts.runpod_exp173d` (module-form, dot separator) matches.
    // The `launch` verb must be present so a `--help`/`status`/`kill`
    // subcommand isn't blocked.
    /(?:^|[\\/\s.])runpod_exp\d+[a-z]?(?:\.py)?\b[^\r\n]*\blaunch\b/i.test(launchStructure) ||
    // Modal python entrypoint scripts (modal_train.py, modal_serve.py, ...).
    /(?:^|[\\/\s])modal_\w*\.py\b/i.test(launchStructure) ||
    // Modal CLI subcommands that launch paid work. Covers run/deploy/launch
    // plus exec/submit seen in newer Modal CLI versions.
    /\bmodal\s+(?:run|deploy|launch|exec|submit)\b/i.test(launchStructure)
  );
}

// HTTP probe — true when an HTTP server is listening on the monitor port AND
// responds 200 to GET / (the `py -3 -m http.server 8173` that serves the live
// HTML + feed files). Stronger than a raw TCP connect: a non-HTTP listener
// on 8173 (a leftover database, an orphan socket) won't satisfy this. 1500ms
// budget: well under the 4s hook timeout, generous under load. Errors and
// timeouts resolve false (treat as no monitor), never throw.
export function monitorServerListening(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1500 },
      (res) => {
        // A 2xx/3xx response proves an HTTP server is live. Consume + destroy
        // to free the socket; we don't need the body.
        res.resume();
        res.on('end', () => finish(res.statusCode !== undefined && res.statusCode < 400));
        res.on('error', () => finish(false));
      },
    );
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
  });
}

export function evaluateMonitorGate(toolName, command, monitorUp) {
  if (!isMonitorableLaunch(toolName, command)) {
    return { applies: false, block: false };
  }
  // Escape token (create-hook Rule 7): a legitimate non-monitorable launch
  // that the classifier over-matches (a non-marcus `modal run`, a <1min smoke)
  // can opt out with MONITOR_GATE_OK=1 in the env or `MONITOR_GATE_OK` in the
  // command. Documented in the block message. Never env-override around a
  // REAL false-negative (a launch that SHOULD have a monitor) — fix the hook.
  const escaped = process.env.MONITOR_GATE_OK === '1'
    || /\bMONITOR_GATE_OK\b/i.test(String(command || ''));
  if (monitorUp || escaped) {
    return { applies: true, block: false };
  }
  const port = configuredMonitorPort();
  return {
    applies: true,
    block: true,
    port,
    reason: `LIVE MONITOR REQUIRED — this is a paid/long launch (RunPod experiment or Modal job) and the live-watch rule (default ON for any run >1min) has no monitor running on 127.0.0.1:${port}.

Start the monitor FIRST, then re-run the launch:

    py -3 -m http.server ${port} --bind 127.0.0.1

(from the repo root, so the browser can fetch the live HTML + the runs/*.jsonl feed files). Then open http://127.0.0.1:${port}/docs/<your-live-monitor>.html and re-run this launch command.

A launch without a monitor leaves the operator blind to a death — the exact failure this hook exists to prevent. If this command genuinely does not need a monitor (a <1min smoke, a non-marcus project), prefix it with MONITOR_GATE_OK=1 (env) or add MONITOR_GATE_OK to the command to opt out — but if it SHOULD have a monitor, fix the hook, don't escape around it.`,
  };
}

function distinctSeedValues(command) {
  const foundSeeds = [];
  const appendSeed = (rawSeed) => {
    const parsedSeed = Number.parseInt(rawSeed, 10);
    if (!foundSeeds.includes(parsedSeed)) foundSeeds.push(parsedSeed);
  };

  for (const match of String(command || '').matchAll(/--seed(?:=|\s+)(-?\d+)\b/g)) {
    appendSeed(match[1]);
  }
  for (const match of String(command || '').matchAll(
    /--seeds(?:=|\s+)(-?\d+(?:[\s,]+-?\d+)*)/g,
  )) {
    for (const rawSeed of match[1].match(/-?\d+/g) || []) appendSeed(rawSeed);
  }
  return foundSeeds;
}

function claimLevel(command) {
  const match = String(command || '').match(
    /\bEXPERIMENT_CLAIM_LEVEL\s*=\s*["']?(pilot|provisional|durability)\b/i,
  );
  return match ? match[1].toLowerCase() : null;
}

export function evaluateSeedLaunch(command) {
  const seeds = distinctSeedValues(command);
  const declaredClaimLevel = claimLevel(command);
  const provisional = declaredClaimLevel === 'pilot' || declaredClaimLevel === 'provisional';

  // ESCAPE HATCH FIRST (fixed 2026-07-25). The denial message below tells the
  // operator to prefix the command with EXPERIMENT_CLAIM_LEVEL=pilot — but the
  // zero-seed denial used to return BEFORE this branch was ever reached, so
  // following that instruction changed nothing and the advertised escape was
  // unreachable. An escape hatch a block message advertises must actually work,
  // so the explicit pilot declaration is now evaluated before any denial.
  if (provisional) {
    const seedCountPhrase = seeds.length === 0
      ? 'no explicit seed'
      : `${seeds.length} distinct seed${seeds.length === 1 ? '' : 's'} scheduled`;
    return {
      block: false,
      seeds,
      provisional: true,
      warning: `PROVISIONAL PILOT ONLY — ${seedCountPhrase}. ` +
        'This run may test plumbing or produce a candidate result, but it cannot establish durability or ' +
        'support a general claim. It cannot unlock a successor experiment. Run at least three distinct seeds next.',
    };
  }

  if (seeds.length === 0) {
    return {
      block: true,
      seeds,
      provisional: false,
      reason: `THREE DISTINCT SEEDS REQUIRED — this experiment launch declares no explicit seed.

Submit one launch batch containing at least ${MIN_DURABILITY_SEEDS} distinct --seed values (or a
single --seeds list). For a smoke/plumbing run only, prefix the command with
\`${CLAIM_LEVEL_NAME}=pilot\`; that result is provisional and cannot unlock a successor.`,
    };
  }

  if (seeds.length < MIN_DURABILITY_SEEDS) {
    return {
      block: true,
      seeds,
      reason: `THREE DISTINCT SEEDS REQUIRED — found ${seeds.length}: ${seeds.join(', ')}.

A worker merely exposing --seed is not durability evidence. Submit one launch batch containing at
least ${MIN_DURABILITY_SEEDS} distinct seeds. Repeating the same seed does not count. If this is
intentionally only a smoke/plumbing pilot, prefix the command with
\`${CLAIM_LEVEL_NAME}=pilot\`; the result will be explicitly provisional and cannot unlock a successor.`,
    };
  }

  return { block: false, seeds, provisional: false, warning: null, durable: true };
}

// ---- flags (still non-blocking — appended to the injected context) ------------

function flagMissingBackground(toolInput) {
  if (toolInput?.run_in_background === true) return null;
  return 'FLAG: this Agent call is missing run_in_background: true — Russell\'s hard rule ' +
    '(2026-07-03), every agent runs detached so an interrupt can\'t kill it. Add it unless this is a ' +
    'genuine read-only one-shot with FOREGROUND_OK stated in the prompt.';
}

function flagMissingBriefBlocks(prompt) {
  const briefText = String(prompt || '');
  const missingMarkers = REQUIRED_BRIEF_MARKERS.filter((marker) => !briefText.includes(marker));
  if (missingMarkers.length === 0) return null;
  return `FLAG: this brief is missing required block(s): ${missingMarkers.join(', ')}. Generate the brief ` +
    `with ${AGENT_BRIEF_SCRIPT} instead of hand-writing it — it emits every guard-required block verbatim.`;
}

// ---- context assembly -----------------------------------------------------

const SECTION_HEADINGS = {
  agentSpawn: /AGENT SPAWNS/i,
  longRun: /LONG-RUNNING COMMANDS/i,
  commitLanding: /COMMIT LANDINGS/i,
};

export function buildContext({ toolName, toolInput, skillText, seedWarning = null }) {
  const contextLines = [];

  if (isAgentSpawn(toolName)) {
    const agentSpawnDigest = digestSection(extractSkillSection(skillText, SECTION_HEADINGS.agentSpawn));
    if (agentSpawnDigest) {
      contextLines.push('LAUNCH PRE-FLIGHT (agent spawn) — from the launch-agent skill:', agentSpawnDigest);
    }
    const backgroundFlag = flagMissingBackground(toolInput);
    if (backgroundFlag) contextLines.push('', backgroundFlag);
    const briefFlag = flagMissingBriefBlocks(toolInput?.prompt);
    if (briefFlag) contextLines.push('', briefFlag);
  } else {
    // long-run Bash/PowerShell
    const longRunDigest = digestSection(extractSkillSection(skillText, SECTION_HEADINGS.longRun));
    if (longRunDigest) {
      contextLines.push('LAUNCH PRE-FLIGHT (long-running command) — from the launch-agent skill:', longRunDigest);
    }
  }

  if (seedWarning) contextLines.push('', seedWarning);

  return contextLines.length ? contextLines.join('\n') : null;
}

// ── Pilot ledger ────────────────────────────────────────────────────────────
// Keyed on the SESSION's own id, never a shared counter: a global tally would
// let one project's pilots block an unrelated session's stop (the shared-token
// dedup bug, 2026-07-13). Entries carry who armed them and expire, so a crashed
// session cannot leave a permanent trap behind.

function readPilotLedger() {
  try {
    const parsed = JSON.parse(readFileSync(PILOT_STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePilotLedger(ledger) {
  try {
    mkdirSync(dirname(PILOT_STATE_PATH), { recursive: true });
    writeFileSync(PILOT_STATE_PATH, JSON.stringify(ledger, null, 2), 'utf8');
  } catch {
    // Fail open: a ledger we cannot persist must never block a launch.
  }
}

function pruneExpired(ledger, now) {
  const live = {};
  for (const [sessionId, record] of Object.entries(ledger)) {
    if (record && now - Number(record.updatedAt || 0) < PILOT_STATE_TTL_MS) {
      live[sessionId] = record;
    }
  }
  return live;
}

export function recordLaunchClaim(sessionId, projectRoot, verdict, now = Date.now()) {
  if (!sessionId) return;
  const ledger = pruneExpired(readPilotLedger(), now);
  const record = ledger[sessionId] || {
    projectRoot, pilots: 0, durableRuns: 0, armedAt: now,
  };
  if (verdict.provisional) record.pilots += 1;
  else if (verdict.durable) record.durableRuns += 1;
  record.projectRoot = projectRoot || record.projectRoot;
  record.updatedAt = now;
  ledger[sessionId] = record;
  writePilotLedger(ledger);
}

export function clearLaunchClaim(sessionId) {
  if (!sessionId) return;
  const ledger = readPilotLedger();
  if (!(sessionId in ledger)) return;
  delete ledger[sessionId];
  writePilotLedger(ledger);
}

/** Pure decision — exported so the rule is testable without touching disk. */
export function evaluatePilotStop(record, transcriptTail = '') {
  if (!record) return { block: false };
  const pilots = Number(record.pilots || 0);
  const durableRuns = Number(record.durableRuns || 0);
  if (pilots < PILOT_STOP_THRESHOLD) return { block: false };
  // A real multi-seed run in the same session settles it — the session did not
  // rest its conclusions on pilots alone.
  if (durableRuns > 0) return { block: false };
  if (String(transcriptTail).includes(PILOT_ACK_TOKEN)) return { block: false };
  return {
    block: true,
    pilots,
    reason: `PILOT-ONLY EVIDENCE — this session launched ${pilots} single-seed/provisional runs and no multi-seed run.

A pilot tests plumbing. It cannot tell a real improvement from run-to-run noise, and tuning
against one is how a session spends real money to chase variance (codeservo, 2026-07-26: six
pilots, ~$24, totals of 22/20/22 that turned out to be the same number).

Before stopping, do ONE of:
  1. Run the durability batch — at least ${MIN_DURABILITY_SEEDS} distinct seeds in one launch.
  2. State plainly in your final reply that the finding is provisional and NOT a claim, using
     the literal token: \`${PILOT_ACK_TOKEN} <what remains unproven>\`

Do not report a pilot number as if it were a result.`,
  };
}

/** Last slice of the transcript, for spotting the acknowledgement token. */
function readTranscriptTail(hookEvent, maxBytes = 20000) {
  const transcriptPath = hookEvent.transcript_path || hookEvent.transcriptPath;
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  try {
    const whole = readFileSync(transcriptPath, 'utf8');
    return whole.slice(-maxBytes);
  } catch {
    return '';
  }
}

function emitStopDenial(eventName, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName },
    decision: 'block',
    reason,
  }));
}

function emitAdditionalContext(eventName, contextMessage) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: contextMessage,
    },
  }));
}

function emitDenial(eventName, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

async function main() {
  let hookEvent;
  try {
    hookEvent = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }

  const eventName = hookEvent.hook_event_name || hookEvent.hookEventName || 'PreToolUse';
  const toolName = hookEvent.tool_name || hookEvent.toolName || '';
  const toolInput = hookEvent.tool_input || hookEvent.toolInput || {};
  const command = String(toolInput.command || '').trim();
  const sessionId = hookEvent.session_id || hookEvent.sessionId || '';

  // STOP: a session may run pilots, but may not END resting on them alone.
  if (eventName === 'Stop' || eventName === 'SubagentStop') {
    const record = pruneExpired(readPilotLedger(), Date.now())[sessionId];
    const verdict = evaluatePilotStop(record, readTranscriptTail(hookEvent));
    if (verdict.block) {
      emitStopDenial(eventName, verdict.reason);
      process.exit(0);
      return;
    }
    clearLaunchClaim(sessionId);
    process.exit(0);
    return;
  }

  const spawningAgent = isAgentSpawn(toolName);
  const runningLongCommand = isLongRunBash(toolName, command);
  const runningRunPodExperiment = isRunPodExperimentLaunch(toolName, command);
  if (!spawningAgent && !runningLongCommand && !runningRunPodExperiment) {
    process.exit(0);
    return;
  }

  const seedVerdict = (runningLongCommand || runningRunPodExperiment)
    ? evaluateSeedLaunch(command)
    : { block: false, warning: null };
  // Record what KIND of evidence this launch can produce, so the Stop gate can
  // see a session that only ever ran pilots.
  if (seedVerdict.provisional || seedVerdict.durable) {
    recordLaunchClaim(sessionId, hookEvent.cwd || process.cwd(), seedVerdict);
  }
  if (seedVerdict.block) {
    emitDenial(eventName, seedVerdict.reason);
    process.exit(0);
    return;
  }

  // Monitor-required gate (2026-07-25): a paid/long launch with no monitor
  // listening is the failure this hook exists to prevent. Probe the port and
  // block BEFORE injecting the skill digest, so the operator stands up the
  // monitor first and never launches blind.
  if (isMonitorableLaunch(toolName, command)) {
    const monitorUp = await monitorServerListening(configuredMonitorPort());
    const monitorVerdict = evaluateMonitorGate(toolName, command, monitorUp);
    if (monitorVerdict.block) {
      emitDenial(eventName, monitorVerdict.reason);
      process.exit(0);
      return;
    }
  }

  const skillText = readSkillText();
  if (!skillText) {
    // Degrade silently per spec — but an Agent-spawn flag check (missing
    // run_in_background / missing brief blocks) is still useful even with no
    // skill file to digest, so only fully no-op when there's nothing to say.
    if (spawningAgent) {
      const backgroundFlag = flagMissingBackground(toolInput);
      const briefFlag = flagMissingBriefBlocks(toolInput.prompt);
      const flagsOnlyContext = [backgroundFlag, briefFlag].filter(Boolean).join('\n\n');
      if (flagsOnlyContext) emitAdditionalContext(eventName, flagsOnlyContext);
    } else if (seedVerdict.warning) {
      emitAdditionalContext(eventName, seedVerdict.warning);
    }
    process.exit(0);
    return;
  }

  const context = buildContext({
    toolName,
    toolInput,
    skillText,
    seedWarning: seedVerdict.warning,
  });
  if (context) emitAdditionalContext(eventName, context);
  process.exit(0);
}

// Exposed for tests/diagnostics — true when the real long-run detector failed to
// load and this file fell back to its own minimal heuristic (duplication flag).
export function isUsingFallbackDetector() {
  return usingFallbackDetector;
}

const invokedAsScript =
  process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1]);
if (invokedAsScript) {
  // async main: an unhandled rejection would exit non-zero and either brick
  // every tool call or silently no-op the hook (depending on the runner's
  // treatment of non-zero). Catch → exit 0 (fail open, per create-hook Rule 6).
  main().catch(() => process.exit(0));
}
