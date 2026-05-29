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

Hooks are **tiered by how portable they are** — pick your comfort level. Full per-hook reference: [`docs/HOOKBOOK.md`](docs/HOOKBOOK.md).

### Tier 1 — Standalone (work anywhere, zero config)
| Hook | Event | What it enforces |
|------|-------|------------------|
| `block-dangerous-commands` | PreToolUse(Bash) | Refuses `rm -rf /`, fork bombs, disk-wipes, etc. |
| `protect-secrets` | PreToolUse | Blocks reads/writes of `.env`, key files, credential stores |
| `no-commit-to-main` | PreToolUse(Bash) | Blocks direct commits to `main`/`master` — branch first |
| `read-before-write` | PreToolUse(Edit) | Blocks editing a file you haven't read this session |
| `pixels-only-proof` | Stop | On a visual/"not rendering" task, blocks "fixed" claims that cite DOM/`toBeVisible` instead of a screenshot |
| `tests-must-pass` | PostToolUse+Stop | Any failing test (incl. "pre-existing") blocks stop until a full green run |
| `name-by-use` | PreToolUse(Write/Edit) | Blocks type-named identifiers (`data`, `result`, `tmp`) — name by role |

### Tier 2 — Needs the companion files (the memory system)
| Hook | Event | What it enforces |
|------|-------|------------------|
| `inject-claude-md` | SessionStart | Loads your `CLAUDE.md` into context every session |
| `learnings-toc-inject` | SessionStart | Injects the `learnings.md` table of contents so the agent scans it before working |
| `learnings-error-match` | PostToolUse | When an error appears, surfaces the matching past lesson — *and drops a marker* |
| `require-learnings-ack` | PreToolUse(Edit) | Blocks code edits until you've actually read the surfaced lesson |
| `learnings-write-nudge` | PostToolUse+Stop | Blocks stop when you fixed a real bug but wrote no learning |
| `handoff-continuity` | Stop | Nags when `HANDOFF.md` is stale relative to work done |

### Tier 3 — Opinionated (great defaults; some teams will disagree — that's fine, toggle them off)
| Hook | Event | What it enforces |
|------|-------|------------------|
| `no-legacy-shims` | PreToolUse(Write/Edit) | Pre-1.0 projects: replace old code outright; no fallback shims kept alive "just in case" |
| `root-cause-first` | PostToolUse | After repeated same-symptom fixes, forces a state-probe before the next swing |
| `decay-footer` | Stop | Code-changing turns must end with a "files touched / smells introduced" footer |
| `hookbook-sync` | Stop | Change a hook → blocks until `HOOKBOOK.md` documents it (and the count matches) |

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

---

## The patterns worth stealing (even if you take nothing else)

1. **Block, don't nag.** A `Stop` hook that returns `{"decision":"block","reason":"..."}` *cannot* be ignored. An injected reminder can. Reserve blocks for true non-negotiables so they don't become noise.
2. **The marker pattern.** A `PostToolUse` hook drops a small JSON marker (`.claude/state/*.json`) when a condition is detected; a `Stop` hook blocks while the marker exists; some later action clears it. This is how you enforce a rule that *spans* events (e.g. "a test failed earlier → can't stop until it's green").
3. **Always give a clear-path.** Every blocking hook tells you *exactly* how to satisfy it (and offers a dismiss token for genuine exceptions). A gate with no escape hatch trains people to disable it.
4. **Enforce the human where judgment is needed; automate only the mechanical.** `hookbook-sync` *forces you* to write the hook's description (judgment) but *auto-checks* the hook count (mechanical). Don't auto-generate prose; do auto-verify facts.
5. **Self-policing meta-hooks.** The system documents and counts itself. The guardrails guard the guardrails.
6. **Pattern hooks false-fire on their own subject.** A hook that greps for a banned word will trip when you *document* that word. Give every blocking hook a dismiss token, and keep the trigger as specific as you can.

---

## Repo layout

```
claude-discipline/
├── README.md                ← you are here (the how-to)
├── docs/
│   ├── HOOKBOOK.md           ← per-hook reference: trigger, behavior, clear-path
│   ├── PHILOSOPHY.md         ← why deterministic > advisory; when to make a hook
│   └── WRITING-HOOKS.md      ← anatomy of a hook + the marker pattern, to write your own
├── hooks/                    ← dependency-free .mjs hooks, one file each
├── skills/                   ← optional workflows (one dir per skill, each a SKILL.md)
├── templates/
│   ├── CLAUDE.md             ← starter rules file (philosophy lives here)
│   ├── learnings.md          ← starter memory file (topic-organized, with TOC)
│   └── HANDOFF.md            ← starter session-state file
├── scripts/
│   └── install.mjs           ← copy hooks + merge settings.json + drop templates
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

## License

**[PolyForm Noncommercial License 1.0.0](LICENSE.md)** — free for noncommercial
use (personal projects, research, education, nonprofits, government). Fork it,
change the rules, encode your own opinions.

**Commercial or for-profit use requires a paid license** — see
[COMMERCIAL.md](COMMERCIAL.md). The hooks are easy to copy; the value is the
system. If it saves your team engineering time, it's worth a license.
