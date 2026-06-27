import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnderHomeClaude, verdictForWrite } from './global-hooks-only.mjs';

const HOME = 'C:/Users/rmill';

test('isUnderHomeClaude distinguishes global vs project .claude', () => {
  assert.ok(isUnderHomeClaude('C:/Users/rmill/.claude/hooks/x.mjs', HOME));
  assert.ok(isUnderHomeClaude('C:\\Users\\rmill\\.claude\\hooks\\x.mjs', HOME)); // backslashes
  assert.equal(isUnderHomeClaude('C:/Users/rmill/Desktop/programming/jarvis/.claude/hooks/x.mjs', HOME), false);
});

test('BLOCKS a hook implementation written to a project-local .claude/hooks/', () => {
  const verdict = verdictForWrite({
    filePath: 'C:/Users/rmill/Desktop/programming/jarvis/.claude/hooks/my-guard.mjs',
    editText: 'export function main(){}',
    homeDir: HOME,
  });
  assert.equal(verdict.block, true);
});

test('ALLOWS a hook written to the global ~/.claude/hooks/', () => {
  const verdict = verdictForWrite({
    filePath: 'C:/Users/rmill/.claude/hooks/my-guard.mjs',
    editText: 'export function main(){}',
    homeDir: HOME,
  });
  assert.equal(verdict.block, false);
});

test('BLOCKS registering a hook in a project-local .claude/settings.json', () => {
  const verdict = verdictForWrite({
    filePath: 'C:/Users/rmill/Desktop/programming/jarvis/.claude/settings.json',
    editText: '{ "hooks": { "PreToolUse": [ { "command": "node ./my-guard.mjs" } ] } }',
    homeDir: HOME,
  });
  assert.equal(verdict.block, true);
});

test('the override lets an intentionally-local hook through', () => {
  const verdict = verdictForWrite({
    filePath: 'C:/Users/rmill/Desktop/programming/jarvis/.claude/hooks/my-guard.mjs',
    editText: '// local-hook-ok: this guard is specific to the jarvis repo layout\nexport function main(){}',
    homeDir: HOME,
  });
  assert.equal(verdict.block, false);
});

test('ALLOWS ordinary source files and the global settings.json', () => {
  assert.equal(verdictForWrite({ filePath: 'extension/lib/chatRouter.js', editText: 'fix();', homeDir: HOME }).block, false);
  assert.equal(verdictForWrite({ filePath: 'C:/Users/rmill/.claude/settings.json', editText: '{ "hooks": { "command": "node x" } }', homeDir: HOME }).block, false);
});
