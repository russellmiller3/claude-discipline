/**
 * pretooluse-arbitration — the SHARED PreToolUse ARBITER.
 *
 * THE BUG THIS EXISTS TO KILL (Russell, 2026-08-15: "most of your guards just create more problems
 * for you. I don't know why you can't just behave the way I intend."). 75 hooks were registered
 * independently on PreToolUse, each holding an absolute veto over every tool call. N independent
 * vetoes make DEADLOCK inevitable as N grows: one guard demands an action, another forbids the only
 * way to take it, and the turn has no legal move left. In one session that shape appeared five
 * separate times — including a guard that refused a command BECAUSE the Edit tool was the right
 * utility, then refused the Edit tool.
 *
 * Individually every one of those guards is defensible. The system has no way to notice that two
 * demands are jointly unsatisfiable, because nothing sees more than one demand at a time.
 *
 * THE PRECEDENT: `lib/stop-arbitration.mjs` solved exactly this for the Stop event on 2026-08-08,
 * taking 54 registered entries to 1. Its own header states the principle — P(clean pass) =
 * (1 - p)^N, so shrinking p one regex at a time is a treadmill while shrinking N is a one-time
 * architectural change. Stop went to 2 registered entries; PreToolUse stayed at 75. This closes
 * that asymmetry, deliberately mirroring that file's structure rather than inventing a second one.
 *
 * WHAT IT ADDS THAT STOP DOES NOT NEED — the CIRCUIT BREAKER. A Stop block costs one regenerated
 * reply and the turn still ends. A PreToolUse block costs the ACTION, and a guard can keep refusing
 * forever, so "no legal move" is a terminal state there in a way it never is at Stop. After
 * MAX_CALL_BLOCKS refusals of the same call in one turn, the call proceeds and the override is
 * recorded. Enforcement degrades; the session does not stop.
 *
 * HOW (Phase 1, adapter-shaped exactly like the Stop arbiter): every existing hook file stays as
 * written and keeps its own tests. The harness already spawned all 75 per tool call, so running
 * them under one parent is the same cost profile — only the delivery changes.
 *
 * Fails OPEN everywhere. As the only PreToolUse entry, a crash here must cost enforcement, never
 * the ability to work.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync, appendFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readTranscript } from './transcript.mjs';
import { humanPromptCount, turnKeyFor } from './style-verdict.mjs';

export { humanPromptCount, turnKeyFor };

/** The harness spells these two ways depending on entry point; read both in exactly one place. */
export function calledToolName(payload) {
  return String(payload?.tool_name ?? payload?.toolName ?? '');
}

export function calledToolInput(payload) {
  return payload?.tool_input ?? payload?.toolInput ?? {};
}

/** Where per-call refusal counters live. Resolved lazily so a test can redirect it (see the Stop
 * arbiter's note on the same hazard: reading the env once at import time ignores a later setenv). */
export function preToolUseStateDir() {
  return process.env.PRETOOLUSE_ARBITER_STATE_DIR
    || resolve(homedir(), '.claude', 'state', 'pretooluse-arbiter');
}

/** Counters older than this are swept; a turn is long over by then. */
const COUNTER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How many times ONE call may be refused in a turn before it proceeds anyway.
 *
 * Two, not one: the first refusal is usually a real correction the assistant can act on, and the
 * second still allows a different guard to weigh in on the corrected attempt. A THIRD refusal of
 * the same call is the signature of guards contradicting each other rather than teaching, and no
 * amount of rewriting resolves it — that is the case this ceiling exists for.
 */
export const MAX_CALL_BLOCKS = (() => {
  const configured = Number(process.env.PRETOOLUSE_ARBITER_MAX_BLOCKS);
  return Number.isInteger(configured) && configured > 0 ? configured : 2;
})();

/** Hard cap on findings in one refusal, so the message is not itself a wall of text. */
export const MAX_VERDICT_ITEMS = 6;

/** Per-checker wall clock. A hung checker must not stall every tool call. */
export const CHECKER_TIMEOUT_MS = Number(process.env.PRETOOLUSE_ARBITER_TIMEOUT_MS) || 5_000;

/** Env escape: waive the whole PreToolUse gate. */
export const ENV_ESCAPE_VARS = ['PRETOOLUSE_ARBITER_OK'];

/** Where breaker trips are recorded, so a loosened gate is auditable rather than invisible. */
export function breakerLogPath() {
  return process.env.PRETOOLUSE_ARBITER_LOG || join(preToolUseStateDir(), 'circuit-breaker.jsonl');
}

/** Scope the arbiter to a subset of checkers, so a ported hook's own test can exercise it alone. */
export function activeCheckers(checkers) {
  const scoped = String(process.env.PRETOOLUSE_ARBITER_ONLY || '').trim();
  if (!scoped) return checkers || [];
  const allowed = new Set(scoped.split(',').map((checkerId) => checkerId.trim()).filter(Boolean));
  return (checkers || []).filter((checker) => allowed.has(checker?.id));
}

/**
 * True when this checker declared it cares about this tool.
 * An absent or empty matcher means "every tool", matching the harness's own semantics.
 */
export function checkerWatchesTool(checker, toolName) {
  const matcher = String(checker?.matcher || '').trim();
  if (!matcher) return true;
  try {
    return new RegExp(`^(?:${matcher})$`, 'i').test(String(toolName || ''));
  } catch {
    return true; // an unparseable matcher must not silently disable a guard
  }
}

/**
 * Identity of ONE attempted call: the turn, the tool, and the arguments.
 *
 * Keyed on the arguments too, so correcting a refused call produces a NEW identity and gets its own
 * full budget. Only a genuinely repeated attempt at the same call counts toward the ceiling.
 */
export function callKeyFor(turnKey, toolName, toolInput) {
  let serializedInput;
  try { serializedInput = JSON.stringify(toolInput ?? {}); } catch { serializedInput = String(toolInput || ''); }
  return createHash('sha1')
    .update(`${turnKey}${String(toolName || '')}${serializedInput}`)
    .digest('hex')
    .slice(0, 20);
}

function counterPathFor(callKey, attempt) {
  return join(preToolUseStateDir(), `call-${callKey}.${attempt}.block`);
}

function sweepStaleCounters() {
  try {
    const cutoff = Date.now() - COUNTER_TTL_MS;
    for (const counterFileName of readdirSync(preToolUseStateDir())) {
      if (!counterFileName.endsWith('.block')) continue;
      const counterFile = join(preToolUseStateDir(), counterFileName);
      try { if (statSync(counterFile).mtimeMs < cutoff) rmSync(counterFile, { force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** How many times this exact call has already been refused. Read-only — does not record. */
export function callBlockCount(callKey) {
  try {
    const prefix = `call-${callKey}.`;
    return readdirSync(preToolUseStateDir())
      .filter((name) => name.startsWith(prefix) && name.endsWith('.block')).length;
  } catch {
    return 0;
  }
}

/** Record one refusal of this call. Returns false when state is unwritable — which must fail OPEN. */
export function recordBlock(callKey) {
  try {
    mkdirSync(preToolUseStateDir(), { recursive: true });
    sweepStaleCounters();
    writeFileSync(
      counterPathFor(callKey, callBlockCount(callKey) + 1),
      JSON.stringify({ callKey, ts: Date.now() }),
      { flag: 'wx' },
    );
    return true;
  } catch {
    return false;
  }
}

/** Append one breaker trip to the audit log. Best effort; never throws. */
export function logBreakerTrip(entry) {
  try {
    const logFile = breakerLogPath();
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch { /* an unwritable log must never block a call */ }
}

/**
 * Parse one checker's result into a finding.
 *
 * A PreToolUse hook refuses by exiting 2 with its reason on stderr. Some also speak JSON on stdout
 * with a permissionDecision. Anything else — exit 0, empty output, malformed JSON — is not a
 * refusal. Unparseable output must never count as one: a crashing hook would then veto everything.
 */
export function parseCheckerResult({ exitCode, stdout, stderr }) {
  const spoken = String(stdout || '').trim();
  if (spoken) {
    try {
      const verdict = JSON.parse(spoken);
      const decision = verdict?.hookSpecificOutput?.permissionDecision ?? verdict?.permissionDecision;
      if (decision === 'deny') {
        const reason = String(
          verdict?.hookSpecificOutput?.permissionDecisionReason ?? verdict?.reason ?? '',
        ).trim();
        return { reason: reason || 'denied without a stated reason' };
      }
      if (decision === 'allow') return null;
    } catch { /* fall through to the exit-code contract */ }
  }
  if (Number(exitCode) !== 2) return null;
  // Exit 2 IS the refusal; the message is how it explains itself. A hook that calls
  // `console.error(...)` immediately followed by `process.exit(2)` can lose buffered stderr when
  // stderr is a pipe (documented in learnings.md, 2026-06-16). Dropping the refusal because its
  // text was truncated would silently disable that guard under the arbiter, which is the one
  // failure mode worse than a vague message.
  return { reason: String(stderr || '').trim() || 'refused without a stated reason' };
}

/** Run one checker as a child process, feeding it the verbatim PreToolUse payload on stdin. */
function runChecker(checker, payload) {
  return new Promise((deliverFinding) => {
    let alreadyDelivered = false;
    const finish = (finding) => {
      if (alreadyDelivered) return;
      alreadyDelivered = true;
      deliverFinding(finding);
    };

    let child;
    try {
      child = spawn(checker.command[0], checker.command.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PRETOOLUSE_ARBITER_CHILD: '1' },
      });
    } catch {
      return finish(null);
    }

    const hangTimer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(null);
    }, CHECKER_TIMEOUT_MS);
    hangTimer.unref?.();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => { clearTimeout(hangTimer); finish(null); });
    child.on('close', (exitCode) => {
      clearTimeout(hangTimer);
      finish(parseCheckerResult({ exitCode, stdout, stderr }));
    });

    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      clearTimeout(hangTimer);
      finish(null);
    }
  });
}

/** Run every checker that watches this tool and collect its finding. */
export async function collectFindings(payload, checkers) {
  const toolName = calledToolName(payload);
  const watching = activeCheckers(checkers).filter((checker) => checkerWatchesTool(checker, toolName));
  const settled = await Promise.all(watching.map(async (checker) => {
    try {
      const found = await runChecker(checker, payload);
      if (!found) return null;
      return { id: checker.id, label: checker.label || checker.id, reason: found.reason };
    } catch {
      return null; // one broken checker must never silence the rest
    }
  }));
  return settled.filter(Boolean);
}

/** The opening lines of a checker's reason — its headline, not its whole essay. */
export function summarize(reason, maxLines = 6) {
  return String(reason || '')
    .split('\n')
    .map((reasonLine) => reasonLine.trimEnd())
    .filter((reasonLine) => reasonLine.trim())
    .slice(0, maxLines)
    .join('\n');
}

/** Merge findings into ONE refusal message naming every objection at once. */
export function formatVerdict(findings, { attempt = 1 } = {}) {
  const listed = findings.slice(0, MAX_VERDICT_ITEMS);
  // Refusals still available AFTER this one. At the last allowed refusal this is 0, which is the
  // honest thing to say: repeating the call unchanged will execute it.
  const remaining = Math.max(0, MAX_CALL_BLOCKS - attempt);
  const header = [
    `TOOL CALL REFUSED — ${listed.length} guard${listed.length === 1 ? '' : 's'} objected.`,
    '',
    'All objections are listed together on purpose: satisfy them in ONE corrected call.',
    remaining > 0
      ? `Changing the call gives it a fresh budget. Repeating this exact call ${remaining} more `
        + 'time(s) unchanged lets it through anyway, on the assumption the guards are contradicting '
        + 'each other rather than teaching.'
      : 'This call has reached its refusal ceiling and will proceed on the next attempt.',
  ].join('\n');

  const sections = listed.map((finding, position) => (
    `${position + 1}. [${finding.label}]\n${summarize(finding.reason)}`
  ));

  return [header, ...sections].join('\n\n');
}

/**
 * Run the whole PreToolUse registry and produce at most one refusal.
 *
 * @returns {Promise<{decision:'deny', reason:string}|null>} null means "let the call proceed"
 */
export async function runPreToolUseArbiter(payload, { checkers } = {}) {
  try {
    const eventName = payload?.hook_event_name || payload?.hookEventName || '';
    if (eventName && eventName !== 'PreToolUse') return null;
    for (const envVar of ENV_ESCAPE_VARS) if (process.env[envVar] === '1') return null;

    const entries = readTranscript(payload?.transcript_path);
    const turnKey = turnKeyFor(payload, entries);
    const toolName = calledToolName(payload);
    const callKey = callKeyFor(turnKey, toolName, calledToolInput(payload));

    // THE CIRCUIT BREAKER. Checked FIRST and cheaply: once a call has been refused this many
    // times, nothing the guards say can be acted on, so there is no reason to ask them again.
    const alreadyBlocked = callBlockCount(callKey);
    if (alreadyBlocked >= MAX_CALL_BLOCKS) {
      logBreakerTrip({ ts: Date.now(), turnKey, tool: toolName, callKey, blocks: alreadyBlocked });
      return null;
    }

    const findings = await collectFindings(payload, checkers);
    if (findings.length === 0) return null;

    recordBlock(callKey);
    return { decision: 'deny', reason: formatVerdict(findings, { attempt: alreadyBlocked + 1 }) };
  } catch {
    return null; // fail open, always
  }
}
