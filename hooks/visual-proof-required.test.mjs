import test from 'node:test';
import assert from 'node:assert/strict';
import { isUiFile, shouldBlock, realScreenshotThisTurn } from './visual-proof-required.mjs';

// ── isUiFile: the union pattern must cover .html (GAP 1) plus the old surfaces ──
test('isUiFile covers .html (the gap that missed widget.html)', () => {
  assert.equal(isUiFile('scripts/widget.html'), true);
  assert.equal(isUiFile('src/App.svelte'), true);
  assert.equal(isUiFile('styles/app.css'), true);
  assert.equal(isUiFile('a/b.scss'), true);
  assert.equal(isUiFile('ui/Button.tsx'), true);
  assert.equal(isUiFile('src/lib/components/Orb.js'), true);   // component path
  assert.equal(isUiFile('scripts/widget.py'), false);
  assert.equal(isUiFile('README.md'), false);
});

// ── shouldBlock verdict table ───────────────────────────────────────────────
test('UI edit with no real screenshot blocks', () => {
  assert.equal(shouldBlock({ editedUi: true, domAsProof: false, heresy: false, realScreenshot: false, overridden: false }), true);
});
test('UI edit WITH a real screenshot passes', () => {
  assert.equal(shouldBlock({ editedUi: true, domAsProof: false, heresy: false, realScreenshot: true, overridden: false }), false);
});
test('override passes even with a UI edit and no shot', () => {
  assert.equal(shouldBlock({ editedUi: true, domAsProof: false, heresy: false, realScreenshot: false, overridden: true }), false);
});
test('DOM-as-proof claim with no shot blocks', () => {
  assert.equal(shouldBlock({ editedUi: false, domAsProof: true, heresy: false, realScreenshot: false, overridden: false }), true);
});
test('heresy blocks even with a real screenshot', () => {
  assert.equal(shouldBlock({ editedUi: false, domAsProof: false, heresy: true, realScreenshot: true, overridden: false }), true);
});
test('a plain non-visual turn does not block', () => {
  assert.equal(shouldBlock({ editedUi: false, domAsProof: false, heresy: false, realScreenshot: false, overridden: false }), false);
});

// ── realScreenshotThisTurn: GAP 2 — tool fired vs image produced ─────────────
const assistantWith = (blocks) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const userWith = (blocks) => ({ type: 'user', message: { role: 'user', content: blocks } });

test('a tool_result carrying an image counts as a real screenshot', () => {
  const turn = [userWith([{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64' } }] }])];
  assert.equal(realScreenshotThisTurn(turn), true);
});
test('a preview_screenshot that FIRED but TIMED OUT (error text, no image) does NOT count', () => {
  const turn = [
    assistantWith([{ type: 'tool_use', name: 'mcp__Claude_Preview__preview_screenshot', input: {} }]),
    userWith([{ type: 'tool_result', content: 'preview_screenshot timed out after 30s.' }]),
  ];
  assert.equal(realScreenshotThisTurn(turn), false);   // THE GAP: tool fired, no image -> not proof
});
test('reading a .png counts', () => {
  const turn = [assistantWith([{ type: 'tool_use', name: 'Read', input: { file_path: 'out/shot.png' } }])];
  assert.equal(realScreenshotThisTurn(turn), true);
});
test('a harness result printing a screenshot .png path counts', () => {
  const turn = [userWith([{ type: 'tool_result', content: 'wrote screenshot -> runs/widgetShot.png' }])];
  assert.equal(realScreenshotThisTurn(turn), true);
});
test('an empty turn has no screenshot', () => {
  assert.equal(realScreenshotThisTurn([]), false);
});
