#!/usr/bin/env node
/**
 * agent-monitor-cadence — Stop hook WITH REAL TEETH. The hook ITSELF detects a stuck/dead background agent
 * and surfaces it by NAME, so Russell never has to notice — AND so the orchestrator can't satisfy the gate
 * with a meaningless glance.
 *
 * Russell's rule (2026-06-24): "why am I the one that has to monitor this?" + (2026-06-24 night) "you were
 * supposed to have a hook that made you check on them every few minutes — fix that hook." The OLD version
 * cleared the gate the moment ANY `git ... worktree-agent-*` string appeared in the transcript tail — so the
 * orchestrator ran a throwaway check, saw old commits, said "alive," and moved on while two agents sat STUCK
 * for 30 min. The detection was delegated to the model instead of done by the hook. THE FIX: the hook runs
 * the git staleness check itself.
 *
 * TWO events, after 2026-06-28 (Russell: "did the deadman switch work? neither did. fix those first." — 3 agents
 * died in a prior session and the NEXT session never alerted; he found them by hand):
 *
 *   1. Stop (in-session) — with ≥1 ACTIVE background agent (this transcript's run_in_background spawns), it reads
 *      the PULSE LOG: any label silent > STALE_MS (2 min) without a DONE is stuck → BLOCK, named, with salvage
 *      steps. The 2-min window is safe because the pulse contract now requires a heartbeat every ≤60s (long
 *      commands MUST be backgrounded + polled). Falls back to the git ref-mtime scan if there's no pulse log.
 *
 *   2. SessionStart (cross-session) — THE GAP THAT BIT US: the Stop monitor is gated on THIS session's spawns, so
 *      a fresh session is structurally blind to agents that died when their parent session ended. This scan reads
 *      the GLOBAL pulse log and surfaces every orphan (pulsed real work, then silent > 5 min, no DONE), ONCE each
 *      (deduped by label@pulse-time), as non-blocking context — so the new session salvages the banked autocommits
 *      instead of discovering the death by hand. A goal-only label (orchestrator placeholder) is excluded as noise.
 *
 * Throttled (Stop) to re-surface at most every CADENCE_MS. Fail-open on any unexpected error.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const STATE_FILE = resolve(homedir(), '.claude', 'state', 'last-agent-monitor.json');
const CADENCE_MS = 6 * 60 * 1000;        // re-surface a stuck agent at most every 6 min (don't nag every stop)
const STALE_MS = 2 * 60 * 1000;          // an agent silent > 2 min = stuck/dead. (2026-06-28, Russell: "heads-down
                                         // agents should pulse every min, then the Stop path could be like 2 min.")
                                         // The OLD 20-min window existed only because an agent in a long FOREGROUND
                                         // command (e.g. a multi-minute test run) goes quiet — no tool events, no
                                         // pulse. The pulse contract now FORBIDS that: any command expected to run
                                         // > 60s must be BACKGROUNDED + polled, pulsing each poll. So a healthy agent
                                         // pulses every ≤60s; 2 missed heartbeats = genuinely dead. The orchestrator
                                         // still cross-checks autocommit recency before treating a flag as a death.
const RECENT_WINDOW_MS = 45 * 60 * 1000; // ...but only if it pulsed within the last 45 min — the pulse log is a
                                         // global months-long history; older labels are ancient, not current agents
const ORPHAN_STALE_MS = 5 * 60 * 1000;   // SessionStart cross-session scan: a background agent dies WITH its parent
                                         // session, so a prior-session agent silent > 5 min (with no live parent to be
                                         // "heads-down") is definitively orphaned — surface it so the next session
                                         // salvages its banked work. THIS is the gap that let 3 dead agents go
                                         // unnoticed (the Stop monitor only saw THIS session's spawns).
const ORPHAN_WINDOW_MS = 12 * 60 * 60 * 1000; // a prior session may have ended hours ago; surface orphans up to 12h old
const TRANSCRIPT_TAIL_BYTES = 60 * 1024; // only the recent end of the transcript is "since last check"

// Pure: given [{branch, ageMs}], return the ones idle past the threshold. Tested without git.
function staleAgentBranches(branchAges, staleMs = STALE_MS) {
  return (branchAges || []).filter((entry) => entry && typeof entry.ageMs === 'number' && entry.ageMs > staleMs);
}

// Read each worktree-agent-* branch's last-commit age via git. Returns [{branch, ageMs}], or null if git/the
// repo is unavailable (caller then falls back to the cadence nag). gitRunner is injectable for the test.
function agentBranchAges(repoRoot, now = Date.now(), gitRunner = defaultGitRunner) {
  try {
    const listing = gitRunner(['for-each-ref', '--format=%(refname:short) %(committerdate:unix)', 'refs/heads/worktree-agent-*'], repoRoot);
    if (listing == null) return null;
    return listing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const lastSpace = line.lastIndexOf(' ');
      const branch = line.slice(0, lastSpace);
      const committedAtMs = Number(line.slice(lastSpace + 1)) * 1000;
      return { branch, ageMs: now - committedAtMs };
    });
  } catch {
    return null;
  }
}

function defaultGitRunner(gitArgs, repoRoot) {
  try {
    return execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    return null;
  }
}

// THE TRUE LIVENESS SIGNAL (2026-06-28 fix): the shared agent pulse log. Every background agent — research
// (isolation worktree) OR build (a feature/* worktree in ANOTHER repo) — appends `[ts] [label] ...` here as it
// works. The OLD git-branch-age check was wrong twice: (1) a just-launched or read-mostly agent's branch tip is
// still the BASE commit (hours old) → FALSE "idle 53 min"; (2) build agents on feature/* in the baryo repo were
// never scanned (only skaffen's worktree-agent-* refs were) → a real death was MISSED. Pulse recency fixes both.
function findPulseLog(repoRoot) {
  const candidatePaths = [
    resolve(repoRoot, '..', '.claude', 'state', 'agent-pulse.log'), // repo is a child of programming/
    resolve(repoRoot, '.claude', 'state', 'agent-pulse.log'),
  ];
  // Last resort: the canonical absolute location, so the scan works regardless of the session cwd.
  candidatePaths.push(resolve(homedir(), 'Desktop', 'programming', '.claude', 'state', 'agent-pulse.log'));
  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) return candidatePath;
  }
  return null;
}

function readPulseLog(repoRoot) {
  const pulseLogPath = findPulseLog(repoRoot);
  if (!pulseLogPath) return null;
  try { return readFileSync(pulseLogPath, 'utf8'); } catch { return null; }
}

// Pure: given the pulse-log text, return non-main-thread agent labels that were RECENTLY active but have since gone
// silent past staleMs without a clean `DONE`. The pulse log is a GLOBAL, append-only, MONTHS-long history shared by
// every session and project — so we must bound BOTH ends: a label is "stuck right now" only if its last pulse is
// OLDER than staleMs (silent) AND NEWER than recentWindowMs (it was plausibly active in this session, not ancient
// history from weeks ago). Without the upper bound this flagged all ~600 labels ever seen. A label whose final line
// is its DONE finished fine. Tested without git/fs.
// Completed/killed agent labels, read from the transcript's task-notifications (`Agent "LABEL" finished` in the
// <summary>). A finished agent stops pulsing but is NOT stuck — exclude its label so a clean completion that didn't
// happen to end on a `DONE` pulse line isn't flagged.
function completedAgentLabels(transcript) {
  const labels = new Set();
  if (!transcript) return labels;
  const notificationRe = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  for (const notification of transcript.matchAll(notificationRe)) {
    const body = notification[1];
    if (!/<status>\s*(completed|killed)\s*<\/status>/i.test(body)) continue;
    const summaryMatch = body.match(/Agent\s+"([^"]+)"\s+finished/i);
    if (summaryMatch) labels.add(summaryMatch[1].trim());
  }
  return labels;
}

function staleAgentsFromPulseLog(pulseLogText, now = Date.now(), staleMs = STALE_MS, recentWindowMs = RECENT_WINDOW_MS, excludeLabels = new Set()) {
  if (!pulseLogText) return null; // no log available → caller falls back to the git/cadence path
  const lastByLabel = new Map(); // label -> { atMs, line }
  const lineRe = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]\s*\[([^\]]+)\]\s*(.*)$/;
  for (const rawLine of String(pulseLogText).split(/\r?\n/)) {
    const lineMatch = rawLine.match(lineRe);
    if (!lineMatch) continue;
    const atMs = Date.parse(lineMatch[1]);
    const label = lineMatch[2].trim();
    if (!Number.isFinite(atMs)) continue;
    if (label.toLowerCase() === 'main thread') continue; // the orchestrator itself, not a background agent
    const previous = lastByLabel.get(label);
    if (!previous || atMs >= previous.atMs) lastByLabel.set(label, { atMs, line: rawLine });
  }
  const stuck = [];
  for (const [label, info] of lastByLabel) {
    const idleMs = now - info.atMs;
    if (idleMs <= staleMs) continue;           // pulsed recently → alive + healthy
    if (idleMs >= recentWindowMs) continue;    // ancient history (other session/long done) → not a current agent
    if (excludeLabels.has(label)) continue;    // a completed/killed agent (per its task-notification) → not stuck
    if (/\bDONE\b/i.test(info.line)) continue; // last pulse was its DONE → finished cleanly, not stuck
    // A label whose LAST line is only the orchestrator's `Goal:` pulse is a PLACEHOLDER, not a dead mid-work agent.
    // The orchestrator writes the Goal under the human task name (e.g. "Phase 4 Activity surface") while the agent
    // pulses its real work under its OWN label (e.g. "p4-activity") — so a goal-only label never gets a DONE and
    // would flag forever. Excluding it collapses the noise to agents that actually pulsed work and then died.
    if (/Agent:\s*Goal:/i.test(info.line)) continue;
    stuck.push({ label, idleMs, atMs: info.atMs, lastLine: info.line });
  }
  return stuck;
}

// A stable dedup key for an orphan so the SessionStart scan nags ONCE per death, not every session forever.
// Keyed on label + the PULSE TIME (atMs), not idle time — idle grows every session, the pulse time is fixed.
// A later pulse from the same label (it came back / a re-run) makes a NEW key → surfaces again, correctly.
function orphanKey(orphan) {
  return `${orphan.label}@${orphan.atMs}`;
}

// Pure: drop orphans whose key is already in `surfacedKeys` (a Set). Tested without fs.
function unsurfacedOrphans(orphans, surfacedKeys) {
  return (orphans || []).filter((orphan) => !surfacedKeys.has(orphanKey(orphan)));
}

const AGENT_BRANCH_PREFIXES = /^(feature\/|fix\/|worktree-agent-)/;

// Immediate sibling directories of the workspace that are git repos (main checkouts — their `.git` is a dir).
function findWorkspaceRepos(workspaceRoot) {
  const repos = [];
  let names;
  try { names = readdirSync(workspaceRoot); } catch { return repos; }
  for (const name of names) {
    try { if (statSync(join(workspaceRoot, name, '.git')).isDirectory()) repos.push(join(workspaceRoot, name)); } catch { /* not a repo */ }
  }
  return repos;
}

// Recursively collect loose ref files under refs/heads → [{branch, mtimeMs}]. (feature/foo is a nested file.)
function looseHeadRefs(headsDir, prefix = '') {
  const refs = [];
  let entries;
  try { entries = readdirSync(headsDir, { withFileTypes: true }); } catch { return refs; }
  for (const entry of entries) {
    const full = join(headsDir, entry.name);
    const branch = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { refs.push(...looseHeadRefs(full, branch)); continue; }
    const mtimeMs = safeMtimeMs(full);
    if (mtimeMs) refs.push({ branch, mtimeMs });
  }
  return refs;
}

// THE RELIABLE SIGNAL (2026-06-28 — after the pulse-log approach kept false-positiving on completed/heads-down/just-
// launched agents): an agent branch's loose-ref-file mtime. It advances on branch CREATION (`worktree add -b`) and on
// EVERY autocommit — so a just-launched, an actively-committing, AND a heads-down agent all read FRESH, while a dead-
// after-committing agent reads STALE. A merged-done agent's branch is DELETED → not scanned → auto-excluded (the exact
// thing pulse-matching kept getting wrong). Scans the session repo + every sibling repo under the workspace parent
// (build agents live on feature/* of OTHER repos, which the old skaffen-only scan never saw). Bounded by recentWindow
// so an ancient un-deleted branch isn't a false death. Fail-safe: any error → empty (no false block).
function staleAgentBranchesByRef(repoRoot, now = Date.now(), staleMs = STALE_MS, recentWindowMs = RECENT_WINDOW_MS) {
  try {
    const workspaceRoot = dirname(repoRoot);
    const repos = [repoRoot, ...findWorkspaceRepos(workspaceRoot).filter((repo) => comparablePath(repo) !== comparablePath(repoRoot))];
    const stale = [];
    for (const repo of repos) {
      for (const ref of looseHeadRefs(join(repo, '.git', 'refs', 'heads'))) {
        if (!AGENT_BRANCH_PREFIXES.test(ref.branch)) continue;
        const ageMs = now - ref.mtimeMs;
        if (ageMs > staleMs && ageMs < recentWindowMs) stale.push({ repo: basename(repo), branch: ref.branch, ageMs });
      }
    }
    return stale;
  } catch {
    return [];
  }
}

function safeMtimeMs(targetPath) {
  try { return statSync(targetPath).mtimeMs; } catch { return 0; }
}

function comparablePath(rawPath) {
  const normalized = String(rawPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function readStopEvent() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function readTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  try {
    return readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
}

// Reuse the authoritative active-agent detection: a spawned run_in_background:true Agent
// whose tool-use id has NOT been cleared by a completed/killed task-notification.
function activeAgentCount(transcript) {
  if (!transcript) return 0;
  const liveSpawnIds = new Set();
  const agentRe = /"id"\s*:\s*"(toolu_[A-Za-z0-9_]+)"[\s\S]{0,200}?"name"\s*:\s*"Agent"[\s\S]{0,3000}?"run_in_background"\s*:\s*true/g;
  for (const spawnMatch of transcript.matchAll(agentRe)) liveSpawnIds.add(spawnMatch[1]);
  if (liveSpawnIds.size === 0) return 0;
  const notificationRe = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  for (const notification of transcript.matchAll(notificationRe)) {
    const notificationBody = notification[1];
    if (!/<status>\s*(completed|killed)\s*<\/status>/i.test(notificationBody)) continue;
    const idMatch = notificationBody.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
    if (idMatch) liveSpawnIds.delete(idMatch[1]);
  }
  return liveSpawnIds.size;
}

// Did the orchestrator run a git check against an agent branch recently? We look only at
// the TAIL of the transcript so stale evidence from much earlier doesn't satisfy the gate.
function recentlyCheckedAgents(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  try {
    const fullTranscript = readFileSync(transcriptPath, 'utf8');
    const recentTail = fullTranscript.length > TRANSCRIPT_TAIL_BYTES ? fullTranscript.slice(-TRANSCRIPT_TAIL_BYTES) : fullTranscript;
    return /worktree-agent-[a-z0-9]/i.test(recentTail) && /\bgit\b|rev-list|git log|--format/i.test(recentTail);
  } catch {
    return false;
  }
}

function readMonitorState() {
  if (!existsSync(STATE_FILE)) return { last_checked_at: 0, last_blocked_at: 0, surfaced_orphans: [] };
  try {
    const parsedState = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      last_checked_at: typeof parsedState.last_checked_at === 'number' ? parsedState.last_checked_at : 0,
      last_blocked_at: typeof parsedState.last_blocked_at === 'number' ? parsedState.last_blocked_at : 0,
      surfaced_orphans: Array.isArray(parsedState.surfaced_orphans) ? parsedState.surfaced_orphans.slice(-200) : [],
    };
  } catch {
    return { last_checked_at: 0, last_blocked_at: 0, surfaced_orphans: [] };
  }
}

function writeMonitorState(monitorState) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(monitorState), 'utf8');
  } catch { /* fail open */ }
}

// SessionStart cross-session deadman: a fresh session can't see the PRIOR session's spawns, so the Stop monitor
// (gated on this-transcript spawns) is structurally blind to agents that died when their parent session ended. This
// scan reads the GLOBAL pulse log instead — any label that pulsed within ORPHAN_WINDOW_MS, went silent past
// ORPHAN_STALE_MS, and never said DONE is an orphaned dead agent. Surfaced ONCE each (deduped by label@pulse-time),
// non-blocking (SessionStart stdout → context), so the new session salvages its banked autocommits instead of
// discovering the death by hand (the failure of 2026-06-28).
function runSessionStartOrphanScan(event, now = Date.now()) {
  const repoRoot = event.cwd || event.cwd_path || process.cwd();
  const pulseLogText = readPulseLog(repoRoot);
  if (!pulseLogText) process.exit(0);
  const orphans = staleAgentsFromPulseLog(pulseLogText, now, ORPHAN_STALE_MS, ORPHAN_WINDOW_MS) || [];
  if (orphans.length === 0) process.exit(0);
  const monitorState = readMonitorState();
  const surfacedKeys = new Set(monitorState.surfaced_orphans);
  const fresh = unsurfacedOrphans(orphans, surfacedKeys);
  if (fresh.length === 0) process.exit(0); // every current orphan already surfaced in a prior session → no nag
  for (const orphan of fresh) surfacedKeys.add(orphanKey(orphan));
  writeMonitorState({ ...monitorState, surfaced_orphans: [...surfacedKeys].slice(-200) });
  const orphanLines = fresh
    .sort((left, right) => right.idleMs - left.idleMs)
    .map((orphan) => `  - [${orphan.label}] — silent ${Math.round(orphan.idleMs / 60000)} min, last pulse: ${orphan.lastLine.replace(/^\[[^\]]+\]\s*/, '')}`)
    .join('\n');
  console.log(`ORPHANED AGENT(S) FROM A PRIOR SESSION — ${fresh.length} background agent(s) pulsed, then went silent without a DONE. A background agent dies with its parent session, so these are almost certainly dead with banked (autocommitted) work waiting to be salvaged:

${orphanLines}

ATTEND before new work (ACT, don't just note it):
1. Find each one's worktree/branch and inspect what it banked: \`git worktree list\` then \`git -C <repo> log --oneline <base>..<branch>\` — autocommits mean its progress is NOT lost.
2. SALVAGE: verify its suite, finish/merge the good parts, or re-spawn it fresh.
3. Delete its branch once merged so it stops showing here.

Surfaced once per dead agent (this won't nag again for these).`);
  // NOTE: do NOT process.exit() here — an immediate exit truncates buffered stdout when it's a pipe (the hook
  // harness). Return and let the process drain + exit naturally so the orphan report actually reaches the session.
}

function main() {
  const stopEvent = readStopEvent();
  const eventName = stopEvent.hook_event_name || stopEvent.hookEventName || '';

  // SessionStart: the cross-session orphan scan (NOT gated on this-session spawns — that's the whole point).
  if (eventName === 'SessionStart') { runSessionStartOrphanScan(stopEvent); return; }

  if (eventName !== 'Stop') process.exit(0);
  if (stopEvent.stop_hook_active) process.exit(0); // never loop

  const transcriptPath = stopEvent.transcript_path || stopEvent.transcriptPath || '';
  const transcript = readTranscript(transcriptPath);
  const liveAgents = activeAgentCount(transcript);
  if (liveAgents === 0) process.exit(0); // nothing to monitor

  const now = Date.now();
  const monitorState = readMonitorState();
  const repoRoot = stopEvent.cwd || stopEvent.cwd_path || process.cwd();

  // PRIMARY SIGNAL (2026-06-28, after the per-minute heartbeat contract): the pulse log. With STALE_MS down to 5 min,
  // the OLD git-ref-mtime check would false-positive on any agent in a >5-min foreground test run (no edit → no
  // autocommit → stale ref) — but the pulse contract now requires a heartbeat every ≤60s (long commands backgrounded),
  // so a silent-past-5-min label is genuinely dead. completedAgentLabels() excludes cleanly-finished agents. If there's
  // no pulse log at all, fall back to the git ref-mtime scan so the monitor still works.
  const completed = completedAgentLabels(transcript);
  const pulseLogText = readPulseLog(repoRoot);
  let stuckLines;
  let stuckCount;
  if (pulseLogText) {
    const stuckAgents = staleAgentsFromPulseLog(pulseLogText, now, STALE_MS, RECENT_WINDOW_MS, completed) || [];
    stuckCount = stuckAgents.length;
    stuckLines = stuckAgents
      .sort((left, right) => right.idleMs - left.idleMs)
      .map((entry) => `  - [${entry.label}] — no pulse in ~${Math.round(entry.idleMs / 60000)} min (the contract requires a heartbeat every ≤60s, so this agent is stalled/dead)`)
      .join('\n');
  } else {
    const stuckBranches = staleAgentBranchesByRef(repoRoot, now);
    stuckCount = stuckBranches.length;
    stuckLines = stuckBranches
      .sort((left, right) => right.ageMs - left.ageMs)
      .map((entry) => `  - ${entry.repo}: ${entry.branch} — no git activity in ~${Math.round(entry.ageMs / 60000)} min (autocommits advance the ref every edit, so this branch is stalled/dead)`)
      .join('\n');
  }
  if (stuckCount === 0) {
    writeMonitorState({ ...monitorState, last_checked_at: now }); // every agent fresh-or-gone → healthy
    process.exit(0);
  }
  if (now - monitorState.last_blocked_at < CADENCE_MS) process.exit(0); // throttle while being salvaged
  writeMonitorState({ ...monitorState, last_blocked_at: now });
  process.stdout.write(JSON.stringify({ decision: 'block', reason: `STUCK AGENT DETECTED — ${stuckCount} background agent(s) silent for > ${Math.round(STALE_MS / 60000)} min. Russell should NOT be the one who notices.

${stuckLines}

ATTEND now (ACT, don't just glance): a cleanly-finished agent ends on a DONE pulse and is excluded, so anything shown here is genuinely stalled or dead.
1. Inspect what it banked: \`git worktree list\` then \`git -C <repo> log --oneline <base>..<branch>\`. Autocommits mean its progress is NOT lost.
2. SALVAGE: verify its suite, finish/merge the good parts. Re-spawn it (SendMessage the agent id) or complete it yourself.
3. Delete its branch once merged so it stops showing here.

Re-surfaces at most every ${Math.round(CADENCE_MS / 60000)} min while an agent stays silent.` }));
  process.exit(0);
}

// Entry-point guard: importing this file (e.g. in its test) must NOT run main(),
// because main() reads stdin (fd 0) and would hang the test. We compare by BASENAME, not full path: a deadman hook
// that silently no-ops is the exact failure we're fixing, and an exact-path compare is fragile on Windows (MSYS
// `/c/...` vs `C:\...`, file:// scheme, separator + case differences) — so the hook could quietly never run. The
// test file's basename (`...-cadence.test.mjs`) differs, so importing it still doesn't trigger main().
function isDirectRun() {
  try {
    return basename(process.argv[1] || '').toLowerCase() === basename(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return false;
  }
}
if (isDirectRun()) main();

export { activeAgentCount, recentlyCheckedAgents, staleAgentBranches, agentBranchAges, staleAgentsFromPulseLog, completedAgentLabels, staleAgentBranchesByRef, unsurfacedOrphans, orphanKey };
