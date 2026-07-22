import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const commandNeedle = 'handoff-freshness-guard.mjs';

test('the live Claude settings register handoff freshness on Stop', () => {
  const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
  const stopCommands = (settings?.hooks?.Stop || [])
    .flatMap((group) => group.hooks || [])
    .map((hook) => hook.command || '');
  assert.equal(stopCommands.filter((command) => command.includes(commandNeedle)).length, 1);
});

test('the install fragment ships handoff freshness as a Stop hook', () => {
  const fragment = JSON.parse(readFileSync(new URL('../settings.fragment.json', import.meta.url), 'utf8'));
  assert.deepEqual(fragment.tier2_memory?.['handoff-freshness-guard'], [{ event: 'Stop', timeout: 10 }]);
});
