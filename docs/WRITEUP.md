# How I made my coding agent enforce my engineering standards

*A short write-up of the thinking behind [Claude Discipline](../README.md). Adapt freely for a blog post, a LinkedIn post, or a cover letter.*

---

## The problem nobody admits about agentic coding

I use Claude Code daily. Like everyone, I started by writing a long `CLAUDE.md` — my rules, my conventions, my hard-won "never do this again" lessons. And like everyone, I watched the agent follow them about 80% of the time.

Eighty percent sounds fine until you see *which* 20% slips. It's never the easy stuff. It's the rule that's inconvenient *right now*: leaving a failing test because "it was already broken, unrelated to my change." Editing a 600-line file from memory and fighting three stale-match retries. Declaring a UI bug "fixed" because a DOM assertion passed — while the element was clipped to zero height and invisible to the actual user. Each one is a reasonable-sounding story the model tells itself at turn 200 that it would never have told at turn 2.

The instruction file is **advice**. Advice degrades under fatigue, length, and plausible rationalization. The fix the Claude Code community converged on is simple to say: **if something must happen every time, it can't be advice. It has to be a mechanism.**

## The mechanism: hooks that block

Claude Code runs *hooks* at lifecycle events — before a tool runs, after it runs, when the agent tries to end its turn. A hook is a small script that sees what's happening and can **refuse**. It runs in its own process, deterministically, whether or not the model "felt like" complying.

So I moved my non-negotiables out of advice and into deterministic gates:

- A test failed this session? A marker drops, and the agent **cannot end its turn** until a full suite comes back green. "Pre-existing failure" is no longer an available excuse.
- About to edit a big file I haven't read this session? **Blocked** until I read it — the stale-edit retry loop is gone.
- Claiming a visual bug is fixed while citing DOM evidence and no screenshot? **Blocked** — the agent has to actually look at pixels.
- About to `rm -rf /` or `cat` a `.env` into the transcript? **Blocked.**

Seventeen of these, tiered by how universal they are, each with a clear escape hatch for the genuine exception (a gate with no override just trains people to disable it).

## The part I'm actually proud of: memory that can't rot

Everyone describes keeping a `learnings.md`. Almost nobody *enforces* it, so it goes stale the first busy week.

I made it a closed loop:

1. The agent hits an error → a hook **surfaces the matching past lesson** from my learnings file automatically.
2. It drops a marker. Now the agent **can't edit code** until it has actually *read* that lesson.
3. If it diagnoses a real bug and fixes it but writes **no** new lesson, a Stop hook **blocks the turn** until the lesson is recorded.

The result is a flywheel: *mistake → the system forces the lesson to be written → the lesson is injected into the next session → the same mistake can't happen twice.* The knowledge base stays current because the gates won't let it drift. Over time, **the system becomes more reliable than I am**, because I forget and it doesn't.

A third layer — `HANDOFF.md`, kept fresh by its own gate — lets a fresh session (or a cheaper model) resume cold without re-deriving state from chat history.

## The moment that proved the thesis

While writing the documentation for the kit, one of my own hooks — the one that bans language about preserving legacy code paths — **blocked me for typing that phrase into the documentation explaining that exact hook.** The guardrail caught its own author describing the guardrail.

I laughed, then realized it was the whole argument in one screenshot. The system doesn't know I'm the one who built it. It doesn't extend me professional courtesy. It just enforces the rule. That's the entire point: **deterministic beats well-intentioned.**

## Why this is the interesting part of working with agents

The flashy demo is "the agent wrote the feature." The durable engineering problem is "how do I make an autonomous system reliably hold a standard over thousands of decisions, without me in the loop for each one?" That's not a prompting problem — it's a *systems* problem: deterministic gates, the marker pattern for rules that span events, fail-open design so a broken guardrail never takes down the tool, escape hatches calibrated so the gate is trusted instead of bypassed.

I packaged the whole thing — generic, installable, MIT-licensed — so anyone can drop it onto their own setup and encode *their* standards as gates instead of hoping the model remembers them. The opinions are mine; the mechanism is yours to reuse.

That's the skill I'd want a team to see: not "I can get an agent to write code," but "I can build the harness that makes an agent trustworthy."

---

*Repo: [claude-discipline](../README.md) — 17 hooks across three tiers, seven workflow skills, a non-destructive installer, and docs on how to write your own.*
