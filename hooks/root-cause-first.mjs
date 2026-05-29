#!/usr/bin/env node
// root-cause-first — PreToolUse(Edit|Write). When you add a new branch / case /
// function to a "hot" pipeline file, require that you've traced the call path
// first. Prevents the most expensive class of fix: correct logic added to a
// function that isn't actually called for this path — the fix lands, tests
// still fail, and you lose 30 minutes finding out why.
//
// Fires ONLY when:
//   - the edited file's basename is in the hot-file list, AND
//   - the new text adds a structural branch (else-if / switch case / function).
//
// Hot files are CONFIGURABLE — set ROOT_CAUSE_FILES to a comma-separated list of
// basenames for YOUR pipeline (e.g. "compiler.js,parser.ts,router.go"). Default
// is a generic guess; if none of your files match, the hook is a silent no-op.
//
// Clear the gate by doing ONE of:
//   - add a call-path comment to the edit:  // call path: entry() → router() → here()
//   - add the token  root-cause-verified  anywhere in the new text
//   - set ROOT_CAUSE_OVERRIDE=1

import { readFileSync } from 'node:fs';

const DEFAULT_HOT_FILES = ['compiler.js', 'parser.js', 'validator.js', 'tokenizer.js', 'router.js'];
const HOT_FILES = (process.env.ROOT_CAUSE_FILES
	? process.env.ROOT_CAUSE_FILES.split(',').map((s) => s.trim()).filter(Boolean)
	: DEFAULT_HOT_FILES);

function main() {
	if (process.env.ROOT_CAUSE_OVERRIDE === '1') process.exit(0);

	let event;
	try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
	catch { process.exit(0); }

	const toolName = event.tool_name || '';
	if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

	const filePath = (event.tool_input?.file_path || '').split('\\').join('/');
	const fileName = filePath.split('/').pop() || '';
	if (!HOT_FILES.includes(fileName)) process.exit(0);

	const newText = event.tool_input?.new_string || event.tool_input?.content || '';

	const addsBranch = [
		/\}\s*else\s+if\s*\(/,
		/\bcase\s+[\w.'"]+\s*:/,
		/^\s*function\s+\w+\s*\(/m,
		/^\s*(?:def|func|fn)\s+\w+\s*\(/m,
	].some((pattern) => pattern.test(newText));
	if (!addsBranch) process.exit(0);

	if (newText.includes('// call path:') || newText.includes('// called from:')) process.exit(0);
	if (newText.includes('root-cause-verified')) process.exit(0);

	const reason = [
		`ROOT-CAUSE-FIRST — new branch/case being added to ${fileName} (a hot pipeline file).`,
		'',
		'Before this lands, verify the call path:',
		'  1. Which entry-point triggers this code path?',
		'  2. Is the function you\'re editing ACTUALLY CALLED for this path?',
		'     (The expensive bug: right logic, wrong function — it\'s never reached.)',
		'  3. Confirm with a quick grep/diagnostic of the caller chain.',
		'',
		'To proceed, do ONE of:',
		'  • Add a comment: // call path: entry() → router() → thisFunction()',
		'  • Add the token  root-cause-verified  anywhere in the new text',
		'  • Set ROOT_CAUSE_OVERRIDE=1',
		'',
		`(Configure which files this guards with ROOT_CAUSE_FILES; currently: ${HOT_FILES.join(', ')})`,
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
