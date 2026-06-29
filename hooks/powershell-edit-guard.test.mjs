#!/usr/bin/env node
/**
 * Tests for powershell-edit-guard — blocks editing/writing files via PowerShell.
 */

import assert from 'node:assert/strict';
import { decidePowershellEditGate } from './powershell-edit-guard.mjs';

let passedCount = 0;
function test(name, testBody) {
  try {
    testBody();
    passedCount += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

const psEvent = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command } });
const bashEvent = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

// 1. PowerShell Set-Content → DENIED.
test('denies Set-Content from the PowerShell tool', () => {
  const decision = decidePowershellEditGate(psEvent('Set-Content -Path README.md -Value $t -Encoding utf8'));
  assert.ok(decision, 'expected deny');
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /Edit\/Write/);
});

// 2. Out-File and [IO.File]::WriteAllText → DENIED.
test('denies Out-File', () => assert.ok(decidePowershellEditGate(psEvent('$x | Out-File foo.txt'))));
test('denies [System.IO.File]::WriteAllText', () =>
  assert.ok(decidePowershellEditGate(psEvent('[System.IO.File]::WriteAllText($p, $t, $enc)'))));
test('denies Add-Content', () => assert.ok(decidePowershellEditGate(psEvent('Add-Content log.txt "x"'))));

// 3. pwsh -c '... Set-Content ...' from Bash → DENIED.
test('denies a Bash pwsh -c that writes a file', () => {
  const decision = decidePowershellEditGate(bashEvent('pwsh -NoProfile -Command "Set-Content a.md $t"'));
  assert.ok(decision, 'expected deny');
});

// 4. PowerShell that only READS / runs is ALLOWED.
test('allows Get-Content (a read)', () => assert.equal(decidePowershellEditGate(psEvent('Get-Content README.md -Raw')), null));
test('allows running a program (no file write)', () =>
  assert.equal(decidePowershellEditGate(psEvent('& py -m py_compile widget.py')), null));
test('allows a plain output redirect (not a write cmdlet)', () =>
  assert.equal(decidePowershellEditGate(psEvent('Get-ChildItem > listing-on-screen')), null));

// 5. Bash with a coincidental "Set-Content" but NOT invoking PowerShell → ignored.
test('ignores a Bash command that does not invoke PowerShell', () =>
  assert.equal(decidePowershellEditGate(bashEvent('echo "see Set-Content docs" >> notes.md')), null));

// 6. The override bypasses.
test('PS_FILE_WRITE_OK bypasses', () =>
  assert.equal(decidePowershellEditGate(psEvent('Set-Content out.bin $bytes  # PS_FILE_WRITE_OK binary export')), null));

// 7. Non-PowerShell/Bash tool ignored.
test('ignores other tools', () =>
  assert.equal(decidePowershellEditGate({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} }), null));

console.log(`\n${passedCount} passed`);
