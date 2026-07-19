#!/usr/bin/env node
/**
 * smoke-script-bounds-guard — PreToolUse(Write) HARD BLOCK on an unbounded "smoke" script.
 *
 * Russell, 2026-07-15: a smoke script set `MAX_EPOCHS = 2` believing "2" was obviously small.
 * It was not — in that codebase one epoch means one full pass over a 50,000-row split, so the
 * "smoke" ran for 20+ minutes before it was killed. The number in the code was never the
 * problem; the codebase's own semantics of "epoch"/"step"/"row" were, and no purely syntactic
 * check can prove that KIND of smallness without deep, per-project knowledge.
 *
 * What this hook CAN enforce instead: any file whose name signals "smoke" (a quick, cheap probe)
 * must contain POSITIVE, explicit evidence that its own unit-of-work count is bounded to a small
 * literal — a slice on the actual data/batch collection (`[:2]`, `data[:5]`), a monkeypatch that
 * visibly caps iteration, or an explicit wall-clock self-guard (timeout/deadline). Deliberately
 * does NOT trust a named counter or CLI flag (`--steps`, `--max-epochs`, `max_epochs=1`) as
 * evidence — "steps"/"epochs" are exactly the abstractions that fooled the author in the
 * motivating incident, since their real size depends on the target codebase and can't be known
 * from syntax alone. Only a literal slice on the real iterable, or a real-time guard, counts.
 *
 * What it ALLOWS: any smoke file that shows a bounded-count pattern, any file whose name doesn't
 * match /smoke/i, any non-code extension. Deliberately narrow and high-signal by design — it
 * looks for evidence FOR smallness, not against it, so it can't be fooled by an absent bad sign.
 *
 * ALSO EXEMPT (Russell, 2026-07-16): a plain DOM / browser / unit test that merely happens to be
 * named like "smoke.mjs" — e.g. a jsdom test that loads an HTML file and asserts DOM/localStorage
 * over a handful of fixed cases. Such a file has no training/eval loop and no large iterable, so
 * "prove a small bound" is meaningless for it. Recognised by an import of jsdom, @testing-library,
 * vitest, node:test, or (node:)assert. The teeth stay: the exemption is REFUSED if the same file
 * also references training/eval vocabulary (train/epoch/dataset/batch/model iteration), so a real
 * training smoke script that happens to `import assert` still has to prove its bound.
 *
 * Override (rare — a smoke script that is genuinely bounded some other way, e.g. wall-clock
 * self-timeout): set SMOKE_BOUNDS_GUARD_OVERRIDE=1 in env.
 * Fail-open on any internal error — never brick a legitimate Write.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE_NAME = /smoke/i;
const CODE_EXTENSION = /\.(?:py|mjs|cjs|js|ts|sh|ps1)$/i;

// Evidence FOR an explicit small bound: ONLY a literal slice on the real data/batch collection
// counts, checked against a generous ceiling (<=20) - large enough for a real tiny probe, small
// enough to catch "I typed a small-looking number that actually means the whole dataset." A named
// counter or flag (--steps, max_epochs=N) is deliberately NOT trusted - see file header.
const BOUND_PATTERNS = [
	/\[\s*:\s*([0-9]{1,3})\s*\]/g, // a slice: rows[:2], batches[:20]
];
const BOUND_CEILING = 20;
// Evidence of an explicit override/monkeypatch that visibly caps iteration, independent of a
// literal number (e.g. slicing a returned collection down inline).
const MONKEYPATCH_CAP = /=\s*lambda[^\n]*\[\s*:\s*[0-9]{1,3}\s*\]/i;
const WALLCLOCK_SELFGUARD = /\b(?:timeout|deadline|max_seconds|time\.monotonic\(\)\s*-|elapsed\s*[<>])\b/i;

// A DOM / browser / unit test imports one of these — jsdom, @testing-library/*, vitest, node:test,
// or (node:)assert. Matched only in an import/require position so a stray "assert" string elsewhere
// doesn't trip it. Presence of any of these marks the file as a unit test, not a training probe.
const UNIT_TEST_MODULE = /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s+)['"](?:jsdom|@testing-library\/[\w.-]+|vitest|node:test|node:assert(?:\/strict)?|assert)['"]/i;
// ML training / eval vocabulary. If a smoke file names any of these it is NOT a plain DOM/unit test
// and keeps the guard's teeth even if it also imports assert — a real training smoke that uses
// node:assert must still prove its bound. `model.<method>` catches "model iteration" without
// flagging a bare `model` variable common in web code.
const TRAINING_SIGNAL = /\b(?:train(?:ing|er|s)?|epochs?|datasets?|dataloaders?|batch(?:es)?|minibatch|fine[-_]?tun\w*|eval(?:uate|uation|s)?|checkpoint\w*|gradients?|optimi[sz]ers?|backprop\w*|backward|max_epochs|max_steps|num_steps|steps_per_epoch|n_epochs)\b|\bmodel\s*\.\s*\w+/i;

// True when the file is clearly a DOM/browser/unit test (imports a unit-test module) and shows NO
// training/eval vocabulary — the case where "prove a small bound" is meaningless and the guard
// must step aside. False for a training smoke script even if it imports assert.
export function isUnitOrDomTest(scriptContent) {
	const source = String(scriptContent || '');
	if (!UNIT_TEST_MODULE.test(source)) return false;
	if (TRAINING_SIGNAL.test(source)) return false;
	return true;
}

export function hasExplicitSmallBound(scriptContent) {
	const source = String(scriptContent || '');
	for (const pattern of BOUND_PATTERNS) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(source)) !== null) {
			const boundValue = Number(match[1]);
			if (Number.isFinite(boundValue) && boundValue >= 1 && boundValue <= BOUND_CEILING) return true;
		}
	}
	if (MONKEYPATCH_CAP.test(source)) return true;
	if (WALLCLOCK_SELFGUARD.test(source)) return true;
	return false;
}

export function isSmokeScript(filePath) {
	const fileName = basename(String(filePath || ''));
	return SMOKE_NAME.test(fileName) && CODE_EXTENSION.test(fileName);
}

// A pytest unit-test file (basename `test_*.py`) is bounded by pytest's own collection and is typically a
// static-assert test with no training loop to bound — it tripped the guard only because a module it tests
// carries "smoke" in its name (`test_exp147b_mask_smoke.py`). Pytest owns these; step aside. A real smoke
// TRAINING script is named `*_smoke.py` / `smoke_*.py`, never `test_*.py`, so the guard keeps its teeth on
// those. (2026-07-19)
export function isPytestUnitTest(filePath) {
	return /^test_.*\.py$/i.test(basename(String(filePath || '')));
}

function main() {
	if (process.env.SMOKE_BOUNDS_GUARD_OVERRIDE === '1') process.exit(0);
	let event;
	try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
	if ((event.hook_event_name || event.hookEventName) !== 'PreToolUse') process.exit(0);
	if ((event.tool_name || '') !== 'Write') process.exit(0);

	const filePath = event.tool_input?.file_path || '';
	if (!isSmokeScript(filePath)) process.exit(0);
	// A pytest test file has no smoke *script* semantics — pytest bounds it. Step aside.
	if (isPytestUnitTest(filePath)) process.exit(0);

	const scriptContent = event.tool_input?.content || '';
	// A plain DOM/browser/unit test named like "smoke" has no bound to prove — step aside (unless it
	// also talks training/eval, in which case keep the teeth). Fail-open on any error.
	try { if (isUnitOrDomTest(scriptContent)) process.exit(0); } catch { process.exit(0); }
	let bounded;
	try { bounded = hasExplicitSmallBound(scriptContent); } catch { process.exit(0); } // fail-open
	if (bounded) process.exit(0);

	const reason = `SMOKE SCRIPT HAS NO VISIBLE SMALL BOUND — ${basename(filePath)}

A file named like a "smoke" test must PROVE it is actually small in the file itself — a literal
slice on the real data/batch collection bounded to <=${BOUND_CEILING} (rows[:2], batches[:5]), a
monkeypatch that visibly caps iteration, or an explicit wall-clock self-guard (timeout/deadline).

A named counter like max_epochs=2 or --steps 2 does NOT count as evidence, even though it looks
small. Why: "2 epochs" or "1 pass" can silently mean a full multi-thousand-row dataset — the
target codebase decides what "epoch" means, not your code. (Real incident, 2026-07-15: a smoke
script set MAX_EPOCHS = 2 believing it was tiny; each "epoch" was a full 50,000-row pass and the
"smoke" ran 20+ minutes before being killed.)

Fix: bound the actual iterable your training/eval loop consumes — slice a batch list (rows[:2]),
or monkeypatch the batch-count function down — don't trust a named counter for an abstraction
(epoch/run/cycle) whose real size you haven't verified in THIS codebase.

Override (rare - a smoke script bounded some other way, e.g. a wall-clock self-timeout that this
scan didn't recognize): set SMOKE_BOUNDS_GUARD_OVERRIDE=1 in env.`;

	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason,
		},
	}));
	process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
