#!/usr/bin/env node
// read-before-write — PreToolUse(Edit|Write). Block editing (or overwriting) a
// big file you have NOT Read in the current session.
//
// The failure mode it catches: the agent edits a large file from partial memory
// of its contents. The `old_string` no longer matches because the file drifted
// since it was last seen → Edit fails → retry → eventually succeeds → wasted
// turns, and sometimes a wrong edit lands on stale assumptions. Reading the file
// first is cheap; guessing its state is not.
//
// Blocks:
//   - Edit on a file > LINES_THRESHOLD lines not Read/Written this session
//   - Write that OVERWRITES an existing file > LINES_THRESHOLD lines, ditto
// Allows:
//   - files <= LINES_THRESHOLD lines (small enough to edit safely)
//   - Write creating a NEW file (nothing to drift from)
//   - any file Read or Written at least once this session
//
// Config: READ_BEFORE_WRITE_LINES overrides the threshold (default 200).
// Override: READ_BEFORE_WRITE_OVERRIDE=1. Fail-open on any error.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const LINES_THRESHOLD = Number(process.env.READ_BEFORE_WRITE_LINES) || 200;

function main() {
	if (process.env.READ_BEFORE_WRITE_OVERRIDE === '1') { process.exit(0); return; }

	let event;
	try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); return; }

	const toolName = event.tool_name;
	if (toolName !== 'Edit' && toolName !== 'Write') { process.exit(0); return; }

	const filePath = event.tool_input && event.tool_input.file_path;
	if (!filePath || typeof filePath !== 'string') { process.exit(0); return; }

	const absPath = resolve(filePath);

	// New file via Write — nothing to drift from.
	if (!existsSync(absPath)) { process.exit(0); return; }

	let stat;
	try { stat = statSync(absPath); } catch { process.exit(0); return; }
	if (!stat.isFile()) { process.exit(0); return; }

	let lineCount = 0;
	try { lineCount = readFileSync(absPath, 'utf8').split('\n').length; }
	catch { process.exit(0); return; }
	if (lineCount <= LINES_THRESHOLD) { process.exit(0); return; }

	// Did we Read/Write this file already this session? Scan the transcript.
	const transcriptPath = event.transcript_path;
	if (!transcriptPath || !existsSync(transcriptPath)) { process.exit(0); return; }

	let transcript;
	try { transcript = readFileSync(transcriptPath, 'utf8'); }
	catch { process.exit(0); return; }

	if (sawPriorAccess(transcript, absPath)) { process.exit(0); return; }

	const reason = `Read Before Write — refusing to ${toolName} a big file you haven't seen this session.

File:        ${filePath}
Lines:       ${lineCount} (threshold: ${LINES_THRESHOLD})
Prior Read:  none in this session's transcript

The failure mode this catches:
  - Editing a big file from partial memory of its state
  - \`old_string\` no longer matches because the file drifted
  - Edit fails → retry → wasted turns, or a wrong edit on stale assumptions

How to proceed:
  1. Read the file first (one Read covers the first 2000 lines).
  2. Re-attempt the ${toolName} with current knowledge.

Override (rare — only if you just created the file in a sibling call):
  READ_BEFORE_WRITE_OVERRIDE=1`;

	process.stdout.write(JSON.stringify({ decision: 'block', reason }));
	process.exit(0);
}

// True if the transcript shows a prior Read/Write/Edit tool_use on this path.
function sawPriorAccess(transcript, targetAbsPath) {
	for (const line of transcript.split('\n')) {
		if (!line.trim()) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type !== 'assistant') continue;
		const msg = entry.message;
		if (!msg || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (!block || block.type !== 'tool_use') continue;
			if (block.name !== 'Read' && block.name !== 'Write' && block.name !== 'Edit') continue;
			const fp = block.input && block.input.file_path;
			if (!fp || typeof fp !== 'string') continue;
			try { if (resolve(fp) === targetAbsPath) return true; } catch { /* skip */ }
		}
	}
	return false;
}

main();
