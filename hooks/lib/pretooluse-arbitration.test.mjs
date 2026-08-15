import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_CALL_BLOCKS,
  callBlockCount,
  callKeyFor,
  checkerWatchesTool,
  collectFindings,
  formatVerdict,
  parseCheckerResult,
  recordBlock,
  runPreToolUseArbiter,
  breakerLogPath,
} from './pretooluse-arbitration.mjs';

// Every test owns its own state dir: these counters are per-call, so a leaked one from a prior
// run would silently trip the breaker and make a real block look like a pass.
// ASYNC on purpose. A synchronous try/finally around an async body runs its teardown the moment
// body() returns its PROMISE -- deleting the temp checkers and restoring the env before the
// arbiter ever spawns anything, so every refusal silently read as "no objection". The first
// version of this helper did exactly that and made four real passes look like failures.
async function withStateDir(body) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pretooluse-arbiter-'));
  const priorDir = process.env.PRETOOLUSE_ARBITER_STATE_DIR;
  const priorLog = process.env.PRETOOLUSE_ARBITER_LOG;
  process.env.PRETOOLUSE_ARBITER_STATE_DIR = stateDir;
  process.env.PRETOOLUSE_ARBITER_LOG = join(stateDir, 'trips.jsonl');
  try {
    return await body(stateDir);
  } finally {
    if (priorDir === undefined) delete process.env.PRETOOLUSE_ARBITER_STATE_DIR;
    else process.env.PRETOOLUSE_ARBITER_STATE_DIR = priorDir;
    if (priorLog === undefined) delete process.env.PRETOOLUSE_ARBITER_LOG;
    else process.env.PRETOOLUSE_ARBITER_LOG = priorLog;
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/** A checker that always refuses, written to disk so the arbiter really spawns it. */
function refusingChecker(stateDir, id, reason) {
  const checkerFile = join(stateDir, `${id}.mjs`);
  writeFileSync(
    checkerFile,
    `process.stdin.resume();\n`
    // process.exitCode, not process.exit(): exiting immediately after writing can truncate a
    // piped stderr, which would make this fixture prove the opposite of what it claims.
    + `process.stdin.on('end', () => { console.error(${JSON.stringify(reason)}); process.exitCode = 2; });\n`,
    'utf8',
  );
  return { id, label: id, command: ['node', checkerFile] };
}

function silentChecker(stateDir, id) {
  const checkerFile = join(stateDir, `${id}.mjs`);
  writeFileSync(checkerFile, 'process.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));\n', 'utf8');
  return { id, label: id, command: ['node', checkerFile] };
}

function payloadFor(toolInput = { command: 'echo hi' }) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'arbiter-test-session',
    tool_name: 'Bash',
    tool_input: toolInput,
  };
}

// -- the refusal contract ---------------------------------------------------

test('exit 2 with a stderr reason is a refusal; exit 0 is not', () => {
  assert.deepEqual(parseCheckerResult({ exitCode: 2, stderr: 'no' }), { reason: 'no' });
  assert.equal(parseCheckerResult({ exitCode: 0, stderr: 'no' }), null);
  // Exit 2 with no surviving message is still a refusal: `console.error` before `process.exit`
  // can truncate on a pipe, and losing the guard entirely is worse than a vague reason.
  assert.match(parseCheckerResult({ exitCode: 2, stderr: '   ' }).reason, /without a stated reason/);
});

test('a crashing or babbling checker never counts as a refusal', () => {
  // The whole file exists to stop one broken guard vetoing everything.
  assert.equal(parseCheckerResult({ exitCode: 1, stdout: 'not json at all' }), null);
  assert.equal(parseCheckerResult({ exitCode: 0, stdout: '{"broken":' }), null);
});

test('an explicit allow decision overrides a nonzero exit', () => {
  assert.equal(
    parseCheckerResult({
      exitCode: 2,
      stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }),
    }),
    null,
  );
});

test('a matcher scopes a checker to its tools; an absent matcher watches all', () => {
  assert.equal(checkerWatchesTool({ matcher: 'Edit|Write' }, 'Edit'), true);
  assert.equal(checkerWatchesTool({ matcher: 'Edit|Write' }, 'Bash'), false);
  assert.equal(checkerWatchesTool({ matcher: '' }, 'Bash'), true);
  // An unparseable matcher must not silently disable a guard.
  assert.equal(checkerWatchesTool({ matcher: '([' }, 'Bash'), true);
});

// -- one merged refusal, not N -----------------------------------------------

test('every objecting guard is named in ONE refusal', async () => {
  await withStateDir(async (stateDir) => {
    const verdict = await runPreToolUseArbiter(payloadFor(), {
      checkers: [
        refusingChecker(stateDir, 'first-guard', 'first objection'),
        refusingChecker(stateDir, 'second-guard', 'second objection'),
        silentChecker(stateDir, 'quiet-guard'),
      ],
    });
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /first objection/);
    assert.match(verdict.reason, /second objection/);
    assert.match(verdict.reason, /2 guards objected/);
  });
});

test('no objections means the call proceeds', async () => {
  await withStateDir(async (stateDir) => {
    const verdict = await runPreToolUseArbiter(payloadFor(), {
      checkers: [silentChecker(stateDir, 'quiet-one'), silentChecker(stateDir, 'quiet-two')],
    });
    assert.equal(verdict, null);
  });
});

// -- THE CIRCUIT BREAKER -----------------------------------------------------

test('a call refused MAX_CALL_BLOCKS times proceeds on the next attempt', async () => {
  await withStateDir(async (stateDir) => {
    const checkers = [refusingChecker(stateDir, 'always-refuses', 'I always say no')];
    const payload = payloadFor();

    for (let attempt = 1; attempt <= MAX_CALL_BLOCKS; attempt += 1) {
      const refusal = await runPreToolUseArbiter(payload, { checkers });
      assert.equal(refusal?.decision, 'deny', `attempt ${attempt} should still be refused`);
    }

    const breakerVerdict = await runPreToolUseArbiter(payload, { checkers });
    assert.equal(breakerVerdict, null, 'the breaker must let the call through');
  });
});

test('a tripped breaker is recorded, never silent', async () => {
  await withStateDir(async (stateDir) => {
    const checkers = [refusingChecker(stateDir, 'always-refuses', 'no')];
    const payload = payloadFor();
    for (let attempt = 0; attempt <= MAX_CALL_BLOCKS; attempt += 1) {
      await runPreToolUseArbiter(payload, { checkers });
    }
    const logFile = breakerLogPath();
    assert.ok(existsSync(logFile), 'the trip must be written to the audit log');
    assert.match(readFileSync(logFile, 'utf8'), /"tool":"Bash"/);
  });
});

test('CORRECTING the call earns a fresh budget', async () => {
  // The breaker must never excuse a DIFFERENT action just because a sibling was refused --
  // otherwise one contested call would blanket-disable enforcement for the rest of the turn.
  await withStateDir(async (stateDir) => {
    const checkers = [refusingChecker(stateDir, 'always-refuses', 'no')];
    for (let attempt = 0; attempt <= MAX_CALL_BLOCKS; attempt += 1) {
      await runPreToolUseArbiter(payloadFor({ command: 'the contested one' }), { checkers });
    }
    const corrected = await runPreToolUseArbiter(payloadFor({ command: 'a different call' }), { checkers });
    assert.equal(corrected?.decision, 'deny', 'a different call must still be judged on its merits');
  });
});

test('the refusal tells the assistant how much budget is left', async () => {
  const firstAttempt = formatVerdict([{ id: 'g', label: 'g', reason: 'no' }], { attempt: 1 });
  assert.match(firstAttempt, /fresh budget/);
  const lastAttempt = formatVerdict([{ id: 'g', label: 'g', reason: 'no' }], { attempt: MAX_CALL_BLOCKS });
  assert.match(lastAttempt, /ceiling|proceed/i);
});

// -- fail open ---------------------------------------------------------------

test('an unspawnable checker is silence, not a refusal', async () => {
  await withStateDir(async () => {
    const verdict = await runPreToolUseArbiter(payloadFor(), {
      checkers: [{ id: 'missing', label: 'missing', command: ['definitely-not-a-real-binary-xyz'] }],
    });
    assert.equal(verdict, null);
  });
});

test('a non-PreToolUse payload is ignored', async () => {
  await withStateDir(async (stateDir) => {
    const verdict = await runPreToolUseArbiter(
      { ...payloadFor(), hook_event_name: 'Stop' },
      { checkers: [refusingChecker(stateDir, 'loud', 'no')] },
    );
    assert.equal(verdict, null);
  });
});

test('the env escape waives the whole gate', async () => {
  await withStateDir(async (stateDir) => {
    process.env.PRETOOLUSE_ARBITER_OK = '1';
    try {
      const verdict = await runPreToolUseArbiter(payloadFor(), {
        checkers: [refusingChecker(stateDir, 'loud', 'no')],
      });
      assert.equal(verdict, null);
    } finally {
      delete process.env.PRETOOLUSE_ARBITER_OK;
    }
  });
});

test('counters are per-call, so two calls never share a budget', () => {
  withStateDir(() => {
    const firstCall = callKeyFor('turn-1', 'Bash', { command: 'a' });
    const secondCall = callKeyFor('turn-1', 'Bash', { command: 'b' });
    assert.notEqual(firstCall, secondCall);
    recordBlock(firstCall);
    assert.equal(callBlockCount(firstCall), 1);
    assert.equal(callBlockCount(secondCall), 0);
  });
});

test('collectFindings skips checkers whose matcher excludes this tool', async () => {
  await withStateDir(async (stateDir) => {
    const findings = await collectFindings(payloadFor(), [
      { ...refusingChecker(stateDir, 'edit-only', 'no'), matcher: 'Edit|Write' },
    ]);
    assert.deepEqual(findings, []);
  });
});
