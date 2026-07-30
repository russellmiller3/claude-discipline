#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  groundTruthViolation,
  isExternalIntegrationTurn,
} from './ground-truth-before-action.mjs';

const user = (text) => ({ message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (...blocks) => ({ message: { role: 'assistant', content: blocks } });
const tool = (name, input = {}, id = `${name}-${Math.random()}`) => ({ type: 'tool_use', id, name, input });
const result = (toolUseId, isError = false) => ({
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: isError ? 'blocked' : 'ok' }] },
});

test('identifies external integration work without a provider allowlist', () => {
  assert.equal(isExternalIntegrationTurn('Port the voice webhook to AcmeTel RTC.', 'src/acmetel-webhook.ts'), true);
  assert.equal(isExternalIntegrationTurn('Fix the payment SDK callback.', 'src/billing.ts'), true);
  assert.equal(isExternalIntegrationTurn('Rename the local date formatter.', 'src/date-format.ts'), false);
});

test('blocks the exact failure: implementation first, documentation research afterward', () => {
  const entries = [
    user('Fix the Telnyx voice integration so calls are no longer silent.'),
    assistant(tool('Read', { file_path: 'src/telnyx-runtime.ts' }, 'read-1')),
    result('read-1'),
    assistant(tool('apply_patch', { patch: '*** Update File: src/telnyx-runtime.ts' }, 'edit-1')),
    result('edit-1'),
    assistant(tool('web__run', { search_query: [{ q: 'Telnyx media streaming docs' }] }, 'search-1')),
    result('search-1'),
    assistant(tool('web__run', { open: [{ ref_id: 'https://developers.telnyx.com/docs/voice' }] }, 'open-1')),
    result('open-1'),
  ];
  assert.match(groundTruthViolation(entries)?.reason ?? '', /action came before external ground truth/i);
});

test('blocks an equivalent provider edit after search snippets but before opening a source', () => {
  const entries = [
    user('Implement the carrier webhook against a new vendor API.'),
    assistant(tool('WebSearch', { query: 'carrier webhook API' }, 'search-1')),
    result('search-1'),
    assistant(tool('Edit', { file_path: 'src/carrier-webhook.ts', new_string: 'handle(event);' }, 'edit-1')),
    result('edit-1'),
  ];
  assert.match(groundTruthViolation(entries)?.reason ?? '', /open.*authoritative/i);
});

test('allows external integration work when search and source-open both precede action', () => {
  const entries = [
    user('Implement the carrier webhook against a new vendor API.'),
    assistant(tool('web__run', { search_query: [{ q: 'vendor webhook official docs' }] }, 'search-1')),
    result('search-1'),
    assistant(tool('web__run', { open: [{ ref_id: 'turn1search0' }] }, 'open-1')),
    result('open-1'),
    assistant(tool('apply_patch', { patch: '*** Update File: src/carrier-webhook.ts' }, 'edit-1')),
    result('edit-1'),
  ];
  assert.equal(groundTruthViolation(entries), null);
});

test('clears a late-research violation only after a post-evidence correction and verification', () => {
  const entries = [
    user('Fix the Telnyx voice integration.'),
    assistant(tool('apply_patch', { patch: '*** Update File: src/telnyx.ts' }, 'early-edit')),
    result('early-edit'),
    assistant(tool('web__run', { search_query: [{ q: 'Telnyx official media docs' }] }, 'search-1')),
    result('search-1'),
    assistant(tool('web__run', { open: [{ ref_id: 'turn1search0' }] }, 'open-1')),
    result('open-1'),
    assistant(tool('apply_patch', { patch: '*** Update File: src/telnyx.ts' }, 'corrective-edit')),
    result('corrective-edit'),
    assistant(tool('shell_command', { command: 'node --test src/telnyx.test.mjs' }, 'verify-1')),
    result('verify-1'),
  ];
  assert.equal(groundTruthViolation(entries), null);
});

test('blocks a deploy before external ground truth even when no source edit occurs', () => {
  const entries = [
    user('Deploy the new payment-provider integration.'),
    assistant(tool('shell_command', { command: 'wrangler deploy --config worker.jsonc' }, 'deploy-1')),
    result('deploy-1'),
  ];
  assert.match(groundTruthViolation(entries)?.reason ?? '', /action came before external ground truth/i);
});

test('detects Codex wrapper calls instead of assuming Claude tool names', () => {
  const entries = [
    user('Fix the Telnyx media integration.'),
    assistant(tool('functions.exec', { code: "await tools.shell_command({command:'Get-Content src/telnyx.ts'})" }, 'read-1')),
    result('read-1'),
    assistant(tool('functions.exec', { code: "await tools.apply_patch('*** Update File: src/telnyx.ts')" }, 'edit-1')),
    result('edit-1'),
  ];
  assert.match(groundTruthViolation(entries)?.reason ?? '', /action came before external ground truth/i);
});

test('allows internal work after local inspection and does not demand web research', () => {
  const entries = [
    user('Fix the local date formatter.'),
    assistant(tool('Read', { file_path: 'src/date-format.ts' }, 'read-1')),
    result('read-1'),
    assistant(tool('Edit', { file_path: 'src/date-format.ts', new_string: 'return isoDate;' }, 'edit-1')),
    result('edit-1'),
  ];
  assert.equal(groundTruthViolation(entries), null);
});

test('blocks internal action without any prior inspection', () => {
  const entries = [
    user('Fix the local date formatter.'),
    assistant(tool('Edit', { file_path: 'src/date-format.ts', new_string: 'return isoDate;' }, 'edit-1')),
    result('edit-1'),
  ];
  assert.match(groundTruthViolation(entries)?.reason ?? '', /local ground truth/i);
});

test('ignores a denied action and permits a user-granted emergency override', () => {
  const denied = [
    user('Fix the provider SDK.'),
    assistant(tool('Edit', { file_path: 'src/provider.ts', new_string: 'fix();' }, 'edit-1')),
    result('edit-1', true),
  ];
  assert.equal(groundTruthViolation(denied), null);

  const overridden = [
    user('ground-truth-override: vendor docs are offline; apply the reversible local rollback only.'),
    assistant(tool('Edit', { file_path: 'src/provider.ts', new_string: 'rollback();' }, 'edit-2')),
    result('edit-2'),
  ];
  assert.equal(groundTruthViolation(overridden), null);
});

test('allows read-only answers and malformed or wrong-event hook input', () => {
  assert.equal(groundTruthViolation([user('Explain this code.'), assistant(tool('Read', { file_path: 'src/x.ts' }, 'read-1'))]), null);

  const directory = mkdtempSync(join(tmpdir(), 'ground-truth-hook-'));
  try {
    const transcriptPath = join(directory, 'transcript.jsonl');
    writeFileSync(transcriptPath, [
      user('Fix the local formatter.'),
      assistant(tool('Edit', { file_path: 'src/x.ts', new_string: 'fix();' }, 'edit-1')),
      result('edit-1'),
    ].map(JSON.stringify).join('\n'));
    const hookPath = join(import.meta.dirname, 'ground-truth-before-action.mjs');
    const blocked = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath }), encoding: 'utf8',
    });
    assert.equal(blocked.status, 0);
    assert.equal(JSON.parse(blocked.stdout).decision, 'block');

    const malformed = spawnSync(process.execPath, [hookPath], { input: '{bad', encoding: 'utf8' });
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('canonical installer registers the guard as a Stop hook', () => {
  const fragment = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'settings.fragment.json'), 'utf8'));
  assert.deepEqual(fragment.tier1_standalone['ground-truth-before-action'], [{ event: 'Stop', timeout: 5 }]);
});
