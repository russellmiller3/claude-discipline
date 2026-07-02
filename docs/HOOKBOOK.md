# HOOKBOOK

Per-hook reference for Claude Discipline — **~40 hooks** across PreToolUse, PostToolUse, Stop, SessionStart, and UserPromptSubmit. For each: when it fires, what it does, and how to satisfy or override it.

> Keep the headline count above in sync with `settings.fragment.json`. The `hookbook-sync` hook checks it mechanically and blocks a turn that changes a hook without updating this file.

Every hook is dependency-free Node (`.mjs`), **fails open** on any parse error (a broken hook never wedges Claude Code), and has an explicit override. Overrides are environment variables unless noted.

### Shared library — `hooks/lib/transcript.mjs`

The transcript-reading Stop / UserPromptSubmit hooks share one set of JSONL helpers instead of each hand-rolling them: `readTranscript`, `roleOf`, `contentBlocks`, `toolUsesOf`, `currentTurnEntries`, `lastAssistantText` / `lastAssistantTextOf`, `lastUserText` / `lastUserTextOf`, `toolResultText`, `isHumanPrompt`. `currentTurnEntries` anchors on the last *human* prompt (so early tool-results stay in-turn); `lastAssistantText` skips a trailing tool-only assistant message. Re-implementing one of these in a hook is blocked by `hook-dry-review` (below) — import from the lib instead.

### Recent additions (2026-06-29)

- **`powershell-edit-guard.mjs`** (PreToolUse `Bash`/`PowerShell`) — DENIES writing file CONTENT via PowerShell (`Set-Content` / `Out-File` / `Add-Content` / `Export-*` / `[IO.File]::WriteAll*`). Windows PowerShell 5.1 re-encodes a UTF-8-no-BOM file and corrupts em-dashes/arrows into mojibake — file edits belong to the Edit/Write tools (encoding-safe). Reads (`Get-Content`) and plain `>` redirects pass. Override: `PS_FILE_WRITE_OK` (a genuine binary/data export). Locked by `powershell-edit-guard.test.mjs` (11 cases).
- **`plan-core-journey-guard.mjs`** (PreToolUse `Write`/`Edit`/`MultiEdit`) — the **PLAN-TIME** core-journey gate. On a plan write (a file under `plans/`, or `plan-*.md` / `*-plan.md`) it reads the project's `NORTH_STAR.md` at the repo root, which declares `core_journey:` (the one user-facing thing the product must do end-to-end) and `proof:` (the path to the integration test that exercises the WHOLE journey). It DENIES when (a) no `NORTH_STAR.md` exists — declare the core journey before planning more components; or (b) the `proof` path is MISSING (the core is unwired) AND the plan doesn't address it (no mention of the proof path/basename, nor `end-to-end`/`e2e`/`core journey`/`integrat*`/`wire…engine|brain|whole`). This stops the failure mode where every isolated COMPONENT ships green while the product's one job stays inert — caught at plan time, not ship time, because by ship time the isolation is already baked in. Override: `NORTH_STAR_DEFER_OK` in the plan. Locked by `plan-core-journey-guard.test.mjs` (9 cases).
- **`long-running-script-guard.mjs`** + **`bench-parallel-guard.mjs`** (PreToolUse `Bash`/`PowerShell`) — require long/bench scripts to be chunked, resumable, visible, and parallel where the work fans out. **Loosened 2026-06-29:** both now scan only the *executable structure* (an `executableText` helper blanks quoted strings + inline `-c`/`-e`/`-Command` code) and exempt inline one-liners, so `py -c "import x"`, `grep "bench"`, and `echo "py -c"` no longer false-block on keywords inside quotes that execute nothing — while real bench/migrate/sweep *runs* stay gated. **Fixed 2026-06-30:** the `.py` FILE EXTENSION no longer matches the `py` interpreter pattern — `git add critic.py` was reading as a python RUN, so with a `bench`/`migrate` keyword in a path a plain git commit false-blocked. A negative-lookbehind for a dot guards `py`/`python` against `*.py`; a real `py -m bench.x` still gates. Overrides: `LONG_SCRIPT_OK=1` / `BENCH_SERIAL_OK=1` / `BENCH_FULL_OK=1`. Locked by their `*.test.mjs`.

- **`background-on-agent-spawn.mjs`** (PreToolUse `Agent`) — DENIES any Agent spawn missing `run_in_background: true`, forcing every agent (build OR read-only research) to run detached so a turn interrupt can't kill it (a foreground agent is owned by the turn, not the session). The companion worktree hook's `FOREGROUND_OK` deliberately does NOT bypass this. Override: `FOREGROUND_RUSSELL_OK` in the prompt. Locked by `background-on-agent-spawn.test.mjs` (6 cases).
- **`cross-repo-worktree-on-agent-spawn.mjs`** (PreToolUse `Agent`) — DENIES an Agent spawn that drives a SIBLING repo by absolute path but lacks `git worktree add`. The Agent tool's `isolation: "worktree"` isolates the SESSION repo, not a sibling the brief operates on by path — so parallel agents share the sibling's single working tree and reset HEAD under each other (commits land on the wrong branch). Fix: the brief sets up its own worktree in the target repo. Escapes: `FOREGROUND_OK` (read-only), `CROSS_REPO_WORKTREE_RUSSELL_OK`. Locked by `cross-repo-worktree-on-agent-spawn.test.mjs` (10 cases).
- **`widget-ux-not-cli.mjs`** (PreToolUse `Agent`) — DENIES a brief that claims to expose/surface UX for a feature via a `py -m`/CLI when the project has a `widget.html` and the brief never mentions the widget. A desktop product's user-facing UX is the widget (wired to Python via pywebview's `js_api` — `window.pywebview.api.<method>()`), not a command line; a CLI is a dev convenience, not "UX exposed." Escapes: `UX_CLI_OK` (genuinely a dev-only tool), `WIDGET_UX_RUSSELL_OK`. Locked by `widget-ux-not-cli.test.mjs` (7 cases).

### Recent additions (2026-06-28)

- **`hook-dry-review.mjs`** (PreToolUse Write/Edit/MultiEdit) — editing or creating a hook forces a DRY review: BLOCKS a hook write that hand-rolls a `lib/transcript.mjs` helper instead of importing it. Override: `dry-reviewed: <why>` in the edit, or `HOOK_DRY_OVERRIDE=1`.
- **`self-verify-before-asking.mjs`** (Stop) — in builder mode, BLOCKS a reply that asks the user to TEST/VERIFY work the agent could verify itself, unless it names a genuine environment/hardware/visual reason. Override: name the real reason, or `self-verify-override: <why>`.

---

## Tier 1 — Standalone (work anywhere, zero config)

### `block-dangerous-commands` · PreToolUse(Bash)
Refuses catastrophic shell commands: `rm -rf /`/`~`/`/*`, `dd` to a raw block device, `mkfs` on a device, block-device shred/overwrite, the classic fork bomb, recursive `chmod`/`chown` on `/` or `~`, and `curl|sh`/`wget|sh` remote-pipe-to-shell. Intentionally narrow — `rm -rf node_modules` passes (the recursive-delete rule has a second guard requiring a root/home/wildcard target). **Override:** `ALLOW_DANGEROUS_COMMAND=1` (env or inline prefix).

### `live-ui-focus-guard` · PreToolUse(Bash|PowerShell|Agent)
Blocks launching focus-stealing live-UI / integration tests on your active desktop: a `pytest` run that SELECTS the `integration` marker (quoted or bare, but NOT `not integration`) or a direct `*_live.py` run — in a shell command OR an Agent brief. Such tests drive a real app (Calculator/Notepad via `uiautomation`, a browser, etc.) and physically take over the screen — fine on headless CI, disruptive when an unattended agent runs them while you're working. The safe default suite (`-m "not integration"`) is never blocked. **(Fixed 2026-07-02)** an Agent brief that *prohibits* the marker in prose ("do NOT run anything marked -m integration") was false-blocked as if it WERE that invocation — a match now only counts as a real invocation when there's no negation cue (not/never/don't/avoid/off-limits/…) in the ~60 chars right before it. **Override** (you're away / it's safe to grab the screen): the token `live-ui-ok: <why>` in the command/brief, or env `LIVE_UI_TEST_OK=1`. Locked by `live-ui-focus-guard.test.mjs` (16 cases).

### `protect-secrets` · PreToolUse(Read|Edit|Write|Bash)
Blocks reading/editing/writing credential files (`.env*`, `*.pem`/`*.key`/`*.p12`, `id_rsa`, `.npmrc`, `.pypirc`, `.aws/credentials`, `.netrc`, `secrets.*`, `service-account*.json`) and blocks Bash commands that would `cat` one into the transcript. `.env.example`/`.sample`/`.template` are allowed; writing a *new* secret file (scaffolding) is allowed. **Override:** `SECRETS_OK=1`.

### `no-commit-to-main` · PreToolUse(Bash)
Blocks `git commit` when the branch the commit actually LANDS on is `main`/`master`. Two resolution steps (both false-blocks fixed 2026-07-01): `cd <path> &&` / `git -C <path>` pick the TARGET repo (not the session repo), and a chained `git switch <name>` / `checkout -b <name>` before the commit sets the effective branch — so the standard one-liner `git switch -c fix/x && git add && git commit` passes from main, while `git switch main && git commit` is still caught (a plain `checkout <target>` is ignored: it may be a file restore). Work on a branch, merge when done. Fails open if not a git repo. **Override:** `COMMIT_MAIN_OVERRIDE=1`. Locked by `no-commit-to-main.test.mjs` (12 tests).

### `read-before-write` · PreToolUse(Edit|Write)
Blocks editing/overwriting a file >200 lines that you haven't Read (or Written) this session — catches the "edit from stale memory → `old_string` mismatch → wasted retries" loop. New files and small files pass. **Config:** `READ_BEFORE_WRITE_LINES` (threshold). **Override:** `READ_BEFORE_WRITE_OVERRIDE=1`.

### `visual-proof-required` · Stop
ONE gate consolidating three near-duplicates (`verify-change-with-screenshot` + `ux-screenshot-required` + `pixels-only-proof`): a visual change/claim needs a REAL screenshot. Blocks Stop when, this turn, NOT overridden, NO real screenshot, AND any of: (A) edited a UI surface — union pattern `.svelte/.css/.scss/.html/.vue/.tsx/.jsx` + component/route/e2e paths (covers plain `.html` widgets); (B) claimed a visual element renders/shows/is-fixed citing DOM evidence (`toBeVisible`/`innerText`/`boundingBox`/`.toContain`/"in the DOM") with no disclaimer; (C) the "DOM is stronger than pixels" heresy (blocks regardless of screenshot). A screenshot tool that merely FIRED (or timed out) does NOT count — proof is a REAL captured image (an `image` part in a tool result, a `Read` of a `.png`, a `SendUserFile` image, or a harness result printing a `.png` path). **Override:** `visual-proof-skip: <why>` (legacy `verify-change-skip:` accepted).

### `ux-verify-artifact` · Stop
File-mtime sibling of `visual-proof-required`: blocks Stop when a UI file was edited but no screenshot file on disk has an mtime newer than the edit (catches "claimed verified" with a stale or absent capture). **(Fixed 2026-07-02)** the disk-file check used to be the ONLY accepted proof, but a live preview tool (e.g. a `preview_screenshot`-style MCP call) renders the image inline for the user without ever saving to `screenshots/` — a real check can still get false-blocked here for lack of a saved file. Now ALSO accepts a `mcp__Claude_Preview__preview_screenshot` tool_use appearing in the transcript at or after the earliest UI-edit tool_use this turn, ordered by transcript entry index (not wall-clock time, which can collide within a turn). The disk-file path is unchanged and still works standalone; a turn with no proof of either kind still blocks. Locked by `ux-verify-artifact.test.mjs` (10 checks — no test file existed before this fix).

### `tests-must-pass` · PostToolUse(Bash) + Stop
A test failure drops a marker; Stop is blocked until a full-suite run comes back green. "Pre-existing" / "unrelated" is never an excuse to leave a red test. **Config:** `TESTS_FULL_SUITE_RE` (what counts as a clearing full run).

### `name-by-use` · PreToolUse(Write|Edit)
Blocks fresh identifiers named after their type (`text`, `data`, `result`, `tmp`, `list`…) instead of their role, in `.js/.ts/.jsx/.tsx/.mjs/.cjs/.py`. Loop counters `i/j/k` are fine. **Override:** the token `name-by-use-override` in the text, or `NAME_BY_USE_OVERRIDE=1`.

### `filename-quality-guard` · PreToolUse(Write)
Blocks creating a file with a low-quality NAME — typos (a token one edit away from a known word but not itself a word, e.g. `findigns`→`findings`, `lenght`→`length`), lazy/scratch stems (`tmp`, `output2`, `asdf`, `untitled`, `stuff`), and dropped-vowel tokens (`fndngs`). Allowlists conventional caps files (README, LICENSE, FINDINGS, HANDOFF…), dotfiles, and tech acronyms; only blocks CLOSE misspellings, so unknown-but-plausible domain words pass (low false-positive). Two structural passes (2026-07-01): a name whose stem matches an EXISTING sibling file is allowed by construction (`X.test.mjs` beside `X.mjs` — "write"→"writer" had false-blocked `no-write-to-main.test.mjs`), and plain verbs that neighbor agent nouns (write/watch/merge/build) are known-good words, not typos. Has teeth (`permissionDecision: deny`). **Override:** `FILENAME_GUARD_OVERRIDE=1`. Locked by `filename-quality-guard.test.mjs` (14 tests).

### `design-md-check` · PreToolUse(Write|Edit|MultiEdit)
Non-blocking. On a UI/style edit — a style file (`.css/.scss/.sass/.less/.html/.svg/.svelte/.vue/.jsx/.tsx`) or JS/TS carrying style signals (`.style.`, `classList`, `createElement`, `innerHTML`…) — injects your design system as `additionalContext` so the change follows the house style. Reads the design doc from `~/Desktop/programming/context/design.md` (falling back to the legacy `~/.claude/design.md`); if neither exists it silently no-ops, so the hook is harmless on a machine without that doc. Personal hook — point the two paths at wherever your own design system lives.

### `agent-autocommit` · PostToolUse(Write|Edit)
Auto-commits WIP inside a linked git worktree after every edit, so a background agent that dies loses at most one edit — git is the only checkpoint that survives a silent death, and this needs no cooperation from the agent.

### `coverage-claim-guard` · Stop
Blocks a "tested everything / covered every X" claim that doesn't state the real scope — a count, or what's left uncovered. Stops blanket coverage claims that quietly mask gaps.

### `look-before-asking` · Stop
Blocks asking the user for a discoverable fact (a path, a key, an env var) when the turn ran zero searches/reads. Search the filesystem/env first; hand the user a question only when it genuinely can't be found.

### `hook-must-enforce` · PreToolUse(Write|Edit)
Meta-guard: blocks writing a "guardrail" hook that only PRINTS advice — no `decision:'block'`, no non-zero exit, no real side-effect. A hook with no teeth is false safety; if it presents as enforcement it must actually deny or act.

### `hook-negative-case-required` · Stop
Meta-guard: blocks stop when a guard hook (one with teeth) was created/edited this SESSION but its `*.test.mjs` has no NEGATIVE (must-allow / must-not-fire) case. A deny-only test proves the guard FIRES, never that it doesn't OVER-fire — the blind spot behind five same-session false-fires. Pure context-injectors are exempt; scope is the hooks you touched. **Override:** `hook-negative-case-waived: <why>`. See "Avoid false positives" in WRITING-HOOKS.md.

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

### `getty-no-repeat-mistakes` · UserPromptSubmit + Stop
"You can make any mistake you want. Just never make the same one twice." Detects a correction in the user's own wording (background-agent completions and system reminders are explicitly excluded — never counted as "the user speaking," even when they quote correction-like phrases). First-time correction: satisfied by adding a learnings bullet. REPEAT correction (wording signals "you've done this before"): a learning already failed once, so only building/strengthening a hook clears it — and the agent must ask before building, never build unilaterally. **Override:** `getty-override: <reason>`.

### `handoff-continuity` · SessionStart + UserPromptSubmit + Stop
Reminds you to read `HANDOFF.md` at start; marks a checkpoint "due" every N turns (default 5) — or when you say "handoff"/"save context"/report a compaction — and blocks Stop until `HANDOFF.md` is updated past the due time. The checkpoint message demands a WHOLE-FILE review + **PRUNE** (keep what's live, cut what's stale/done), not just an append, and to create `learnings.md` if it's missing. **Config:** `HANDOFF_CHECKPOINT_EVERY_TURNS` (default 5), `HANDOFF_CONTINUITY_STATE_PATH`.

### `new-repo-scaffold` · PostToolUse(Bash)
On `git init`, WRITES the repo's missing scaffolding — it has teeth (creates files, never overwrites an existing one): `README.md` with a **NORTH STAR** + main user-stories + tech-stack-via-interview + roadmap + go-to-market skeleton (and the message tells you to INTERVIEW the owner before guessing the stack), `HANDOFF.md` (compaction parachute), `learnings.md` (long-term memory), plus the commit gate — `.pre-commit-config.yaml` for Python, a husky reminder for Node. Turns "a fresh repo starts empty" into "a fresh repo starts with its purpose, memory, and gate in place."

---

## Tier 3 — Opinionated (great defaults; toggle off if they don't fit)

### `no-backcompat` · PreToolUse(Write|Edit) + Stop
For a pre-1.0 project with no users: blocks backcompat language (deprecation warnings, "old form still works", soft-deprecation) in edits and in the final reply. Time-bound — turn it off once you have users you can't break. **(Fixed 2026-07-02)** the pattern list used to fire on ANY prose use of the trigger words, so a plain markdown doc describing an unrelated design decision (a CSS/UI color palette note) got the full API-compatibility excoriation meant for real code shims. A match now only counts as a real hit with code-adjacent evidence nearby: a fenced code block anywhere in the text, code/API vocabulary (function/API/endpoint/parser/compiler/syntax/interface/version/schema/…) within an 80-char window, or code punctuation (dotted calls, `//` comments, statement semicolons) right around the match. A real shim — a `console.warn(...)` call, or "keep the old API version for backwards compatibility so callers don't break" — still fires, in markdown or code. **Override:** the token `intentional backcompat`, or `BACKCOMPAT_OVERRIDE=1`. Locked by `no-backcompat.test.mjs` (9 tests, up from 5).

### `root-cause-first` · PreToolUse(Edit|Write)
When you add a new branch/case/function to a configured "hot" pipeline file, requires a traced call path first (catches "right logic, wrong function"). **Config:** `ROOT_CAUSE_FILES` (comma-separated basenames; no-op if none match). **Clear it:** a `// call path:` comment, the token `root-cause-verified`, or `ROOT_CAUSE_OVERRIDE=1`.

### `decay-footer` · Stop
If you wrote/edited code files this turn, the reply must end with a debt-surface footer (Files touched / Invariants relied on / Smells introduced / Suggested follow-up). **Override for trivial edits:** the line `decay-footer override: trivial change — <what>`, or `DECAY_FOOTER_OVERRIDE=1`.

### `jargon-gloss-guard` · Stop
Blocks if a reply's FIRST use of a jargon term has no plain-English gloss nearby (a parenthetical, a dash-explanation, or a signal phrase like "which means"). Fires on every EXPLAINING turn; on a turn that ALSO wrote code it fires only when the final message is a real explanation (>= 40 words), so terse coding status beats aren't nagged but jargon-walls still get caught. Word list covers ML + logic terms (argmax, marginals, soft-Z3/soft-sat, gradient, encoder, overfit, generalize, param groups, warmup, combinatorial, satisfiability, BCE, fine-tuning, GNN, …). Skips terms the transcript's "Already known ... :" reminder already covers. WIDENED 2026-07-01 after a page of jargon slipped through JUST because the turn also edited a file and the word list was too small (Russell: "pages of jargon i didnt follow"). **Override:** the line `jargon-gloss override: <why>`, or `JARGON_GLOSS_OVERRIDE=1`. Locked by `jargon-gloss-guard.test.mjs` (10 tests).

### `fix-false-positive-hooks` · Stop
The teeth behind "a false-positiving hook gets fixed, not worked around." Scans the session transcript for the three-part pattern: a hook BLOCKED a tool call → a LATER assistant-authored tool input or message used that same hook's OVERRIDE token → the hook's `.mjs` file was neither edited NOR dispatched to a background Agent this session. If found, blocks the stop until one of those lands, or the final reply explicitly declares the block was correct: `true-positive: <hook-name> — <why>`. Hook identity comes from the block message's `[node .../hooks/X.mjs]` path, or a signature table for deny-style messages that don't carry their path. Overrides are counted ONLY from assistant-authored channels (a block message advertising its own escape hatch can't self-trigger), only AFTER that hook's block — a proactive, sanctioned override (like a doc-commit `COMMIT_MAIN_OVERRIDE=1`) never fires — and never from hook-authoring targets: writing a hook / HOOKBOOK / CLAUDE.md that documents override tokens isn't using them (the hook flagged ITSELF on its first live stop via its own token list; fixed the same turn). Input-level tokens (env vars, sentinel comments) count only inside tool inputs; reply-level ones (the `... override:` family) also count in message text, while a prose mention of an input-level token doesn't. **(Amended 2026-07-02)** hook-fixing is now ALWAYS delegated: an `Agent` tool_use with `run_in_background: true` whose prompt names the blocked hook's `.mjs` file clears the gate the same as an inline edit — so the main thread can dispatch the fix and keep going, instead of stopping to fix hooks itself. A foreground Agent call doesn't count (that still blocks the main thread). **Off switch:** `FIX_FALSE_POSITIVE_HOOKS_OFF=1`. Locked by `fix-false-positive-hooks.test.mjs` (16 tests).

### `hookbook-sync` · Stop
If a hook `.mjs` changed this turn but HOOKBOOK wasn't touched, or the "N hooks" headline drifts from the count registered in settings.json, blocks until you fix it. The system documents itself. **Config:** `HOOKBOOK_PATH`, `HOOK_SETTINGS_PATH`. **Override:** `HOOKBOOK_SYNC_OVERRIDE=1`.

### `discipline-sync` · Stop
The sibling of `hookbook-sync` for THIS published kit. On ANY hook work this turn it forces the full publish loop: every changed live hook (incl. its `*.test.mjs`) must be COPIED into the kit (a brand-NEW hook is flagged `missing` and must be published — no longer skipped), the kit's **README/docs must be updated** (a hook change must move the surface people read), neither the live `~/.claude` repo (hooks/settings) nor the kit repo may have uncommitted changes, AND the kit must be **pushed to GitHub** — once the rest is satisfied the hook AUTO-PUSHES the kit's branch (kit repo only; it runs git directly so it doesn't trip the push-permission guard) and blocks only if commits remain unpushed. So a guard never ships drifted from the version that runs, and "published" means actually on GitHub, not just committed locally. Only hooks REGISTERED in `settings.json` (or already in the kit) are forced in — an unregistered project-specific hook stays out of the portable kit instead of being false-flagged "missing"; the live-repo commit check still covers all your hook work. **Config:** `DISCIPLINE_KIT_DIR`. **Override:** `DISCIPLINE_NO_PUSH=1` (gate without auto-push) or `DISCIPLINE_SYNC_OVERRIDE=1`.

### `instrument-before-debug` · UserPromptSubmit + PreToolUse(Write|Edit|MultiEdit)
Forces "measure before fixing." A debugging-an-in-app-failure signal in your prompt (a pasted debug artifact, "still broken / doesn't work / wrong tier / routed to / you failed") opens a debug-gate; while it's open and no instrumentation has been added, BLOCKS any edit to source LOGIC that isn't itself logging (tests/docs/`/hooks/` exempt). An edit that adds a `console.log` / structured debug push clears the gate; so does an override. Kills the "ship a blind hypothesis-fix to an unobservable path, reload, repeat" loop — add the logging that captures WHY first. **Override:** `instrumented: <where>` or `instrument-override: <why>`.

### `global-hooks-only` · PreToolUse(Write|Edit|MultiEdit)
Hooks are global by default — blocks writing a hook implementation into a PROJECT-local `.claude/hooks/`, or registering one in a project `.claude/settings(.local).json`. Keeps the kit and its registration in `~/.claude` so every project gets the guard. **Override:** `local-hook-ok: <why>` or `LOCAL_HOOK_OK=1`.

### `chrome-only-testing-guard` · PreToolUse(Bash|PowerShell)
Project-scoped (gated on a project name in cwd): blocks installing or invoking Playwright in a repo that is meant to be tested only on its real loaded browser extension, not a Playwright stand-in. A template for "this repo has ONE real test harness, not a reimplementation." **Override:** `chrome-only-override: <why>` or `CHROME_ONLY_OVERRIDE=1`.

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

### `no-write-to-main` · PreToolUse(Bash)
Closes the shell-bypass gap in `no-commit-to-main`: blocks `cp`/`mv`/redirect/`tee` writes of code files into the repo while on `main`/`master`. Docs (`.md`/`.txt`) and non-repo paths (`/tmp`, temp dirs) are allowed. cp/mv judge the DESTINATION only — the last positional argument; earlier arguments are sources (reads). The old 2-arg pattern grabbed a source on multi-file copies and false-blocked `cp a.mjs b.mjs dest/` into another repo's branch (fixed 2026-07-01). **Override:** `WRITE_MAIN_OVERRIDE=1`. Locked by `no-write-to-main.test.mjs` (7 checks).

### `require-langdocs-read` · PreToolUse(Edit|Write|MultiEdit)
TWO gates. (1) **langdocs**: blocks edits in a language/DSL until its syntax/FAQ docs were Read this session (per-project `.claude/langdocs.json`). (2) **generic external-API gate**: blocks editing code with external-API signals (an `api.*` host, `/vN/...` path, `RTCPeerConnection`/`WebSocket`/`EventSource`, an SDK import like `openai`/`stripe`) unless the session shows a `WebFetch`/`WebSearch` — read the API's docs and audit the whole protocol BEFORE editing, instead of patching one server error per reload. Skips `*.test.*` and docs files (`.md`/`.txt`/`.rst` mention APIs, they don't integrate them); the `api` host signal requires `api` as its OWN word in the hostname (a bare substring false-positived on `fonts.googleapis.com` in a static HTML page, fixed 2026-07-01). **Override:** `api-docs-read: <why>` in the edit, or `API_DOCS_OVERRIDE=1` (API gate); `LANGDOCS_OVERRIDE=1` (langdocs gate). Locked by `require-langdocs-read.test.mjs` (8 checks).

### `delete-merged-branches` · PostToolUse(Bash|PowerShell)
After a `git merge`/`push` to `main`, auto-deletes every local branch whose commits are fully reachable from `main` — the "delete the branch" step that's easy to forget. Current, worktree-checked-out, and protected branches are never touched. **Disable:** `BRANCH_AUTODELETE_OFF=1`.

### `no-junk-files` · Stop
Blocks stop while throwaway/scratch files (`tmp-*`, `scan-*`, `probe-*`, stray `COMMIT_*.txt`, etc.) sit in the repo. **Override:** put `keep-junk: <reason>` in the reply.

### `never-idle` · Stop
Blocks stop while background work is still running (async Agents, background Bash, spawned tasks) — so you salvage their results instead of ending the turn on top of them. Clears automatically once the work completes.

### `husky-on-new-projects` · SessionStart
Nudges (never blocks) when a Node + git project has no husky installed — no git hooks means commits/pushes run no test gate. This is the second enforcement layer the README recommends pairing with.

### `rebuild-after-commit` · Stop
If the turn edited buildable source but the build output (`dist/`) is stale by content hash (or missing), blocks until you rebuild — a bundled app runs from the build, not the source. Ships with `lib/buildFingerprint.mjs`; pairs with `stamp-build-fingerprint`. **Override:** `rebuild-skip: <why>`.

### `stamp-build-fingerprint` · PostToolUse(Bash)
On a successful build command, records a content fingerprint of the source it was built from, so `rebuild-after-commit` proves staleness by hash instead of unreliable timestamps.

### `no-bullshit-tests` · PreToolUse(Write|Edit)
Blocks writing a test file whose only assertions are tautologies (`assert(true)`, `assert.equal(x, x)`) or a lone "is a function" smoke check — a test must assert behavior that could actually break. **Override:** `no-bullshit override: <reason>`.

### `docs-on-feature-commit` · PostToolUse(Bash) + Stop
Nudges after a non-docs commit, then blocks stop if the turn committed code but moved no documentation (front-door only: README or CHANGELOG — a docs/ file no longer counts). **(Fixed 2026-07-02, two bugs)** (1) a `cd <dir> && git commit` chain was checked against the session's cwd instead of the repo the commit actually landed in, so a commit made in a different repo entirely got nudged based on some unrelated repo's last commit — now resolves the real target repo (`cd`/`git -C` prefix), mirroring `no-commit-to-main`'s fix. (2) the "is this a docs commit" check scanned the ENTIRE command string, so a repo path merely containing the word "docs" (e.g. `.../docs-site/`, or a temp dir `docs-post-XXXX`) short-circuited every commit as exempt — now strips the `cd`/`-C` targeting prefix before checking commit intent. **Override:** `docs-skip: <why>` (or the word `docs` in the commit message). Locked by `docs-on-feature-commit.test.mjs` (14 checks).

### `lib/transcript.mjs` (shared helper — not a registered hook)
The canonical transcript/stdin helpers — `readHookEvent`, `readTranscript`, `roleOf`, `contentBlocks`, `toolUsesOf`, `toolResultText`, `isHumanPrompt`, `currentTurnEntries`, `lastAssistantText` — that Stop/PostToolUse hooks import via `./lib/transcript.mjs` instead of re-implementing. `currentTurnEntries` here is the bug-fixed version (it walks back to the last *human* prompt, so early-turn tool results aren't dropped); `lastAssistantText` accepts either a transcript path or an already-parsed entries array.

---

## The override philosophy

Every gate has an escape hatch on purpose. A hook with no override trains people to disable the whole hook the first time it's wrong — and then it protects nothing. The override is a one-time, intentional "yes, I mean it," not a way of life. If you find yourself reaching for the same override every session, that's a signal to tune the hook's trigger, not to keep dismissing it.
