# AGENT-HANDOFF — guard-fp-kit-sync

**GOAL:** Sync two FIXED guardrail hooks (`no-commit-to-main.mjs`, `unsafe-main-ref-write-guard.mjs`)
from `~/.claude` HEAD (bbca06c) into the claude-discipline KIT byte-identical, and add kit-variant
regression tests for the 2026-07-06 quoted-prose + heredoc/comment false-positive fix.

**DONE:**
- Cut isolated worktree `fix/guard-fp-sync` from kit main (aee4625 / branch base d7623b3). Other
  session's WIP on primary (discipline-sync, require-learnings-ack) left UNTOUCHED and un-staged.
- KEY FINDING: the on-disk `~/.claude` working-tree `no-commit-to-main.mjs` was polluted by ANOTHER
  session that STRIPPED the heredoc/comment neutralization (`neutralizeNonExecutableRegions`). Synced
  from `git show HEAD:` (bbca06c), which KEEPS it — byte-identical to the committed blob (LF, which is
  the kit index convention: `i/lf w/crlf` across all kit hooks).
- Both hooks copied byte-identical (sha256 vs `git show HEAD` matched: no-commit 4183e86d, unsafe-ref 3106c7c0).
- Red-first PROVEN: pre-fix kit hooks (kit HEAD, no quote-mask / no heredoc pass) DENY all FP inputs;
  synced hooks PASS them (empty stdout).
- Added regression cases: no-commit-to-main +5 (quoted prose, quoted arg to another program, heredoc
  BODY, `#` comment, TEETH real-commit-still-blocks); unsafe-ref +4 (quoted prose, quoted arg, read-only
  `git status -- x-main-y.mjs`, TEETH real-ref-write-still-blocks).
- Both kit test files GREEN: no-commit-to-main 23/23, unsafe-ref 18/18 (41/41 combined).
- HOOKBOOK.md both rows updated: 2026-07-06 FP note + corrected test counts (23 / 18; were 18 / 14).

**NEXT:** squash autocommit WIP → one clean commit (explicit-path staging, never `git add -A`) →
safe-merge-to-main.sh with the two-file test command → delete branch. No push (DISCIPLINE_NO_PUSH=1).

**BLOCKER:** none.

STATUS: DONE
