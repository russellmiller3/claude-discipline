#!/usr/bin/env node
// protect-secrets — PreToolUse(Read|Edit|Write|Bash). Stop the agent from
// reading or writing credential files, and from echoing them through the shell.
//
// Why: an agent that Reads your `.env` pulls live secrets into the transcript
// (and into the model provider's logs). An agent that `cat`s `~/.ssh/id_rsa`
// does the same. This is the single most common way a coding agent leaks a key.
//
// Blocks:
//   - Read/Edit/Write whose path looks like a secret store (.env, *.pem, *.key,
//     id_rsa, .npmrc, .pypirc, .aws/credentials, .netrc, *.p12/.pfx, etc.)
//   - Bash commands that print such a file (cat/less/head/tail/strings/xxd)
//
// Allows:
//   - .env.example / .env.sample / .env.template (these are meant to be shared)
//   - writing a brand-new .env (scaffolding is fine; reading an EXISTING one is not)
//
// Override: SECRETS_OK=1 (env or inline prefix). Fail-open on parse errors.

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const SECRET_PATH_RE = [
	/(^|[\\/])\.env(\.[\w-]+)?$/i,          // .env, .env.local, .env.production
	/(^|[\\/])\.npmrc$/i,
	/(^|[\\/])\.pypirc$/i,
	/(^|[\\/])\.netrc$/i,
	/(^|[\\/])\.git-credentials$/i,
	/(^|[\\/])\.aws[\\/]credentials$/i,
	/(^|[\\/])\.ssh[\\/].*(id_[a-z0-9]+|identity)$/i,
	/(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
	/\.(pem|key|p12|pfx|keystore|jks)$/i,
	/(^|[\\/])(secrets?|credentials?)\.(json|ya?ml|toml|ini)$/i,
	/(^|[\\/])service[-_]account.*\.json$/i,
];

// .env.example and friends are templates — safe to share.
const SAFE_EXAMPLE_RE = /\.(example|sample|template|dist)$/i;

function looksSecret(filePath) {
	if (!filePath || typeof filePath !== 'string') return false;
	if (SAFE_EXAMPLE_RE.test(filePath)) return false;
	return SECRET_PATH_RE.some((re) => re.test(filePath));
}

// Bash commands that would dump a secret file's contents to the transcript.
function bashLeaksSecret(command) {
	if (typeof command !== 'string') return null;
	const printRe = /\b(cat|bat|less|more|head|tail|strings|xxd|od|nl|tac|type|Get-Content|gc)\b([^\n|&;]*)/gi;
	let m;
	while ((m = printRe.exec(command)) !== null) {
		for (const token of m[2].split(/\s+/)) {
			const arg = token.replace(/^["']|["']$/g, '');
			if (arg && looksSecret(arg)) return arg;
		}
	}
	return null;
}

function deny(reason) {
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason,
		},
	}));
	process.exit(0);
}

function main() {
	if (process.env.SECRETS_OK === '1') process.exit(0);

	let event;
	try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); }

	const tool = event.tool_name || '';
	const input = event.tool_input || {};

	if (tool === 'Bash' || tool === 'PowerShell') {
		const command = input.command || '';
		if (/\bSECRETS_OK=1\b/.test(command)) process.exit(0);
		const leaked = bashLeaksSecret(command);
		if (leaked) {
			deny([
				'BLOCKED — this command would print a secret file into the transcript.',
				'',
				`File: ${leaked}`,
				'',
				'Reading a credential file pulls live secrets into the conversation (and',
				'the model provider\'s logs). Don\'t. If you need a value FROM it, have the',
				'human paste only the one value you need, or read it via an env var.',
				'',
				'Override (you accept the exposure): SECRETS_OK=1 <command>',
			].join('\n'));
		}
		process.exit(0);
	}

	if (tool === 'Read' || tool === 'Edit' || tool === 'Write') {
		const filePath = input.file_path || input.path || '';
		if (!looksSecret(filePath)) process.exit(0);

		// Writing a NEW secret file (scaffolding) is allowed; reading/editing an
		// EXISTING one is the leak.
		if (tool === 'Write' && !existsSync(filePath)) process.exit(0);

		deny([
			`BLOCKED — ${tool} on a credential file.`,
			'',
			`File: ${basename(filePath)}`,
			'',
			'This path looks like a secret store (key, .env, credentials). Reading it',
			'exposes live secrets to the model and its logs; editing it risks committing',
			'them. Work with a `.env.example` instead, or have the human handle the real file.',
			'',
			'Override (you accept the exposure): set SECRETS_OK=1 in the environment.',
		].join('\n'));
	}

	process.exit(0);
}

main();
