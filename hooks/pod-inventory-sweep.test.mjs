// Tests for pod-inventory-sweep.mjs — a SessionStart sweep that asks the PROVIDER
// "is anything billing right now?" instead of trusting remembered local state. Red-first.
//
// THE MISTAKE (2026-07-24, $23.50): pod `n6svu7vv2ab41q` (the Exp173 live endpoint,
// A40 @ $0.44/hr) finished its 10/10 proof on Jul 22 at 10:30am and then idled for
// ~52 HOURS. pod-cost-circuit-breaker was armed the whole time and its state file was
// correct (launchAt = Jul 22 07:55) — but it is a PostToolUse timer, so it can only fire
// while a session is running. No marcus session existed for two days, so nothing fired.
// The pod-liveness watch that should have caught it had itself crashed on a transport
// error and died silently.
//
// ROOT CAUSE (matches the distilled global learning "a monitor's detection WINDOW must
// match the invariant's LIFETIME"): the invariant "no pod bills unattended" lives in
// WALL-CLOCK time across sessions; the breaker's window is one tool call inside one
// session. Also: the breaker reasons over REMEMBERED STATE, which a wiped state file, an
// externally-launched pod, or a dead watcher all silently falsify.
//
// THE FIX UNDER TEST: at SessionStart, query the provider for the real pod list. Reality
// cannot go stale. This closes the between-sessions gap at the earliest possible moment.
//
//   node --test hooks/pod-inventory-sweep.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInScopedRepo,
  normalizePod,
  summarizeRunningPods,
  formatAlert,
} from './pod-inventory-sweep.mjs';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-07-24T20:35:00Z');

test('scope: only marcus/legible arm the sweep', () => {
  assert.equal(isInScopedRepo('C:\\Users\\rmill\\Desktop\\programming\\marcus'), true);
  assert.equal(isInScopedRepo('/home/rmill/programming/legible/exp'), true);
  assert.equal(isInScopedRepo('C:\\Users\\rmill\\Desktop\\programming\\Macher'), false);
  assert.equal(isInScopedRepo(undefined), false);
});

// ── normalizePod: tolerate both the list and detail payload shapes ─────────────
test('normalizePod reads the detail shape (status/cost/runtime.uptime)', () => {
  const pod = normalizePod({
    id: 'n6svu7vv2ab41q',
    name: 'marcus-live-endpoint',
    status: 'RUNNING',
    cost: 0.44,
    createdAt: '2026-07-22T16:22:09.571Z',
    runtime: { uptime: 188593 },
  });
  assert.equal(pod.id, 'n6svu7vv2ab41q');
  assert.equal(pod.isRunning, true);
  assert.equal(pod.costPerHour, 0.44);
  assert.equal(pod.uptimeSeconds, 188593);
});

test('normalizePod reads the list shape (desiredStatus/costPerHr)', () => {
  const pod = normalizePod({
    id: 'abc123',
    desiredStatus: 'RUNNING',
    costPerHr: 0.79,
    createdAt: '2026-07-24T19:35:00Z',
  });
  assert.equal(pod.isRunning, true);
  assert.equal(pod.costPerHour, 0.79);
});

test('normalizePod treats EXITED/TERMINATED as not running', () => {
  assert.equal(normalizePod({ id: 'x', status: 'EXITED' }).isRunning, false);
  assert.equal(normalizePod({ id: 'x', desiredStatus: 'TERMINATED' }).isRunning, false);
});

// ── summarizeRunningPods: the load-bearing arithmetic ─────────────────────────
test('no pods → no alert (the quiet, common case must stay silent)', () => {
  const summary = summarizeRunningPods([], NOW);
  assert.equal(summary.alert, false);
  assert.equal(summary.running.length, 0);
});

test('only dead pods → no alert', () => {
  const summary = summarizeRunningPods(
    [normalizePod({ id: 'x', status: 'EXITED', cost: 0.44 })],
    NOW,
  );
  assert.equal(summary.alert, false);
});

test('a long-idle running pod alerts with age and accrued cost', () => {
  const summary = summarizeRunningPods(
    [normalizePod({
      id: 'n6svu7vv2ab41q',
      name: 'marcus-live-endpoint',
      status: 'RUNNING',
      cost: 0.44,
      createdAt: '2026-07-22T16:22:09.571Z',
      runtime: { uptime: 188593 },
    })],
    NOW,
  );
  assert.equal(summary.alert, true);
  assert.equal(summary.running.length, 1);
  // 188593s ≈ 52.4h × $0.44 ≈ $23.05 — the real bleed, within rounding.
  assert.ok(Math.abs(summary.totalAccruedUsd - 23.05) < 0.5,
    `expected ~$23 accrued, got ${summary.totalAccruedUsd}`);
  assert.ok(Math.abs(summary.hourlyBurnUsd - 0.44) < 0.001);
});

test('a freshly launched pod still surfaces but is not flagged as long-running', () => {
  const summary = summarizeRunningPods(
    [normalizePod({
      id: 'fresh', status: 'RUNNING', cost: 0.44,
      createdAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
      runtime: { uptime: 600 },
    })],
    NOW,
  );
  assert.equal(summary.running.length, 1);
  assert.equal(summary.alert, true, 'any running pod is worth surfacing at session start');
  assert.equal(summary.running[0].isLongRunning, false);
});

test('past the long-running threshold the pod is flagged', () => {
  const summary = summarizeRunningPods(
    [normalizePod({
      id: 'old', status: 'RUNNING', cost: 0.44,
      createdAt: new Date(NOW - 5 * HOUR_MS).toISOString(),
      runtime: { uptime: 5 * 3600 },
    })],
    NOW,
    { longRunningHours: 2 },
  );
  assert.equal(summary.running[0].isLongRunning, true);
});

test('uptime is preferred over createdAt when both exist (createdAt survives restarts)', () => {
  // A pod stopped and restarted has an old createdAt but a young uptime; billing
  // follows the RUNNING time, so uptime is the honest age for cost.
  const summary = summarizeRunningPods(
    [normalizePod({
      id: 'restarted', status: 'RUNNING', cost: 1.0,
      createdAt: '2026-07-01T00:00:00Z',
      runtime: { uptime: 3600 },
    })],
    NOW,
  );
  assert.ok(Math.abs(summary.totalAccruedUsd - 1.0) < 0.01,
    `expected ~$1 from 1h uptime, got ${summary.totalAccruedUsd}`);
});

test('multiple running pods sum their burn', () => {
  const summary = summarizeRunningPods(
    [
      normalizePod({ id: 'a', status: 'RUNNING', cost: 0.44, runtime: { uptime: 3600 } }),
      normalizePod({ id: 'b', status: 'RUNNING', cost: 1.56, runtime: { uptime: 3600 } }),
    ],
    NOW,
  );
  assert.equal(summary.running.length, 2);
  assert.ok(Math.abs(summary.hourlyBurnUsd - 2.0) < 0.001);
  assert.ok(Math.abs(summary.totalAccruedUsd - 2.0) < 0.01);
});

test('a missing cost does not crash the arithmetic', () => {
  const summary = summarizeRunningPods(
    [normalizePod({ id: 'nocost', status: 'RUNNING', runtime: { uptime: 3600 } })],
    NOW,
  );
  assert.equal(summary.alert, true);
  assert.ok(Number.isFinite(summary.totalAccruedUsd));
});

// ── formatAlert: the operator-facing message ──────────────────────────────────
test('formatAlert names the pod, its age, its accrued cost, and the teardown path', () => {
  const summary = summarizeRunningPods(
    [normalizePod({
      id: 'n6svu7vv2ab41q', name: 'marcus-live-endpoint', status: 'RUNNING',
      cost: 0.44, runtime: { uptime: 188593 },
    })],
    NOW,
  );
  const message = formatAlert(summary);
  assert.match(message, /n6svu7vv2ab41q/);
  assert.match(message, /marcus-live-endpoint/);
  assert.match(message, /52/);           // hours up
  assert.match(message, /\$2[0-9]/);     // accrued cost
  assert.match(message, /job is alive|JOB/i);  // must push the job-liveness question
});

test('formatAlert is empty when nothing is running (never nag on a clean account)', () => {
  assert.equal(formatAlert(summarizeRunningPods([], NOW)), '');
});

// ── IO-shell coverage: spawn the real hook against a stub provider ────────────
// A clean account can only ever prove the SILENT path. To prove the ALERT path —
// the one that actually matters, and the one that failed for 52 hours — point the
// hook at a local stub serving the exact RunPod v2 shapes and assert it speaks up.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const HOOK_PATH = resolvePath(dirname(fileURLToPath(import.meta.url)), 'pod-inventory-sweep.mjs');

function runHook({ cwd, baseUrl, env = {} }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: {
        ...process.env,
        RUNPOD_API_KEY: 'stub-key-not-a-real-secret',
        POD_SWEEP_BASE_URL: baseUrl || 'http://127.0.0.1:1/unused',
        POD_SWEEP_TIMEOUT_MS: '2000',
        ...env,
      },
    });
    let stdoutText = '';
    child.stdout.on('data', (chunk) => { stdoutText += chunk.toString(); });
    child.on('close', (exitCode) => resolveRun({ stdoutText, exitCode }));
    child.stdin.write(JSON.stringify({ hook_event_name: 'SessionStart', cwd }));
    child.stdin.end();
  });
}

function startStubProvider(pods) {
  return new Promise((resolveServer) => {
    const server = createServer((request, reply) => {
      reply.setHeader('Content-Type', 'application/json');
      const detailMatch = request.url.match(/\/pods\/([^/?]+)$/);
      if (detailMatch) {
        const pod = pods.find((candidate) => candidate.id === detailMatch[1]);
        reply.end(JSON.stringify(pod || {}));
        return;
      }
      // The list shape deliberately omits cost/uptime, exactly like the real API.
      reply.end(JSON.stringify({
        pods: pods.map(({ id, name, status }) => ({ id, name, desiredStatus: status })),
      }));
    });
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('IO: a bleeding pod makes the hook speak up with id, hours, and cost', async () => {
  const { server, baseUrl } = await startStubProvider([{
    id: 'n6svu7vv2ab41q',
    name: 'marcus-live-endpoint',
    status: 'RUNNING',
    cost: 0.44,
    createdAt: '2026-07-22T16:22:09.571Z',
    runtime: { uptime: 188593 },
  }]);
  try {
    const { stdoutText, exitCode } = await runHook({
      cwd: 'C:\\Users\\rmill\\Desktop\\programming\\marcus',
      baseUrl,
    });
    assert.equal(exitCode, 0, 'the sweep must never fail a session start');
    assert.match(stdoutText, /n6svu7vv2ab41q/);
    assert.match(stdoutText, /52\.4h/);
    assert.match(stdoutText, /\$23\./);
    assert.match(stdoutText, /LONG-RUNNING/);
  } finally {
    server.close();
  }
});

test('IO: a clean account stays completely silent', async () => {
  const { server, baseUrl } = await startStubProvider([]);
  try {
    const { stdoutText, exitCode } = await runHook({
      cwd: 'C:\\Users\\rmill\\Desktop\\programming\\marcus',
      baseUrl,
    });
    assert.equal(exitCode, 0);
    assert.equal(stdoutText.trim(), '', 'no pods running must produce no noise');
  } finally {
    server.close();
  }
});

test('IO: an out-of-scope repo never even calls the provider', async () => {
  const { server, baseUrl } = await startStubProvider([{
    id: 'x', name: 'n', status: 'RUNNING', cost: 9.99, runtime: { uptime: 99999 },
  }]);
  try {
    const { stdoutText, exitCode } = await runHook({
      cwd: 'C:\\Users\\rmill\\Desktop\\programming\\Macher',
      baseUrl,
    });
    assert.equal(exitCode, 0);
    assert.equal(stdoutText.trim(), '');
  } finally {
    server.close();
  }
});

test('IO: an unreachable provider fails OPEN and silent (never blocks a session)', async () => {
  const { stdoutText, exitCode } = await runHook({
    cwd: 'C:\\Users\\rmill\\Desktop\\programming\\marcus',
    baseUrl: 'http://127.0.0.1:1/dead',
  });
  assert.equal(exitCode, 0);
  assert.equal(stdoutText.trim(), '');
});
