#!/usr/bin/env node
/**
 * commit-cadence-guard — PreToolUse + Stop hook. Blocks the NEXT
 * mutation when enough WORK has accumulated since the last commit. The trigger
 * is FILE TOUCHES or LoC CHANGED — never time. A crash mid-flow loses only the
 * work since the last commit, so this keeps that window bounded by WORK SIZE,
 * not minutes. (Russell, 2026-07-25 — "get rid of time altogether, key off
 * work, make it work mid flow.")
 *
 * WHY PreToolUse, NOT Stop: a Stop hook only fires when the agent tries to wind
 * down. A 30-min deep edit flow that never pauses loses everything if a crash
 * hits at minute 29. PreToolUse fires BEFORE the next mutation, so the block
 * lands between edits — the natural moment to bank. The agent commits, then the
 * mutation proceeds. No mid-tool-call interruption.
 *
 * THE WORK SIGNAL:
 *   The first mutating tool call records hashes of pre-existing dirty files.
 *   Later calls count only files created or changed by this session, so Russell's
 *   unrelated work never gets claimed or swept into a broad commit.
 *
 * THRESHOLDS (override via env):
 *   - COMMIT_CADENCE_FILE_THRESHOLD (default 3): ≥ this many files touched.
 *   - COMMIT_CADENCE_LOC_THRESHOLD (default 30): ≥ this many lines churned.
 *   Either trips the block. Tuned so a typo fix never trips, but a real edit
 *   session (3 files or 30 lines) does — that's where loss starts to hurt.
 *
 * WHY NOT JUST FILE COUNT: a 1-file 500-line rewrite is more loss than a 3-file
 * 3-line tweak. Either axis alone misses half the cases; both together catch the
 * work that actually matters to bank.
 *
 * WIP COMMITS SKIP TESTS (Russell, 2026-07-25): the block message instructs
 * staging only session-owned paths + `git commit --no-verify`. This is loss-prevention, not a
 * quality gate — the work isn't at a "good state" yet. `--no-verify` skips
 * pre-commit hooks and the test suite so the snapshot is instant. The full
 * verified commit happens later at a real checkpoint.
 *
 * EXEMPT:
 *   - No git repo in cwd's ancestry (fail open).
 *   - No session-owned dirty files (pre-existing dirt is ignored).
 *   - A checkpoint is not complete until the owned work is committed AND the
 *     project's existing HANDOFF.md (or AGENT-HANDOFF.md) changed with it.
 *   - Below both thresholds (not enough work to warrant a snapshot).
 *   - COMMIT_CADENCE_OK=1 env (one-shot waiver).
 *   - `cadence-override: <reason>` in the tool input or recent transcript.
 *   - Reads only — the matcher is Edit|Write|Bash, but within Bash we skip
 *     obviously-non-mutating commands (git status, git diff, ls, cat, and the
 *     read-only `node scratchpad/*.mjs` diagnostic probes that only fetch()
 *     GETs from external APIs and print to stdout) so a diagnostic read never
 *     trips the guard mid-investigation.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { humanSafetyApproval, readTranscript } from './lib/transcript.mjs';

const FILE_THRESHOLD = parseInt(process.env.COMMIT_CADENCE_FILE_THRESHOLD || '3', 10);
const LOC_THRESHOLD = parseInt(process.env.COMMIT_CADENCE_LOC_THRESHOLD || '30', 10);
const STATE_DIR = resolve(
  process.env.COMMIT_CADENCE_STATE_DIR
    || resolve(process.env.USERPROFILE || process.env.HOME || '.', '.claude', 'state', 'commit-cadence'),
);

/** Walk up from startDir until a `.git` dir/file is found; null if none. */
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 25; i++) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Run a git command in repoRoot; returns trimmed stdout or '' on failure. */
function git(repoRoot, args) {
  try {
    return execSync(`git ${args}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** Stable content summary; stores no source text. */
function fingerprint(path) {
  try {
    const content = readFileSync(path);
    const text = content.includes(0) ? '' : content.toString('utf8');
    return {
      hash: createHash('sha256').update(content).digest('hex'),
      lines: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0,
    };
  } catch {
    return { hash: '<missing>', lines: 0 };
  }
}

/** Current dirty paths and fingerprints, including untracked files. */
function dirtySnapshot(repoRoot) {
  const paths = new Set();
  for (const output of [
    git(repoRoot, 'diff --name-only HEAD'),
    git(repoRoot, 'ls-files --others --exclude-standard'),
  ]) {
    for (const path of output.split('\n').map((value) => value.trim()).filter(Boolean)) paths.add(path);
  }
  return Object.fromEntries(
    [...paths].sort().map((path) => [path, fingerprint(resolve(repoRoot, path))]),
  );
}

/** Git's exact tracked-line churn, keyed by path. */
function trackedLineChurn(repoRoot) {
  const churn = new Map();
  for (const line of git(repoRoot, 'diff --numstat HEAD').split('\n')) {
    const [added, deleted, ...pathParts] = line.split('\t');
    if (!pathParts.length) continue;
    const path = pathParts.join('\t');
    const addCount = /^\d+$/.test(added) ? parseInt(added, 10) : 0;
    const deleteCount = /^\d+$/.test(deleted) ? parseInt(deleted, 10) : 0;
    churn.set(path, addCount + deleteCount);
  }
  return churn;
}

function statePath(payload, repoRoot) {
  const identity = payload.session_id || payload.sessionId
    || payload.transcript_path || payload.transcriptPath || '';
  if (!identity) return null;
  const key = createHash('sha256').update(`${repoRoot}\0${identity}`).digest('hex');
  return resolve(STATE_DIR, `${key}.json`);
}

function readState(payload, repoRoot) {
  const path = statePath(payload, repoRoot);
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function writeState(payload, repoRoot, state) {
  const path = statePath(payload, repoRoot);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), 'utf8');
  } catch { /* fail open; the existing guard still protects the current call */ }
}

const HANDOFF_NAMES = ['HANDOFF.md', 'AGENT-HANDOFF.md'];

/** Snapshot only the handoff identity and hash; never store its contents in global state. */
function handoffSnapshot(repoRoot) {
  const path = HANDOFF_NAMES
    .map((name) => resolve(repoRoot, name))
    .find((candidate) => existsSync(candidate)) || null;
  return { path, hash: path ? fingerprint(path).hash : null };
}

function currentHead(repoRoot) {
  return git(repoRoot, 'rev-parse HEAD');
}

function snapshotsDiffer(left = {}, right = {}) {
  return left.path !== right.path || left.hash !== right.hash;
}

function handoffName(snapshot = {}) {
  return snapshot.path ? basename(snapshot.path) : 'HANDOFF.md';
}

function checkpointStatus(state, repoRoot) {
  const pending = state?.pending;
  if (!pending) return { pending: false, satisfied: false, handoffChanged: false, headChanged: false };
  const currentHandoff = handoffSnapshot(repoRoot);
  const handoffChanged = snapshotsDiffer(currentHandoff, pending.handoff);
  const headChanged = Boolean(pending.head) && currentHead(repoRoot) !== pending.head;
  return { pending: true, satisfied: headChanged && handoffChanged, handoffChanged, headChanged };
}

function hasHandoff(state, repoRoot) {
  return Boolean(state?.handoff?.path || handoffSnapshot(repoRoot).path);
}

function armCheckpoint(payload, repoRoot, state) {
  state.pending = {
    head: state.head || currentHead(repoRoot),
    handoff: state.handoff || { path: null, hash: null },
  };
  writeState(payload, repoRoot, state);
}

function clearCheckpoint(payload, repoRoot, state) {
  state.dirty = dirtySnapshot(repoRoot);
  state.handoff = handoffSnapshot(repoRoot);
  state.head = currentHead(repoRoot);
  state.pending = null;
  writeState(payload, repoRoot, state);
}

/** Capture pre-existing dirt before this session's first mutation. */
function ensureBaseline(payload, repoRoot) {
  const path = statePath(payload, repoRoot);
  if (!path) return { baseline: null, created: false };
  const existing = readState(payload, repoRoot);
  if (existing?.dirty) {
    // Older state files predate the handoff checkpoint fields. Preserve their
    // dirty baseline and start the stronger checkpoint contract from here.
    if (!('handoff' in existing)) existing.handoff = { path: null, hash: null };
    if (!('head' in existing)) existing.head = currentHead(repoRoot);
    if (!('pending' in existing)) existing.pending = null;
    writeState(payload, repoRoot, existing);
    return { baseline: existing.dirty, state: existing, created: false };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const baseline = dirtySnapshot(repoRoot);
    const state = {
      repoRoot,
      dirty: baseline,
      handoff: handoffSnapshot(repoRoot),
      head: currentHead(repoRoot),
      pending: null,
    };
    writeFileSync(path, JSON.stringify(state), 'utf8');
    return { baseline, state, created: true };
  } catch {
    return { baseline: null, created: false };
  }
}

/** Count only dirt created or changed after the session baseline. */
function measureSessionWork(repoRoot, baseline) {
  const current = dirtySnapshot(repoRoot);
  const trackedChurn = trackedLineChurn(repoRoot);
  let files = 0;
  let lines = 0;
  for (const [path, now] of Object.entries(current)) {
    const before = baseline[path];
    if (before?.hash === now.hash) continue;
    files += 1;
    if (!before) lines += trackedChurn.get(path) ?? now.lines;
    else lines += Math.max(1, Math.abs(now.lines - (before.lines || 0)));
  }
  return { files, lines };
}

/** Bash commands that are pure reads — never block on them mid-investigation. */
const READ_ONLY_BASH_RE = /^\s*(git\s+(status|diff|log|show|branch|stash|blame)|ls|cat|head|tail|grep|find|echo|pwd|wc|file|stat|type)\b/;

/**
 * DEADLOCK EXEMPTION — `cadence-override: fixing this guard's own deadlock`.
 *
 * Caught the minute this hook was first registered (2026-07-28): the guard demands a commit, and
 * then blocked the commit. `git add`/`commit`/`switch`/`checkout` ARE the prescribed remedy, so
 * blocking them makes the guard unsatisfiable — and an unsatisfiable guard gets switched off by
 * its owner within the hour. It also blocked the Edit that fixes this line, which is how a guard
 * ends up permanently disabled instead of repaired.
 *
 * Matched anywhere in the command, not anchored: the remedy is nearly always chained
 * (`git add -A && git commit -m ...`) and often prefixed with `cd <repo> &&`.
 */
const GIT_REMEDY_RE = /\bgit\s+(add|commit|switch|checkout|merge|rebase|restore|rm|mv|tag|push|pull|fetch|worktree|init|config|stash)\b/;

export function blockReason({ files, lines }) {
  const which = files >= FILE_THRESHOLD
    ? `${files} files touched (≥ ${FILE_THRESHOLD})`
    : `${lines} lines churned (≥ ${LOC_THRESHOLD})`;
  return [
    `⏱ COMMIT-CADENCE GUARD — bank WIP before the next mutation.`,
    ``,
    `**${which} since the last commit, and you're about to mutate again.**`,
    `Snapshot the work as a loss-prevention commit. Stage only the files you changed, then run:`,
    `  \`git commit --no-verify -m "wip: <what>"\``,
    `then re-run the mutation. A crash/context-fill/restart loses only what's uncommitted.`,
    ``,
    `USE \`--no-verify\`: this is a WIP snapshot, NOT a quality gate. The work isn't at a good`,
    `state yet — \`--no-verify\` skips pre-commit hooks and the test suite so the snapshot is`,
    `instant. The full verified commit (with tests) happens later at a real checkpoint.`,
    ``,
    `Legitimate exception (mid-refactor, banking as one commit at the end): include`,
    `\`cadence-override: <why>\` in your reply, or set COMMIT_CADENCE_OK=1.`,
  ].join('\n');
}

export function checkpointBlockReason({ files, lines, handoff = 'HANDOFF.md', handoffChanged = false, headChanged = false }) {
  const missing = [
    !handoffChanged ? `refresh \`${handoff}\`` : null,
    !headChanged ? 'commit the owned work' : null,
  ].filter(Boolean);
  return [
    `CHECKPOINT REQUIRED — ${files} file(s) / ${lines} line(s) are ready to bank.`,
    `Before the next mutation, ${missing.join(' and ')}.`,
    `Stage only the files changed in this session, then run \`git commit --no-verify -m "wip: <what>"\`.`,
    `The handoff is the breadcrumb trail; the commit is the black box. Keep both after every real work chunk.`,
    `Legitimate exception: include \`cadence-override: <why>\` in the tool input.`,
  ].join('\n');
}

/**
 * STOP-PATH message. Ending a turn on uncommitted work is the failure Russell named on
 * 2026-07-28: the assistant finished green work, then ASKED what to do with it instead of
 * banking it. There is no version of "finished but uncommitted" that is correct at stop time.
 */
export function stopBlockReason({ files, lines, handoffStale, handoffRequired = false, handoff = 'HANDOFF.md' }) {
  return [
    `COMMIT BEFORE YOU STOP — ${files} file(s) / ${lines} line(s) are uncommitted.`,
    ``,
    `Russell's rule (2026-07-28): **never ask what to do with finished work.** Commit it, move the`,
    `front-door docs, refresh the handoff. Asking "say what you want done with it" is the violation`,
    `this gate exists to stop.`,
    ``,
    `Do it now, in this order:`,
    `  1. \`git switch -c feature/<name>\` if you're on main; stage only the files you changed, then commit.`,
    handoffRequired
      ? `  2. Refresh \`${handoff}\` with what changed and what comes next — same turn as the commit.`
      : `  2. Move README / CHANGELOG / HANDOFF for what changed — same turn as the commit.`,
    ``,
    `Genuinely mid-refactor and banking as one commit next turn? Say \`cadence-override: <why>\`.`,
  ].filter((line) => line !== null).join('\n');
}

export function noDirtBlockReason({ paths = [], handoff = null, handoffStale = false } = {}) {
  const visible = paths.slice(0, 8).map((path) => `  - ${path}`);
  if (paths.length > visible.length) visible.push(`  - …and ${paths.length - visible.length} more`);
  return [
    `NO-DIRT HANDOFF — ${paths.length} uncommitted path(s) would leak into the next agent's context.`,
    `Never ask what to do with finished work. Resolve every path before stopping.`,
    `Commit finished work. Preserve inherited work in a separate checkpoint after inspection. Restore only changes proven disposable.`,
    `Stage paths explicitly; never sweep unknown work into a broad commit.`,
    handoff ? `Refresh \`${handoff}\` — refresh ONLY. Never commit the handoff: it is the working` : null,
    handoff ? `parachute, deliberately gitignored in many repos, so \`git add\` refuses it outright.` : null,
    ...visible,
    `If ownership or disposition creates a real safety concern, raise the concrete risk to the human. Only a later human approval can leave the tree dirty.`,
  ].filter(Boolean).join('\n');
}

function isHandoffMutation(payload) {
  const toolName = payload.tool_name || payload.toolName || '';
  const input = payload.tool_input || {};
  const raw = JSON.stringify(input);
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    const path = input.file_path || input.filePath || input.path || '';
    return /(?:^|[\\/])(?:HANDOFF|AGENT-HANDOFF)\.md$/i.test(String(path));
  }
  return toolName === 'apply_patch' && /(?:HANDOFF|AGENT-HANDOFF)\.md/i.test(raw);
}

/** True when HANDOFF.md exists but predates the newest commit — the parachute is stale. */
function handoffIsStale(repoRoot) {
  const handoff = resolve(repoRoot, 'HANDOFF.md');
  if (!existsSync(handoff)) return false;
  const lastCommitEpoch = parseInt(git(repoRoot, 'log -1 --format=%ct') || '0', 10);
  if (!lastCommitEpoch) return false;
  try {
    return statSync(handoff).mtimeMs / 1000 < lastCommitEpoch;
  } catch {
    return false;
  }
}

async function main() {
  let stdinRaw = '';
  // PreToolUse payloads are small; read synchronously.
  try { stdinRaw = readFileSync(0, 'utf8'); } catch { return; }
  let payload;
  try { payload = JSON.parse(stdinRaw); } catch { return; }

  const eventName = payload.hook_event_name || payload.hookEventName || '';
  if (eventName !== 'Stop' && process.env.COMMIT_CADENCE_OK === '1') return;

  // ── STOP PATH (added 2026-07-28, Russell: "a stop hook") ──────────────────────────────
  // The PreToolUse half bounds crash-loss MID-FLOW. It is structurally blind to the case
  // that actually bit: a turn that finishes its edits, drops under the mutation threshold's
  // radar, and ends with the work still on disk. Same guard, second event — the detection
  // window has to match the invariant's lifetime (the monitoring meta-lesson), and the
  // invariant here is "no turn ends on uncommitted work", which only Stop can see.
  if (eventName === 'Stop') {
    const stopCwd = payload.cwd || process.cwd();
    const stopRepoRoot = findRepoRoot(stopCwd);
    if (!stopRepoRoot) return;              // not a git repo — fail open
    const state = readState(payload, stopRepoRoot);
    const transcriptPath = payload.transcript_path || payload.transcriptPath || '';
    if (humanSafetyApproval(readTranscript(transcriptPath))) return;
    // A dirty handoff is expected working state, not a leak: it is refreshed every few turns
    // and never committed. Counting it as unresolved dirt demanded a commit that cannot happen.
    const dirtyPaths = Object.keys(dirtySnapshot(stopRepoRoot))
      .filter((path) => !/(?:^|[\\/])(?:HANDOFF|AGENT-HANDOFF)\.md$/i.test(path));
    if (dirtyPaths.length === 0) {
      if (state?.pending) clearCheckpoint(payload, stopRepoRoot, state);
      return;
    }
    const handoff = handoffSnapshot(stopRepoRoot);
    if (state?.dirty && handoff.path) armCheckpoint(payload, stopRepoRoot, state);
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: noDirtBlockReason({
        paths: dirtyPaths,
        handoff: handoff.path ? handoffName(handoff) : null,
      }),
    }));
    return;
  }

  if (eventName !== 'PreToolUse') return;

  // Only block MUTATING tool calls. Reads never warrant a snapshot.
  const toolName = payload.tool_name || payload.toolName || '';
  if (toolName === 'Bash') {
    const cmd = payload.tool_input?.command || payload.tool_input?.cmd || '';
    if (READ_ONLY_BASH_RE.test(cmd)) return; // pure read — let it through
    if (GIT_REMEDY_RE.test(cmd)) return;     // the prescribed bank/branch remedy must stay usable
  } else if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit' && toolName !== 'apply_patch') {
    return; // not a mutation — let it through
  }

  const cwd = payload.cwd || process.cwd();
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return; // not a git repo

  const { baseline, state, created } = ensureBaseline(payload, repoRoot);
  if (!baseline || created) return; // first mutation establishes ownership; never claim earlier dirt

  // REFRESHING THE HANDOFF IS THE REMEDY THIS GUARD PRESCRIBES, so it can never be a thing this
  // guard blocks (2026-08-17, Russell: "commit guard should say to refresh but never commit
  // handoff"). isHandoffMutation used to exempt the handoff edit from the pending-checkpoint
  // deny below and then let it fall straight through to the bottom deny anyway — the guard
  // blocked the exact action it was demanding, live, for a whole turn. An exemption that covers
  // one of two exits is not an exemption. Same family as GIT_REMEDY_RE further down: when a
  // guard prescribes a remedy, EVERY step of that remedy stays reachable while it is blocking.
  if (isHandoffMutation(payload)) return;
  // The override must be read BEFORE any deny, not between two of them. It used to sit below
  // the pending-checkpoint deny, so the moment a checkpoint armed, the only sanctioned escape
  // this guard advertises became unreachable — it printed instructions for a door it had locked.
  if (/cadence-override\s*:/i.test(JSON.stringify(payload.tool_input || {}))) return;

  const pending = checkpointStatus(state, repoRoot);
  if (pending.pending) {
    if (pending.satisfied) clearCheckpoint(payload, repoRoot, state);
    else if (!isHandoffMutation(payload)) {
      const work = measureSessionWork(repoRoot, state.dirty);
      process.stdout.write(JSON.stringify({
        permissionDecision: 'deny',
        reason: checkpointBlockReason({
          ...work,
          handoff: handoffName(state.pending.handoff),
          handoffChanged: pending.handoffChanged,
          headChanged: pending.headChanged,
        }),
      }));
      return;
    }
  }
  const { files, lines } = measureSessionWork(repoRoot, state.dirty);
  if (files < FILE_THRESHOLD && lines < LOC_THRESHOLD) return; // not enough work yet

  // Escape token in the tool input or recent transcript waives this one call.
  const toolInputStr = JSON.stringify(payload.tool_input || {});
  if (/cadence-override\s*:/i.test(toolInputStr)) return;

  // cadence-override: fixing this guard's own truncation bug, same fix as the Stop path above.
  // No explicit process.exit() here — see the comment on the Stop path: an immediate exit()
  // truncates the async stdout write on a pipe, turning an intended deny into an unparseable crash.
  if (hasHandoff(state, repoRoot)) armCheckpoint(payload, repoRoot, state);
  process.stdout.write(JSON.stringify({
    permissionDecision: 'deny',
    reason: hasHandoff(state, repoRoot)
      ? checkpointBlockReason({ files, lines, handoff: handoffName(handoffSnapshot(repoRoot)) })
      : blockReason({ files, lines }),
  }));
}

// Entry-point guard: only run when invoked directly as the hook process.
if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main().catch(() => process.exit(0));
}
