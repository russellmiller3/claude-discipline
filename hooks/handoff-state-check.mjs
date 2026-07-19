#!/usr/bin/env node
// handoff-state-check.mjs — PreToolUse(Write|Edit) guard with TEETH. Blocks a HANDOFF.md write whose
// "Pick up here" names a branch that no longer exists, or a head commit that doesn't match that branch's
// tip. Prevents the stale-handoff cold-start derailment (2026-06-25: the handoff pointed at branch
// `feature/record-to-recipe` after it was merged to main + DELETED; the next session typed "go" and was
// instantly confused because the handoff and git disagreed). The skill rule alone can't guarantee this —
// this hook enforces the OUTCOME: a saved handoff names a branch+head that actually exist.
//
// 2026-07-13 fix (cross-repo + in-flight false positive): the guard used to rev-parse ONLY in the repo
// that owns the HANDOFF.md. A Marcus handoff line truthfully describing a branch that lives in a
// DIFFERENT repo (Desktop/programming/legible) — and was being created by a just-dispatched agent —
// got hard-blocked. Now, before blocking:
//   (a) any repo path/name mentioned on the SAME line as the branch claim is resolved (absolute paths
//       as-is; relative names against the handoff's repo, its parent, ~/Desktop, ~/Desktop/programming,
//       and ~) and the branch is re-checked there;
//   (b) a line marking the branch as agent work in flight (dispatched / agent / will create / spawning)
//       downgrades a would-be block to a WARNING (stderr, exit 0).
// A repo mentioned on the line but NOT on this disk does NOT soften the block (can't verify ≠ verified —
// and the canonical orientation line always names a repo path, so an unresolvable path as an excuse would
// neuter the guard); the block message explains the in-flight escape hatch instead. The original true
// positive — a merged+deleted branch claimed in the handoff's own repo with no in-flight marker — still
// blocks, and stays pinned by a regression test.

import { execSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Pull the branch name and (optional) head short-hash out of the handoff's orientation block. Matches the
// canonical "on branch `X`" / "branch **`X`**" phrasings + "head `abc1234`". Returns nulls when absent.
export function extractBranchAndHead(handoffContent) {
  // Primary: the canonical orientation-block phrasings ("on branch `X`" / "**Repo:** ... branch `X`").
  // Fallback: a "Branch `X`" CALLOUT -- anchored to line-start (optionally through **emphasis**) so it
  // only matches the callout shape this hook actually cares about, not the word "branch" appearing
  // anywhere in prose (e.g. "the frozen-branch code path" is a DIFFERENT sense of "branch" entirely --
  // a code branch, not a git branch -- and must not be mistaken for one). Also excludes a callout
  // immediately followed by "(merged"/"(deleted"/"(closed" etc., which is this project's own convention
  // for narrating a COMPLETED, already-gone branch in a "Prior milestone" history section (e.g.
  // "**Branch `feature/foo` (merged to main).**"). Without both guards, ordinary prose or a
  // merged-milestone writeup permanently false-positives this hook, since HANDOFF.md accumulates that
  // historical prose by design and never removes it.
  const branchMatch = handoffContent.match(/(?:on branch|^\s*\*\*Repo:\*\*[^\n]*?branch)\s+\*{0,2}`([^`]+)`/im)
    || handoffContent.match(/^\s*\*{0,2}branch\s+\*{0,2}`([^`]+)`(?!\s*\(\s*(?:merged|deleted|closed|removed)\b)/im);
  const headMatch = handoffContent.match(/\bhead\s+`?([0-9a-f]{6,40})`?/i);
  return { branch: branchMatch ? branchMatch[1].trim() : null, head: headMatch ? headMatch[1].trim() : null };
}

// Same extraction, plus the full physical LINE that carries the branch claim — the line is the context
// window for cross-repo mentions and in-flight markers (both are only trusted when they sit on the same
// line as the claim, so prose elsewhere in the file can't accidentally soften a real staleness block).
export function extractBranchClaim(handoffContent) {
  const claimMatch = handoffContent.match(/(?:on branch|^\s*\*\*Repo:\*\*[^\n]*?branch)\s+\*{0,2}`([^`]+)`/im)
    || handoffContent.match(/^\s*\*{0,2}branch\s+\*{0,2}`([^`]+)`(?!\s*\(\s*(?:merged|deleted|closed|removed)\b)/im);
  const headMatch = handoffContent.match(/\bhead\s+`?([0-9a-f]{6,40})`?/i);
  if (!claimMatch) return { branch: null, head: headMatch ? headMatch[1].trim() : null, line: null };
  const claimLineStart = handoffContent.lastIndexOf('\n', claimMatch.index) + 1;
  const claimLineBreak = handoffContent.indexOf('\n', claimMatch.index);
  const claimLineEnd = claimLineBreak === -1 ? handoffContent.length : claimLineBreak;
  return {
    branch: claimMatch[1].trim(),
    head: headMatch ? headMatch[1].trim() : null,
    line: handoffContent.slice(claimLineStart, claimLineEnd),
  };
}

// The line says this branch is agent work in flight — it may legitimately not exist YET.
const IN_FLIGHT_RE = /\b(dispatch(?:ed|ing)?|in[- ]flight|will\s+(?:be\s+)?creat(?:e|es|ed|ing)|being\s+created|not\s+(?:yet\s+)?created|spawn(?:ed|ing)?|agent)\b/i;

// Repo path/name candidates mentioned on the claim line: backticked path-ish spans first (most explicit),
// then bare slash-containing tokens. The branch token itself and hash-looking tokens are never candidates.
// A candidate only MATTERS if it resolves to an existing directory, so ordinary slashed prose is inert.
export function findRepoTokens(line, branch) {
  const repoTokens = [];
  const pushToken = (rawToken) => {
    const token = rawToken.trim().replace(/[).,;:!?]+$/, '');
    if (!token || token === branch || repoTokens.includes(token)) return;
    if (/^[0-9a-f]{6,40}$/i.test(token)) return; // a commit hash, not a path
    repoTokens.push(token);
  };
  for (const backtickSpan of line.matchAll(/`([^`]+)`/g)) {
    const spanText = backtickSpan[1];
    if (/[\\/]/.test(spanText) || /^~[\\/]/.test(spanText) || /^[A-Za-z]:/.test(spanText)) pushToken(spanText);
  }
  for (const barePathMatch of line.matchAll(/(?:^|[\s(])((?:[A-Za-z]:[\\/])?(?:[\w.~-]+[\\/])+[\w.-]+)/g)) {
    pushToken(barePathMatch[1]);
  }
  return repoTokens;
}

// Where might a repo token live on disk? Absolute paths (and ~/) resolve as-is; relative names are tried
// against the handoff's own repo, its parent, and Russell's standard project roots.
function candidateDirs(repoToken, repoDir) {
  const home = homedir();
  const expandedToken = repoToken.replace(/^~(?=[\\/])/, home);
  if (isAbsolute(expandedToken) || /^[A-Za-z]:[\\/]/.test(expandedToken)) return [expandedToken];
  return [
    join(repoDir, expandedToken),
    join(dirname(repoDir), expandedToken),
    join(home, 'Desktop', expandedToken),
    join(home, 'Desktop', 'programming', expandedToken),
    join(home, expandedToken),
  ];
}

function defaultDirExists(candidatePath) {
  try { return statSync(candidatePath).isDirectory(); } catch { return false; }
}

// The workspace's project repos: immediate child dirs of `workspaceDir` that hold a `.git`, plus each
// checkout under a `*-worktrees/` dir. Used when a HANDOFF.md lives at a NON-repo workspace root
// (`programming/`) and names a branch that lives in one of the projects. (2026-07-16)
function defaultListChildRepos(workspaceDir) {
  const childRepos = [];
  const hasGit = (dirPath) => { try { statSync(join(dirPath, '.git')); return true; } catch { return false; } };
  let entries;
  try { entries = readdirSync(workspaceDir, { withFileTypes: true }); } catch { return childRepos; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = join(workspaceDir, entry.name);
    if (hasGit(childPath)) childRepos.push(childPath);
    if (/-worktrees$/i.test(entry.name)) {
      let worktrees;
      try { worktrees = readdirSync(childPath, { withFileTypes: true }); } catch { continue; }
      for (const worktree of worktrees) {
        if (worktree.isDirectory() && hasGit(join(childPath, worktree.name))) childRepos.push(join(childPath, worktree.name));
      }
    }
  }
  return childRepos;
}

// Pure verdict: given the handoff content + an injected git(args, repoDir) runner, decide ok/blocked.
// git() must THROW when a command fails (so a missing branch surfaces as a thrown rev-parse).
// Returns { ok, reason?, warn? } — warn means "allowed, but say so on stderr".
export function checkHandoffState({ content, repoDir, git, dirExists = defaultDirExists, listChildRepos = defaultListChildRepos }) {
  const { branch, head, line } = extractBranchClaim(content);
  if (!branch) return { ok: true }; // no branch claim in this write → nothing to verify (e.g. a partial edit)

  const branchTipIn = (candidateRepoDir) => {
    try { return git(`rev-parse --verify --short ${branch}`, candidateRepoDir); } catch { return null; }
  };

  let branchTip = branchTipIn(repoDir);
  let resolvedIn = repoDir;
  let checkedForeignRepo = null;      // a mentioned repo that EXISTS on disk but doesn't have the branch
  let unverifiableForeignRepo = null; // a mentioned repo that is NOT on this disk at all
  let scannedWorkspaceRepos = [];     // child project repos scanned when the handoff is at a workspace root

  if (branchTip === null && line) {
    for (const repoToken of findRepoTokens(line, branch)) {
      const existingDir = candidateDirs(repoToken, repoDir).find((candidatePath) => dirExists(candidatePath));
      if (!existingDir) { unverifiableForeignRepo ??= repoToken; continue; }
      const foreignTip = branchTipIn(existingDir);
      if (foreignTip !== null) { branchTip = foreignTip; resolvedIn = existingDir; break; }
      checkedForeignRepo ??= repoToken;
    }
  }

  // A HANDOFF.md at a NON-repo workspace root (`programming/`) legitimately names a branch that lives in
  // one of the workspace's project repos, even when the line names no path. If repoDir is not itself a git
  // repo (no `.git` here), scan its child project repos and accept a hit in ANY. Gated on "not its own
  // repo" so a merged+deleted branch in the handoff's OWN repo still blocks (that true positive survives).
  if (branchTip === null && !dirExists(join(repoDir, '.git'))) {
    scannedWorkspaceRepos = listChildRepos(repoDir);
    for (const candidateRepo of scannedWorkspaceRepos) {
      const workspaceTip = branchTipIn(candidateRepo);
      if (workspaceTip !== null) { branchTip = workspaceTip; resolvedIn = candidateRepo; break; }
    }
  }

  if (branchTip === null) {
    if (line && IN_FLIGHT_RE.test(line)) {
      return {
        ok: true,
        warn: `HANDOFF names branch \`${branch}\`, which doesn't exist yet — but the line marks it as agent work in flight, so this is allowed. Re-verify the handoff once that agent lands its branch.`,
      };
    }
    // NOTE (deliberate): a repo mentioned on the line but NOT on this disk does not soften the block —
    // "can't verify" is not "verified", and the canonical orientation line ALWAYS names a repo path, so
    // treating an unresolvable path as exculpatory would neuter the original true positive. The honest
    // escape hatches are: fix the branch name, or mark the line as in-flight agent work.
    return {
      ok: false,
      reason: `HANDOFF "Pick up here" names branch \`${branch}\`, which does NOT exist (git rev-parse failed${checkedForeignRepo ? ` here AND in the mentioned repo \`${checkedForeignRepo}\`` : ''}${unverifiableForeignRepo ? `; mentioned repo \`${unverifiableForeignRepo}\` was not found on this disk to check` : ''}${scannedWorkspaceRepos.length ? `; also scanned ${scannedWorkspaceRepos.length} workspace repo(s): ${scannedWorkspaceRepos.join(', ')}` : ''}) — it was probably merged + deleted. Re-point the handoff at the ACTUAL current branch: run \`git branch --show-current\` and \`git log -1\` and copy the real values in. (If the branch is being created by an in-flight agent, say so ON the same line — "dispatched"/"will create" — and this guard downgrades to a warning.)`,
    };
  }
  if (head && !branchTip.startsWith(head) && !head.startsWith(branchTip)) {
    return {
      ok: false,
      reason: `HANDOFF head \`${head}\` does not match the tip of branch \`${branch}\` (\`${branchTip}\`${resolvedIn !== repoDir ? ` in \`${resolvedIn}\`` : ''}). The handoff is stale — re-derive the head from \`git log -1\` against the real branch.`,
    };
  }
  return { ok: true };
}

function realGit(gitArgs, repoDir) {
  return execSync(`git ${gitArgs}`, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const toolName = input.tool_name;
  const filePath = input.tool_input?.file_path || '';
  if (!/HANDOFF\.md$/i.test(filePath)) process.exit(0); // only guards HANDOFF.md

  // Write carries the whole new file; Edit carries just the replacement snippet (only check it if it
  // actually contains a branch claim — otherwise the edit didn't touch the orientation block).
  const content = toolName === 'Write' ? (input.tool_input?.content || '') : (input.tool_input?.new_string || '');
  if (!content) process.exit(0);

  const verdict = checkHandoffState({ content, repoDir: dirname(filePath) || '.', git: realGit });
  if (!verdict.ok) {
    console.error(`STALE-HANDOFF BLOCKED — ${verdict.reason}`);
    process.exit(2); // teeth: non-zero blocks the tool call
  }
  if (verdict.warn) console.error(`STALE-HANDOFF WARNING (allowed) — ${verdict.warn}`);
  process.exit(0);
}

// Entry-point guard so the test can import the pure functions without running main() (which reads stdin).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
