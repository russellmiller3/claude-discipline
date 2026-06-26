# Philosophy

Why this kit exists, and the handful of ideas that make it work.

## CLAUDE.md is advisory. Hooks are deterministic.

`CLAUDE.md` is the instruction file you give the agent. It's *advice* — and advice gets roughly 80% compliance. The agent follows it until a long session, a tired prompt, or a plausible-sounding rationalization pulls it off course. "This test was already failing, it's not related to my change" is exactly the kind of reasonable-sounding story that ends with a broken suite shipped.

The community already agrees on the fix: **if something must happen every single time, make it a hook.** Hooks run in a separate process, deterministically, whether or not the model "felt like it." They don't get tired, they don't rationalize, and they don't forget on turn 200 what they knew on turn 2.

So the division of labor is:

- **Philosophy and preferences → `CLAUDE.md`.** The stuff that's contextual, that wants judgment, that you're fine with 80% on.
- **Non-negotiables → hooks.** The handful of things where 80% isn't good enough because the 20% is expensive: a leaked secret, a red test shipped, a "fixed" UI bug that was never actually visible.

Don't put everything in hooks. A wall of gates that fire constantly is noise, and noise gets disabled. Reserve hooks for the rules that genuinely must hold every time.

## The three pillars

```
1. GUARDRAILS         2. MEMORY              3. CONTINUITY
   (deterministic)       (compounding)          (across runs)
   block the wrong       force the lesson       carry state to
   move before it        to be written, then    the next session
   lands                 inject it next time     (HANDOFF.md)
            └──────────── the loop ────────────┘
   mistake → hook forces a learning → injected next session →
            the same mistake can't happen twice
```

**Guardrails** are PreToolUse/Stop hooks that *block* when a rule is about to break. **Memory** is a plain `learnings.md`, organized by topic — but with teeth: a hook surfaces the matching lesson when a relevant error appears, another *blocks* code edits until you've read it, another *blocks* the turn if you fixed a real bug and wrote no lesson. **Continuity** is `HANDOFF.md`, kept fresh by a hook that nags when it goes stale.

The result is a feedback loop. The agent makes a mistake → a hook forces the lesson into `learnings.md` → that lesson is injected into the next session → the mistake doesn't recur. **The system gets more trustworthy than the operator**, because the operator forgets and the system doesn't.

## Block, don't nag

There are two ways a hook can react: inject a reminder (the agent *can* ignore it) or return a block (the agent *cannot* proceed). Injection is for context — "here's a lesson that might help." Blocking is for non-negotiables.

The danger is over-blocking. A gate that fires on false positives, or on rules that don't really matter, trains everyone — human and model — to reach for the override reflexively. Once the override is muscle memory, the gate is decoration. So: **block only true non-negotiables, and always give a clear path out.** Every block in this kit tells you exactly how to satisfy it and offers a one-time override for the genuine exception.

## When to make something a hook

Ask three questions:

1. **Must this hold *every* time?** If 80% is fine, leave it in `CLAUDE.md`. If the 20% is expensive, it's a hook candidate.
2. **Can a deterministic check detect it?** Hooks see tool inputs, tool outputs, and the transcript. If the rule is "did a test fail," "is this an `.env` file," "did the reply cite a screenshot" — detectable. If it's "is this code elegant" — not.
3. **Is the failure cheap to catch here and expensive to catch later?** A leaked secret, a deleted database, a "fixed" bug that wasn't — these are catastrophic late and trivial to gate early. Those are the best hooks.

If a mistake costs you real time twice, that's the bar: turn it into a rule, and if it's detectable, into a hook.

## Encode *your* opinions, not mine

Tier 3 hooks (`no-backcompat`, `root-cause-first`, `decay-footer`) encode specific engineering taste. You may disagree with some — that's the point working as intended. The value isn't that you adopt these opinions; it's the *mechanism*: turning a standard you care about into a deterministic gate instead of hoping the model remembers it. Fork the hook, change the rule, keep the pattern. A hook you wrote for the bug that bit *you* is worth ten you inherited.

## Fail open, always

Every hook in this kit wraps its logic so that any unexpected error exits cleanly and lets the action proceed. A hook that crashes must never wedge Claude Code — a guardrail that takes down the whole agent is worse than no guardrail. Protection is best-effort by design; correctness of the *tool* comes first.
