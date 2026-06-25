# HANDOFF — claude-discipline

_Parachute, not diary. Last updated this session._

## State
- **No code in flight.** Working tree clean at `c0f067b`.
- This session was a single Q&A turn — no build work started.

## Pending decision (waiting on Russell)
Russell asked what lessons to steal from Ishaan Sehgal's **"The Log Is the Agent"** (Omnara) for his **handoff skills**. I answered and offered to implement. Awaiting yes/no on:

1. **Fold 4 lessons into the handoff skill** (`.claude/skills/handoff` or equiv):
   - HANDOFF.md = lossy *compaction*, not source of truth → make it a **pointer** into durable artifacts (transcript JSONL + git + priority-queue.md + root-cause-analysis.md); raw wins on conflict.
   - **Resumability litmus**: could a fresh Haiku reconstruct WHERE + WHY from this alone?
   - Capture **mid-flight tool state**, not just done/next (the "died at a permission prompt" failure).
   - Dedicated **"already committed to the world (irreversible)"** section (pushed commits, sent msgs, branches).
   - Consider **append-only dated checkpoints** instead of clobbering HANDOFF.md.
2. **Fix the SessionStart hook line** that says *"treat HANDOFF.md as the source of truth"* — the article argues that's backwards; it's a projection, not the log.

## Next action if Russell says yes
Locate the handoff skill file + the hook that emits the "source of truth" line, then edit both.
