import assert from 'node:assert/strict';
import { evaluate, resolveContent } from './pod-launch-durability-guard.mjs';

let passed = 0;
function test(name, assertion) { assertion(); passed++; console.log(`  ✓ ${name}`); }

const LAUNCHER_BARE = `
import sys
from runner.training import TrainingLifecycle
from runner.providers.runpod import RunPodTrainingProvider, RunPodLaunchSpec

def start_writer(work_dir):
    lifecycle = TrainingLifecycle(work_dir / "t.sqlite3")
    provider = RunPodTrainingProvider(api_key=key, launch_spec=RunPodLaunchSpec(cfg))
    resource = lifecycle.start_or_reconcile(identity, provider)
    return resource
`;

const LAUNCHER_WIRED = `
import sys
from runner.training import TrainingLifecycle, RescueWaiver
from runner.providers.runpod import RunPodTrainingProvider, RunPodLaunchSpec
from pod_liveness_watch import watch_pod

def start_writer(work_dir):
    lifecycle = TrainingLifecycle(work_dir / "t.sqlite3")
    provider = RunPodTrainingProvider(api_key=key, launch_spec=RunPodLaunchSpec(cfg))
    resource = lifecycle.start_or_reconcile(identity, provider)
    watch_pod(api_key=key, resource_id=resource.resource_id, pulse_label="exp-pod")
    lifecycle.publish_checkpoint(identity, step=100, transport=t, verifier=v)
    lifecycle.authorize_teardown(identity, rescue_waiver=RescueWaiver(reason="single final"))
    return resource
`;

test('blocks a bare launcher missing all three durability wirings', () => {
  const verdict = evaluate({ toolName: 'Write', filePath: 'scripts/run_train.py', content: LAUNCHER_BARE });
  assert.equal(verdict.block, true);
  assert.deepEqual(verdict.missing.sort(), ['eager-rescue', 'liveness-watch']);
});

test('passes a fully wired launcher', () => {
  const verdict = evaluate({ toolName: 'Write', filePath: 'scripts/run_train.py', content: LAUNCHER_WIRED });
  assert.equal(verdict.block, false);
});

test('flags a bare teardown call as not rescue-gated', () => {
  const almostWired = LAUNCHER_BARE
    .replace('def start_writer', 'from pod_liveness_watch import watch_pod\n\ndef start_writer')
    + '\n    lifecycle.publish_checkpoint(identity, step=1, transport=t, verifier=v)'
    + '\n    watch_pod(api_key=k, resource_id=r, pulse_label="p")'
    + '\n    lifecycle.authorize_teardown(identity)\n';
  const verdict = evaluate({ toolName: 'Write', filePath: 'scripts/run_train.py', content: almostWired });
  assert.equal(verdict.block, true);
  assert.deepEqual(verdict.missing, ['teardown-rescue-arg']);
});

test('ignores a file that does not launch a pod', () => {
  const worker = `
from runner.training import TrainingLifecycle
def train():
    lifecycle.publish_checkpoint(identity, step=1, transport=t, verifier=v)
`;
  assert.equal(evaluate({ toolName: 'Write', filePath: 'scripts/worker.py', content: worker }).block, false);
});

test("skips Runner's own library files (they DEFINE the machinery)", () => {
  const runnerFile = `
class RunPodTrainingProvider:
    def start_or_reconcile(self, identity, provider):
        return self._attach(identity)
`;
  assert.equal(evaluate({ toolName: 'Write', filePath: 'runner/runner/training.py', content: runnerFile }).block, false);
  assert.equal(evaluate({ toolName: 'Write', filePath: 'pod_liveness_watch.py', content: LAUNCHER_BARE }).block, false);
});

test('skips test files', () => {
  assert.equal(evaluate({ toolName: 'Write', filePath: 'scripts/test_run_train.py', content: LAUNCHER_BARE }).block, false);
});

test('honors the override token', () => {
  const shim = '# pod-durability-checked: thin relaunch shim\n' + LAUNCHER_BARE;
  assert.equal(evaluate({ toolName: 'Write', filePath: 'scripts/relaunch.py', content: shim }).block, false);
});

test('allows (does not fire on) a fully wired launcher — must not over-fire', () => {
  // The exact legitimate input the guard must never block: a real launcher that
  // DOES wire liveness + eager rescue + a rescue-gated teardown.
  const verdict = evaluate({ toolName: 'Write', filePath: 'scripts/run_train.py', content: LAUNCHER_WIRED });
  assert.equal(verdict.block, false);
  assert.equal(verdict.missing, undefined);
});

test('allows a monitoring helper that references watch_pod but launches nothing', () => {
  const monitor = `
from pod_liveness_watch import watch_pod
def monitor(resource_id):
    return watch_pod(api_key=k, resource_id=resource_id, pulse_label="p")
`;
  assert.equal(evaluate({ toolName: 'Write', filePath: 'scripts/monitor.py', content: monitor }).block, false);
});

test('fails open on missing input', () => {
  assert.equal(evaluate({ toolName: 'Write', filePath: '', content: '' }).block, false);
  assert.equal(evaluate({ toolName: 'Read', filePath: 'x.py', content: LAUNCHER_BARE }).block, false);
});

test('resolveContent reads the on-disk file for an Edit', () => {
  const combined = resolveContent({
    toolName: 'Edit',
    filePath: 'scripts/run_train.py',
    input: { new_string: '    resource = lifecycle.start_or_reconcile(identity, provider)' },
    readFileFn: () => 'from runner.providers.runpod import RunPodTrainingProvider\n',
    existsFn: () => true,
  });
  assert.ok(combined.includes('start_or_reconcile'));
  assert.ok(combined.includes('RunPodTrainingProvider'));
  const verdict = evaluate({ toolName: 'Edit', filePath: 'scripts/run_train.py', content: combined });
  assert.equal(verdict.block, true);
});

console.log(`\n${passed} tests passed`);
