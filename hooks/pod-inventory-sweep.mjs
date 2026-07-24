#!/usr/bin/env node
// =============================================================================
// POD-INVENTORY-SWEEP — at SessionStart, ask the PROVIDER what is actually billing.
// =============================================================================
//
// api-docs-read: the whole RunPod API v2 surface this hook touches was audited in one pass
// this session, from the repo's own authoritative client `runner/providers/runpod.py` —
// base URL https://api.runpod.io/v2, `Authorization: Bearer <key>` auth, GET /pods
// (returns `{"pods": [...]}`), GET /pods/{id} (returns one pod object), DELETE /pods/{id}
// (expects 204), GET /billing/pods?podId=&bucketSize=, and the RunPodRequestError status
// wrapping incl. the 404-means-absent case. Both response shapes this hook parses were
// then confirmed AGAINST THE LIVE API with two real read-only calls before writing: the
// list payload (id/name/desiredStatus/createdAt) and the detail payload
// (status/cost/runtime.uptime/runtime.gpus). No unaudited protocol surface remains.
//
// new-hook-category: Benchmark / long-run discipline (pod lifecycle) — the BETWEEN-SESSIONS
// counterpart to pod-cost-circuit-breaker. That hook is a PostToolUse timer over REMEMBERED
// state; this one is a SessionStart query against REALITY.
//
// THE MISTAKE (2026-07-24, $23.50): pod `n6svu7vv2ab41q` (Exp173 live endpoint, A40 @
// $0.44/hr) finished its 10/10 proof on Jul 22 at 10:30am and then idled ~52 HOURS.
// pod-cost-circuit-breaker was armed and its state was CORRECT the entire time
// (launchAt = Jul 22 07:55, lastLivenessAt never advanced) — but it only fires on
// PostToolUse, and no marcus session ran for two days. Nothing could fire. Separately,
// the pod-liveness watch that should have caught it had crashed on a transport error
// and died silently, and `runpod_marcus_live_endpoint.py` shipped no teardown verb, so
// the run had no way to close itself out.
//
// ROOT CAUSE — two independent structural failures, both fixed here:
//   1. WINDOW vs LIFETIME. The invariant "no pod bills unattended" lives in wall-clock
//      time ACROSS sessions. The breaker's detection window is one tool call INSIDE one
//      session. A monitor whose window is narrower than its invariant's lifetime is
//      structurally blind to exactly the gap that costs money. (This is the distilled
//      global learning: "a monitor's detection WINDOW must match the invariant's LIFETIME.")
//   2. PROXY vs REALITY. The breaker reasons over a local state file. A wiped state file,
//      a pod launched outside a session, or a dead watcher all silently falsify it.
//      The provider's own pod list cannot go stale. (The distilled learning again:
//      "liveness = the ACTIVITY STREAM, never a proxy.")
//
// SAFETY (Getty rule, 2026-07-19 — a "check" must never destroy): this hook is READ-ONLY.
// It issues one GET for the pod list and one GET per running pod. It has no delete path,
// no --confirm, no teardown call. It cannot kill a pod even if it is wrong about one.
//
// FAILS OPEN, ALWAYS: no key, no network, provider error, bad payload, slow response —
// every path exits 0 silently. A session must never be blocked by this sweep.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCOPED_REPO_RE = /[\\/](marcus|legible)(?:[\\/]|$)/i;
export function isInScopedRepo(workingDirectory) {
  return typeof workingDirectory === 'string' && SCOPED_REPO_RE.test(workingDirectory);
}

const RUNPOD_BASE_URL = process.env.POD_SWEEP_BASE_URL || 'https://api.runpod.io/v2';
const REQUEST_TIMEOUT_MS = Number(process.env.POD_SWEEP_TIMEOUT_MS ?? 8000);
const LONG_RUNNING_HOURS = Number(process.env.POD_SWEEP_LONG_HOURS ?? 2);
const MAX_DETAIL_FETCHES = 12;
const DEAD_STATUSES = new Set(['EXITED', 'TERMINATED']);

const ENV_FILE_CANDIDATES = [
  resolve(homedir(), 'Desktop', 'programming', 'marcus', '.env'),
  resolve(homedir(), 'Desktop', 'programming', 'legible', '.env'),
];

/** Normalize either the list payload or the detail payload into one shape. */
export function normalizePod(rawPod) {
  const pod = rawPod && typeof rawPod === 'object' ? rawPod : {};
  const status = String(pod.status ?? pod.desiredStatus ?? 'UNKNOWN').toUpperCase();
  const rawCost = pod.cost ?? pod.costPerHr;
  const costPerHour = typeof rawCost === 'number' && Number.isFinite(rawCost) ? rawCost : null;
  const runtime = pod.runtime && typeof pod.runtime === 'object' ? pod.runtime : {};
  const rawUptime = runtime.uptime ?? runtime.uptimeInSeconds;
  const uptimeSeconds =
    typeof rawUptime === 'number' && Number.isFinite(rawUptime) ? rawUptime : null;
  return {
    id: typeof pod.id === 'string' ? pod.id : '',
    name: typeof pod.name === 'string' ? pod.name : '',
    status,
    isRunning: status !== 'UNKNOWN' && !DEAD_STATUSES.has(status),
    costPerHour,
    uptimeSeconds,
    createdAt: typeof pod.createdAt === 'string' ? pod.createdAt : null,
  };
}

/**
 * Age a pod has actually been BILLING, in hours.
 * Prefers `runtime.uptime` over `createdAt`: a stopped-and-restarted pod carries an old
 * createdAt but only bills for the current running stretch, so uptime is the honest number.
 */
function billingHours(pod, nowMs) {
  if (typeof pod.uptimeSeconds === 'number') return pod.uptimeSeconds / 3600;
  if (pod.createdAt) {
    const createdMs = Date.parse(pod.createdAt);
    if (Number.isFinite(createdMs)) return Math.max(0, (nowMs - createdMs) / 3600000);
  }
  return 0;
}

export function summarizeRunningPods(pods, nowMs, options = {}) {
  const longRunningHours = Number(options.longRunningHours ?? LONG_RUNNING_HOURS);
  const running = [];
  let totalAccruedUsd = 0;
  let hourlyBurnUsd = 0;

  for (const pod of pods || []) {
    if (!pod || !pod.isRunning) continue;
    const hoursUp = billingHours(pod, nowMs);
    const hourlyCost = typeof pod.costPerHour === 'number' ? pod.costPerHour : 0;
    const accruedUsd = hoursUp * hourlyCost;
    totalAccruedUsd += accruedUsd;
    hourlyBurnUsd += hourlyCost;
    running.push({
      ...pod,
      hoursUp,
      accruedUsd,
      isLongRunning: hoursUp >= longRunningHours,
    });
  }

  running.sort((left, right) => right.hoursUp - left.hoursUp);
  return {
    running,
    totalAccruedUsd,
    hourlyBurnUsd,
    alert: running.length > 0,
  };
}

export function formatAlert(summary) {
  if (!summary || !summary.alert || summary.running.length === 0) return '';
  const podCount = summary.running.length;
  const plural = podCount === 1 ? 'POD IS' : 'PODS ARE';
  const lines = [
    `=== ${podCount} PAID ${plural} RUNNING RIGHT NOW ===`,
    '',
    'This is a live read of the RunPod account, not remembered state.',
    '',
  ];
  for (const pod of summary.running) {
    const hourly = typeof pod.costPerHour === 'number' ? `$${pod.costPerHour.toFixed(2)}/hr` : 'cost unknown';
    const flag = pod.isLongRunning ? '  <-- LONG-RUNNING' : '';
    lines.push(
      `  ${pod.id}${pod.name ? ` (${pod.name})` : ''} — ${pod.status}, ` +
      `up ${pod.hoursUp.toFixed(1)}h, ${hourly}, accrued ~$${pod.accruedUsd.toFixed(2)}${flag}`,
    );
  }
  lines.push(
    '',
    `Total burn: $${summary.hourlyBurnUsd.toFixed(2)}/hr — about $${(summary.hourlyBurnUsd * 24).toFixed(2)}/day.`,
    `Accrued so far: ~$${summary.totalAccruedUsd.toFixed(2)}.`,
    '',
    'A pod being UP is not the JOB being alive (the $13 exp154 lesson, and the $23.50',
    'exp173 live-endpoint bleed on 2026-07-24). Before anything else, confirm the JOB:',
    '  - ssh the pod and `pgrep -f <trainer>` / `nvidia-smi`, or check a progress file mtime.',
    '  - If the job is DONE or DEAD: rescue results, then tear the pod down.',
    '',
    'Teardown that also writes billing + absence receipts:',
    '  py -3 scripts/runpod_marcus_live_endpoint_closeout.py --pod-id <id>            # read-only report',
    '  py -3 scripts/runpod_marcus_live_endpoint_closeout.py --pod-id <id> --confirm <id>  # delete',
  );
  return lines.join('\n');
}

// ── IO shell (not covered by the pure tests) ─────────────────────────────────

function discoverApiKey() {
  for (const variableName of ['RUNPOD_API_KEY', 'RUNPOD_KEY']) {
    if (process.env[variableName]) return process.env[variableName];
  }
  for (const envPath of ENV_FILE_CANDIDATES) {
    try {
      if (!existsSync(envPath)) continue;
      const envBody = readFileSync(envPath, 'utf8');
      const found = envBody.match(/^\s*RUNPOD_(?:API_)?KEY\s*=\s*["']?([^\s"'#]+)/m);
      if (found) return found[1];
    } catch { /* fail open */ }
  }
  return null;
}

async function getJson(url, apiKey) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);
  try {
    const providerReply = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: abortController.signal,
    });
    if (!providerReply.ok) return null;
    return await providerReply.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function readHookPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

async function sweepRunningPods() {
  try {
    if (process.env.POD_SWEEP_OFF === '1') return;
    const hookPayload = readHookPayload();
    const workingDirectory = hookPayload.cwd || hookPayload.workingDirectory || process.cwd();
    if (!isInScopedRepo(workingDirectory)) return;

    const apiKey = discoverApiKey();
    if (!apiKey) return;

    const podListPayload = await getJson(`${RUNPOD_BASE_URL}/pods`, apiKey);
    const rawPods = podListPayload && Array.isArray(podListPayload.pods) ? podListPayload.pods : null;
    if (!rawPods || rawPods.length === 0) return;

    // The list payload omits cost/uptime, so enrich each RUNNING pod from its detail
    // endpoint. Bounded so a surprising account size cannot stall session start.
    const normalizedPods = [];
    let detailFetchCount = 0;
    for (const rawPod of rawPods) {
      const listPod = normalizePod(rawPod);
      if (!listPod.isRunning || !listPod.id) { normalizedPods.push(listPod); continue; }
      if (detailFetchCount >= MAX_DETAIL_FETCHES) { normalizedPods.push(listPod); continue; }
      detailFetchCount += 1;
      const podDetail = await getJson(
        `${RUNPOD_BASE_URL}/pods/${encodeURIComponent(listPod.id)}`,
        apiKey,
      );
      normalizedPods.push(podDetail ? normalizePod(podDetail) : listPod);
    }

    const alertMessage = formatAlert(summarizeRunningPods(normalizedPods, Date.now()));
    if (alertMessage) process.stdout.write(alertMessage);
  } catch {
    /* fail open — a session must never be blocked by this sweep */
  }
}

if (basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url))) sweepRunningPods();
