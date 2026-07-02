#!/usr/bin/env node
/**
 * PreToolUse hook — block raw git ref writes to main/master, the exact pattern that caused
 * three separate silent-history-loss incidents in one skaffen-desktop session (2026-07-02).
 *
 * Root cause: a git worktree isolates the WORKING TREE + index, but NOT refs/heads/main --
 * that ref lives in the one shared .git directory across every worktree of a repo. An agent
 * landing its work with `git update-ref refs/heads/main <sha>` (or `git branch -f main`, or
 * `git checkout -B main <sha>`) skips git's built-in fast-forward safety check entirely --
 * unlike `git merge --ff-only`, which REFUSES to move the ref unless the target truly
 * contains the current tip. Three agents did this independently in one session, each
 * silently overwriting a sibling agent's just-landed commit (recoverable via reflog, but
 * each incident cost 20-40 minutes of manual archaeology to notice and repair).
 *
 * The fix agents should use instead: `~/.claude/scripts/safe-merge-to-main.sh` -- a real
 * mutex (atomic mkdir lock) around rebase-test-land, landing via a COMPARE-AND-SWAP
 * `update-ref <new> <old>` (the three-arg form, which DOES check the current value first)
 * rather than an unconditional two-arg write. This hook does not care HOW an agent lands
 * work as long as it isn't one of the three known-unsafe raw patterns below; the script
 * above is the recommended path, not the only technically-allowed one.
 *
 * Blocks (git targeting refs/heads/main or refs/heads/master, or the bare branch name):
 *   - `git update-ref refs/heads/main <sha>` (two-arg form -- no old-value check)
 *   - `git branch -f main <sha>` / `git branch --force main <sha>`
 *   - `git checkout -B main <sha>` / `git switch -C main <sha>`
 * Allows: the three-arg `update-ref refs/heads/main <new> <old>` compare-and-swap form
 * (that's the safe pattern the script itself uses), any command invoking
 * safe-merge-to-main.sh, `git merge --ff-only`, ordinary `git commit`/`git push`, and
 * everything else.
 *
 * Override (rare -- e.g. Russell directly repairing a corrupted ref): SAFE_MERGE_OVERRIDE=1
 */

import { readFileSync } from 'node:fs';

function main() {
  if (process.env.SAFE_MERGE_OVERRIDE === '1') process.exit(0);

  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  if (!['Bash', 'PowerShell'].includes(event.tool_name)) process.exit(0);

  const command = (event.tool_input && event.tool_input.command) || '';
  if (typeof command !== 'string') process.exit(0);

  const c = command.replace(/\s+/g, ' ').trim();
  if (/\bSAFE_MERGE_OVERRIDE=1\b/.test(c)) process.exit(0);

  // Invoking the sanctioned script is always fine, regardless of what it does internally --
  // this hook only inspects the literal command an agent typed, never a spawned subprocess.
  if (/safe-merge-to-main\.sh\b/.test(c)) process.exit(0);

  const BRANCH = '(?:main|master)';

  const patterns = [
    // Two-arg update-ref: `update-ref refs/heads/main <sha>` with NO third (old-value) arg.
    // The three-arg CAS form is the safe one the script uses -- only flag when a ref path
    // is followed by exactly one more bare token before end-of-command/pipe/&&/;.
    {
      re: new RegExp(`\\bgit\\s+update-ref\\s+refs/heads/${BRANCH}\\s+\\S+\\s*(?:$|[;&|])`, 'i'),
      why: 'a two-arg `update-ref` write with no old-value check -- git will overwrite the ref unconditionally, even if it moved since you last looked.',
    },
    {
      re: new RegExp(`\\bgit\\s+branch\\s+(?:-f|--force)\\s+${BRANCH}\\b`, 'i'),
      why: '`branch -f` force-moves the ref with no ancestry check at all.',
    },
    {
      re: new RegExp(`\\bgit\\s+(?:checkout\\s+-B|switch\\s+-C)\\s+${BRANCH}\\b`, 'i'),
      why: '`checkout -B`/`switch -C` resets the branch to wherever you point it, no fast-forward check.',
    },
  ];

  const hit = patterns.find((p) => p.re.test(c));
  if (!hit) process.exit(0);

  // The safe three-arg CAS form of update-ref (`update-ref refs/heads/main <new> <old>`)
  // must not be caught by the two-arg pattern above -- double-check by counting trailing
  // tokens after the ref path before allowing the deny to fire.
  if (hit.why.startsWith('a two-arg')) {
    const afterRef = c.slice(c.search(new RegExp(`refs/heads/${BRANCH}`, 'i')));
    const tokensAfterRef = afterRef.trim().split(/\s+/).slice(1).filter((t) => t && !/^[;&|]/.test(t));
    if (tokensAfterRef.length >= 2) process.exit(0); // three-arg CAS form -- safe, allow
  }

  const reason = [
    'UNSAFE MAIN-REF WRITE BLOCKED.',
    '',
    `Command: ${c.slice(0, 160)}${c.length > 160 ? '...' : ''}`,
    `Why: ${hit.why}`,
    '',
    'Three separate agents did exactly this in one skaffen-desktop session and each silently',
    "overwrote a sibling agent's just-landed work (recoverable via reflog, but 20-40 min of",
    'archaeology per incident). A git worktree isolates your working tree, NOT refs/heads/main --',
    'that ref is shared across every worktree of this repo.',
    '',
    'Use the sanctioned landing script instead -- it holds a real lock and lands via a',
    'compare-and-swap that fails loudly on a race instead of silently discarding work:',
    '',
    '  ~/.claude/scripts/safe-merge-to-main.sh <repo-path> <your-branch> "<test-command>"',
    '',
    '(<repo-path> is YOUR OWN worktree -- the one with <your-branch> already checked out,',
    'never the primary working directory or another worktree.)',
    '',
    'Override (rare -- a deliberate, supervised ref repair): SAFE_MERGE_OVERRIDE=1',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

main();
