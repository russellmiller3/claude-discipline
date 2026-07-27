import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'no-backcompat.mjs');

function isDenied({ filePath = 'notes.md', newString }) {
  const hookRun = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: filePath, new_string: newString },
    }),
    encoding: 'utf8',
  });
  return /"permissionDecision"\s*:\s*"deny"/.test(hookRun.stdout || '');
}

// --- ALLOW (the 2026-07-01 false-fire): documenting the guard BY NAME is not a violation ---
test('allows a doc row that names the no-backcompat hook', () => {
  assert.equal(isDenied({ newString: '| `no-backcompat` | PreToolUse | Blocks direct commits to main; branch first |' }), false);
});

test('allows prose that references the BACKCOMPAT_OVERRIDE token', () => {
  assert.equal(isDenied({ newString: 'Escape hatch: set BACKCOMPAT_OVERRIDE=1 only when Russell says so.' }), false);
});

// --- ALLOW: editing the guard's OWN source/test must never self-block ---
test('allows an edit to the guard\'s own source file', () => {
  assert.equal(isDenied({ filePath: 'C:/x/hooks/no-backcompat.mjs', newString: 'const PATTERN = /deprecation warning/;' }), false);
});

// --- BLOCK: a real Claude-introduced backcompat path still fires ---
test('blocks language keeping an old form for backwards compatibility', () => {
  assert.equal(isDenied({ filePath: 'parser.js', newString: '// keep the old syntax for backwards compatibility\nif (legacy) parseOld();' }), true);
});

test('blocks adding a deprecation warning', () => {
  assert.equal(isDenied({ filePath: 'api.js', newString: 'console.warn("deprecated: use newForm instead");' }), true);
});

// --- ALLOW (2026-07-02 false positive): plain prose about a non-code decision doesn't fire ---
test('allows a HANDOFF note about an old UI color palette (not a code backcompat shim)', () => {
  assert.equal(isDenied({
    filePath: 'HANDOFF.md',
    newString: 'only the widget regressed back to the old rejected palette (the deprecated indigo-on-ivory look) — the two sibling products already ship Cloud correctly.',
  }), false);
});

test('allows a design doc describing a deprecated feature by name, still no code nearby', () => {
  assert.equal(isDenied({
    filePath: 'plans/design-notes.md',
    newString: 'The old warm "machined parchment" identity was deprecated in favor of the cool Cloud palette.',
  }), false);
});

test('still blocks a real backcompat shim written in markdown-adjacent prose (code vocabulary present)', () => {
  assert.equal(isDenied({
    filePath: 'notes.md',
    newString: 'Plan: keep the old API version working for backwards compatibility so existing callers do not break.',
  }), true);
});

test('still blocks a fenced code block in markdown that adds a deprecation warning', () => {
  assert.equal(isDenied({
    filePath: 'docs/CHANGELOG.md',
    newString: '```js\nconsole.warn("deprecated: use newForm instead");\n```',
  }), true);
});

// --- ALLOW (2026-07-13 false positive): quoting a vendor's own API error text in a HANDOFF
// note is not a backcompat code decision, even when generic engineering prose ("function-level
// test", "the reasoning flag") happens to sit nearby.
test('allows a HANDOFF note quoting a third-party API deprecation error message', () => {
  assert.equal(isDenied({
    filePath: 'HANDOFF.md',
    newString: '- Confirmed live (caught by an isolated function-level smoke test, not\n' +
      '  the full harness): temperature is flatly DEPRECATED on this whole model\n' +
      '  family, not just incompatible with thinking - a bare temperature:0.0\n' +
      '  with no thinking field still 400s ("temperature is deprecated for this\n' +
      '  model"). Omitted for these models regardless of the reasoning flag.',
  }), false);
});

test('allows a HANDOFF note describing that a vendor API rejects a parameter outright', () => {
  assert.equal(isDenied({
    filePath: 'HANDOFF.md',
    newString: "Anthropic's own API rejects `temperature` outright on the whole " +
      'Opus 4.8/Sonnet 5/Fable 5 family — confirmed live via an isolated ' +
      'function-level test (their error text calls it out explicitly, not ' +
      'something guessable from the docs alone) — omitted now regardless of ' +
      'the reasoning flag.',
  }), false);
});

// --- BLOCK: a genuine Clear-project backcompat violation, written the way Claude actually
// writes them (a code comment describing a fallback/soft-migration path), must still fire —
// scope tightening must not create a false negative for the real thing the guard exists for.
test('still blocks a genuine backcompat shim in Clear compiler code', () => {
  assert.equal(isDenied({
    filePath: 'C:/Users/rmill/Desktop/programming/clear/compiler/parser.js',
    newString:
      '// Keep the old syntax working for compatibility so existing callers do not break\n' +
      'function parseExpression(tokens) {\n' +
      '  if (isLegacyForm(tokens)) return parseOldForm(tokens);\n' +
      '  return parseNewForm(tokens);\n' +
      '}\n',
  }), true);
});

// --- ALLOW (the 2026-07-27 false-fire): documenting a MIGRATION OFF a third-party's deprecated
// endpoint is COMPLIANCE with the rule ("rip out the old API"), not a violation of it. Blocking
// this made it impossible to write a CHANGELOG entry about obeying the rule.
test('allows a CHANGELOG entry about migrating off a vendor-deprecated endpoint', () => {
  assert.equal(isDenied({
    filePath: 'CHANGELOG.md',
    newString:
      'Retell removes the deprecated GET /list-agents endpoint on 2026-07-31. Both remaining ' +
      'callers now issue one POST /v2/list-agents with the documented filter_criteria selector ' +
      'and read the v2 items array.',
  }), false);
});

test('allows a code comment explaining why a call was migrated off a deprecated API', () => {
  assert.equal(isDenied({
    filePath: 'src/retell-client.ts',
    newString:
      '// The deprecated GET shape is removed upstream on 2026-07-31; this endpoint no longer\n' +
      '// accepts it, so the caller was switched to the POST /v2 form.\n' +
      'const page = await fetch(listAgentsUrl, { method: "POST" });\n',
  }), false);
});

// --- BLOCK: "migrated off, BUT the old form still works" is still a violation. Preservation
// language must always beat the removal exemption, or the exemption becomes a loophole.
test('still blocks a migration that ALSO keeps the old path alive', () => {
  assert.equal(isDenied({
    filePath: 'src/retell-client.ts',
    newString:
      '// Migrated off the deprecated GET endpoint, but the old form still works for callers\n' +
      '// that have not moved yet.\n' +
      'if (useLegacy) return getLegacy(); // legacy path\n',
  }), true);
});
