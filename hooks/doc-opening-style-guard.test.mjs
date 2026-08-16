import assert from 'node:assert/strict';
import { evaluate, isColdReadDoc, openingWindow } from './doc-opening-style-guard.mjs';

let passed = 0;
function test(name, assertions) { assertions(); passed += 1; console.log(`  \u2713 ${name}`); }

// ---------------------------------------------------------------------------
// FIXTURE A — the real HANDOFF.md opening Russell called gibberish
// (codeservo, the blob at d4f07eb^). Verbatim.
// ---------------------------------------------------------------------------
const REAL_FAILING_OPENER_A = `# CodeServo Handoff

**Read top to bottom. Ordered by what to do next, not by history.**

---

# START HERE — the exact first action

**The job: make a warm CodeServo edit fast, without losing any accuracy.**
A Task is several successive edits. Startup belongs in the background. The
closeout runs ONCE at the end. Everything between is the hot path.

## There is work already in flight. Do NOT redo it.

Branch **\`fix/share-snapshot-derivations\`**, commit **\`02b59f7\`**, worktree
\`codeservo-wt/share-snapshot-derivations\`. 61/61 librarian tests green, **NOT
merged.**

It memoizes the file-first branch of \`code_entries_for_snapshot\`, which rebuilt
its whole mapping on every call while the sibling branch returned a memo. After
an edit the caller holds a file-first version, so the warm path was exactly the
unmemoized one — the branch that runs most often cached least.

**Its one missing gate is a trustworthy AFTER measurement.** The number taken on
2026-08-17 came back ~3x the known-good baseline because the test suite had just
loaded the machine — the cold-stampede trap in \`learnings.md\`. Re-measure on a
settled machine, then merge or discard on the evidence.
`;

// ---------------------------------------------------------------------------
// FIXTURE B — the second real failing opener (the blob at c7785de^). Verbatim.
// ---------------------------------------------------------------------------
const REAL_FAILING_OPENER_B = `# CodeServo Handoff

**Read top to bottom. Ordered by what to do next, not by history.**

## North star

Prove the same model finishes Russell's recurring repository work more
accurately, faster, cheaper and with fewer tokens through CodeServo than through
ordinary tools.

## The current job: make a real task fast

**Russell's framing, 2026-08-17.** A Task is several successive edits. Startup
belongs in the background when a coding session opens. \`finish_task\` runs ONCE
at the end, to verify CodeServo did what the model intended. Everything between
is the hot path.

| step | per edit | x6 | status |
|---|---|---|---|
| \`build_cockpit\` | 97 | 582 | SHIPPED \`d055b1d\` |
| blast radius | 94 | 564 | reverted on purpose |
| \`inspect_code\` | 42 | 252 | split, no hotspot |
| \`_file_first_inventory\` | 12 | 72 | at floor |
`;

// ---------------------------------------------------------------------------
// FIXTURE C — the opener Russell rewrote himself and accepted. MUST PASS.
// ---------------------------------------------------------------------------
const REAL_GOOD_OPENER = `# CodeServo Handoff

**Read top to bottom. Ordered by what to do next, not by history.**

---

# START HERE

## What we are doing, in one line

**Making CodeServo fast enough that editing code through it feels instant.**

A real task is several edits in a row. Right now each edit takes about 1.3
seconds. Most of that is not the edit — it is CodeServo re-checking things about
the repository that could not possibly have changed.

## Where we got to

Yesterday an edit took 3.9 seconds. It now takes about 1.3. Eight fixes, all
shipped, all with identical output before and after.

The pattern behind every one: the code was never slow. It was correct code
answering a question about the WHOLE repository when only ONE file had changed.
`;

test('BLOCKS the first real failing opener (machine nouns, no gloss)', () => {
  const verdict = evaluate({ path: 'C:/repo/HANDOFF.md', docText: REAL_FAILING_OPENER_A });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /machine names in the opening/);
});

test('BLOCKS the second real failing opener (symbol table, no gloss)', () => {
  const verdict = evaluate({ path: 'C:/repo/HANDOFF.md', docText: REAL_FAILING_OPENER_B });
  assert.equal(verdict.block, true);
});

test('PASSES the opener Russell rewrote and accepted', () => {
  assert.equal(evaluate({ path: 'C:/repo/HANDOFF.md', docText: REAL_GOOD_OPENER }).block, false);
});

test('BLOCKS a wall of text in the opening', () => {
  const wall = `# Doc\n\n${'plain readable english words '.repeat(30)}\n`;
  assert.equal(evaluate({ path: 'docs/thing.md', docText: wall }).block, true);
});

test('never touches a code file, a test, or an out-of-scope doc', () => {
  for (const docPath of ['src/librarian.py', 'hooks/foo.test.mjs', 'learnings.md', 'CLAUDE.md']) {
    assert.equal(isColdReadDoc(docPath), false, docPath);
    assert.equal(evaluate({ path: docPath, docText: REAL_FAILING_OPENER_A }).block, false, docPath);
  }
});

test('covers HANDOFF.md, README, and markdown under plans/ or docs/', () => {
  for (const docPath of ['HANDOFF.md', 'README.md', 'README', 'plans/256-x.md', 'a/docs/b.md']) {
    assert.equal(isColdReadDoc(docPath), true, docPath);
  }
});

test('dense reference detail BELOW the opening stays allowed', () => {
  // The good opener is ~150 words, so the 250-word window would otherwise bleed into the
  // dense block below it. Pad past the window with more clean prose first.
  const doc = `${REAL_GOOD_OPENER}\n${REAL_GOOD_OPENER}\n${REAL_FAILING_OPENER_A}`;
  assert.equal(evaluate({ path: 'HANDOFF.md', docText: doc }).block, false);
});

test('the escape token waives it', () => {
  const escaped = `${REAL_FAILING_OPENER_A}\nDOC_OPENING_STYLE_OK`;
  assert.equal(evaluate({ path: 'HANDOFF.md', docText: escaped }).block, false);
  assert.equal(evaluate({ path: 'HANDOFF.md', docText: REAL_FAILING_OPENER_A, envOk: true }).block, false);
});

test('fails open on empty / missing input', () => {
  assert.equal(evaluate({}).block, false);
  assert.equal(evaluate({ path: 'HANDOFF.md', docText: '' }).block, false);
  assert.equal(openingWindow(null), '');
});

console.log(`\n${passed} tests passed`);
