#!/usr/bin/env node
// launch-preflight-monitor.test.mjs — locks the monitor-required gate
// (Russell, 2026-07-25): a paid/long launch (RunPod experiment launch or
// Modal job) is BLOCKED unless a local monitor server is listening on the
// configured port. The live-watch rule was a skill with no enforcer; this
// gate is the mechanical fix so no future launch goes up blind.
//
// Run: node --test launch-preflight-monitor.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  evaluateMonitorGate,
  monitorServerListening,
  configuredMonitorPort,
  isMonitorableLaunch,
  startMonitorServer,
  waitForMonitor,
  stopMonitorServer,
} from './launch-preflight.mjs';

const hookDir = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(hookDir, 'launch-preflight.mjs');
const scratchDir = mkdtempSync(join(tmpdir(), 'launch-preflight-monitor-test-'));

let transcriptSeq = 0;
function runHook(command, { toolName = 'Bash' } = {}) {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command },
  };
  const result = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 8000,
  });
  return { stdout: result.stdout, status: result.status, stderr: result.stderr };
}

// --- unit: isMonitorableLaunch ---
test('isMonitorableLaunch: RunPod experiment launch matches', () => {
  assert.equal(isMonitorableLaunch('Bash', 'py scripts/runpod_exp173d.py launch --seeds 173,174,175'), true);
  assert.equal(isMonitorableLaunch('Bash', 'py -3 scripts/runpod_exp147b.py launch --seed 173'), true);
});

test('isMonitorableLaunch: RunPod launch WITHOUT .py (module-form) matches', () => {
  // Pre-mortem finding: `python -m scripts.runpod_exp173d launch` bypassed
  // the original .py-required regex. The broadened regex must catch it.
  assert.equal(isMonitorableLaunch('Bash', 'python -m scripts.runpod_exp173d launch --seeds 173,174,175'), true);
  assert.equal(isMonitorableLaunch('Bash', 'py -3 runpod_exp173d launch'), true);
});

test('isMonitorableLaunch: RunPod NON-launch subcommand does NOT match', () => {
  // --help / status / kill must not be blocked (no monitor needed for a read).
  assert.equal(isMonitorableLaunch('Bash', 'py scripts/runpod_exp173d.py status'), false);
  assert.equal(isMonitorableLaunch('Bash', 'py scripts/runpod_exp173d.py --help'), false);
  assert.equal(isMonitorableLaunch('Bash', 'py scripts/runpod_exp173d.py kill'), false);
});

test('isMonitorableLaunch: Modal python script matches', () => {
  assert.equal(isMonitorableLaunch('Bash', 'python scripts/modal_train.py'), true);
});

test('isMonitorableLaunch: modal run/deploy/launch/exec/submit subcommand matches', () => {
  assert.equal(isMonitorableLaunch('Bash', 'modal run train.py --gpu A100'), true);
  assert.equal(isMonitorableLaunch('Bash', 'modal deploy scripts/modal_serve.py'), true);
  assert.equal(isMonitorableLaunch('Bash', 'modal exec train.py'), true);
  assert.equal(isMonitorableLaunch('Bash', 'modal submit train.py'), true);
});

test('isMonitorableLaunch: generic long-run bash does NOT match (no false positives)', () => {
  assert.equal(isMonitorableLaunch('Bash', 'npm run build'), false);
  assert.equal(isMonitorableLaunch('Bash', 'py -3 scripts/exp173d.py --local --steps 10'), false);
  assert.equal(isMonitorableLaunch('Bash', 'pytest -q'), false);
});

test('isMonitorableLaunch: non-shell tool never matches', () => {
  assert.equal(isMonitorableLaunch('Read', 'py scripts/runpod_exp173d.py launch'), false);
  assert.equal(isMonitorableLaunch('Edit', 'modal run x.py'), false);
});

test('isMonitorableLaunch: PowerShell and Exec tool names match (pre-mortem fix)', () => {
  // The hook was registered under matcher 'Bash' only on a Windows/PowerShell
  // host — it silently no-oped. isShellTool must accept every shell-tool name.
  assert.equal(isMonitorableLaunch('PowerShell', 'py scripts/runpod_exp173d.py launch'), true);
  assert.equal(isMonitorableLaunch('exec', 'py scripts/runpod_exp173d.py launch'), true);
  assert.equal(isMonitorableLaunch('Exec', 'modal run x.py'), true);
});

// --- unit: configuredMonitorPort ---
test('configuredMonitorPort: defaults to 8173 when env unset', () => {
  delete process.env.MARCUS_MONITOR_PORT;
  assert.equal(configuredMonitorPort(), 8173);
});

test('configuredMonitorPort: honors MARCUS_MONITOR_PORT when valid', () => {
  process.env.MARCUS_MONITOR_PORT = '9000';
  assert.equal(configuredMonitorPort(), 9000);
  delete process.env.MARCUS_MONITOR_PORT;
});

test('configuredMonitorPort: falls back to 8173 on garbage env', () => {
  process.env.MARCUS_MONITOR_PORT = 'not-a-port';
  assert.equal(configuredMonitorPort(), 8173);
  delete process.env.MARCUS_MONITOR_PORT;
});

// --- unit: monitorServerListening ---
test('monitorServerListening: false on a dead port', async () => {
  const up = await monitorServerListening(59999); // nothing listening here
  assert.equal(up, false);
});

test('monitorServerListening: true when an HTTP server is up and returns 200', async () => {
  // Spin a throwaway HTTP server on an ephemeral port returning 200, prove the
  // probe sees it. (The probe now requires an HTTP 2xx/3xx, not just a TCP
  // accept — pre-mortem fix for the "any TCP listener satisfies the gate" kill.)
  const server = http.createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const up = await monitorServerListening(port);
    assert.equal(up, true);
  } finally {
    server.close();
  }
});

test('monitorServerListening: false when a NON-HTTP TCP listener is on the port', async () => {
  // A raw TCP socket (e.g. a leftover database) accepting connections but not
  // speaking HTTP must NOT satisfy the gate — that's the false-positive the
  // HTTP probe exists to kill.
  const { createServer } = await import('node:net');
  const server = createServer((sock) => { sock.end('not http\r\n'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const up = await monitorServerListening(port);
    assert.equal(up, false);
  } finally {
    server.close();
  }
});

test('monitorServerListening: false when the HTTP server returns 500', async () => {
  // A broken monitor (500 on /) should not satisfy the gate — treat as down.
  const server = http.createServer((_req, res) => { res.statusCode = 500; res.end('err'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const up = await monitorServerListening(port);
    assert.equal(up, false);
  } finally {
    server.close();
  }
});

// --- unit: evaluateMonitorGate ---
test('evaluateMonitorGate: BLOCKS a RunPod launch when monitor is down', () => {
  delete process.env.MONITOR_GATE_OK;
  const v = evaluateMonitorGate('Bash', 'py scripts/runpod_exp173d.py launch --seeds 173,174,175', false);
  assert.equal(v.applies, true);
  assert.equal(v.block, true);
  assert.equal(v.port, 8173);
  assert.match(v.reason, /LIVE MONITOR REQUIRED/);
  assert.match(v.reason, /http\.server 8173/);
});

test('evaluateMonitorGate: PASSES a RunPod launch when monitor is up', () => {
  delete process.env.MONITOR_GATE_OK;
  const v = evaluateMonitorGate('Bash', 'py scripts/runpod_exp173d.py launch --seeds 173,174,175', true);
  assert.equal(v.applies, true);
  assert.equal(v.block, false);
});

test('evaluateMonitorGate: does NOT apply to generic bash (no false positives)', () => {
  const v = evaluateMonitorGate('Bash', 'npm run build', false);
  assert.equal(v.applies, false);
  assert.equal(v.block, false);
});

test('evaluateMonitorGate: escape token MONITOR_GATE_OK in command opts out', () => {
  // create-hook Rule 7: every enforcement hook needs an escape for legitimate
  // exceptions (a non-marcus `modal run`, a <1min smoke). The token must work
  // even with no monitor up.
  delete process.env.MONITOR_GATE_OK;
  const v = evaluateMonitorGate('Bash', 'MONITOR_GATE_OK py scripts/runpod_exp173d.py launch --seeds 173,174,175', false);
  assert.equal(v.applies, true);
  assert.equal(v.block, false);
});

test('evaluateMonitorGate: escape token MONITOR_GATE_OK=1 in env opts out', () => {
  process.env.MONITOR_GATE_OK = '1';
  try {
    const v = evaluateMonitorGate('Bash', 'py scripts/runpod_exp173d.py launch --seeds 173,174,175', false);
    assert.equal(v.applies, true);
    assert.equal(v.block, false);
  } finally {
    delete process.env.MONITOR_GATE_OK;
  }
});

// --- end-to-end: hook blocks a launch with no monitor, passes with one ---
test('e2e: RunPod launch with NO monitor listening is BLOCKED', { timeout: 10000 }, async () => {
  // Ensure 8173 is free for this test (no real monitor running). We can't
  // guarantee that globally, so probe first and skip if something is up —
  // the unit tests above cover the deterministic classifier behavior.
  const up = await monitorServerListening(8173);
  if (up) {
    // A monitor is already running (likely Russell's live session). The
    // block path is covered by the unit test; skip the e2e to avoid a
    // false pass from the live monitor.
    return;
  }
  const { stdout, status } = runHook('py scripts/runpod_exp173d.py launch --seeds 173,174,175');
  assert.equal(status, 0);
  const decision = JSON.parse(stdout);
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /LIVE MONITOR REQUIRED/);
});

test('e2e: RunPod launch WITH a monitor listening PASSES (no denial)', { timeout: 10000 }, async () => {
  // Spin a real http server on 8173 for the duration of this test so the
  // hook's TCP probe sees it, then tear it down.
  const { createServer } = await import('node:net');
  const server = createServer(() => {});
  // If 8173 is already taken (live session), use the existing one — the probe
  // will still succeed. If not, bind our own.
  let ownsServer = false;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(8173, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    ownsServer = true;
  } catch {
    // Port already in use — a monitor is already up; the probe will pass.
    ownsServer = false;
  }
  try {
    const { stdout, status } = runHook('py scripts/runpod_exp173d.py launch --seeds 173,174,175');
    assert.equal(status, 0);
    // No denial: either empty stdout (no context to inject) or additionalContext
    // with the skill digest — but NEVER a permissionDecision: 'deny'.
    if (stdout.trim()) {
      const decision = JSON.parse(stdout);
      assert.notEqual(decision.hookSpecificOutput?.permissionDecision, 'deny');
    }
  } finally {
    if (ownsServer) server.close();
  }
});

test('e2e: generic bash is never blocked by the monitor gate', { timeout: 8000 }, () => {
  const { stdout, status } = runHook('npm run build');
  assert.equal(status, 0);
  if (stdout.trim()) {
    const decision = JSON.parse(stdout);
    assert.notEqual(decision.hookSpecificOutput?.permissionDecision, 'deny');
  }
});

// --- AUTO-START: don't block on something you can just do (2026-07-26) --------

test('startMonitorServer spawns a detached, unref-d http server on the port', () => {
  const calls = [];
  const fakeChild = { pid: 4242, on() {}, unref() { calls.push('unref'); } };
  const spawner = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild; };
  const written = [];

  const started = startMonitorServer(8173, 'C:/repo', spawner, (path, body) => written.push([path, body]));

  assert.equal(started, true);
  const spawnCall = calls.find((entry) => entry && entry.cmd);
  assert.equal(spawnCall.cmd, 'py');
  assert.ok(spawnCall.args.includes('http.server'));
  assert.ok(spawnCall.args.includes('8173'));
  assert.equal(spawnCall.opts.cwd, 'C:/repo');
  assert.equal(spawnCall.opts.detached, true, 'must outlive this short-lived hook');
  assert.equal(spawnCall.opts.stdio, 'ignore', 'an inherited pipe would stall the harness');
  assert.ok(calls.includes('unref'), 'unref so the hook can exit');
  assert.equal(written[0][1], '4242', 'pid recorded so the server is always stoppable');
});

test('startMonitorServer never throws when spawning fails', () => {
  const exploding = () => { throw new Error('no python'); };
  assert.equal(startMonitorServer(8173, 'C:/repo', exploding, () => {}), false);
});

test('startMonitorServer survives a child that emits EADDRINUSE', () => {
  // A non-HTTP listener holding the port makes python exit EADDRINUSE. An
  // unhandled 'error' event would crash the hook; it must be swallowed.
  const fakeChild = {
    pid: 7,
    on(event, handler) { if (event === 'error') handler(new Error('EADDRINUSE')); },
    unref() {},
  };
  assert.equal(startMonitorServer(8173, 'C:/repo', () => fakeChild, () => {}), true);
});

test('waitForMonitor returns true as soon as the server answers', async () => {
  let probes = 0;
  const probe = async () => { probes += 1; return probes >= 2; };
  assert.equal(await waitForMonitor(8173, probe, 6, 1), true);
  assert.equal(probes, 2, 'stops probing the moment it is up');
});

test('waitForMonitor gives up and fails SAFE when nothing ever answers', async () => {
  const probe = async () => false;
  assert.equal(await waitForMonitor(8173, probe, 3, 1), false);
});

test('stopMonitorServer kills the recorded pid', () => {
  const killed = [];
  assert.equal(stopMonitorServer((pid) => killed.push(pid), () => 999), true);
  assert.deepEqual(killed, [999]);
});

test('stopMonitorServer is a no-op when no pid was recorded', () => {
  assert.equal(stopMonitorServer(() => { throw new Error('should not be called'); }, () => null), false);
});

test('stopMonitorServer treats an already-dead pid as success-enough', () => {
  const killer = () => { throw new Error('ESRCH'); };
  assert.equal(stopMonitorServer(killer, () => 123), false);
});
