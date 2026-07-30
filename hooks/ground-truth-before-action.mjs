#!/usr/bin/env node
/**
 * GROUND-TRUTH-BEFORE-ACTION — Stop gate.
 *
 * An agent may not finish a turn after editing, deploying, or mutating a live
 * system unless the evidence needed to understand that system came first.
 * External integrations require both a web search and an opened source before
 * the first action. Internal work requires local inspection before action.
 * Evidence gathered after implementation does not retroactively satisfy the gate.
 */

import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  contentBlocks,
  currentTurnEntries,
  readTranscript,
  roleOf,
  textOf,
  toolUsesOf,
} from './lib/transcript.mjs';

const DIRECT_MUTATIONS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const LOCAL_INSPECTIONS = new Set(['Read', 'Grep', 'Glob', 'LS', 'view_file', 'view_image']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell_command']);
const EXTERNAL_INTEGRATION = /\b(?:external|third[- ]party|vendor|provider|integration|api|sdk|webhook|oauth|carrier|telephony|rtc|webrtc|sip|payment|billing|voice|media stream|speech|tts|stt|transcri(?:be|ption)|stripe|telnyx|twilio|deepgram|retell|openai|anthropic|supabase|cloudflare|plaid|cartesia|livekit)\b/i;
const SHELL_MUTATION = /\b(?:wrangler\s+deploy|supabase\s+(?:db\s+push|migration\s+up)|terraform\s+apply|kubectl\s+apply|npm\s+publish|git\s+(?:commit|push)|secret\s+put|deploy|migrate)\b|\b(?:curl|invoke-restmethod)\b[^\n]*(?:-x\s*(?:post|put|patch|delete)|-method\s+(?:post|put|patch|delete))/i;
const SHELL_INSPECTION = /(?:^|[;&|]\s*)(?:rg\b|grep\b|git\s+(?:status|diff|log|show)\b|get-content\b|select-string\b|ls\b|get-childitem\b|find\b)/i;
const VERIFICATION_COMMAND = /\b(?:node\s+--(?:test|check)|vitest|pytest|npm\s+(?:run\s+)?(?:test|check|build)|pnpm\s+(?:test|check)|svelte-check|tsc\b|verify(?::|\s)|wrangler\s+tail|git\s+diff\s+--check)\b/i;
const USER_OVERRIDE = /\bground-truth-override:\s*\S/i;

function inputText(toolUse) {
  try { return JSON.stringify(toolUse?.input ?? toolUse?.tool_input ?? {}); }
  catch { return ''; }
}

function resultErrors(entries) {
  const errors = new Set();
  for (const entry of entries) {
    for (const block of contentBlocks(entry)) {
      if (block?.type === 'tool_result' && block.tool_use_id && block.is_error === true) errors.add(block.tool_use_id);
    }
  }
  return errors;
}

function successfulToolUses(entries) {
  const errors = resultErrors(entries);
  const uses = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    for (const toolUse of toolUsesOf(entries[entryIndex])) {
      if (toolUse.id && errors.has(toolUse.id)) continue;
      uses.push({ ...toolUse, entryIndex });
    }
  }
  return uses;
}

function codexSource(toolUse) {
  if (toolUse?.name !== 'functions.exec') return '';
  return String(toolUse?.input?.code ?? toolUse?.input?.source ?? inputText(toolUse));
}

function isMutation(toolUse) {
  if (DIRECT_MUTATIONS.has(toolUse?.name)) return true;
  const source = codexSource(toolUse);
  if (/tools\.apply_patch\s*\(/.test(source)) return true;
  if (SHELL_MUTATION.test(source)) return true;
  if (!SHELL_TOOLS.has(toolUse?.name)) return false;
  return SHELL_MUTATION.test(String(toolUse?.input?.command ?? inputText(toolUse)));
}

function isLocalInspection(toolUse) {
  if (LOCAL_INSPECTIONS.has(toolUse?.name)) return true;
  const source = codexSource(toolUse);
  if (source && SHELL_INSPECTION.test(source)) return true;
  if (!SHELL_TOOLS.has(toolUse?.name)) return false;
  return SHELL_INSPECTION.test(String(toolUse?.input?.command ?? inputText(toolUse)));
}

function isWebSearch(toolUse) {
  const name = String(toolUse?.name || '');
  const input = toolUse?.input ?? {};
  if (/WebSearch|search_query/i.test(name)) return true;
  if (/web(?:__|\.)run/i.test(name) && (Array.isArray(input.search_query) || /search_query/.test(inputText(toolUse)))) return true;
  const source = codexSource(toolUse);
  return /web__run\s*\([^)]*search_query/s.test(source);
}

function isOpenedWebSource(toolUse) {
  const name = String(toolUse?.name || '');
  const input = toolUse?.input ?? {};
  if (/WebFetch|open_url/i.test(name)) return true;
  if (/web(?:__|\.)run/i.test(name) && (Array.isArray(input.open) || /"?open"?\s*:/.test(inputText(toolUse)))) return true;
  const source = codexSource(toolUse);
  return /web__run\s*\([^)]*\bopen\s*:/s.test(source);
}

function isVerification(toolUse) {
  const source = codexSource(toolUse);
  if (source && VERIFICATION_COMMAND.test(source)) return true;
  if (!SHELL_TOOLS.has(toolUse?.name)) return false;
  return VERIFICATION_COMMAND.test(String(toolUse?.input?.command ?? inputText(toolUse)));
}

function repairedAfterEvidence(uses, evidenceIndex) {
  const afterEvidence = uses.slice(evidenceIndex + 1);
  const correctionIndex = afterEvidence.findIndex(isMutation);
  return correctionIndex >= 0 && afterEvidence.slice(correctionIndex + 1).some(isVerification);
}

export function isExternalIntegrationTurn(userText, actionText = '') {
  return EXTERNAL_INTEGRATION.test(`${userText}\n${actionText}`);
}

export function groundTruthViolation(entries) {
  const turnEntries = currentTurnEntries(entries);
  if (!turnEntries.length) return null;
  const userText = turnEntries.filter((entry) => roleOf(entry) === 'user').map(textOf).join('\n');
  if (USER_OVERRIDE.test(userText)) return null;

  const uses = successfulToolUses(turnEntries);
  const firstActionIndex = uses.findIndex(({ name, input, ...toolUse }) => isMutation({ name, input, ...toolUse }));
  if (firstActionIndex < 0) return null;
  const firstAction = uses[firstActionIndex];
  const actionText = inputText(firstAction);
  const evidenceBefore = uses.slice(0, firstActionIndex);

  if (isExternalIntegrationTurn(userText, actionText)) {
    const searchIndex = uses.findIndex(isWebSearch);
    const openIndex = uses.findIndex(isOpenedWebSource);
    const searched = searchIndex >= 0 && searchIndex < firstActionIndex;
    const opened = openIndex >= 0 && openIndex < firstActionIndex;
    if (!searched || !opened) {
      const completeEvidenceIndex = searchIndex >= 0 && openIndex >= 0 ? Math.max(searchIndex, openIndex) : -1;
      if (completeEvidenceIndex >= 0 && repairedAfterEvidence(uses, completeEvidenceIndex)) return null;
      const missing = [!searched ? 'search the web' : '', !opened ? 'open an authoritative source' : ''].filter(Boolean).join(' and ');
      return {
        kind: 'external',
        reason: `Action came before external ground truth: ${missing} before the first edit, deploy, or live mutation. Research performed afterward does not count.`,
      };
    }
    return null;
  }

  if (!evidenceBefore.some(isLocalInspection)) {
    const inspectionIndex = uses.findIndex(isLocalInspection);
    if (inspectionIndex >= 0 && repairedAfterEvidence(uses, inspectionIndex)) return null;
    return {
      kind: 'local',
      reason: 'Action came before local ground truth: inspect the owning source, tests, or current state before the first edit or mutation.',
    };
  }
  return null;
}

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); return; }
  if ((event.hook_event_name || event.hookEventName) !== 'Stop') process.exit(0);
  const violation = groundTruthViolation(readTranscript(event.transcript_path));
  if (!violation) process.exit(0);
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `GROUND TRUTH BEFORE ACTION — BLOCKED\n\n${violation.reason}\n\nDo not merely read now and defend the existing work. Establish the missing evidence, re-audit every assumption and changed artifact against it, correct or revert what the evidence does not support, rerun focused proof, then stop again. Only Russell may grant an emergency exception by writing ground-truth-override: <reason>.`,
  }));
}

if (process.argv[1] && basename(fileURLToPath(import.meta.url)) === basename(process.argv[1])) {
  main();
}
