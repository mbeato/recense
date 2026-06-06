# brain-memory dogfood setup

Cutover runbook for the founder as customer-zero (ADAPT-01/02, D-33 reversibility).

The engine replaces the flat MEMORY.md as the *injection source* — but you must never delete
MEMORY.md. The physical file stays on disk as a fallback/safety net at all times. If retrieval
misbehaves, drop the hooks and Claude Code falls back to the file immediately (D-33).

---

## Prerequisites

- Node.js active on PATH (nvm recommended — run `nvm use <version>` first)
- API keys set: `OPENAI_API_KEY` (for embeddings) and `ANTHROPIC_API_KEY` (for consolidation)
- (Optional) `BRAIN_MEMORY_DB` exported if the cold-start-seeded DB is not at
  `$PROJECT_ROOT/brain.db`

---

## Installation

### Step 1 — Run the setup script

```
bash scripts/setup-dogfood.sh
```

The script (idempotent — safe to re-run):

1. Runs `npm run build` → `dist/`
2. Renders `scripts/com.brain-memory.sleep-pass.plist.template` into
   `~/Library/LaunchAgents/com.brain-memory.sleep-pass.plist` (substitutes your absolute
   node binary path, sleep-pass-cli.js path, and DB path)
3. Validates the plist with `plutil -lint` and loads it via `launchctl load`
4. Prints the three hook JSON entries to copy-merge into `~/.claude/settings.json`

### Step 2 — Merge hooks into `~/.claude/settings.json`

The script prints a JSON block. Copy-merge the three hook entries into the `"hooks"` section
of your existing `~/.claude/settings.json`. **Do not replace the entire file** — append each
entry to the existing array for that hook event.

Resulting shape (your existing hooks stay intact):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/abs/path/node /abs/path/dist/src/adapter/session-start-cli.js",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/abs/path/node /abs/path/dist/src/adapter/turn-capture-cli.js",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/abs/path/node /abs/path/dist/src/adapter/stop-cli.js",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

All paths and `timeout: 5` are printed by the script with your real absolute paths substituted.

### Step 3 — Confirm launchd loaded

```
launchctl list | grep brain-memory
```

Expected: one line with `com.brain-memory.sleep-pass` and PID `-` (not running yet, waiting
for its next StartCalendarInterval trigger). A `0` in the exit-status column is correct.

---

## MEMORY.md double-injection check

After registering the hooks, start a **new** Claude Code session and check whether the raw
MEMORY.md content appears alongside the engine's `additionalContext` block. Two outcomes:

### Outcome A — no double-inject (content appears once, engine-formatted)

Nothing to do. Leave MEMORY.md exactly as-is.

### Outcome B — double-inject (raw MEMORY.md text appears AND engine block appears)

Claude Code's built-in MEMORY.md inject is firing in addition to the SessionStart hook.
Neutralize the auto-inject **without deleting the file** (you must never delete MEMORY.md — D-33):

1. Back up the file:
   ```
   cp MEMORY.md MEMORY.md.bak
   ```
2. Replace the content with a single comment line so the auto-inject loads a benign stub:
   ```
   echo '# [managed by brain-memory engine — see docs/dogfood-setup.md]' > MEMORY.md
   ```
3. Start another new session. Confirm only the engine block appears.
4. The original content is in `MEMORY.md.bak` for manual recovery if needed.

The physical MEMORY.md file is never deleted — it remains as the fallback (D-33). After rollback
the file is still there and Claude Code's auto-inject resumes loading it immediately.

### Checking hook logs

```
tail -50 /tmp/brain-memory-hook-errors.log
tail -50 /tmp/brain-memory-sleep.log
```

The hook-errors log captures errors from session-start-cli, turn-capture-cli, and stop-cli.
The sleep log captures output from the hourly launchd pass and detached sleep-pass runs.

---

## Rollback

To stop using the engine and revert to MEMORY.md at any time:

1. Remove the three brain-memory entries from `~/.claude/settings.json`:
   - `SessionStart` → `session-start-cli.js`
   - `UserPromptSubmit` → `turn-capture-cli.js`
   - `Stop` → `stop-cli.js`
2. Unload the launchd agent:
   ```
   launchctl unload ~/Library/LaunchAgents/com.brain-memory.sleep-pass.plist
   ```
3. (Optional) Remove the plist file:
   ```
   rm ~/Library/LaunchAgents/com.brain-memory.sleep-pass.plist
   ```

**MEMORY.md is never deleted by the engine or these rollback steps.** After rollback,
Claude Code's built-in injection uses MEMORY.md as-is. If you ran the double-inject
neutralization (Outcome B above), restore from the backup:
```
cp MEMORY.md.bak MEMORY.md
```

The brain-memory DB is also unaffected — all stored nodes and episodes are preserved.
Re-register the hooks at any time to resume using the engine.

---

## Manual sleep-pass trigger (for testing)

To run consolidation immediately without waiting for the hourly launchd tick:

```
launchctl start com.brain-memory.sleep-pass
```

Or directly via node (requires BRAIN_MEMORY_DB set):

```
node dist/src/adapter/sleep-pass-cli.js
```

---

## Troubleshooting

### No engine context at session start

- Confirm the three hook entries are in `~/.claude/settings.json` with absolute paths.
- Run `tail /tmp/brain-memory-hook-errors.log` for errors.
- Confirm `dist/src/adapter/session-start-cli.js` exists (`npm run build` if missing).
- Confirm `BRAIN_MEMORY_DB` points at the right DB (or `brain.db` exists in the project root).

### Sleep pass not running

- Check `tail /tmp/brain-memory-sleep.log` — look for "complete" or error lines.
- Verify launchd loaded: `launchctl list | grep brain-memory`
- Re-run setup: `bash scripts/setup-dogfood.sh` (idempotent).
- Check API keys: `echo $OPENAI_API_KEY $ANTHROPIC_API_KEY` (both must be non-empty).

### Plist failed to load

- Validate XML: `plutil -lint ~/Library/LaunchAgents/com.brain-memory.sleep-pass.plist`
- The setup script validates the plist before loading; if it passed there, check permissions:
  `ls -la ~/Library/LaunchAgents/com.brain-memory.sleep-pass.plist`

### Hook takes too long / times out

- Session-start retrieval is pure synchronous SQLite (~100-150ms expected). If it exceeds
  the 5-second timeout, check `tail /tmp/brain-memory-hook-errors.log`.
- A timeout logs an error and the engine injects an empty context (`additionalContext: ""`).
  Claude Code falls back to MEMORY.md if that file is non-empty. No data is lost.
