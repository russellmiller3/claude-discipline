// no-premature-defer.test.mjs — run: node --test ~/.claude/hooks/no-premature-defer.test.mjs
//
// Pins the 2026-06-25 repeat mistake: ending a turn by handing Russell a CHEAP RUN ("that one's yours
// to run", "owes a paid live run", "the hook blocks me from launching") instead of just running it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defersCheapRunToRussell } from './no-premature-defer.mjs';

// ── these DEFER a runnable job back to Russell — must BLOCK ──
const SHOULD_BLOCK = [
  "C is the only open thread, and that one's yours to run.",
  "Item C prompt fix made, but it owes one paid live run — Russell runs it.",
  "the bench-guard hook blocks me from launching any bench command, so you run it",
  "I can't launch the bench, so you'll need to run the harness yourself.",
  "research-scrape-live owes a run; run the bench command above to verify.",
  "Verified D; C is deferred to Russell to run.",
  "leaving the run to you — kick it off with the command above.",
  // POISONING BUG (2026-07-16): citing the cost RULE/threshold must NOT exempt a cheap defer.
  "Under the <$5 rule I could run the ~$2 retrain, but I defer it to you — run the command above.",
  "The ~$2 job is yours to run; also I check in at ~$20 cumulative per the cost rule.",
  "This is well under the $5 auto-run threshold, but that one's yours to run.",
  // 2026-07-16 gap: gating a CHEAP run behind Russell's "go" — the exact phrasing that let a $0.75
  // GPU launch get deferred (this hook did NOT fire on any of these).
  "I stop at green and hand you the ~$0.75 estimate — then it's your one-word go for the paid run.",
  "The wiring's done and it's gated on your go. Command: py -3 run_exp150_training.py --regen-dir runs.",
  "I recommend we gate the launch — build now, then you approve the ~$1 run above.",
  "Everything's staged; awaiting your sign-off to launch the retrain with the command above.",
];

for (const assistantText of SHOULD_BLOCK) {
  test(`BLOCKS deferring a cheap run: "${assistantText.slice(0, 50)}"`, () => {
    assert.ok(defersCheapRunToRussell(assistantText).length > 0);
  });
}

// ── these are legit — must NOT block ──
const SHOULD_PASS = [
  "I ran the full e2e gate myself: 18/18 PASS, $0.87. Everything's green.",
  "Done — committed and merged to main, nothing left to run.",
  // genuine blocker: a live browser Russell must watch
  "This one's yours to run — it needs a live Chrome session you have to watch reload.",
  // genuine blocker: hardware
  "You'll need to run the mic test — it needs real hardware I can't drive headless.",
  // real-money gate: cost >= $5
  "This sweep costs about $40 to run, so that one's yours to run after you approve the spend.",
  // real-money gate stated as an hourly estimate — must still exempt
  "The pod runs ~$8/hr for about 6 hours, so that one's yours to run after you approve the spend.",
  // explicit override
  "Russell runs it. defer-run-override: the OAuth flow needs your interactive Google sign-in.",
  // missing credential
  "I can't launch it — there's no API key configured, so you run it once the key is set.",
];

for (const assistantText of SHOULD_PASS) {
  test(`PASSES (legit / not a cheap defer): "${assistantText.slice(0, 50)}"`, () => {
    assert.equal(defersCheapRunToRussell(assistantText).length, 0);
  });
}

// quoting the trigger in code/backticks shouldn't false-fire
test('code-span quoting of a trigger phrase does not fire', () => {
  assert.equal(defersCheapRunToRussell('The hook matches `yours to run` and `owes a run` phrases.').length, 0);
});

// ── 2026-07-13 regression: "you run" in ordinary explanatory PROSE, with nothing runnable
// handed over, is not a defer. The old pattern-1 blocked all of these. Must NOT block. ──
const PROSE_NO_ARTIFACT_SHOULD_PASS = [
  'verification becomes ~free, so you run it everywhere', // the exact false positive
  'Once the suite is fast, you run tests on every save without thinking about it.',
  'In that world Russell runs whatever experiments he likes because the cost rounds to zero.',
  'The point of cheap evals is that you could run this kind of check continuously.',
  'When checks are that cheap you just run everything twice and diff the outputs.',
];

for (const assistantText of PROSE_NO_ARTIFACT_SHOULD_PASS) {
  test(`PASSES (prose, no runnable artifact): "${assistantText.slice(0, 50)}"`, () => {
    assert.deepEqual(defersCheapRunToRussell(assistantText), []);
  });
}

// ── but "you run" WITH a concrete runnable artifact nearby (backticked command, script/CLI
// name, '$'-prompt, "the command"/"this script") is still a real defer. Must BLOCK. ──
const PROSE_WITH_ARTIFACT_SHOULD_BLOCK = [
  'you can run the e2e gate with `npm run e2e`',
  'You run bench/realworld/run.mjs with --resume to finish the sweep.',
  'You should run the command above; it finishes in about a minute.',
  'Everything is staged — Russell runs:\n$ pytest tests/ -x',
  'You should run this script tonight; it only takes a minute.',
];

for (const assistantText of PROSE_WITH_ARTIFACT_SHOULD_BLOCK) {
  test(`BLOCKS prose defer with runnable artifact: "${assistantText.slice(0, 50)}"`, () => {
    assert.ok(defersCheapRunToRussell(assistantText).length > 0);
  });
}
