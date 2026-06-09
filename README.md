# brain-memory

A brain-inspired memory engine for AI agents. It runs a two-store system (fast episodic + slow semantic graph + vector) that does more than recall facts — it **learns**: it abstracts general schemas from experience, reasons over them to handle novel situations, and updates stored beliefs the way the brain does (prediction-error-gated reconsolidation) instead of accumulating stale duplicates.

This is **open-source, self-hosted, single-user, bring-your-own-keys**. You clone it, wire your own API keys, and run it on your own machine. It is NOT a hosted product — no data ever leaves your machine to a brain-memory service.

---

## Requirements

- **macOS** — the iMessage channel reads `~/Library/Messages/chat.db`, which is macOS-only. The core engine and sleep pass run on any platform with Node; the iMessage channel requires macOS.
- **Node.js** 18 or later
- **Anthropic API key** (Claude — for compose + judge heads)
- **OpenAI API key** (for embedding head)

You supply both keys. See [BYO-keys](#byo-keys) below.

---

## Install and build

```sh
npm install
npm run build
```

Compiled entry points land in `dist/`. The launchd setup scripts reference these paths.

---

## BYO-keys

Keys live in a gitignored env file — never in source code or config literals.

Create `~/.config/brain-memory/sleep.env` (chmod 600):

```sh
mkdir -p ~/.config/brain-memory
touch ~/.config/brain-memory/sleep.env
chmod 600 ~/.config/brain-memory/sleep.env
```

Add your keys:

```sh
ANTHROPIC_API_KEY=your-anthropic-key-here
OPENAI_API_KEY=your-openai-key-here
```

Replace the placeholder values with your real keys. The launchd wrappers source this file at startup; the Node processes read keys from environment via the SDK defaults. Keys are never logged or stored elsewhere.

---

## iMessage channel setup

The iMessage channel lets you text a question from an allowlisted handle and get a memory-grounded answer back. It runs as a long-running launchd watcher (`KeepAlive`) that polls `chat.db` and replies via AppleScript.

### Step 1 — Grant Full Disk Access

The watcher reads `~/Library/Messages/chat.db` directly. macOS requires Full Disk Access for any process that touches the Messages database.

1. Open **System Settings** → **Privacy & Security** → **Full Disk Access**
2. Click **+** and add your terminal app (e.g. Terminal, iTerm2) **and** the `node` binary you intend to use (find it with `which node`)
3. If you use a version manager (nvm, mise, volta), add the specific node binary path — the symlink alone is not enough on some macOS versions

Without Full Disk Access the watcher exits immediately with a permissions error. This is the expected fail-closed behavior.

### Step 2 — Configure the channel in `src/lib/config.ts`

Open `src/lib/config.ts` and find the `channel` section in `DEFAULT_CONFIG`. Set:

```ts
channel: {
  enable: true,
  chatDbPath: '/Users/<you>/Library/Messages/chat.db',
  allowlist: ['+1XXXXXXXXXX'],   // add your own handle(s) here
  pollIntervalMs: 2_000,
},
```

**The allowlist is fail-closed by default.** An empty `allowlist` (`[]`) means the watcher answers no one — it starts fully silent until you add at least one handle. Unlisted senders are silently ignored; no reply is sent, so the surface never confirms it exists to an unknown sender.

Handles are matched against `handle.id` in `chat.db`. Use the same format that appears there — typically E.164 for phone numbers (e.g. `+1XXXXXXXXXX`) or an email address for Apple ID contacts (e.g. `you@example.com`).

After editing, rebuild: `npm run build`.

### Step 3 — Run the setup script

```sh
bash scripts/setup-imessage-channel.sh
```

`setup-imessage-channel.sh` does the following:

1. Builds the project (`npm run build`) and verifies the compiled watcher CLI exists
2. Adds `BRAIN_MEMORY_WATCHER_JS` to `~/.config/brain-memory/sleep.env` (additive — does not clobber your existing API keys)
3. Renders the launchd plist template, lints it with `plutil`, and bootstraps the job via `launchctl`
4. Prints rollback instructions and a reminder to verify Full Disk Access

The watcher runs as a `KeepAlive` job — launchd restarts it automatically if it exits.

### Step 4 — Verify

Text a question from an allowlisted handle. You should receive a reply within a few seconds. Schema-grounded inferences carry a trailing `(inferred)` marker; direct fact recalls are unmarked.

To check the watcher log:

```sh
tail -f /tmp/brain-memory-imessage.log
```

---

## Privacy stance

brain-memory is a **read-only query surface** for iMessage. It answers questions from allowlisted senders; it never ingests your message history. Passive conversation watching/ingestion is explicitly rejected — iMessage is a channel, not a source. The only write the watcher performs is an ephemeral inferred episode logged under the single-writer lock (origin `inferred`, salience 0), which is never promoted to a graph fact. Your conversation history stays in `chat.db` and is never read by the memory engine except to detect the inbound question text.

---

## License

MIT — see [LICENSE](LICENSE).
