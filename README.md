# brain-memory

A brain-inspired memory engine for AI agents. It runs a two-store system (fast episodic + slow semantic graph + vector) that does more than recall facts — it **learns**: it abstracts general schemas from experience, reasons over them to handle novel situations, and updates stored beliefs the way the brain does (prediction-error-gated reconsolidation) instead of accumulating stale duplicates.

This is **open-source, self-hosted, single-user, bring-your-own-keys**. You clone it, wire your own API keys, and run it on your own machine. It is NOT a hosted product — no data ever leaves your machine to a brain-memory service.

---

## Requirements

- **Node.js** 18 or later — the core engine, sleep pass, and Telegram channel are platform-agnostic
- **Anthropic API key** (Claude — for compose + judge heads)
- **OpenAI API key** (for embedding head)
- **Telegram bot token** — create a bot via [@BotFather](https://t.me/BotFather) to get one

The Telegram channel uses the bot API (HTTPS polling) and requires no macOS-specific APIs. The optional iMessage channel is macOS-only; see [below](#optional-imessage-channel-advanced).

---

## Install and build

```sh
npm install
npm run build
```

Compiled entry points land in `dist/`. The launchd setup script references these paths.

---

## BYO-keys

Keys and the bot token live in a gitignored env file — never in source code or config literals.

Create `~/.config/brain-memory/sleep.env` (chmod 600):

```sh
mkdir -p ~/.config/brain-memory
touch ~/.config/brain-memory/sleep.env
chmod 600 ~/.config/brain-memory/sleep.env
```

Add your keys and token (replace placeholder names with real values — never commit this file):

```sh
ANTHROPIC_API_KEY=your-anthropic-key-here
OPENAI_API_KEY=your-openai-key-here
BRAIN_MEMORY_TELEGRAM_TOKEN=123456:ABC-your-bot-token-here
```

The launchd wrapper sources this file at startup; the Node processes read keys from environment via the SDK defaults. Keys are never logged or stored elsewhere.

---

## Telegram channel setup

The Telegram channel is the recommended query surface. You DM your bot a question and get a memory-grounded answer. A bot has its own Telegram identity, so there is no self-echo loop.

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
