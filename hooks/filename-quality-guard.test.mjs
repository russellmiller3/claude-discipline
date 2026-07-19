// Tests for filename-quality-guard's pure verdict. Run: node --test filename-quality-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assessFilename } from './filename-quality-guard.mjs';

test('blocks the motivating typo: findigns -> findings', () => {
  const verdict = assessFilename('bench/voice-latency/findigns.md');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /findings/);
});

// 2026-07-17 FALSE-BLOCK (marcus): `test_telemetry_drain.py` was blocked as a misspelling of "brain".
// "drain" is a standard engineering term (Heroku/Fly/Papertrail all call it a "log drain"). A real word
// one edit from a listed word must not be flagged as a typo of it.
test('ALLOWS "drain" and other real engineering terms one edit from a listed word', () => {
  for (const good of ['test_telemetry_drain.py', 'log-sink.ts', 'work-pump.mjs', 'thread-spool.py']) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good}`);
  }
});
// REGRESSION: a genuine typo (not itself a real word) must STILL block.
test('still BLOCKS a genuine typo (findigns) after the drain allowlist', () => {
  assert.equal(assessFilename('findigns.md').ok, false);
});
// 2026-07-19: "match" (one edit from "watch") and "cases" (one edit from "causes") are real words.
test('ALLOWS "match"/"cases" families (one edit from "watch"/"causes")', () => {
  for (const good of ['match.md', 'quoted-string-matcher.mjs', 'file-watcher.ts', 'test-cases.md', 'edge-case.py']) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good}`);
  }
});

test('blocks common misspellings (near-miss, one edit away)', () => {
  for (const bad of ['recieve.js', 'lenght.ts', 'benchmrk.mjs', 'summery-report.md', 'transcrpit.txt']) {
    assert.equal(assessFilename(bad).ok, false, `expected BLOCK for ${bad}`);
  }
});

test('blocks lazy/scratch stems', () => {
  for (const bad of ['tmp.mjs', 'output2.js', 'asdf.txt', 'untitled.md', 'final.docx', 'stuff.json', 'foo.ts']) {
    assert.equal(assessFilename(bad).ok, false, `expected BLOCK for ${bad}`);
  }
});

test('blocks vowelless dropped-vowel tokens', () => {
  for (const bad of ['fndngs.md', 'bnchmrk.mjs', 'schdlr.js']) {
    assert.equal(assessFilename(bad).ok, false, `expected BLOCK for ${bad}`);
  }
});

test('blocks a placeholder token inside a compound name', () => {
  assert.equal(assessFilename('voice-tmp-runner.mjs').ok, false);
});

test('ALLOWS the real files we just created (no false positives)', () => {
  for (const good of [
    'bench/voice-latency/FINDINGS.md',
    'bench/voice-latency/realtimeClients.mjs',
    'bench/voice-latency/bakeoff.mjs',
    'bench/voice-latency/env.mjs',
    'bench/voice-latency/smoke.mjs',
    'bench/voice-latency/package.json',
    'filename-quality-guard.mjs',
    // 2026-07-01 false-fires: real ML words wrongly flagged as typos, and mid-name "test".
    'train.py',                        // "train" was flagged as a typo of "brain"
    'test_b_modal.py',                 // "modal" was flagged as a typo of "model"
    'test_b_pretrained_fusion.py',     // "pretrained"/"fusion" — real words
    'validate_test_b.py',              // mid-name "test" beside real word "validate"
    'run_fusion_sizes.py',
  ]) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good} (got: ${JSON.stringify(assessFilename(good))})`);
  }
});

test('ALLOWS conventional caps files and dotfiles', () => {
  for (const good of ['README.md', 'LICENSE', 'HANDOFF.md', 'CLAUDE.md', '.gitignore', '.env', 'tsconfig.json', 'index.ts']) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good}`);
  }
});

test('ALLOWS unknown-but-plausible new domain words (only blocks CLOSE misspellings)', () => {
  for (const good of ['servoFormat.mjs', 'rhonda-orchestrator.js', 'meph-eval.mjs', 'kontext-loader.ts', 'zavient-api.js']) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good} (got: ${JSON.stringify(assessFilename(good))})`);
  }
});

test('camelCase and kebab tokenization both split correctly', () => {
  assert.equal(assessFilename('realtimeClients.mjs').ok, true);
  assert.equal(assessFilename('voice-latency-bakeoff.mjs').ok, true);
});

test('ALLOWS the test-file naming convention (pytest test_ prefix, Go _test suffix)', () => {
  // The `test`/`tests` token is STRUCTURAL in these positions (the file IS a test for X),
  // not a lazy placeholder — judge the rest of the name instead.
  for (const good of ['test_live_bridge.py', 'tests/integration/test_core_journey.py', 'bridge_test.go', 'test_brain_act.py']) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good} (got: ${JSON.stringify(assessFilename(good))})`);
  }
});

test('ALLOWS real words (out/in/data/output) INSIDE a compound, blocks them standalone', () => {
  // "out"/"in"/"data" are lazy only as a whole filename — inside a compound they're meaningful
  // (figure_it_out, opt_in, user_data, parse_output). The whole-stem check still blocks them alone.
  for (const good of ['figure_it_out.py', 'opt_in.js', 'roll_out.ts', 'user_data.py', 'parse_output.mjs', 'new_user.ts']) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good} (got: ${JSON.stringify(assessFilename(good))})`);
  }
  for (const bad of ['out.py', 'in.ts', 'data.md', 'output.js']) {
    assert.equal(assessFilename(bad).ok, false, `expected BLOCK for ${bad}`);
  }
});

test('still BLOCKS a bare/lazy test name even with the convention prefix', () => {
  // The prefix is structure, but the REST must still be meaningful: `test.py` and
  // `test_tmp.py` are caught (bare junk stem / lazy `tmp` token).
  for (const bad of ['test.py', 'tests.py', 'test_tmp.py']) {
    assert.equal(assessFilename(bad).ok, false, `expected BLOCK for ${bad}`);
  }
});

test('ALLOWS plain verbs beside their agent nouns (write vs writer, 2026-07-01 false-fire)', () => {
  // "write" is a real word one edit from "writer" — it was flagged as a typo and blocked
  // no-write-to-main.test.mjs. Verbs like write/watch/merge/build are known-good now.
  for (const good of ['no-write-to-main.mjs', 'watch-and-rebuild.mjs', 'merge-check.mjs']) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good} (got: ${JSON.stringify(assessFilename(good))})`);
  }
});

test('ALLOWS a new file whose stem matches an EXISTING sibling (X.test.mjs beside X.mjs)', () => {
  // Uses this real hooks directory: no-write-to-main.mjs exists, so a companion named
  // no-write-to-main.<anything> is consistent-by-construction even if a token looked bad.
  const hooksDirectory = dirname(fileURLToPath(import.meta.url));
  assert.equal(assessFilename(join(hooksDirectory, 'no-write-to-main.test.mjs')).ok, true);
});

test('ALLOWS standard English plurals of known words ("checks" false-fire, 2026-07-12)', () => {
  // 'skip-phone-width-checks.md' was blocked: "checks" flagged as a misspelling of "check".
  // A standard plural (word+s / word+es) of a known word is itself a known word — never a typo.
  for (const good of [
    'skip-phone-width-checks.md',   // the motivating false-fire
    'checks.md', 'guards.md', 'trains.py',          // word+s of known singulars
    'watches.mjs', 'batches.json', 'fixes.md',      // word+es (and fixes: plain plausible word)
    'results.md', 'notes.md',                       // already-listed plurals stay allowed
  ]) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good} (got: ${JSON.stringify(assessFilename(good))})`);
  }
  // No exemption for a trailing-s token whose SINGULAR is not a known word: real typos still block.
  assert.equal(assessFilename('findigns.md').ok, false, 'findigns must still BLOCK');
  assert.equal(assessFilename('resutls.md').ok, false, 'resutls (transposed typo of "results", itself s-final) must still BLOCK');
});

test('ALLOWS "audit" (real word wrongly flagged as a typo of "audio", 2026-07-03 false-fire)', () => {
  // "audit" is one OSA edit from "audio" — it was false-blocked as a likely misspelling even
  // though it's a common, correctly-spelled word in its own right.
  for (const good of ['delete-audit-guard.mjs', 'audit.mjs', 'auditor-report.md', 'auditing-rules.mjs']) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good} (got: ${JSON.stringify(assessFilename(good))})`);
  }
});

test('ALLOWS "cause"/"root-cause" (real word wrongly flagged as a typo of "clause", 2026-07-13 false-fire)', () => {
  // "cause" is one OSA edit (single insertion of "l") from "clause" — it was false-blocked as a
  // likely misspelling. This is the exact stem the ROOT-CAUSE-FIRST hook requires agents to
  // create ("root-cause-analysis.md") before editing code on fix/debug branches, so the false
  // positive actively blocked normal workflow.
  for (const good of ['root-cause-analysis.md', 'root-cause.md', 'cause.md', 'causal-chain.md', 'because-of-cause.md']) {
    assert.equal(assessFilename(good).ok, true, `expected ALLOW for ${good} (got: ${JSON.stringify(assessFilename(good))})`);
  }
  // The real-typo and lazy-name detectors must still fire — this fix must not weaken them.
  for (const bad of ['findigns.md', 'tmp.md']) {
    assert.equal(assessFilename(bad).ok, false, `expected BLOCK for ${bad} (regression: fix must not weaken real detection)`);
  }
});
