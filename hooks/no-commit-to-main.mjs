#!/usr/bin/env node
// no-commit-to-main — PreToolUse(Bash). Block `git commit` while the current
// branch is main (or master). Work on a branch; merge when done.
//
// Why a hook and not just a rule: "always branch first" is easy to follow until
// a quick one-line fix feels not worth a branch — and that's exactly the commit
// that ends up on main with no review boundary. A deterministic gate removes the
// judgment call.
//
// Allows: git commit on any branch other than main/master.
// Blocks: git commit (any flags) when the current branch is main or master.
// Override: COMMIT_MAIN_OVERRIDE=1 (env or inline) for deliberate main commits
//           — version bumps, doc-only changes, repo maintenance.
// Fail-open on any git error.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const PROTECTED = new Set(['main', 'master']);

function main() {
	if (process.env.COMMIT_MAIN_OVERRIDE === '1') process.exit(0);

	let event;
	try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); }

	if (event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') process.exit(0);

	const command = (event.tool_input && event.tool_input.command) || '';
	if (typeof command !== 'string') process.exit(0);
	const normalized = command.replace(/\s+/g, ' ').trim();

	// Inline `COMMIT_MAIN_OVERRIDE=1 git commit …` sets the var for the git
	// subprocess, not for this hook — honor it explicitly.
	if (/\bCOMMIT_MAIN_OVERRIDE=1\b/.test(normalized)) process.exit(0);

	if (!/\bgit\s+commit\b/.test(normalized)) process.exit(0);

	let branch;
	try {
		branch = execSync('git branch --show-current', {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();
	} catch {
		process.exit(0); // not a repo / git unavailable — don't block
	}

	if (!PROTECTED.has(branch)) process.exit(0);

	const reason = [
		'Commit to main blocked.',
		'',
		`Current branch: ${branch}`,
		`Command: ${normalized.slice(0, 120)}${normalized.length > 120 ? '…' : ''}`,
		'',
		'Rule: never commit directly to main. Work on a branch.',
		'',
		'Branch, then commit:',
		'  git switch -c feature/<task>',
		'  git commit …',
		'',
		'When done, merge back:',
		'  git switch main',
		'  git merge --ff-only feature/<task>',
		'  git branch -d feature/<task>',
		'',
		'Override for deliberate main commits (version bumps, doc-only, maintenance):',
		'  COMMIT_MAIN_OVERRIDE=1',
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
