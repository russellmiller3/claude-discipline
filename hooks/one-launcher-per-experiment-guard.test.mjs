// Tests for one-launcher-per-experiment-guard: a runpod_exp<ID>.py must reference only
// its OWN experiment's workers. Run: node --test one-launcher-per-experiment-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foreignExperimentIds } from './one-launcher-per-experiment-guard.mjs';

test('THE INCIDENT: runpod_exp147.py referencing sibling workers is flagged', () => {
  const content = `
    if arm in ("tools",): return ("bash","-lc", f"python .../exp147c_qwen_tools.py ...")
    if arm in ("spawn",): return ("bash","-lc", f"python .../exp147d_qwen_spawn.py ...")
    if arm in ("memento",): return ("bash","-lc", f"python .../exp149_qwen_memento.py ...")
  `;
  const foreign = foreignExperimentIds('scripts/runpod_exp147.py', content).sort();
  assert.deepEqual(foreign, ['147c', '147d', '149']);
});

test('CLEAN: a per-exp launcher referencing only its OWN worker passes', () => {
  const content = `
    from runpod_experiment_launcher import build_qwen_finetune_command, run_experiment_cli
    CONFIG = ExperimentLaunchConfig(experiment_slug="exp147c", ...)
    def _cmd(*, seed, arm, steps):
        return build_qwen_finetune_command("exp147c_qwen_tools.py", experiment_slug="exp147c", ...)
  `;
  assert.deepEqual(foreignExperimentIds('scripts/runpod_exp147c.py', content), []);
});

test('EXEMPT: shared exp146 transport/image infra is not a foreign science worker', () => {
  const content = `
    from marcus_exp146_runpod_transport import bundle_from_source_snapshot
    from runpod_exp146 import EXP146_RUNPOD_IMAGE
    # references its own worker exp149_qwen_memento.py
    cmd = build_qwen_finetune_command("exp149_qwen_memento.py", ...)
  `;
  // exp146 is infra (exempt); exp149 is the file's own id -> clean.
  assert.deepEqual(foreignExperimentIds('scripts/runpod_exp149.py', content), []);
});

test('NON-LAUNCHER files (the shared template, workers) are never checked', () => {
  const content = `build_qwen_finetune_command("exp147c_qwen_tools.py") ... exp149_qwen_memento.py`;
  // the shared glue module is not named runpod_exp<ID>.py -> out of scope
  assert.deepEqual(foreignExperimentIds('scripts/runpod_experiment_launcher.py', content), []);
  // a worker file itself is out of scope
  assert.deepEqual(foreignExperimentIds('scripts/exp147c_qwen_tools.py', content), []);
});

test('ALLOWS (does not fire): the real runpod_exp147c.py content passes clean', () => {
  // The actual shape of the shipped per-exp launcher — imports the shared template, its own
  // worker, and references exp146 infra via the template (not directly). Must NOT be flagged.
  const realLauncher = `
    from runpod_experiment_launcher import ExperimentLaunchConfig, build_qwen_finetune_command, run_experiment_cli
    def _remote_command(*, seed, arm, steps):
        return build_qwen_finetune_command("exp147c_qwen_tools.py", experiment_slug="exp147c",
            seed=seed, steps=steps, extra_flags=("--tool-mode", "real"))
    CONFIG = ExperimentLaunchConfig(experiment_number=147, experiment_slug="exp147c",
        arms=("tools","tools-scrambled","tools-smoke"), remote_command_builder=_remote_command, ...)
  `;
  assert.deepEqual(foreignExperimentIds('scripts/runpod_exp147c.py', realLauncher), [],
    'a clean per-exp launcher must not be flagged');
});

test('letter-suffixed ids are distinct: exp147 != exp147c', () => {
  const content = `python .../exp147c_qwen_tools.py`;
  // a file named runpod_exp147.py (the base toy) referencing exp147c's worker IS foreign
  assert.deepEqual(foreignExperimentIds('runpod_exp147.py', content), ['147c']);
  // but exp147c's own launcher referencing exp147c is clean
  assert.deepEqual(foreignExperimentIds('runpod_exp147c.py', content), []);
});
