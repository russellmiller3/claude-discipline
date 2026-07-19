// require-learnings-ack.test.mjs — regression net for the learnings-ack gate.
//
// The bug this pins (bit twice: 2026-06-01 filebrain, 2026-06-22 jarvis/extension): the marker that
// BLOCKS an edit lives at the edited file's project root, which can be a NESTED package root (a subdir
// with its own package.json, e.g. extension/). The Read-clear used to only wipe the read-file root and
// the cwd root, so a marker at a nested root was never cleared and the gate stuck forever. The fix sweeps
// the whole repo subtree on ack. These tests prove: (1) a nested marker IS cleared by reading a
// learnings.md, (2) an unacknowledged nested marker still BLOCKS a code edit, (3) after the read the edit
// is allowed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'require-learnings-ack.mjs');
const MARKER_RELATIVE = join('.claude', 'state', 'learnings-ack-needed.json');

// Build a temp repo: a git root with a NESTED package root that holds the marker + the file we'll edit.
function makeRepo() {
	const repoRoot = mkdtempSync(join(tmpdir(), 'ack-gate-'));
	mkdirSync(join(repoRoot, '.git'), { recursive: true });
	writeFileSync(join(repoRoot, 'package.json'), '{}');
	writeFileSync(join(repoRoot, 'learnings.md'), '# learnings\n');
	const nestedRoot = join(repoRoot, 'extension');
	mkdirSync(join(nestedRoot, 'lib'), { recursive: true });
	writeFileSync(join(nestedRoot, 'package.json'), '{}'); // makes extension/ a project root
	writeFileSync(join(nestedRoot, 'lib', 'foo.js'), '// code\n');
	return { repoRoot, nestedRoot, editTarget: join(nestedRoot, 'lib', 'foo.js') };
}

function dropMarker(atRoot) {
	const markerFile = join(atRoot, MARKER_RELATIVE);
	mkdirSync(dirname(markerFile), { recursive: true });
	writeFileSync(markerFile, JSON.stringify({ ts: Date.now(), sections: ['x'], files: ['learnings.md'], tokens: ['build'] }));
	return markerFile;
}

function runHook(event, extraEnv) {
	const completed = spawnSync(process.execPath, [hookPath], {
		input: JSON.stringify(event),
		encoding: 'utf8',
		env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
	});
	return completed.stdout || '';
}

test('reading a learnings.md clears a marker at a NESTED package root (the stuck-gate bug)', () => {
	const { repoRoot, nestedRoot } = makeRepo();
	const markerFile = dropMarker(nestedRoot); // marker lives in extension/, not at the repo root
	try {
		runHook({ tool_name: 'Read', tool_input: { file_path: join(repoRoot, 'learnings.md') }, cwd: repoRoot });
		assert.equal(existsSync(markerFile), false, 'nested marker should be swept by the ack read');
	} finally {
		rmSync(repoRoot, { recursive: true, force: true });
	}
});

test('an unacknowledged nested marker BLOCKS a code edit', () => {
	const { repoRoot, nestedRoot, editTarget } = makeRepo();
	dropMarker(nestedRoot);
	try {
		const hookStdout = runHook({ tool_name: 'Write', tool_input: { file_path: editTarget }, cwd: repoRoot });
		const verdict = JSON.parse(hookStdout || '{}');
		assert.equal(verdict.hookSpecificOutput?.permissionDecision, 'deny', 'edit must be denied while marker unacked');
	} finally {
		rmSync(repoRoot, { recursive: true, force: true });
	}
});

test('after the ack read, the same code edit is allowed', () => {
	const { repoRoot, nestedRoot, editTarget } = makeRepo();
	dropMarker(nestedRoot);
	try {
		runHook({ tool_name: 'Read', tool_input: { file_path: join(repoRoot, 'learnings.md') }, cwd: repoRoot });
		const hookStdout = runHook({ tool_name: 'Write', tool_input: { file_path: editTarget }, cwd: repoRoot });
		assert.equal(hookStdout.trim(), '', 'no deny output once the learning is acknowledged');
	} finally {
		rmSync(repoRoot, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Session-scoped, section-aware acknowledgment (2026-07-03 TDD false-positive
// loop): a full-file Read of learnings.md must keep counting as acknowledgment
// for the REST of the session, even after error tokens (intentional TDD reds)
// re-arm the marker. Partial reads credit only the sections they covered;
// sections the session never read still block.
// ---------------------------------------------------------------------------

// learnings.md with two H2 sections at known line positions:
//   line 1: # learnings          line 5: - alpha bullet two
//   line 2: (blank)              line 6: (blank)
//   line 3: ## Alpha Gotchas     line 7: ## Beta Gotchas
//   line 4: - alpha bullet one   line 8: - beta bullet
// Alpha spans lines 3-6, Beta spans 7-EOF. A Read of lines 1-6 covers Alpha only.
const SECTIONED_LEARNINGS = '# learnings\n\n## Alpha Gotchas\n- alpha bullet one\n- alpha bullet two\n\n## Beta Gotchas\n- beta bullet\n';

function makeSessionRepo() {
	const { repoRoot, nestedRoot, editTarget } = makeRepo();
	writeFileSync(join(repoRoot, 'learnings.md'), SECTIONED_LEARNINGS);
	const env = { LEARNINGS_ACK_DIR: join(repoRoot, 'ack-store') };
	return { repoRoot, nestedRoot, editTarget, env };
}

function dropSectionedMarker(atRoot, sections) {
	const markerFile = join(atRoot, MARKER_RELATIVE);
	mkdirSync(dirname(markerFile), { recursive: true });
	writeFileSync(markerFile, JSON.stringify({ ts: Date.now(), sections, files: ['learnings.md'], tokens: ['AttributeError'] }));
	return markerFile;
}

test('full-file read acknowledges ALL sections for the session', () => {
	const { repoRoot, nestedRoot, env } = makeSessionRepo();
	const markerFile = dropSectionedMarker(nestedRoot, ['[project] Alpha Gotchas', '[project] Beta Gotchas']);
	try {
		runHook({ tool_name: 'Read', tool_input: { file_path: join(repoRoot, 'learnings.md') }, cwd: repoRoot, session_id: 'sess-full' }, env);
		assert.equal(existsSync(markerFile), false, 'full-file read must clear every marker section');
	} finally {
		rmSync(repoRoot, { recursive: true, force: true });
	}
});

test('acknowledged sections do NOT re-block when error tokens re-arm the marker (TDD red loop)', () => {
	const { repoRoot, nestedRoot, editTarget, env } = makeSessionRepo();
	try {
		// 1. Agent reads the whole learnings file early in the session.
		runHook({ tool_name: 'Read', tool_input: { file_path: join(repoRoot, 'learnings.md') }, cwd: repoRoot, session_id: 'sess-tdd' }, env);
		// 2. An intentional red test prints AttributeError -> learnings-error-match re-drops the marker.
		const rearmedMarker = dropSectionedMarker(nestedRoot, ['[project] Alpha Gotchas', '[project] Beta Gotchas']);
		// 3. The next code edit in the SAME session must NOT be blocked.
		const hookStdout = runHook({ tool_name: 'Write', tool_input: { file_path: editTarget }, cwd: repoRoot, session_id: 'sess-tdd' }, env);
		assert.equal(hookStdout.trim(), '', 'sections read this session must not re-block after marker re-arm');
		assert.equal(existsSync(rearmedMarker), false, 'fully-acknowledged re-armed marker should be consumed');
	} finally {
		rmSync(repoRoot, { recursive: true, force: true });
	}
});

test('partial read acknowledges ONLY the covered sections; uncovered sections still block', () => {
	const { repoRoot, nestedRoot, editTarget, env } = makeSessionRepo();
	const markerFile = dropSectionedMarker(nestedRoot, ['[project] Alpha Gotchas', '[project] Beta Gotchas']);
	try {
		// Read lines 1-6: covers Alpha (3-6) fully, leaves Beta (7-EOF) unread.
		runHook({ tool_name: 'Read', tool_input: { file_path: join(repoRoot, 'learnings.md'), offset: 1, limit: 6 }, cwd: repoRoot, session_id: 'sess-part' }, env);
		assert.equal(existsSync(markerFile), true, 'marker must survive while a section is still unread');
		const markerAfterRead = JSON.parse(readFileSync(markerFile, 'utf8'));
		assert.deepEqual(markerAfterRead.sections, ['[project] Beta Gotchas'], 'only the covered section is dropped from the marker');

		const hookStdout = runHook({ tool_name: 'Write', tool_input: { file_path: editTarget }, cwd: repoRoot, session_id: 'sess-part' }, env);
		const verdict = JSON.parse(hookStdout || '{}');
		const reason = verdict.hookSpecificOutput?.permissionDecisionReason || '';
		assert.equal(verdict.hookSpecificOutput?.permissionDecision, 'deny', 'unread section must still block');
		assert.ok(reason.includes('Beta Gotchas'), 'block message lists the still-unread section');
		assert.ok(!reason.includes('Alpha Gotchas'), 'block message must NOT list the already-read section');
	} finally {
		rmSync(repoRoot, { recursive: true, force: true });
	}
});

// LIVE BUG (2026-07-19, Macher): a read whose window shows a section's HEADER and its first
// lines — but stops before the section body ends — must credit that section. The old rule required
// the read range to FULLY contain the section, so `offset 22 limit 30` over a section starting at
// line 40 (body running past 51) never counted, and the gate looped forever.
const HEADER_VISIBLE_LEARNINGS =
	'# learnings\n\n## Alpha Gotchas\n- alpha one\n- alpha two\n- alpha three\n- alpha four\n\n## Beta Gotchas\n- beta bullet\n';
// Alpha header line 3, body runs to line 7, section span 3-8. Beta header line 9.

test('a read that shows a section header but stops before the section ends credits that section', () => {
	const { repoRoot, nestedRoot, editTarget, env } = makeSessionRepo();
	writeFileSync(join(repoRoot, 'learnings.md'), HEADER_VISIBLE_LEARNINGS);
	const markerFile = dropSectionedMarker(nestedRoot, ['[project] Alpha Gotchas']);
	try {
		// Read lines 1-4: shows Alpha's header (line 3) + first bullet, but NOT the rest of Alpha (5-7).
		runHook({ tool_name: 'Read', tool_input: { file_path: join(repoRoot, 'learnings.md'), offset: 1, limit: 4 }, cwd: repoRoot, session_id: 'sess-header' }, env);
		assert.equal(existsSync(markerFile), false, 'seeing the section header must credit the section');
		const hookStdout = runHook({ tool_name: 'Write', tool_input: { file_path: editTarget }, cwd: repoRoot, session_id: 'sess-header' }, env);
		assert.equal(hookStdout.trim(), '', 'edit must be allowed once the section header was shown');
	} finally {
		rmSync(repoRoot, { recursive: true, force: true });
	}
});

test('a session that never read the matched section still gets blocked (no cross-session leak)', () => {
	const { repoRoot, nestedRoot, editTarget, env } = makeSessionRepo();
	try {
		// Session A reads everything; the marker then re-arms.
		runHook({ tool_name: 'Read', tool_input: { file_path: join(repoRoot, 'learnings.md') }, cwd: repoRoot, session_id: 'sess-reader' }, env);
		dropSectionedMarker(nestedRoot, ['[project] Alpha Gotchas']);
		// Session B (different session_id) never read anything -> must be blocked.
		const hookStdout = runHook({ tool_name: 'Write', tool_input: { file_path: editTarget }, cwd: repoRoot, session_id: 'sess-stranger' }, env);
		const verdict = JSON.parse(hookStdout || '{}');
		assert.equal(verdict.hookSpecificOutput?.permissionDecision, 'deny', 'acks are session-scoped; another session must still be blocked');
	} finally {
		rmSync(repoRoot, { recursive: true, force: true });
	}
});

test('reading the PROJECT learnings does not acknowledge a [global] section', () => {
	const { repoRoot, nestedRoot, editTarget, env } = makeSessionRepo();
	try {
		runHook({ tool_name: 'Read', tool_input: { file_path: join(repoRoot, 'learnings.md') }, cwd: repoRoot, session_id: 'sess-scope' }, env);
		dropSectionedMarker(nestedRoot, ['[global] Windows / Tooling Gotchas']);
		const hookStdout = runHook({ tool_name: 'Write', tool_input: { file_path: editTarget }, cwd: repoRoot, session_id: 'sess-scope' }, env);
		const verdict = JSON.parse(hookStdout || '{}');
		assert.equal(verdict.hookSpecificOutput?.permissionDecision, 'deny', 'project-file read must not credit global-scope sections');
	} finally {
		rmSync(repoRoot, { recursive: true, force: true });
	}
});

test('LIVE-BUG replica: full read of GLOBAL learnings, then AttributeError re-arms a [global] marker -> edit allowed', () => {
	const { repoRoot, nestedRoot, editTarget, env } = makeSessionRepo();
	// Stand in for ~/.claude/learnings.md via the test seam.
	const fakeGlobalDir = join(repoRoot, 'fake-home', '.claude');
	mkdirSync(fakeGlobalDir, { recursive: true });
	const fakeGlobalLearnings = join(fakeGlobalDir, 'learnings.md');
	writeFileSync(fakeGlobalLearnings, '# global learnings\n\n## Windows / Tooling Gotchas\n- gotcha bullet\n');
	const scopedEnv = { ...env, LEARNINGS_GLOBAL_PATH: fakeGlobalLearnings };
	try {
		// 19:58 — the agent reads the ENTIRE global learnings file (offset 1, no limit).
		runHook({ tool_name: 'Read', tool_input: { file_path: fakeGlobalLearnings, offset: 1 }, cwd: repoRoot, session_id: 'sess-live' }, scopedEnv);
		// Minutes later — intentional TDD red prints AttributeError; marker re-armed with the [global] section.
		dropSectionedMarker(nestedRoot, ['[global] Windows / Tooling Gotchas']);
		// The next implementation edit must sail through.
		const hookStdout = runHook({ tool_name: 'Write', tool_input: { file_path: editTarget }, cwd: repoRoot, session_id: 'sess-live' }, scopedEnv);
		assert.equal(hookStdout.trim(), '', 'the exact 2026-07-03 false-positive loop must not block');
	} finally {
		rmSync(repoRoot, { recursive: true, force: true });
	}
});
