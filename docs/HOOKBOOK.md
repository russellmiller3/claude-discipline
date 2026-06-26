# HOOKBOOK

Per-hook reference for Claude Discipline — **22 hooks** across PreToolUse, PostToolUse, Stop, and SessionStart. For each: when it fires, what it does, and how to satisfy or override it.

> Keep the headline count above in sync with `settings.fragment.json`. The `hookbook-sync` hook checks it mechanically and blocks a turn that changes a hook without updating this file.

Every hook is dependency-free Node (`.mjs`), **fails open** on any parse error (a broken hook never wedges Claude Code), and has an explicit override. Overrides are environment variables unless noted.

---

## Tier 1 — Standalone (work anywhere, zero config)

### `block-dangerous-commands` · PreToolUse(Bash)
Refuses catastrophic shell commands: `rm -rf /`/`~`/`/*`, `dd` to a raw block device, `mkfs` on a device, block-device shred/overwrite, the classic fork bomb, recursive `chmod`/`chown` on `/` or `~`, and `curl|sh`/`wget|sh` remote-pipe-to-shell. Intentionally narrow — `rm -rf node_modules` passes (the recursive-delete rule has a second guard requiring a root/home/wildcard target). **Override:** `ALLOW_DANGEROUS_COMMAND=1` (env or inline prefix).

### `protect-secrets` · PreToolUse(Read|Edit|Write|Bash)
Blocks reading/editing/writing credential files (`.env*`, `*.pem`/`*.key`/`*.p12`, `id_rsa`, `.npmrc`, `.pypirc`, `.aws/credentials`, `.netrc`, `secrets.*`, `service-account*.json`) and blocks Bash commands that would `cat` one into the transcript. `.env.example`/`.sample`/`.template` are allowed; writing a *new* secret file (scaffolding) is allowed. **Override:** `SECRETS_OK=1`.

### `no-commit-to-main` · PreToolUse(Bash)
Blocks `git commit` while the current branch is `main`/`master`. Work on a branch, merge when done. Fails open if not a git repo. **Override:** `COMMIT_MAIN_OVERRIDE=1`.

### `read-before-write` · PreToolUse(Edit|Write)
Blocks editing/overwriting a file >200 lines that you haven't Read (or Written) this session — catches the "edit from stale memory → `old_string` mismatch → wasted retries" loop. New files and small files pass. **Config:** `READ_BEFORE_WRITE_LINES` (threshold). **Override:** `READ_BEFORE_WRITE_OVERRIDE=1`.

### `pixels-only-proof` · Stop
For a visual / "not rendering" bug, blocks "it's fixed / it renders" claims that cite DOM-level evidence (`toBeVisible`, `innerText`, `boundingBox`, `.toContain`, "in the DOM") when the turn never viewed a screenshot. An honest disclaimer ("not visually verified") or actually reading a `.png` clears it. **Override:** `PIXELS_PROOF_OVERRIDE=1`.

### `tests-must-pass` · PostToolUse(Bash) + Stop
A test failure drops a marker; Stop is blocked until a full-suite run comes back green. "Pre-existing" / "unrelated" is never an excuse to leave a red test. **Config:** `TESTS_FULL_SUITE_RE` (what counts as a clearing full run).

### `name-by-use` · PreToolUse(Write|Edit)
Blocks fresh identifiers named after their type (`text`, `data`, `result`, `tmp`, `list`…) instead of their role, in `.js/.ts/.jsx/.tsx/.mjs/.cjs/.py`. Loop counters `i/j/k` are fine. **Override:** the token `name-by-use-override` in the text, or `NAME_BY_USE_OVERRIDE=1`.

### `filename-quality-guard` · PreToolUse(Write)
Blocks creating a file with a low-quality NAME — typos (a token one edit away from a known word but not itself a word, e.g. `findigns`→`findings`, `lenght`→`length`), lazy/scratch stems (`tmp`, `output2`, `asdf`, `untitled`, `stuff`), and dropped-vowel tokens (`fndngs`). Allowlists conventional caps files (README, LICENSE, FINDINGS, HANDOFF…), dotfiles, and tech acronyms; only blocks CLOSE misspellings, so unknown-but-plausible domain words pass (low false-positive). Has teeth (`permissionDecision: deny`). **Override:** `FILENAME_GUARD_OVERRIDE=1`.

### `agent-autocommit` · PostToolUse(Write|Edit)
Auto-commits WIP inside a linked git worktree after every edit, so a background agent that dies loses at most one edit — git is the only checkpoint that survives a silent death, and this needs no cooperation from the agent.

### `coverage-claim-guard` · Stop
Blocks a "tested everything / covered every X" claim that doesn't state the real scope — a count, or what's left uncovered. Stops blanket coverage claims that quietly mask gaps.

### `look-before-asking` · Stop
Blocks asking the user for a discoverable fact (a path, a key, an env var) when the turn ran zero searches/reads. Search the filesystem/env first; hand the user a question only when it genuinely can't be found.

### `hook-must-enforce` · PreToolUse(Write|Edit)
Meta-guard: blocks writing a "guardrail" hook that only PRINTS advice — no `decision:'block'`, no non-zero exit, no real side-effect. A hook with no teeth is false safety; if it presents as enforcement it must actually deny or act.

---

## Tier 2 — Memory system (needs the companion files)

### `learnings-toc-inject` · SessionStart
Surfaces the `## Table of Contents` of `~/.claude/learnings.md` and `<project>/learnings.md` so the agent knows what lessons exist. Prints a "start one" hint if neither file exists.

### `learnings-error-match` · PostToolUse(Bash|Edit|Write)
When a tool emits error output, scans the learnings files for matching bullets (by error token + generic topic buckets) and injects them — and drops an ack marker for the next hook.

### `require-learnings-ack` · PreToolUse(Read|Edit|Write)
While the ack marker exists, blocks edits to *code* files until you Read the surfaced learnings file (which clears the marker). Docs/markdown edits flow freely. **Config:** `LEARNINGS_ACK_TTL_HOURS` (default 6). **Override:** `LEARNINGS_ACK_OVERRIDE=1`.

### `learnings-write-nudge` · PostToolUse(Bash) + Stop
After a `fix`/`feat` commit with lesson-worthy language, nudges you to add a learnings bullet. The Stop half is commit-independent: if the turn diagnosed a real error and applied a fix but wrote no learning, it blocks. **Dismiss:** the token `no-learning-needed`. **Override:** `LEARNINGS_NUDGE_OVERRIDE=1`.

### `handoff-continuity` · SessionStart + UserPromptSubmit + Stop
Reminds you to read `HANDOFF.md` at start; marks a checkpoint "due" every N turns (or when you say "handoff"/"save context"/report a compaction); blocks Stop until `HANDOFF.md` is updated past the due time. **Config:** `HANDOFF_CONTINUITY_TURN_INTERVAL` (default 3), `HANDOFF_CONTINUITY_STATE_PATH`.

---

## Tier 3 — Opinionated (great defaults; toggle off if they don't fit)

### `no-legacy-shims` · PreToolUse(Write|Edit) + Stop
For a pre-1.0 project with no users: blocks backcompat language (deprecation warnings, "old form still works", soft-deprecation) in edits and in the final reply. Time-bound — turn it off once you have users you can't break. **Override:** the token `intentional backcompat`, or `BACKCOMPAT_OVERRIDE=1`.

### `root-cause-first` · PreToolUse(Edit|Write)
When you add a new branch/case/function to a configured "hot" pipeline file, requires a traced call path first (catches "right logic, wrong function"). **Config:** `ROOT_CAUSE_FILES` (comma-separated basenames; no-op if none match). **Clear it:** a `// call path:` comment, the token `root-cause-verified`, or `ROOT_CAUSE_OVERRIDE=1`.

### `decay-footer` · Stop
If you wrote/edited code files this turn, the reply must end with a debt-surface footer (Files touched / Invariants relied on / Smells introduced / Suggested follow-up). **Override for trivial edits:** the line `decay-footer override: trivial change — <what>`, or `DECAY_FOOTER_OVERRIDE=1`.

### `hookbook-sync` · Stop
If a hook `.mjs` changed this turn but HOOKBOOK wasn't touched, or the "N hooks" headline drifts from the count registered in settings.json, blocks until you fix it. The system documents itself. **Config:** `HOOKBOOK_PATH`, `HOOK_SETTINGS_PATH`. **Override:** `HOOKBOOK_SYNC_OVERRIDE=1`.

### `discipline-sync` · Stop
The sibling of `hookbook-sync` for THIS published kit. If a hook changed this turn whose copy here is now byte-different from the live `~/.claude/hooks/` source, blocks until the kit copy is re-synced — so a shipped guard never drifts from the version that actually runs. Only fires for hooks already in the kit (it doesn't force every new hook to publish); the content-equality check also catches drift left by an earlier turn. **Config:** `DISCIPLINE_KIT_DIR`. **Override:** `DISCIPLINE_SYNC_OVERRIDE=1`.

### `never-stop-asking` · Stop
Bias to action (the "Ross Perot" rule). **Default (always on):** blocks asking-permission phrasing (`want me to` / `should I` / `if you'd rather`) and satisfaction-stops — winding-down language (`next session`, `TL;DR`, `wrapping up`) or naming a "next move" while the turn made zero working tool calls toward it. Suppressed when the user explicitly pauses (handoff / wrap / stop), except asking-permission which always fires. **Opt-in extras (env):** `NEVER_STOP_REQUIRE_BEAT=1` (work turns must include an orientation beat), `NEVER_STOP_REQUIRE_QUEUE=1` (work turns need a `.claude/state/priority-queue.md`). **Override:** `NEVER_STOP_OVERRIDE=1`.

### `recommend-when-listing` · Stop
When the last reply lists alternatives (Option A/B, "either X or Y", "two approaches", "your call") but contains no recommendation verb, blocks until you lead with a pick. A menu of equal options pushes the decision back onto the user. Quiet when the user asked for survey/think mode ("just thinking", "what do you think", "feedback only"). **Override:** `RECOMMEND_WHEN_LISTING_OVERRIDE=1`.

### `file-size-guard` · PostToolUse(Write)
Warns (never blocks) when a freshly written code file crosses a structural limit: too many lines, an over-long function, or too many switch/match arms (the next arm probably wants to be a new type). Surfaces the smell so you can report it honestly. **Config:** `FILE_SIZE_MAX_LINES` (400), `FILE_SIZE_MAX_FN` (80), `FILE_SIZE_MAX_ARMS` (7). **Disable:** `FILE_SIZE_GUARD_OFF=1`.

### `e2e-or-its-theatre` · Stop
**"Unit tests without e2e are theatre."** Blocks stop when, this turn, you edited a load-bearing source module (`.js`/`.mjs`/`.svelte` under `src/`/`lib/`) whose OWN source crosses a REAL external boundary — WASM (`pyodide`/`.wasm`), network (`fetch`/`WebSocket`/an HTTP client), a DB (`indexedDB`/`idb`/`sqlite`/`pglite`), a `Worker`, or DOM serialization (`document`/`jsdom`/`querySelector`) — AND its only sibling tests MOCK that boundary (`vi.mock`/`vi.fn`/`jest.mock`) AND there is NO real e2e (no `<module>.e2e.test.*`, no e2e-tagged test in the tree). A mocked-boundary test proves the wiring, never that the real dependency works — the bug a mock physically can't fake (a WASM bigint, a real DOM serialize, a real DB round-trip) has no net. A pure-logic module (no boundary signal) is **exempt**. Teeth: `decision:'block'` until you add a real e2e that exercises the actual dependency and asserts something a mock couldn't satisfy. **Override:** `e2e-owed-live-gate: <why>` when a real e2e is genuinely infeasible headlessly (real mic/socket/browser) — **NOT a free pass**: it records the deferral in the owed-live-gate ledger and lets the stop proceed, but `owed-live-gate-reminder` then nags every turn until the live e2e runs green (detected here via a passing `<stem>.e2e.test…` run), which clears it. `e2e-skip: <why>` remains a true pass for a misjudged no-boundary change. Fail-open. Locked by `e2e-or-its-theatre.test.mjs` + `owed-live-gate.test.mjs`.

### `owed-live-gate-reminder` · UserPromptSubmit
The teeth behind `e2e-or-its-theatre`'s `e2e-owed-live-gate:` override (which now records to a durable ledger instead of free-passing). On every turn this surfaces each outstanding owed gate — module, age, "run the live e2e green to clear it" — until the real test actually passes. Non-blocking by design (it never blocks a commit, so you don't lose work); it simply won't let you forget. A green live run clears the gate automatically. Ledger lib: `lib/owedLiveGates.mjs`. Locked by `owed-live-gate.test.mjs`.

### `ross-perot-guard` · Stop
"Lead, don't ask." Blocks a turn that ends by SOLICITING the user's input — detected structurally, not by a phrase museum: the final message ends with a question mark, or on a small stable set of hand-off closers ("your call", "say the word", "your move"). Novel "…?" closers are caught for free. A genuine question belongs in an interactive picker, not a prose "?". Survey/"what do you think" mode and an explicit override are exempt.

### `parallel-when-possible` · SessionStart + Stop
SessionStart injects the "decompose → fan out" reflex: independent work units should be dispatched to concurrent subagents in ONE message, not ground through serially. Stop backstops it — blocks when a turn made many edits across many files with zero subagents spawned. Suppress genuinely-coupled work with "serial only".

### `bench-pattern-guard` · PreToolUse(Write)
Blocks writing a benchmark/eval/sweep runner that isn't parallel + event-emitting + durable/resumable — a bounded worker pool with a concurrency knob, live progress, and per-task checkpoints with `--resume`. No serial for-loop benches that can't stream progress or resume.

### `agent-monitor-cadence` · Stop
Forces the orchestrator to actually watch its background agents — blocks stop while a spawned agent has sat idle/unattended past a threshold, so you inspect and salvage its committed work instead of letting it rot unnoticed.

### `clean-merged-worktrees` · Stop
Auto-removes a spent agent git worktree whose branch has already merged — keeps the working tree clean with no manual `git worktree remove`.

---

## The override philosophy

Every gate has an escape hatch on purpose. A hook with no override trains people to disable the whole hook the first time it's wrong — and then it protects nothing. The override is a one-time, intentional "yes, I mean it," not a way of life. If you find yourself reaching for the same override every session, that's a signal to tune the hook's trigger, not to keep dismissing it.
