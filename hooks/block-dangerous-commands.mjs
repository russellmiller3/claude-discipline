#!/usr/bin/env node
// block-dangerous-commands — PreToolUse(Bash). The safety floor: refuse the
// handful of shell commands that can irreversibly nuke a machine or repo.
//
// This is intentionally NARROW. It blocks catastrophes (recursive force-deletes
// of the filesystem root or home, disk overwrites, fork bombs), not merely
// risky commands — a gate that fires constantly gets disabled, and then it
// protects nothing. Everything here is something you almost never mean to run.
//
// Blocks:
//   - rm -rf / , rm -rf ~, rm -rf /* , rm -rf $HOME and friends
//   - dd writing to a whole block device (of=/dev/sd?, /dev/nvme?, /dev/disk?)
//   - mkfs.* on a device
//   - shredding / overwriting block devices
//   - the classic :(){ :|:& };: fork bomb
//   - chmod/chown -R on / or ~
//   - curl|sh / wget|sh piping a remote script straight into a shell
//
// Override: set ALLOW_DANGEROUS_COMMAND=1 (env or inline prefix) for the rare
// case you genuinely mean it. Fail-open on any parse error — never wedge CC.

import { readFileSync } from 'node:fs';

const RULES = [
	{
		name: 'recursive force-delete of root / home / wildcard',
		// rm with -r and -f (in any order/combination)…
		re: /\brm\b[^\n|&;]*-[a-z]*r[a-z]*f|\brm\b[^\n|&;]*-[a-z]*f[a-z]*r/i,
		// …targeting /, ~, $HOME, /*, .* (not a named subdirectory)
		guard: /\brm\b[^\n|&;]*\s(\/|~|\$HOME|\/\*|\.\*)(\s|$|\*|\/)/i,
	},
	{
		name: 'dd to a raw block device',
		re: /\bdd\b[^\n]*\bof=\/dev\/(sd[a-z]|nvme\d|disk\d|hd[a-z]|vd[a-z])/i,
	},
	{
		name: 'mkfs on a device',
		re: /\bmkfs(\.\w+)?\b[^\n]*\/dev\//i,
	},
	{
		name: 'overwrite / shred a block device',
		re: /\b(shred|wipefs)\b[^\n]*\/dev\/|>\s*\/dev\/(sd[a-z]|nvme\d|disk\d)/i,
	},
	{
		name: 'fork bomb',
		re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
	},
	{
		name: 'recursive chmod/chown on root or home',
		re: /\b(chmod|chown)\b[^\n]*\s-R[^\n]*\s(\/|~|\$HOME)(\s|$)/i,
	},
	{
		name: 'piping a remote script straight into a shell',
		re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|d|fi)?sh\b/i,
	},
];

function isDangerous(command) {
	for (const rule of RULES) {
		if (!rule.re.test(command)) continue;
		// If a rule has a secondary guard, BOTH must match (cuts false positives,
		// e.g. `rm -rf node_modules` is fine; `rm -rf /` is not).
		if (rule.guard && !rule.guard.test(command)) continue;
		return rule.name;
	}
	return null;
}

function main() {
	if (process.env.ALLOW_DANGEROUS_COMMAND === '1') process.exit(0);

	let event;
	try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); }

	if (event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') process.exit(0);
	const command = (event.tool_input && event.tool_input.command) || '';
	if (typeof command !== 'string' || !command.trim()) process.exit(0);

	// Inline `ALLOW_DANGEROUS_COMMAND=1 rm ...` sets the var for the subprocess,
	// not for this hook — honor it explicitly.
	if (/\bALLOW_DANGEROUS_COMMAND=1\b/.test(command)) process.exit(0);

	const hit = isDangerous(command);
	if (!hit) process.exit(0);

	const reason = [
		'BLOCKED — dangerous command.',
		'',
		`Matched: ${hit}`,
		`Command: ${command.slice(0, 160)}${command.length > 160 ? '…' : ''}`,
		'',
		'This command can irreversibly destroy data or the machine. If you are',
		'CERTAIN you mean it (and have a backup), re-run with the override:',
		'  ALLOW_DANGEROUS_COMMAND=1 <command>',
		'',
		'Otherwise: narrow the target (delete a specific subdirectory, not /),',
		'or do the destructive step by hand outside the agent.',
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
