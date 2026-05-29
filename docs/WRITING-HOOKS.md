# Writing Hooks

How to write your own Claude Code hook in the style of this kit. Read [PHILOSOPHY.md](PHILOSOPHY.md) first for *when* to make a hook; this is the *how*.

## Anatomy of a hook

A hook is a script Claude Code runs at a lifecycle event. It receives a JSON event on **stdin** and communicates back via **exit code** and/or **stdout JSON**. Every hook in this kit is a dependency-free `.mjs`:

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function main() {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); }            // fail open — never wedge CC

  // ... inspect event, decide ...

  process.exit(0);                       // allow
}

main();
```

`readFileSync(0, ...)` reads file descriptor 0 (stdin). The `|| '{}'` and the `try/catch` are the fail-open guarantee: a malformed event must let the action through, not crash.

## The events you'll use

| Event | Fires | You get | You can |
|-------|-------|---------|---------|
| `PreToolUse` | before a tool runs | `tool_name`, `tool_input` | **deny** the call |
| `PostToolUse` | after a tool runs | `tool_name`, `tool_input`, `tool_response` | inject context, drop a marker |
| `Stop` | the agent is about to end its turn | `transcript_path`, `stop_hook_active` | **block** the stop, inject context |
| `SessionStart` | a session begins | (minimal) | inject context |
| `UserPromptSubmit` | the user sends a prompt | `prompt` | inject context |

Match the event to your goal: stop a bad action *before* it happens → `PreToolUse`. React to what a tool produced → `PostToolUse`. Enforce something about the whole turn (a footer, a green suite) → `Stop`.

## The two block shapes

There are two distinct "no" outputs, and using the wrong one silently does nothing:

**PreToolUse — deny a tool call:**
```js
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'why, and how to proceed',
  },
}));
process.exit(0);
```

**Stop — block the turn from ending:**
```js
process.stdout.write(JSON.stringify({ decision: 'block', reason: 'why, and how to clear it' }));
process.exit(0);
```

To **allow**, write nothing and `exit(0)`. To **inject context** (not block) on PostToolUse/SessionStart/UserPromptSubmit, use `hookSpecificOutput.additionalContext`.

> The `reason`/`permissionDecisionReason` string is the entire UX of your hook. Write it like a good error message: say what tripped, *why it matters*, exactly how to satisfy the gate, and the override. A block with a vague reason just frustrates.

## The marker pattern (enforcing a rule that spans events)

Some rules can't be checked at a single moment — "a test failed earlier, so you can't stop until it's green" spans a PostToolUse and a later Stop. The pattern: one hook **drops a small marker file**; another hook **blocks while it exists**; some action **clears it**.

```js
// PostToolUse: a test failed → drop a marker
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const markerPath = join(projectRoot, '.claude', 'state', 'tests-failing.json');
mkdirSync(join(projectRoot, '.claude', 'state'), { recursive: true });
writeFileSync(markerPath, JSON.stringify({ ts: Date.now(), names }));

// Stop: marker exists → block
import { existsSync } from 'node:fs';
if (existsSync(markerPath)) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: '…fix the tests…' }));
}

// later — a full green run clears it
import { rmSync } from 'node:fs';
rmSync(markerPath, { force: true });
```

`tests-must-pass`, `learnings-error-match` + `require-learnings-ack`, and `handoff-continuity` are all built this way. Always give the marker a **TTL** (ignore/drop it after N hours) so a stale marker can never block forever.

## Reading the transcript

`Stop` hooks get `transcript_path` — a JSONL file, one event per line. To check "did this turn write code" or "did the last reply cite a screenshot," walk it backwards and parse each line. The robust shape:

```js
const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
for (let i = lines.length - 1; i >= 0; i--) {
  let entry; try { entry = JSON.parse(lines[i]); } catch { continue; }
  if (entry.type !== 'assistant') continue;
  const blocks = entry.message?.content || [];
  // blocks are { type: 'text' | 'tool_use' | 'tool_result', ... }
}
```

Define a "turn" as everything since the previous `user` message, so you only inspect the work being judged.

## Gotchas this kit learned the hard way

- **A pattern hook false-fires on its own subject.** A hook that bans a phrase trips the moment that phrase appears — including in its own reason string, or in your documentation *of the hook*. (This very file got blocked while describing exactly this gotcha.) Give every blocking hook a dismiss token — a literal string that, if present, exempts the text — and keep the trigger as specific as you can.
- **Don't bail on `stop_hook_active` if your Stop hook uses a marker.** When another Stop hook blocks first, the re-evaluation sets `stop_hook_active=true`. A hook that bails on that flag will skip its check and let changes slip through. It can't loop forever as long as clearing the marker is what stops the block.
- **Windows: write hooks as UTF-8 *without* a BOM.** A leading BOM (`0xFEFF`) makes `node --check` choke on the `#!` shebang even though the file runs fine. Use the Write tool or `fs.writeFileSync`, not PowerShell `Out-File`/`Set-Content` (which add a BOM).
- **Make paths and thresholds env-configurable.** A hook hardcoded to your repo layout won't survive being shared. Defaults plus an env override (`ROOT_CAUSE_FILES`, `READ_BEFORE_WRITE_LINES`, `HOOKBOOK_PATH`) is the difference between "my hook" and "a hook."
- **`cwd` is the project root, not your `-C` target.** A hook that shells out to `git` sees the *session's* repo, not whatever directory your command names. Resolve the project root from the event's file path or `cwd` when you need a specific repo.

## Registering and testing

Add the hook to `settings.json` under the right event (the installer's `settings.fragment.json` shows the shape: `{ "type": "command", "command": "node ~/.claude/hooks/<name>.mjs", "timeout": 5 }`, optionally with a `matcher`).

Test it before you trust it — pipe a fake event in and watch the output:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' | node hooks/block-dangerous-commands.mjs
# expect: {"hookSpecificOutput":{...,"permissionDecision":"deny",...}}

echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf node_modules"}}' | node hooks/block-dangerous-commands.mjs
# expect: (nothing) — the allow path
```

And always `node --check hooks/<name>.mjs` to catch a BOM or syntax slip before it ships.
