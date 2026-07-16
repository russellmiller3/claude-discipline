// Tests for discipline-sync's pure core. Run: node --test discipline-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hooksNeedingSync, filterStillNeedingSync, changedHookBasenames, uncommittedForChanged,
  kitDocsTouchedThisSession, kitDocsFilesTouchedThisSession, uncommittedKitDocsForTouched } from './discipline-sync.mjs';

const assistantEditing = (file_path) => ({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path } }] } });

// The docs half of main()'s decision, replayed from the two pure functions main() uses:
//   docsTouched = a kit doc was edited this session; kitDocsDirty = only THOSE files if left uncommitted.
// The publish loop lets Stop through the docs gate iff (docsTouched && kitDocsDirty is empty). This mirrors the
// exact conjuncts in main()'s `if (… && docsTouched && !kitDocsDirty.length)`, so it asserts the REAL decision.
const docsGatePasses = (sessionEntries, kitPorcelain) => {
  const touched = kitDocsFilesTouchedThisSession(sessionEntries);
  const dirty = uncommittedKitDocsForTouched(kitPorcelain, touched);
  return touched.length > 0 && dirty.length === 0;
};

test('kitDocsTouchedThisSession: true when the kit README was edited', () => {
  assert.equal(kitDocsTouchedThisSession([assistantEditing('C:/x/claude-discipline/README.md')]), true);
});
test('kitDocsTouchedThisSession: true when a kit docs/ file was edited', () => {
  assert.equal(kitDocsTouchedThisSession([assistantEditing('/home/u/Desktop/programming/claude-discipline/docs/HOOKBOOK.md')]), true);
});
test('kitDocsTouchedThisSession: false for a kit HOOK edit (not docs)', () => {
  assert.equal(kitDocsTouchedThisSession([assistantEditing('C:/x/claude-discipline/hooks/ross-perot-guard.mjs')]), false);
});
test('kitDocsTouchedThisSession: false when nothing in the kit was touched', () => {
  assert.equal(kitDocsTouchedThisSession([assistantEditing('C:/x/.claude/hooks/foo.mjs')]), false);
});

// ── kitDocsFilesTouchedThisSession (which specific kit doc BASENAMES this session edited) ──
test('kitDocsFilesTouchedThisSession: returns the edited kit doc basename (docs/ file)', () => {
  const got = kitDocsFilesTouchedThisSession([assistantEditing('/home/u/Desktop/programming/claude-discipline/docs/HOOKBOOK.md')]);
  assert.deepEqual(got, ['hookbook.md']);
});
test('kitDocsFilesTouchedThisSession: returns README basename', () => {
  assert.deepEqual(kitDocsFilesTouchedThisSession([assistantEditing('C:/x/claude-discipline/README.md')]), ['readme.md']);
});
test('kitDocsFilesTouchedThisSession: empty when only a kit HOOK (not a doc) was edited', () => {
  assert.deepEqual(kitDocsFilesTouchedThisSession([assistantEditing('C:/x/claude-discipline/hooks/ross-perot-guard.mjs')]), []);
});

// ── uncommittedKitDocsForTouched (scopes the dirty-docs porcelain to what THIS session touched) ──
test('uncommittedKitDocsForTouched: flags a touched doc left dirty, ignores an UNRELATED dirty README', () => {
  const porcelain = [
    ' M docs/HOOKBOOK.md',   // this session edited this → flag it if dirty
    ' M README.md',          // another session's WIP → must be ignored
  ].join('\n');
  assert.deepEqual(uncommittedKitDocsForTouched(porcelain, ['hookbook.md']), [' M docs/HOOKBOOK.md']);
});
test('uncommittedKitDocsForTouched: empty when the only dirty doc is one this session did NOT touch', () => {
  assert.deepEqual(uncommittedKitDocsForTouched(' M README.md', ['hookbook.md']), []);
});

// ── THE 2026-07-06 FIX (the decision, replayed the way main() computes it) ──
// FALSE-POSITIVE that started this fix: this session committed its own kit doc row (docs/HOOKBOOK.md — NOT dirty),
// but the kit ALSO carried an UNRELATED dirty README.md from another task. The old BLANKET docs check blocked Stop,
// demanding I commit that unrelated WIP. With the scoped check the docs gate must PASS (no block).
test('does NOT block when this session\'s kit doc is committed but an UNRELATED README is dirty (the FP)', () => {
  const sessionEntries = [assistantEditing('C:/x/claude-discipline/docs/HOOKBOOK.md')]; // I edited (then committed) HOOKBOOK
  const kitPorcelain = ' M README.md';                                                   // another session's dirty WIP
  assert.equal(docsGatePasses(sessionEntries, kitPorcelain), true, 'unrelated dirty README must not block Stop');
});

// The real requirement is NOT weakened: if THIS session edited a kit doc and left it UNCOMMITTED, still block.
test('DOES block when THIS session edited a kit doc and left it uncommitted', () => {
  const sessionEntries = [assistantEditing('C:/x/claude-discipline/docs/HOOKBOOK.md')]; // I edited HOOKBOOK
  const kitPorcelain = ' M docs/HOOKBOOK.md';                                            // …and left it dirty
  assert.equal(docsGatePasses(sessionEntries, kitPorcelain), false, 'my own uncommitted kit doc must still block');
});

// ── hooksNeedingSync ──
test('flags a published hook whose live + kit copies differ as drift', () => {
  const readLive = (name) => ({ 'a.mjs': 'LIVE-A' }[name] ?? null);
  const readKit = (name) => ({ 'a.mjs': 'OLD-A' }[name] ?? null);
  assert.deepEqual(hooksNeedingSync(['a.mjs'], readLive, readKit), [{ basename: 'a.mjs', reason: 'drift' }]);
});

test('flags a NEW hook (no kit twin) as missing — must be published now', () => {
  const readLive = () => 'LIVE';
  const readKit = () => null;                 // not in the kit yet
  assert.deepEqual(hooksNeedingSync(['new-guard.mjs'], readLive, readKit), [{ basename: 'new-guard.mjs', reason: 'missing' }]);
});

test('flags a mix of missing + drift, skips in-sync', () => {
  const live = { 'a.mjs': '1', 'b.mjs': 'NEW', 'c.mjs': 'same' };
  const kit = { 'a.mjs': 'X', 'c.mjs': 'same' };          // b.mjs absent from kit
  const needing = hooksNeedingSync(['a.mjs', 'b.mjs', 'c.mjs'], (n) => live[n] ?? null, (n) => kit[n] ?? null);
  assert.deepEqual(needing.sort((x, y) => x.basename.localeCompare(y.basename)),
    [{ basename: 'a.mjs', reason: 'drift' }, { basename: 'b.mjs', reason: 'missing' }]);
});

test('does NOT flag a hook that is already in sync', () => {
  const same = () => 'IDENTICAL';
  assert.deepEqual(hooksNeedingSync(['a.mjs'], same, same), []);
});

test('does NOT flag when the live file is gone (deleted, not this guard\'s job)', () => {
  assert.deepEqual(hooksNeedingSync(['a.mjs'], () => null, () => 'KIT'), []);
});

// ── filterStillNeedingSync (THE 2026-07-12 FIX) ──
// Real incident: `ross-perot-guard.mjs` + its test were fixed and committed to a FEATURE branch this session, but
// discipline-sync.mjs only ever checked the kit's `main` branch — which never got the update — so it reported
// "drift" forever even though the live file matched the kit's actual current HEAD exactly. main() now runs
// hooksNeedingSync() against `main`, then drops anything from that list whose live content matches the kit's HEAD.
test('drops a hook from "needing" when it only looks like drift against main but matches the kit\'s current HEAD (fixed on a feature branch, not merged to main yet)', () => {
  const needingFromMain = [{ basename: 'ross-perot-guard.mjs', reason: 'drift' }, { basename: 'ross-perot-guard.test.mjs', reason: 'drift' }];
  const live = { 'ross-perot-guard.mjs': 'FIXED-V2', 'ross-perot-guard.test.mjs': 'FIXED-V2-TEST' };
  const head = { 'ross-perot-guard.mjs': 'FIXED-V2', 'ross-perot-guard.test.mjs': 'FIXED-V2-TEST' }; // committed here, not on main
  const got = filterStillNeedingSync(needingFromMain, (n) => live[n] ?? null, (n) => head[n] ?? null);
  assert.deepEqual(got, [], 'both hooks are actually synced (on HEAD) — must NOT still block Stop');
});

// The requirement is NOT weakened: real, uncommitted-anywhere drift must still block.
test('keeps a hook in "needing" when it does not match main OR head (genuine unpublished drift)', () => {
  const needingFromMain = [{ basename: 'a.mjs', reason: 'drift' }];
  const live = { 'a.mjs': 'LIVE-NEW' };
  const head = { 'a.mjs': 'STILL-OLD' };            // not committed here either
  const got = filterStillNeedingSync(needingFromMain, (n) => live[n] ?? null, (n) => head[n] ?? null);
  assert.deepEqual(got, [{ basename: 'a.mjs', reason: 'drift' }], 'genuine drift must still block Stop');
});

// THE 2026-07-06 CASE MUST STILL WORK: a hook published on main, where the alt-ref (HEAD) read is unavailable
// (e.g. the checkout is parked on an unrelated branch that doesn't have this file, or the ref lookup fails) —
// hooksNeedingSync() already resolved it as in-sync via the `main` reader, so it's not in `needingFromMain` at
// all; filterStillNeedingSync must be a no-op pass-through here, proving the main-branch path still works
// independently of HEAD.
test('a hook already resolved as in-sync via main (2026-07-06 case) is never touched by the HEAD filter', () => {
  const needingFromMain = hooksNeedingSync(['agent-watchdog.mjs'],
    (n) => ({ 'agent-watchdog.mjs': 'PUBLISHED' }[n] ?? null),
    (n) => ({ 'agent-watchdog.mjs': 'PUBLISHED' }[n] ?? null)); // main already matches → hooksNeedingSync returns []
  assert.deepEqual(needingFromMain, []);
  const got = filterStillNeedingSync(needingFromMain, () => 'PUBLISHED', () => null); // HEAD read fails/unrelated
  assert.deepEqual(got, [], 'nothing to filter — main alone already satisfied sync');
});

// ── uncommittedForChanged (whole-session scoping must NOT yak-shave unrelated WIP hooks) ──
test('uncommittedForChanged: flags only this session\'s touched hooks + settings.json, ignores other WIP hooks', () => {
  const porcelain = [
    ' M hooks/agent-monitor-cadence.mjs',   // I touched this → flag
    ' M hooks/e2e-or-its-theatre.mjs',      // someone else's WIP → ignore
    '?? hooks/verify-change-with-screenshot.mjs', // unrelated → ignore
    ' M settings.json',                      // registration → flag
  ].join('\n');
  const got = uncommittedForChanged(porcelain, ['agent-monitor-cadence.mjs']);
  assert.deepEqual(got, [' M hooks/agent-monitor-cadence.mjs', ' M settings.json']);
});

test('uncommittedForChanged: empty when nothing I touched is uncommitted', () => {
  assert.deepEqual(uncommittedForChanged(' M hooks/someone-else.mjs', ['my-hook.mjs']), []);
});

// ── changedHookBasenames ──
const turn = (toolUses) => [{ role: 'assistant', message: { content: toolUses.map((t) => ({ type: 'tool_use', ...t })) } }];

test('detects a Write to a live hook file', () => {
  const got = changedHookBasenames(turn([{ name: 'Write', input: { file_path: 'C:/Users/rmill/.claude/hooks/foo-guard.mjs' } }]));
  assert.deepEqual(got, ['foo-guard.mjs']);
});

test('detects an Edit and includes .test.mjs', () => {
  const got = changedHookBasenames(turn([
    { name: 'Edit', input: { file_path: '/c/Users/rmill/.claude/hooks/bar.mjs' } },
    { name: 'Write', input: { file_path: '/c/Users/rmill/.claude/hooks/bar.test.mjs' } },
  ]));
  assert.deepEqual(got.sort(), ['bar.mjs', 'bar.test.mjs']);
});

test('detects a Bash cp that targets the live hooks dir', () => {
  const got = changedHookBasenames(turn([{ name: 'Bash', input: { command: 'cp x ~/.claude/hooks/copied.mjs' } }]));
  assert.deepEqual(got, ['copied.mjs']);
});

// THE 2026-07-03 FIX: a hook merely READ/GREPPED/TESTED in a Bash command must NOT count as "changed" — only an
// actual WRITE to it should. A naive substring scan flagged bench-pattern-guard.mjs as "changed this session" from
// a plain `grep` reference, surfacing its unrelated pre-existing drift as a blocking publish requirement even
// though nothing about it was touched this session.
test('ignores a read-only grep referencing a hook path (no false positive)', () => {
  const got = changedHookBasenames(turn([{ name: 'Bash', input: { command: 'grep -n "OVERRIDE" ~/.claude/hooks/bench-pattern-guard.mjs' } }]));
  assert.deepEqual(got, []);
});

test('ignores a read-only cat of a hook path', () => {
  const got = changedHookBasenames(turn([{ name: 'Bash', input: { command: 'cat ~/.claude/hooks/foo-guard.mjs' } }]));
  assert.deepEqual(got, []);
});

test('ignores running a hook\'s own test suite (node --test)', () => {
  const got = changedHookBasenames(turn([{ name: 'Bash', input: { command: 'node --test ~/.claude/hooks/foo-guard.test.mjs' } }]));
  assert.deepEqual(got, []);
});

test('ignores a live smoke-test piping JSON into a hook (executing it, not writing it)', () => {
  const got = changedHookBasenames(turn([{ name: 'Bash', input: { command: 'echo \'{}\' | node ~/.claude/hooks/foo-guard.mjs' } }]));
  assert.deepEqual(got, []);
});

test('still detects a redirect write into a hook path', () => {
  const got = changedHookBasenames(turn([{ name: 'Bash', input: { command: 'echo "x" > ~/.claude/hooks/foo-guard.mjs' } }]));
  assert.deepEqual(got, ['foo-guard.mjs']);
});

test('still detects a heredoc append into a hook path', () => {
  const got = changedHookBasenames(turn([{ name: 'Bash', input: { command: 'cat >> ~/.claude/hooks/foo-guard.mjs <<EOF\nx\nEOF' } }]));
  assert.deepEqual(got, ['foo-guard.mjs']);
});

test('still detects sed -i on a hook path', () => {
  const got = changedHookBasenames(turn([{ name: 'Bash', input: { command: "sed -i 's/x/y/' ~/.claude/hooks/foo-guard.mjs" } }]));
  assert.deepEqual(got, ['foo-guard.mjs']);
});

test('a cp SOURCE from the hooks dir to elsewhere is not a write to that source', () => {
  const got = changedHookBasenames(turn([{ name: 'Bash', input: { command: 'cp ~/.claude/hooks/foo-guard.mjs /tmp/copy.mjs' } }]));
  assert.deepEqual(got, []);
});

test('ignores writes that are not in the hooks dir (no false positives)', () => {
  const got = changedHookBasenames(turn([
    { name: 'Write', input: { file_path: 'C:/Users/rmill/Desktop/programming/jarvis/src/app.mjs' } },
    { name: 'Edit', input: { file_path: 'C:/Users/rmill/.claude/hooks/HOOKBOOK.md' } },
  ]));
  assert.deepEqual(got, []);
});

// THE 2026-07-16 FIX: a Write to a hook file that was DENIED/BLOCKED by a PreToolUse guard NEVER created the file,
// so it must NOT count as a hook edit. Real incident: two blocked Writes to experiment-monitor-required.mjs (both
// denied by hook guards, the file never landed on disk) made discipline-sync demand a kit sync for a hook that was
// never written — the whole publish loop turned on for a phantom. The matching tool_result carries is_error:true
// (Claude Code marks every PreToolUse-blocked call that way); that tool_use is skipped. A successful write's result
// is NOT an error, so it still counts.
const assistantWrite = (id, file_path) => ({ role: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path } }] } });
const resultBlock = (tool_use_id, content, is_error) => ({ role: 'user', message: { content: [{ type: 'tool_result', tool_use_id, content, is_error }] } });

test('does NOT count a BLOCKED/denied Write to a hook file (file never created) — the 2026-07-16 FP', () => {
  const entries = [
    assistantWrite('tu_1', 'C:/Users/rmill/.claude/hooks/experiment-monitor-required.mjs'),
    resultBlock('tu_1', 'NEW HOOK — SWEEP THE EXISTING HOOKS FIRST: "experiment-monitor-required.mjs".', true),
  ];
  assert.deepEqual(changedHookBasenames(entries), [], 'a denied write never wrote the file → zero changed basenames');
});

test('does NOT count a Write whose PreToolUse:Write hook error result is marked is_error', () => {
  const entries = [
    assistantWrite('tu_2', 'C:/Users/rmill/.claude/hooks/experiment-monitor-required.mjs'),
    resultBlock('tu_2', 'HOOK DRY REVIEW — "experiment-monitor-required.mjs" re-implements helper(s)...', true),
  ];
  assert.deepEqual(changedHookBasenames(entries), []);
});

test('STILL counts a SUCCESSFUL Write to a hook file (result is not an error)', () => {
  const entries = [
    assistantWrite('tu_3', 'C:/Users/rmill/.claude/hooks/foo-guard.mjs'),
    resultBlock('tu_3', 'File created successfully at: C:/Users/rmill/.claude/hooks/foo-guard.mjs', false),
  ];
  assert.deepEqual(changedHookBasenames(entries), ['foo-guard.mjs']);
});

test('STILL counts a Write with no tool_result recorded yet (optimistic default — a bare assistant turn still counts)', () => {
  const entries = [assistantWrite('tu_4', 'C:/Users/rmill/.claude/hooks/foo-guard.mjs')];
  assert.deepEqual(changedHookBasenames(entries), ['foo-guard.mjs']);
});

// A successful Edit result may echo a diff snippet of the edited hook — and many guard hooks literally contain the
// word "BLOCKED" in their own strings. Keying on is_error (NOT on text) means such a legit edit is NOT false-skipped.
test('STILL counts a successful Edit of a hook whose own content contains the word BLOCKED', () => {
  const entries = [
    { role: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_5', name: 'Edit', input: { file_path: 'C:/Users/rmill/.claude/hooks/some-guard.mjs' } }] } },
    resultBlock('tu_5', 'The file has been updated. Snippet:\n  reason: "... BLOCKED — do the thing ..."', false),
  ];
  assert.deepEqual(changedHookBasenames(entries), ['some-guard.mjs']);
});

// THE 2026-06-28 FIX: a hook edited in an EARLIER turn (with a later user turn in between) must still be detected —
// main() now scans the whole-session transcript, not just the current turn. Build a multi-turn transcript and assert
// the turn-1 hook edit is found even though turn 2 touched nothing relevant.
test('detects a hook edited in an earlier turn across a multi-turn session (the cross-turn miss)', () => {
  const sessionEntries = [
    { role: 'user', message: { content: 'go' } },
    ...turn([{ name: 'Edit', input: { file_path: 'C:/Users/rmill/.claude/hooks/agent-monitor-cadence.mjs' } }]),
    { role: 'user', message: { content: 'now do something unrelated' } },
    ...turn([{ name: 'Bash', input: { command: 'git status' } }]),
  ];
  assert.deepEqual(changedHookBasenames(sessionEntries), ['agent-monitor-cadence.mjs']);
});
