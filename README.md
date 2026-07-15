# Claude Discipline

**An operating system for your coding agent — guardrails that *can't* be skipped and memory that *can't* rot.**

---

## The 60-second pitch

`CLAUDE.md` is advice. Advice gets ~80% compliance — the agent follows it until a long session, a tired prompt, or a plausible rationalization pulls it off course. The fix the community already agrees on: **if something must happen every time, make it a hook.** Hooks are deterministic. They run whether or not the model "felt like it."

Most published hook collections stop at *safety* (block `rm -rf`, protect secrets) and *logging*. This one goes further in two directions:

1. **Guardrails that enforce engineering judgment**, not just safety — TDD-before-code, no silent legacy fallbacks, "pixels are the only proof for a UI bug," fix-the-root-cause, no failing test survives a turn.
2. **Memory that compounds and can't rot.** Everyone describes a `learnings.md`. Nobody *enforces* it. Here, a Stop hook **blocks** when you fixed a real bug and didn't write the lesson down. Another blocks when you changed a hook and didn't document it. Another blocks when the session state (`HANDOFF.md`) goes stale. The knowledge base stays current because the gates won't let it drift.

The result is a feedback loop: the agent makes a mistake → a hook forces the lesson into `learnings.md` → that lesson is injected into the next session → the mistake doesn't recur. **The system gets more trustworthy than the operator.**

---

## How it works (the three pillars)

```
┌─────────────────────────────────────────────────────────────┐
│  1. GUARDRAILS            2. MEMORY              3. CONTINUITY │
│  (deterministic)          (compounding)          (across runs) │
│                                                                │
│  PreToolUse / Stop        learnings.md           HANDOFF.md    │
│  block the wrong move     (durable lessons)      (session      │
│  before it lands          + Stop hooks that      state, auto-  │
│                           FORCE you to write      surfaced on  │
│                           the lesson              next start)  │
│                                                                │
│            └──────── the loop ────────┘                        │
│   mistake → hook forces a learning → injected next session →   │
│            same mistake can't happen twice                     │
└─────────────────────────────────────────────────────────────┘
```

- **Guardrails** are `PreToolUse` and `Stop` hooks that *block* (exit non-zero / `decision: "block"`) when a rule is about to be broken. Each one encodes a specific, hard-won engineering opinion.
- **Memory** is a plain `learnings.md`, organized by topic. A `SessionStart` hook injects its table of contents every session; a `PostToolUse` hook surfaces the matching lesson the moment a relevant error appears; a `Stop` hook blocks if you fixed something and didn't log it.
- **Continuity** is `HANDOFF.md` — the working-memory snapshot that lets a fresh session (or a cheaper model) resume without re-deriving state. A `Stop` hook nags when it goes stale.

Why hooks instead of just a longer `CLAUDE.md`? Because **`CLAUDE.md` is advisory (~80%) and hooks are deterministic (100%).** Put the *philosophy* in `CLAUDE.md`; put the *non-negotiables* in hooks.

---

## Install (5 minutes)

**Requirements:** Node 18+ (hooks are dependency-free `.mjs` — no `npm install`, no build step), Claude Code, git.

```bash
git clone https://github.com/<you>/claude-discipline ~/claude-discipline
cd ~/claude-discipline
node scripts/install.mjs            # interactive: pick which hooks to enable
```

The installer:
1. Copies the hooks you select into `~/.claude/hooks/`.
2. Merges their registrations into `~/.claude/settings.json` (it *merges* — it won't clobber hooks you already have).
3. Drops the starter `CLAUDE.md`, `learnings.md`, and `HANDOFF.md` templates where you choose (global `~/.claude/` or a project root).
4. Prints exactly what it changed.

Add `--skills` to also install the workflow skills (`write-plan`, `red-team-plan`, `red-team-code`, `pres`, `ship`, `docs-cascade`, `handoff`) into `~/.claude/skills/`.

**Dry run first** (recommended): `node scripts/install.mjs --dry-run` shows every change without writing anything.

To uninstall a hook: `node scripts/install.mjs --remove <hook-name>` (removes the file + its settings.json entry).

---

## What's in the box

Hooks are **tiered by how portable they are** — pick your comfort level. This kit ships **~40 hooks across three tiers** — a curated, portable slice of a larger personal set (~100 hooks in daily use); the rest are project-specific and stay out of the public kit. Full per-hook reference: [`docs/HOOKBOOK.md`](docs/HOOKBOOK.md).

### Tier 1 — Standalone (work anywhere, zero config)
| Hook | Event | What it enforces |
|------|-------|------------------|
| `block-dangerous-commands` | PreToolUse(Bash) | Refuses `rm -rf /`, fork bombs, disk-wipes, etc. |
| `protect-secrets` | PreToolUse | Blocks reads/writes of `.env`, key files, credential stores |
| `no-commit-to-main` | PreToolUse(Bash) | Blocks direct commits to `main`/`master` — branch first. Auto-allows a commit when every staged file is doc-only (`.md`/`.markdown`/`.mdx`/`.txt`/`.rst`), including files staged by a chained `git add ... && git commit` in the same command — an ambiguous pathspec (`-A`, `.`, `-u`) still fails closed and blocks. Also denies a `COMMIT_MAIN_OVERRIDE=1` commit to main when another worktree is currently `locked` (a background agent may be mid-landing) — see HOOKBOOK for the incident that motivated this |
| `read-before-write` | PreToolUse(Edit) | Blocks editing a file you haven't read this session |
| `pixels-only-proof` | Stop | On a visual/"not rendering" task, blocks "fixed" claims that cite DOM/`toBeVisible` instead of a screenshot |
| `tests-must-pass` | PostToolUse+Stop | Any failing test (incl. "pre-existing") blocks stop until a full green run |
| `name-by-use` | PreToolUse(Write/Edit) | Blocks type-named identifiers (`data`, `result`, `tmp`) — name by role |
| `filename-quality-guard` | PreToolUse(Write) | Blocks low-quality file *names* — typos one edit from a real word (`findigns`→`findings`), lazy/scratch stems (`tmp`, `output2`, `untitled`), dropped-vowel tokens. Allowlists conventional caps files, dotfiles, tech acronyms — only close misspellings block. Override: `FILENAME_GUARD_OVERRIDE=1` |
| `coverage-claim-guard` | Stop | Blocks "tested everything / every X" claims that don't state the real scope (a count, or what's uncovered) |
| `look-before-asking` | Stop | Blocks asking the user for a discoverable fact (a path/key/env var) when the turn ran zero searches/reads |
| `agent-autocommit` | PostToolUse(Write/Edit) | Auto-commits WIP inside a linked git worktree after every edit — a dying agent loses ≤1 edit |
| `hook-must-enforce` | PreToolUse(Write/Edit) | Meta-guard: blocks writing a "guardrail" hook that only advises (no deny/exit-2/side-effect — no teeth) |
| `no-write-to-main` | PreToolUse(Bash) | Closes the shell-bypass gap in `no-commit-to-main`: blocks `cp`/`mv`/redirect/`tee` of code into the repo while on `main` (docs + non-repo paths allowed) |
| `delete-merged-branches` | PostToolUse(Bash) | After a merge/push to `main`, auto-deletes local branches whose commits are fully reachable from `main` (current/worktree/protected branches kept) |
| `no-junk-files` | Stop | Blocks stop while throwaway/scratch files (`tmp-*`, `probe-*`, `scan-*`, stray `COMMIT_*.txt`) linger in the repo |
| `never-idle` | Stop | Blocks stop while background work (async agents, background Bash) is still running — salvage it, don't abandon it |
| `compass-line-guard` | Stop | Blocks stop when the reply doesn't OPEN with a plain-English "Mission / this step / why" line — advisory versions of this get compressed out under context pressure, so this one enforces it. Widened 2026-07-03 to fire on every reply, chat-only turns included (no more exemption) |
| `husky-on-new-projects` | SessionStart | Nudges husky setup when a Node+git project has no git hooks (so there's a real commit-time test gate) |
| `rebuild-after-commit` | Stop | Edited buildable source but `dist/` is stale (by content hash)? Blocks until you rebuild — the running artifact is the build, not the commit. Ships `lib/buildFingerprint.mjs` |
| `stamp-build-fingerprint` | PostToolUse(Bash) | On a successful build, records a content fingerprint of the source it built from, so freshness checks compare by hash, not mtime (companion to `rebuild-after-commit`) |
| `delete-audit-guard` | PreToolUse(Bash/PowerShell) | Blocks `rm`/`del`/`Remove-Item`/`mv`/`git rm`/`git clean <path>`/`git checkout -- <path>`/`git restore <path>` on a file that exists, wasn't created/edited by the assistant this session, and isn't an obvious scratch artifact — built after the assistant deleted a user's intentional manual rename of a load-bearing doc, mistaking it for a stray duplicate. Same-day fix: a background subprocess's run-output files (never seen as a Write/Edit tool call) were false-blocked on a later `mv`; mtime-after-session-start is now checked independently of transcript coverage, not only when the transcript is fully missing. Override: `USER_DELETE_OK` token or `DELETE_AUDIT_OVERRIDE=1` |
| `phantom-delete-commit-guard` | PreToolUse(Bash/PowerShell) | Blocks `git commit` from a PRIMARY checkout whose working tree went stale under a moved ref — sibling-agent landings then show as phantom DELETIONS or stale MODIFICATIONS, and committing them silently reverts the landed work (bit 4x in one night). Blocks when any in-play path (deletions always; modifications staged, or unstaged with `-a`) was never created/edited by this session per the transcript; names the phantom paths and the `git checkout HEAD -- <paths>` fix. Skips linked worktrees under `.claude/worktrees/`. Override: `PHANTOM_DELETE_OK` token or `PHANTOM_DELETE_OK=1` |

*2026-07-03 fix: `filename-quality-guard` was wrongly blocking "audit" as a one-edit misspelling
of "audio" (e.g. `delete-audit-guard.mjs`). `audit`/`audits`/`auditing`/`auditor` are now in its
known-words list; regression test added.*

### Tier 2 — Needs the companion files (the memory system)
| Hook | Event | What it enforces |
|------|-------|------------------|
| `learnings-toc-inject` | SessionStart | Injects the `learnings.md` table of contents so the agent scans it before working |
| `learnings-error-match` | PostToolUse | When an error appears, surfaces the matching past lesson — *and drops a marker* |
| `require-learnings-ack` | PreToolUse(Edit) | Blocks code edits until you've actually read the surfaced lesson |
| `learnings-write-nudge` | PostToolUse+Stop | Blocks stop when you fixed a real bug but wrote no learning |
| `getty-no-repeat-mistakes` | UserPromptSubmit+Stop | On a correction, requires a learning; on a REPEAT correction, a learning already failed — requires asking to build a hook instead |
| `handoff-continuity` | SessionStart+UserPromptSubmit+Stop | Fires every ~5 turns (and on compaction/"handoff"); blocks stop until `HANDOFF.md` is re-pruned whole-file, not just appended |
| `new-repo-scaffold` | PostToolUse(Bash) | On `git init`, writes a README (North Star / user-stories / roadmap / GTM), `HANDOFF.md`, `learnings.md` + a commit-gate config; never overwrites |

### Tier 3 — Opinionated (great defaults; some teams will disagree — that's fine, toggle them off)
| Hook | Event | What it enforces |
|------|-------|------------------|
| `no-backcompat` | PreToolUse(Write/Edit)+Stop | Pre-1.0 projects: replace old code outright; no fallback shims kept alive "just in case". Fires only on code-adjacent evidence (fenced code, API/syntax vocabulary, code punctuation) near the trigger word — a markdown doc's unrelated "deprecated" prose (e.g. a UI color palette note) no longer false-fires (fixed 2026-07-02, see HOOKBOOK) |
| `root-cause-first` | PostToolUse | After repeated same-symptom fixes, forces a state-probe before the next swing |
| `jargon-gloss-guard` | Stop | Blocks a reply whose first use of jargon has no plain-English gloss nearby — fires on explaining turns AND on any substantial (>=40 word) explanation even when the turn also edited code; wide ML/logic word list (argmax, gradient, overfit, generalize, ...) |
| `decay-footer` | Stop | Code-changing turns must end with a "files touched / smells introduced" footer |
| `hookbook-sync` | Stop | Change a hook → blocks until `HOOKBOOK.md` documents it (and the count matches) |
| `discipline-sync` | Stop | The sibling of `hookbook-sync` for this published kit. A hook change must complete the full publish loop before the turn ends: the kit copy matches the live `~/.claude/hooks/` source, the kit's **README/docs are updated**, both repos are committed, and the kit is **pushed to GitHub** — the hook auto-pushes it (kit repo only) and only blocks if commits remain unpushed. So a shipped guard never drifts from the version that runs, and "published" means actually on GitHub, not just committed locally. Override: `DISCIPLINE_NO_PUSH=1` (gate without push) or `DISCIPLINE_SYNC_OVERRIDE=1` |
| `never-stop-asking` | Stop | Bias to action: blocks asking-permission phrasing and satisfaction-stops (winding down with work left). Opinionated extras (orientation beat, priority queue) are opt-in via env |
| `recommend-when-listing` | Stop | When the reply lists options but picks none, blocks until you lead with a recommendation. Quiet in survey/"what do you think" mode |
| `file-size-guard` | PostToolUse(Write) | Warns (never blocks) when a written file exceeds size limits — too many lines, an over-long function, too many switch arms. Thresholds env-configurable |
| `e2e-or-its-theatre` | Stop | "Unit tests without e2e are theatre." When you edit a source module that crosses a REAL boundary (WASM / network / DB / Worker / DOM) and its only tests MOCK that boundary with no real e2e, blocks until you add one. Pure-logic modules exempt. The `e2e-owed-live-gate: <why>` override is **not a free pass** — it records the deferral in a durable ledger (`owed-live-gate-reminder` then nags until you run it); `e2e-skip: <why>` is a true pass for a misjudged no-boundary change. |
| `owed-live-gate-reminder` | UserPromptSubmit | The teeth behind the override above: surfaces every OWED live e2e (module, age, "run it green to clear") on **every turn** until the real live test actually passes. Non-blocking by design — it never blocks a commit (don't lose work), it just won't let you forget. A green live run clears the gate automatically. |
| `ross-perot-guard` | Stop | "Lead, don't ask." Blocks a turn that ends by soliciting the user's input — a trailing question, or a hand-off closer like "your call" / "say the word" — instead of deciding and acting. Survey/"what do you think" mode and an explicit override are exempt. |
| `parallel-when-possible` | SessionStart+Stop | Up front: decompose the task and fan independent units out to concurrent subagents. Backstops a long serial grind (many edits across many files with zero subagents spawned). |
| `bench-pattern-guard` | PreToolUse(Write) | Blocks writing a benchmark/eval/sweep runner that isn't parallel + event-emitting + durable/resumable — no serial for-loop benches that can't stream progress or resume. |
| `agent-monitor-cadence` | Stop | Forces the orchestrator to actually watch its background agents — blocks stop while a spawned agent sits idle/unattended past a threshold, so you salvage its committed work instead of forgetting it. |
| `clean-merged-worktrees` | Stop | Auto-removes spent agent git worktrees whose branch has already merged — keeps the working tree clean with no manual cleanup. |
| `no-bullshit-tests` | PreToolUse(Write/Edit) | Blocks test files whose only assertions are tautologies (`assert(true)`, `x === x`) or a lone "is a function" smoke check — assert real behavior |
| `docs-on-feature-commit` | PostToolUse(Bash)+Stop | Blocks stop when the turn committed code but moved no docs (README/docs/CHANGELOG) — unless it's a docs commit. **Override:** `docs-skip: <why>` (or the word `docs` in the commit) |
| `hook-dry-review` | PreToolUse(Write/Edit/MultiEdit) | Editing or creating a hook forces a DRY review: blocks a hook write that hand-rolls a helper already in the shared `lib/transcript.mjs` (transcript parsing) instead of importing it — so ~20 copy-pasted copies can't grow back. **Override:** `dry-reviewed: <why>` or `HOOK_DRY_OVERRIDE=1` |
| `hook-negative-case-required` | Stop | Meta-guard: a guard hook changed this session must ship a `*.test.mjs` with a must-allow (negative) case — a deny-only test can't catch a false-fire. **Override:** `hook-negative-case-waived: <why>` |
| `self-verify-before-asking` | Stop | "Test it yourself." In builder mode (you wrote/built something this turn), blocks a reply that asks the human to test/verify when a CLI run, unit test, or smoke run was right there — unless you name a genuine environment/hardware/visual reason. **Override:** name the real reason, or `self-verify-override: <why>` |
| `pres-cycle-guard` | PreToolUse(Write/Edit/MultiEdit + Bash/PowerShell) | Enforces a project's opted-in `/pres` rules (its `AGENTS.md` mentions reviewing the research before planning). Blocks writing a `plans/*.md` with no `## Research notes` section citing a primary source (URL / author-year / named source doc). Blocks a training/sweep launch (`modal_gate1.py`, `gate1.py --single`, `diag_*.py`, `seed_distribution.py`, or a keyword fallback — the runner token can't be the `py` tail of a `.py` filename, so read-only commands over `.py` files never count) unless a RECENT plan in `plans/` (among the 5 newest by mtime, modified within the last 14 days) has BOTH a Research notes section AND a `red-teamed: YYYY-MM-DD` stamp (only the `red-team-plan` skill writes that stamp; the recent-plans rule replaced the single-newest-plan gate 2026-07-04 so a sibling agent's unstamped newer plan can't block a stamped plan's launch). Silent no-op in any repo that hasn't opted in. **Override:** `PRES_CYCLE_OK`; a `--steps N` smoke test with N<=100 always passes. |

> **Opinions are configurable.** Tier 3 encodes *my* engineering taste. The point isn't that you adopt my opinions — it's that you encode *yours* as deterministic gates instead of hoping the model remembers them. Fork the hook, change the rule, keep the mechanism.

---

## Skills (the workflows on top)

Hooks enforce; **skills are the workflows** — the *right way* to do the recurring things, available on demand. The hooks make sure you can't do the wrong thing; the skills make the right thing one command away. They're optional (`node scripts/install.mjs --skills`), and they compose into one loop:

```
  idea ─▶ write-plan ─▶ red-team-plan ─▶ execute ─▶ red-team-code ─▶ ship
                                                                       │
                              docs-cascade ◀───────────────────────────┘
   (handoff at any boundary — pass full context to the next session)
```

| Skill | What it does |
|-------|--------------|
| `pres` | The orchestrator: **P**lan → **R**ed-team → **E**xecute → **S**hip in one run, no manual handoffs |
| `write-plan` | A phased TDD plan with the **hardest phase first**; incremental writes you can steer mid-draft |
| `red-team-plan` | Attacks a plan before coding — edge cases, race conditions, spec contradictions — and *fixes* them, copy-paste ready |
| `red-team-code` | Attacks code that already compiles — security, concurrency, contracts, dead code — and fixes findings directly |
| `ship` | Doc gate → test gate → data-at-risk gate → commit → merge → push, with a plain-English wrap-up |
| `docs-cascade` | After a feature, sync every doc surface (config-driven to your project's set) so it's visible to users and to AI |
| `handoff` | Write `HANDOFF.md` action-first so a fresh (often cheaper) session resumes cold without re-deriving state |

> **Skills are generic by design.** They carry the *method* (hardest-phase-first planning, fix-don't-suggest red-teaming, action-first handoffs) with the project-specifics stripped out. Point `docs-cascade` at your doc surfaces, set `ROOT_CAUSE_FILES` for your pipeline, and they fit any repo.

Full per-skill reference — how to invoke each, its method, and how they compose: [`docs/SKILLBOOK.md`](docs/SKILLBOOK.md).

---

## The patterns worth stealing (even if you take nothing else)

1. **Block, don't nag.** A `Stop` hook that returns `{"decision":"block","reason":"..."}` *cannot* be ignored. An injected reminder can. Reserve blocks for true non-negotiables so they don't become noise.
2. **The marker pattern.** A `PostToolUse` hook drops a small JSON marker (`.claude/state/*.json`) when a condition is detected; a `Stop` hook blocks while the marker exists; some later action clears it. This is how you enforce a rule that *spans* events (e.g. "a test failed earlier → can't stop until it's green").
3. **Always give a clear-path.** Every blocking hook tells you *exactly* how to satisfy it (and offers a dismiss token for genuine exceptions). A gate with no escape hatch trains people to disable it.
4. **Enforce the human where judgment is needed; automate only the mechanical.** `hookbook-sync` *forces you* to write the hook's description (judgment) but *auto-checks* the hook count (mechanical). Don't auto-generate prose; do auto-verify facts.
5. **Self-policing meta-hooks.** The system documents and counts itself, and stays DRY: `hookbook-sync` blocks an undocumented hook, `discipline-sync` blocks a drifted kit copy, and `hook-dry-review` blocks a hook that re-implements a shared helper instead of importing it. The guardrails guard the guardrails.
6. **Pattern hooks false-fire on their own subject.** A hook that greps for a banned word will trip when you *document* that word. Give every blocking hook a dismiss token, and keep the trigger as specific as you can.

---

## Pair it with git hooks (the second gate)

These are **Claude Code hooks** — they gate *the agent, in real time*: before a tool runs, after it runs, when it tries to stop. That catches the agent in the act. But an agent hook only fires when the agent is driving, and it can be overridden mid-session.

So pair them with **git hooks** — I use [Husky](https://typicode.github.io/husky/). Git hooks gate the *commit and push boundary* for **everything that reaches the repo** — the agent, you by hand, another tool, a teammate. Same standards, enforced at a second gate that nothing slips past.

The two layers are complementary, not redundant:

| | Claude Code hooks | Git hooks (Husky) |
|---|---|---|
| **Fires** | While the agent works (tool calls, stop) | At `git commit` / `git push` |
| **Catches** | The agent, in the act | Anything that reaches the repo |
| **Overridable** | Yes, mid-session (by design) | No — the backstop that actually ships |

Put your fast, deterministic checks in a Husky `pre-commit` (lint, typecheck, secret scan) and the slower ones in `pre-push` (full test suite). Several guardrails here have a natural git-hook twin — `tests-must-pass` → tests green in `pre-push`; `protect-secrets` → a secret scan in `pre-commit`; `no-commit-to-main` → a branch check in `pre-commit`. Agent-time enforcement keeps the session honest; commit-time enforcement keeps `main` honest.

> This kit stays dependency-free (clone and go, no `npm install`). Husky lives in *your* project, not here — wire the same standards into both gates.

---

## Repo layout

```
claude-discipline/
├── README.md                ← you are here (the how-to)
├── docs/
│   ├── HOOKBOOK.md           ← per-hook reference: trigger, behavior, clear-path
│   ├── SKILLBOOK.md          ← per-skill reference: how to invoke, method, how they compose
│   ├── PHILOSOPHY.md         ← why deterministic > advisory; when to make a hook
│   └── WRITING-HOOKS.md      ← anatomy of a hook + the marker pattern, to write your own
├── hooks/                    ← dependency-free .mjs hooks, one file each
├── skills/                   ← optional workflows (one dir per skill, each a SKILL.md)
├── templates/
│   ├── CLAUDE.md             ← starter rules file (philosophy lives here)
│   ├── learnings.md          ← starter memory file (topic-organized, with TOC)
│   └── HANDOFF.md            ← starter session-state file
├── scripts/
│   ├── install.mjs           ← copy hooks + merge settings.json + drop templates
│   └── safe-merge-to-main.sh ← the safe way a background agent lands work onto main
│                                (locked compare-and-swap update-ref — see HOOKBOOK's
│                                 unsafe-main-ref-write-guard entry for why)
└── settings.fragment.json    ← the exact hook registrations (installer merges these)
```

---

## FAQ

**Do I have to adopt all of it?** No. Start with Tier 1 + `tests-must-pass`. Add the memory system (Tier 2) when you want the compounding loop. Tier 3 is taste.

**Python or Node?** Node `.mjs`, dependency-free. No `uv`, no virtualenv, no build. (The popular `claude-code-hooks-mastery` uses Python/UV — fine choice; this kit optimizes for "clone and go" with zero toolchain.)

**Will it fight my existing hooks?** The installer *merges* into `settings.json` and never removes entries it didn't add. Dry-run to see exactly what changes.

**Windows?** Yes — hooks are plain Node and avoid shell-isms. (One gotcha the kit itself documents: write hook files as UTF-8 *without* a BOM, or `node --check` chokes on the shebang line.)

**Is this affiliated with Anthropic?** No. It's a personal, opinionated kit built from daily use of Claude Code.

---

## Who built this — and hiring

I'm **Russell Miller**. I built this from six months of using Claude Code as my primary way of shipping software. The kit is the distilled result: the guardrails and memory loop that made an AI coding agent actually reliable for daily work.

**I'm available for AI consulting and product management work** — helping teams adopt coding agents safely (guardrails, governance, eval harnesses) and shaping AI-powered products end to end. If your team is standing up AI engineering workflows, or needs a product leader who can go deep on the technical side, let's talk.

- **Email:** rmiller@zavient.com
- **LinkedIn:** [linkedin.com/in/russellmiller](https://linkedin.com/in/russellmiller)
- **X:** [@russellm](https://x.com/russellm)
- **Substack:** [russellmiller2](https://substack.com/@russellmiller2)
- **GitHub:** [russellmiller3](https://github.com/russellmiller3)

---

## Recent changes

- **2026-07-15** — `require-langdocs-read.mjs`'s external-API override is now sticky per file:
  previously the check only scanned the CURRENT edit's diff for the `api-docs-read:` token, so a
  file that already had it from an earlier accepted edit still re-blocked on every later edit
  whose own diff didn't repeat it. Now checks the file's own on-disk content too — the token
  landing anywhere in the file once is enough for every later edit to that same file. 10 tests
  (up from 8).
- **2026-07-03** — `discipline-sync` no longer treats a hook merely *read* by a shell command
  (`grep`/`cat`/`node --test`/a smoke-test piping input into it) as a change — only a real write
  (redirect, `tee`, in-place edit, or a `cp`/`mv` destination) counts, so referencing a hook while
  debugging can't falsely block the publish loop. Hardened `.gitignore` to never track agent
  `.bak` backup snapshots.

## License

**[PolyForm Noncommercial License 1.0.0](LICENSE.md)** — free for noncommercial
use (personal projects, research, education, nonprofits, government). Fork it,
change the rules, encode your own opinions.

**Commercial or for-profit use requires a paid license** — see
[COMMERCIAL.md](COMMERCIAL.md). The hooks are easy to copy; the value is the
system. If it saves your team engineering time, it's worth a license.
