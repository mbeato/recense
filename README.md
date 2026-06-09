# brain-memory

A brain-inspired memory engine for AI agents. It runs a two-store system (fast episodic + slow semantic graph + vector) that does more than recall facts — it **learns**: it abstracts general schemas from experience, reasons over them to handle novel situations, and updates stored beliefs the way the brain does (prediction-error-gated reconsolidation) instead of accumulating stale duplicates.

This is **open-source, self-hosted, single-user, bring-your-own-keys**. You clone it, wire your own API keys, and run it on your own machine. It is NOT a hosted product — no data ever leaves your machine to a brain-memory service.

---

## Prerequisites

- **Node.js 22 or later** — required for the native module (better-sqlite3 ABI)
- **Anthropic API key** — Claude compose + judge heads
- **OpenAI API key** — embedding head

Optional (macOS only):
- **Telegram bot token** — always-on query bot; create one via [@BotFather](https://t.me/BotFather)

---

## Install

```sh
git clone https://github.com/<owner>/brain-memory.git
cd brain-memory
npm install
npm run init
```

`npm run build` compiles the TypeScript source to `dist/`. `npm run init` runs the build then launches `brain init` — a guided wizard that:

1. Prompts for your DB path (where `brain.db` will live)
2. Collects and live-validates your API keys
3. Captures the correct `node` binary path (required by the scheduler and hooks — BRAIN_MEMORY_NODE_BIN)
4. Writes `~/.config/brain-memory/sleep.env` (`chmod 600`)
5. Registers the sleep-pass scheduler (macOS: launchd; Linux: prints `brain scheduler run` guidance)
6. Wires the three Claude Code hooks into `~/.claude/settings.json`
7. Optionally seeds from an existing `MEMORY.md` (`[y/N]` — default No)

`brain init` is idempotent — re-run it to update keys or recapture the node binary after switching Node versions.

After init, verify the install:

```sh
brain doctor
```

---

## Command reference

| Command | Description |
|---------|-------------|
| `brain init` | Guided bootstrap wizard — run once after clone, or re-run to update config |
| `brain doctor` | Health audit: DB, API keys, scheduler, hooks, Node ABI |
| `brain scheduler install` | macOS: register the launchd sleep-pass agent. Linux: prints `brain scheduler run` guidance |
| `brain scheduler status` | Check whether the scheduler is registered / running |
| `brain scheduler run` | Linux: start hourly sleep-pass in the foreground (stops when the process exits) |
| `brain recall` | Query memory from the command line |
| `brain seed` | One-shot cold-start seed from existing memory files |
| `brain ingest` | Run the source adapter pass (email, transcripts, Obsidian vault) |
| `brain sleep-pass` | Run one consolidation pass immediately |
| `brain snapshot` | Export a DB snapshot |
| `brain watcher` | Start the Telegram / iMessage query watcher (macOS only) |
| `brain hook session-start \| turn-capture \| stop` | Claude Code hook handlers — wired automatically by `brain init` |

---

## Supported platforms

| Platform | Scheduler | Claude Code hooks | Query channel |
|----------|-----------|-------------------|---------------|
| **macOS** (full support) | launchd — always-on, survives reboots | ✓ | Telegram (launchd KeepAlive) · iMessage (optional, see [below](#optional-imessage-channel-advanced)) |
| **Linux** | `brain scheduler run` — foreground, stops with process¹ | ✓ | — (channel watcher is macOS-only in v2.0) |
| **Windows** | WSL — community-supported² | WSL | WSL |

¹ **Linux scheduler caveat:** `brain scheduler run` starts an hourly croner tick in the foreground. The process stops when your terminal session ends — there is no background daemon or reboot-survival on Linux in v2.0. Reboot-survival via a systemd unit is planned for v2.1. Until then, restart `brain scheduler run` manually after reboots.

² **Windows:** Native Windows is out of scope. Run under WSL2 — the engine, hooks, and foreground scheduler work; the channel watcher (Telegram/iMessage) behaves as on Linux (not supported in v2.0).

---

## BYO-keys

`brain init` creates and writes `~/.config/brain-memory/sleep.env` with `chmod 600`. **You do not need to create this file manually** unless you prefer to skip the wizard.

If you set it up manually, create `~/.config/brain-memory/sleep.env` (`chmod 600`) with:

```sh
ANTHROPIC_API_KEY=your-anthropic-key-here
OPENAI_API_KEY=your-openai-key-here
```

For the Telegram channel (macOS), also add:

```sh
BRAIN_MEMORY_TELEGRAM_TOKEN=123456:ABC-your-bot-token-here
```

Keys are never logged or stored outside this file. The scheduler and hooks read keys from the environment at runtime via the SDK defaults.

---

## Cold-start seed

Before the sleep pass can consolidate anything there must be nodes in the graph. `brain init` offers a one-shot seed at the end of the wizard (`[y/N]` — default No). You can also run it later:

```sh
brain seed
```

The seed reads your existing memory files (configured via `BRAIN_MEMORY_COLD_START_MEMORY_DIR` and `BRAIN_MEMORY_COLD_START_CLAUDE_FILE`), extracts entity and fact claims, and writes them into the SQLite graph.

### Semantics

**One-shot:** once the seeder finishes successfully it sets a `seeded` meta flag. Re-running against the same database is a no-op — it exits 0 without re-extracting anything.

**Safe no-op on misconfiguration:** if neither source path resolves to any files (e.g. you ran it before setting the env vars), the seeder exits 0 *without* burning the one-shot flag. Fix the paths and re-run.

**Lock-guarded:** `brain seed` acquires the shared single-writer lock before opening the database. It is safe to run while the Telegram watcher or the hourly sleep-pass is active — they will wait or skip their cycle rather than colliding.

---

## Telegram channel setup

The Telegram channel is the recommended query surface on macOS. You DM your bot a question and get a memory-grounded answer.

> **macOS only.** The always-on watcher (`brain watcher` / `setup-watcher.sh`) uses launchd and is not supported on Linux in v2.0.

### Step 1 — Create a bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. BotFather gives you a token that looks like `123456:ABC-telegram-token` — copy it

### Step 2 — Get your numeric user ID

Message [@userinfobot](https://t.me/userinfobot) on Telegram. It replies with your numeric user ID (e.g. `123456789`). You will need this for the allowlist.

### Step 3 — Put the token in sleep.env

Add the line to `~/.config/brain-memory/sleep.env`:

```sh
BRAIN_MEMORY_TELEGRAM_TOKEN=123456:ABC-your-bot-token-here
```

### Step 4 — Configure the channel in `src/lib/config.ts`

Open `src/lib/config.ts` and find the `telegram` section in `DEFAULT_CONFIG`. Set:

```ts
telegram: {
  enable: true,
  allowlist: [123456789],   // your numeric Telegram user ID
  pollIntervalMs: 2_000,
},
```

**The allowlist is fail-closed.** An empty `allowlist` (`[]`) means the watcher answers no one — it starts fully silent until you add at least one ID. Unlisted senders are silently ignored; no reply is sent, so the surface never confirms it exists to an unknown sender.

After editing, rebuild: `npm run build`.

### Step 5 — Install the always-on watcher

```sh
bash scripts/setup-watcher.sh
```

`setup-watcher.sh` does the following:

1. Builds the project (`npm run build`) and verifies the compiled watcher CLI exists
2. Adds `BRAIN_MEMORY_WATCHER_JS` to `~/.config/brain-memory/sleep.env` (additive — does not clobber your existing API keys or token)
3. Renders the launchd plist template, lints it with `plutil`, and bootstraps the `com.brain-memory.watcher` KeepAlive job via `launchctl`
4. Prints rollback instructions

The watcher runs as a `KeepAlive` job — launchd restarts it automatically if it exits.

Alternatively, run it directly in a terminal (with sleep.env sourced):

```sh
source ~/.config/brain-memory/sleep.env
node dist/src/adapter/watcher-cli.js --db /Users/<you>/.config/brain-memory/brain.db
```

### Step 6 — Verify

DM your bot a question. You should receive a reply within a few seconds. Schema-grounded inferences carry a trailing `(inferred)` marker; direct fact recalls are unmarked.

To check the watcher log:

```sh
tail -f /tmp/brain-memory-watcher.log
```

Note: the bot only answers while your Mac is awake — this is a local self-hosted service, not a cloud process.

---

## Privacy stance

brain-memory is a **read-only query surface**. It answers questions from allowlisted senders; it never ingests your message history. The only write the watcher performs per query is an ephemeral inferred episode logged under the single-writer lock (origin `inferred`, salience 0, never promoted to a graph fact). Your conversation history is never read by the memory engine — the channel delivers only the inbound question text.

---

## Optional: iMessage channel (advanced)

The iMessage channel is macOS-only and requires Full Disk Access for the `node` binary to read `~/Library/Messages/chat.db`.

**Important caveat:** if you use your own phone number on the same Apple ID as the Mac, the watcher will see its own outbound replies as new inbound messages — a self-echo loop. To avoid this, the iMessage channel realistically needs a dedicated Apple ID with a separate handle. This is why the Telegram channel is the recommended surface.

To use iMessage:

1. Grant Full Disk Access to your `node` binary: **System Settings → Privacy & Security → Full Disk Access**, add `$(which node)`
2. In `src/lib/config.ts`, set `channel.enable = true`, `channel.chatDbPath`, and `channel.allowlist` with your E.164 handle(s) or Apple ID email(s)
3. Rebuild: `npm run build`
4. Re-run `bash scripts/setup-watcher.sh` — the watcher auto-selects iMessage when Telegram is not configured

---

## License

MIT — see [LICENSE](LICENSE).
