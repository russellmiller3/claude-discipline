#!/usr/bin/env node
/**
 * powershell-edit-guard — gate hook that DENIES editing/writing a file via PowerShell
 * (the PowerShell tool, or `pwsh`/`powershell` invoked from Bash). Use the Edit/Write tools.
 *
 * Why this rule exists (2026-06-29, Russell: "powershell has been a persistent problem ...
 * make a hook to ensure you dont use powershell to edit a file again"):
 * I edited a README via `Set-Content -Encoding utf8` and corrupted every em-dash — Windows
 * PowerShell 5.1 reads a UTF-8-no-BOM file as ANSI and re-encodes, double-mangling (`â€"`/`â†'`).
 * Editing file CONTENT belongs to the Edit/Write tools (encoding-safe); PowerShell is the wrong
 * tool for writing source, full stop.
 *
 * Teeth: permissionDecision:'deny'. Detects content-writing cmdlets/methods:
 *   Set-Content · Out-File · Add-Content · Export-Csv · Export-Clixml ·
 *   [System.IO.File]::WriteAllText/WriteAllLines/AppendAllText/WriteAllBytes
 * Fires when the PowerShell TOOL runs one, or a Bash command invokes pwsh/powershell with one.
 * Plain output redirects (`>`/`>>`) and reads (Get-Content) are NOT blocked.
 *
 * Override: PS_FILE_WRITE_OK in the command (a genuine binary/data export that truly needs
 * PowerShell, not a source edit). Use sparingly.
 *
 * Fail-open on any unexpected error.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRITE_CMDLET =
  /\b(?:Set-Content|Out-File|Add-Content|Export-Csv|Export-Clixml)\b|\[(?:System\.)?IO\.File\]::\s*(?:Write|Append)\w*/i;
const INVOKES_POWERSHELL = /\b(?:pwsh|powershell)(?:\.exe)?\b/i;

/**
 * Decide on one PreToolUse event. Returns a deny-decision object, or null to allow. Pure.
 */
export function decidePowershellEditGate(event) {
  const eventName = event.hook_event_name || event.hookEventName || '';
  if (eventName !== 'PreToolUse') return null;

  const toolName = event.tool_name || event.toolName || '';
  if (toolName !== 'PowerShell' && toolName !== 'Bash') return null;

  const command = String(event.tool_input?.command || event.toolInput?.command || '');
  if (!command) return null;

  if (/\bPS_FILE_WRITE_OK\b/.test(command)) return null;
  if (!WRITE_CMDLET.test(command)) return null;

  // From Bash, only block when it actually drives PowerShell (a `pwsh -c '... Set-Content ...'`);
  // a coincidental "Set-Content" elsewhere in a Bash command isn't a PowerShell write.
  if (toolName === 'Bash' && !INVOKES_POWERSHELL.test(command)) return null;

  const reason = `Blocked — don't edit/write files with PowerShell.

Russell's rule (2026-06-29): PowerShell file-writes (Set-Content / Out-File / [IO.File]::WriteAllText …) MANGLE UTF-8 — Windows PowerShell 5.1 re-encodes a UTF-8-no-BOM file and corrupts em-dashes/arrows into mojibake. Editing file CONTENT belongs to the Edit/Write tools, which are encoding-safe.

Fix: use the Write tool (new file) or the Edit tool (change an existing file). If a hook is FALSE-blocking the Edit, fix/override THAT hook — don't route the edit through PowerShell.
Override (rare — a genuine binary/data export, not a source edit): add PS_FILE_WRITE_OK to the command.`;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
    return;
  }
  const decision = decidePowershellEditGate(event);
  if (decision) process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

const invokedAsScript =
  process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1]);
if (invokedAsScript) main();
