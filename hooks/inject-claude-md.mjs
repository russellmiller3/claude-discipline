#!/usr/bin/env node
// inject-claude-md — SessionStart. Read ~/.claude/CLAUDE.md and print it so it
// lands in the conversation context at session start.
//
// Claude Code already loads CLAUDE.md natively in most setups; this hook is a
// belt-and-suspenders guarantee for SDK/headless/cron sessions where the native
// load may not happen. No-ops silently if the file doesn't exist.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const claudeMdPath = resolve(homedir(), '.claude', 'CLAUDE.md');

try {
	const fileBody = readFileSync(claudeMdPath, 'utf8');
	console.log('=== AUTO-LOADED: ~/.claude/CLAUDE.md ===');
	console.log(fileBody);
} catch {
	// File not found / unreadable — nothing to inject. Stay silent so the hook
	// is invisible when the companion file isn't present.
}
