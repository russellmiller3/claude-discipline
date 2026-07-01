#!/usr/bin/env node
/**
 * PreToolUse hook — block EVERY `git push` unless Russell just authorized it.
 *
 * Russell's rule (2026-06-04, ~/.claude/CLAUDE.md "Never Push to GitHub
 * Without Explicit Permission"): the default is local-only. Commit and merge
 * locally all you want, but a push to GitHub — including `origin main` — only
 * happens when Russell explicitly says "push". "Ship" / "finish" / "land it"
 * do NOT count; only a direct push instruction does.
 *
 * This is STRICTER than no-feature-branch-push.mjs (which allows main pushes).
 * The two compose: a push needs BOTH the PUSH_APPROVED token here AND a
 * main-on-origin target there.
 *
 * Why a token instead of an env var: an env override is sticky for the whole
 * session, which re-opens the exact reflexive-push gap this rule closes. A
 * per-command token forces a deliberate, single-push authorization that maps
 * 1:1 to "Russell just told me to push THIS."
 *
 * How to push when authorized: append the literal token `PUSH_APPROVED` to the
 * command (a trailing `# PUSH_APPROVED` comment is the clean way), e.g.
 *   git push origin main   # PUSH_APPROVED
 * Append it ONLY when Russell has explicitly authorized that specific push.
 *
 * Fail-open on any unexpected error — never permanently wedge CC.
 */

import { readFileSync } from 'node:fs';

// Blank heredoc bodies (<<'EOF' … EOF) and quoted strings so text INSIDE a commit message can't be
// read as a real git command. A genuine `git push` on the command line is never quoted, so it survives.
function commandWithoutStringsAndHeredocs(command) {
  let stripped = command.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, ' ');
  stripped = stripped.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  return stripped;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  if (event.tool_name !== 'Bash') process.exit(0);

  const command = (event.tool_input && event.tool_input.command) || '';
  if (typeof command !== 'string') process.exit(0);

  // Only fire on an ACTUAL `git push` command — not the words "git push" quoted inside a commit
  // MESSAGE or heredoc body (e.g. `git commit -m "removed the stale 'git push origin main' line"`).
  // Strip heredoc bodies + quoted strings first, then look for the command. (2026-07-01 false-fire.)
  if (!/\bgit\s+push\b/.test(commandWithoutStringsAndHeredocs(command))) process.exit(0);

  // The one escape hatch: Russell authorized THIS push, so the command carries
  // the deliberate token.
  if (/PUSH_APPROVED/.test(command)) process.exit(0);

  const reason =
    `🚫 Push blocked — Russell hasn't authorized a push to GitHub.\n\n` +
    `Russell's rule (2026-06-04, ~/.claude/CLAUDE.md "Never Push to GitHub Without\n` +
    `Explicit Permission"): the default is local-only. Commit and merge locally;\n` +
    `a push happens ONLY when Russell explicitly says "push" / "push to GitHub" /\n` +
    `"publish" / "push main". "Ship" / "finish" / "land it" do NOT authorize a push.\n\n` +
    `Detected command: ${command.replace(/\s+/g, ' ').trim().slice(0, 120)}\n\n` +
    `If — and only if — Russell just authorized this exact push, re-run it with the\n` +
    `deliberate token appended:\n` +
    `  ${command.replace(/\s+/g, ' ').trim().slice(0, 80)}   # PUSH_APPROVED\n\n` +
    `Otherwise: leave the work committed to local main and tell Russell it's ready\n` +
    `to push when he gives the word.`;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

main();
