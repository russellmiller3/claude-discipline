import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, isExperimentMonitor, emojiOffenders } from './no-emoji-landing.mjs';

// --- isExperimentMonitor: *-live.html + watch-template.html are exempt ---

test('a *-live.html file is an experiment monitor', () => {
  assert.equal(isExperimentMonitor('C:/x/docs/exp153-3seed-live.html'), true);
  assert.equal(isExperimentMonitor('docs/exp150-live.html'), true);
});

test('watch-template.html is an experiment monitor', () => {
  assert.equal(isExperimentMonitor('C:/Users/rmill/.claude/skills/live-watch/watch-template.html'), true);
});

test('a normal landing page is NOT an experiment monitor', () => {
  assert.equal(isExperimentMonitor('site/index.html'), false);
  assert.equal(isExperimentMonitor('landing.html'), false);
  assert.equal(isExperimentMonitor('docs/alive.html'), false); // "alive" != "-live"
});

// --- evaluate: block emoji on landing pages, allow on monitors ---

test('BLOCK: emoji in a landing-page HTML', () => {
  const verdict = evaluate({ path: 'site/index.html', htmlContent: '<h1>Welcome 🎉</h1>' });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /emoji are not permitted/);
});

test('ALLOW: emoji in an experiment-monitor page (*-live.html)', () => {
  const verdict = evaluate({ path: 'docs/exp153-3seed-live.html', htmlContent: 'method: "🧪 same 96 tasks"' });
  assert.equal(verdict.block, false);
});

test('ALLOW: emoji in watch-template.html', () => {
  const verdict = evaluate({ path: 'skills/live-watch/watch-template.html', htmlContent: '✅ PASSED ⚡' });
  assert.equal(verdict.block, false);
});

test('ALLOW: a landing page with NO emoji', () => {
  const verdict = evaluate({ path: 'site/index.html', htmlContent: '<h1>Welcome</h1>' });
  assert.equal(verdict.block, false);
});

test('ALLOW: non-HTML path is ignored', () => {
  const verdict = evaluate({ path: 'src/app.js', htmlContent: 'const x = "🎉";' });
  assert.equal(verdict.block, false);
});

test('escape: NO_EMOJI_LANDING_OK token in the text lets a landing page through', () => {
  const verdict = evaluate({ path: 'site/index.html', htmlContent: '<h1>🎉</h1><!-- NO_EMOJI_LANDING_OK -->' });
  assert.equal(verdict.block, false);
});

test('escape: envOk lets it through', () => {
  const verdict = evaluate({ path: 'site/index.html', htmlContent: '🎉', envOk: true });
  assert.equal(verdict.block, false);
});

test('fails open on empty/malformed input', () => {
  assert.equal(evaluate({}).block, false);
  assert.equal(evaluate({ path: 'index.html', htmlContent: '' }).block, false);
});

// --- emojiOffenders: dedup, order-preserving ---

test('emojiOffenders lists unique glyphs in order', () => {
  assert.deepEqual(emojiOffenders('a🎉b🧪c🎉d'), ['🎉', '🧪']);
  assert.deepEqual(emojiOffenders('no emoji here'), []);
});
