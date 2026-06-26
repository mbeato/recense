<p align="center">
  <img src="docs/assets/recense-logo.png" width="104" alt="recense logo">
</p>

<h1 align="center">Recense</h1>

<p align="center">
  <img src="docs/assets/recense-demo.webp" alt="recense — real recall pathways firing across the memory graph, rendered as a brain" width="600">
  <br>
  <em>Real recall pathways firing across the memory graph, rendered live by <code>recense viz</code></em>
</p>

Memory that stays correct. When a fact changes, recense updates the existing belief in place rather than keeping both versions and hoping retrieval picks the right one. The old value is tombstoned and the change is auditable.

Self-hosted from a single SQLite file, single-user, bring-your-own-keys. You clone it, add your own API keys, and run it on your own machine. Nothing is sent to a recense service; there is no recense service.

```sh
git clone https://github.com/mbeato/recense.git && cd recense
npm install
recense init     # prompts for your API keys, validates them live, writes ~/.config/recense/sleep.env
```

Runs on macOS and Linux. The engine, CLI, Claude Code hooks, and MCP server are cross-platform; the always-on scheduler, chat channels, and tray app are macOS-only today (see [Supported platforms](#supported-platforms)).

---

## How it compares

Most memory libraries are open source and run locally, so that isn't the pitch. mem0, Graphiti, Letta, Cognee, and Supermemory all do the same. Three things actually distinguish recense.

**One SQLite file, nothing to operate.** The graph, the vectors (via sqlite-vec), and the episodic log live in a single file in one Node process. The graph-backed alternatives expect you to run infrastructure first: Neo4j or FalkorDB for Graphiti and Memary, Postgres plus a graph and vector store for Cognee, Postgres for Letta. recense is clone-and-run. Everyone runs locally; recense is the one with nothing to stand up.

**It corrects beliefs instead of stacking them.** When a fact changes, a contradiction triggers a judge, the old belief is tombstoned, and the new one replaces it. Provenance keeps the engine's own output from re-entering as evidence, so recalls can't inflate into duplicates. Zep and Graphiti handle correctness well too, with bi-temporal edge invalidation that's more battle-tested than this engine; the distinction is that recense rewrites the belief on prediction error rather than appending a new edge. Benchmarks are below. Most other libraries are append-only or dedup-only.

**You can watch it recall.** `recense viz` renders retrieval as it happens: real pathways lighting up across the graph, on your machine, in the package. The clip at the top is an actual run. A few systems ship interactive graph views, Supermemory's being the closest open-source one, but a live activation render you run yourself is not something they offer.

It's early. recense runs daily as the author's own Claude Code memory and the eval suite is still growing, so treat the numbers below as a floor, not a ceiling.

---

## The problem with AI memory

| The complaint | What recense does instead | Evidence |
|---------------|---------------------------|----------|
| Stale facts coexist with new ones; memory never corrects itself ([mem0 #4896](https://github.com/mem0ai/mem0/issues/4896): semantically contradictory facts stored side by side, MD5 dedup only) | A contradiction triggers a judge call; the old belief is tombstoned and the new one is written, so one belief survives instead of two | EVAL-02: belief-correction suite |
| Self-confirmation loops inflate noise ([mem0 #4573](https://github.com/mem0ai/mem0/issues/4573): one hallucinated fact became 808 duplicates because recalled output was re-extracted as new input) | The engine's own inferred output never counts as evidence, so the loop can't form. A `source_inference_id` flag blocks it at the write path | Architecture invariant |
| Junk accumulates without limit: a boot file restated 200+ times, 97.8% junk rate in production (mem0 #4573) | Repeated inputs strengthen the existing node's confidence score instead of inserting copies; strength-based decay prunes what goes unused | EVAL-02 stale-recall and duplicate-count metrics |
| No forgetting, no decay; stale entries degrade retrieval over time ([mem0 #5330](https://github.com/mem0ai/mem0/issues/5330)) | Strength-based lazy decay fades unused facts. Eviction requires both zero evidence and below-threshold strength, so an evidence-backed fact is never deleted | Decay invariant |
| Stores facts but doesn't learn: "user prefers Python" saved 100 times with no pattern abstraction ([Ask HN](https://news.ycombinator.com/item?id=46891715)) | The sleep pass abstracts recurring patterns into schema nodes, generalizations the user never stated explicitly, and applies them to new cues | Sleep-pass consolidation |

---

## Benchmark results

See [docs/evals.md](docs/evals.md) for full methodology, case-set description, judge-validation evidence, and caveats.

| Eval | recense | Comparison | Methodology | Run date | Repro |
|------|---------|------------|-------------|----------|-------|
| LongMemEval-S, knowledge-update subset (n=78, end-to-end QA) | **69.2%** (54/78) | Full-context Haiku: **79.5%** (same questions, same answer model, same scorer, measured by us); agentmemory: 95.2% (self-reported, retrieval-only R@5, not end-to-end QA) | full ~48-session haystack ingest, consolidation, retrieval, Haiku 4.5 answer, GPT-4o-2024-08-06 binary judge | 2026-06-12 | `npm run eval:longmemeval` (~$14, ~15 min) |
| EVAL-02: Correctness suite (belief-correction) | **92.3%** (12/13 content-correct, API) · **84.6%** scorer-credited (11/13) on the free local stack | ADD-only baseline: **0%** (same cases, no consolidation) | end-to-end engine, scratch DB, 17 fictional-persona cases, graph-state verification (tombstones + duplicate counts) | 2026-06-13 (commit bedd132) | `npm run eval:correctness` (~$2 API / $0 local, ~10–40 min) |

Reading the LongMemEval row: a model handed the entire conversation in-context scores 79.5% on this subset, about 10 points above recense. Compression is lossy, and we publish that comparison rather than bury it. In return, recense answers each question while reading roughly 1% of the tokens (about 2K vs 100K) at roughly 250× lower per-question cost, and it keeps working once history outgrows the context window. The knowledge-update subset is the hardest category for a memory system, because it requires *not* returning stale values, which is this engine's core claim. Competitor figures are vendor self-reported under differing methodology and are not directly comparable; agentmemory's 95.2% in particular is retrieval recall, not question answering. The 69.2% is conservative: about 10 of the 18 knowledge-update failures recover with temporal ranking and ask-time query rewrite (both shipped, zero stable-correct regressions), but a full-subset re-measurement was deferred for budget, so we publish the pre-lever number rather than an extrapolation. Per-failure attribution is in [docs/evals.md](docs/evals.md).

---

## Quickstart

### Prerequisites

**Required:**

- **Node.js 22 or later** — required for the native module (better-sqlite3 ABI)
- **`claude` CLI, logged into a Claude subscription** — the sleep-pass runs on `claude -p` (headless Haiku/Sonnet), so no Anthropic API billing needed; your subscription covers it
- **OpenAI API key** — used for embeddings; still required

**Optional:**

- **Anthropic API key** — only needed if you choose direct-API mode instead of subscription billing; leave it out on the subscription path
- **Telegram bot token** (macOS only) — always-on query bot; create one via [@BotFather](https://t.me/BotFather)

> **Billing footgun:** if `ANTHROPIC_API_KEY` is present in the `env` block of `~/.claude/settings.json`, `claude -p` will bill the Anthropic API directly even on a subscription plan. Remove it from that env block to stay on subscription billing. `recense doctor` will warn you if it detects this.

### Install

```sh
git clone https://github.com/mbeato/recense.git
cd recense
npm install
npm run init
```

> **node-gyp prerequisite:** `npm install` compiles better-sqlite3 from source, which needs Python 3 and C++ build tools. On macOS: `xcode-select --install`. On Ubuntu/Debian: `sudo apt install build-essential python3`. If install fails with a `node-gyp` error, install these first and retry.

> **Local development (npm link):** to use the `recense` CLI from a local clone without a global npm install, run `npm link` once after `npm install`. This creates a global symlink so `recense` resolves to `dist/src/adapter/recense.js` in your clone. Run `npm unlink recense` to remove it. `npm link` does not auto-rebuild; run `npm run build` after source changes.

`npm run build` compiles the TypeScript source to `dist/`. `npm run init` runs the build and then launches `recense init`, a guided wizard that:

1. Prompts for your DB path (where `recense.db` will live)
2. Collects and live-validates your API keys
3. Captures the correct `node` binary path (required by the scheduler and hooks — RECENSE_NODE_BIN)
4. Writes `~/.config/recense/sleep.env` (`chmod 600`)
5. Registers the sleep-pass scheduler (macOS: launchd; Linux: prints `recense scheduler run` guidance)
6. Wires the three Claude Code hooks into `~/.claude/settings.json`
7. Optionally seeds from an existing `MEMORY.md` (`[y/N]`, default No)

`recense init` is idempotent; re-run it to update keys or recapture the node binary after switching Node versions.

After init, verify the install:

```sh
recense doctor
```

### BYO-keys

`recense init` creates and writes `~/.config/recense/sleep.env` with `chmod 600`. **You do not need to create this file manually** unless you prefer to skip the wizard.

If you set it up manually, create `~/.config/recense/sleep.env` (`chmod 600`) with:

```sh
# Required
OPENAI_API_KEY=your-openai-key-here

# Optional — only needed for direct-API mode (not subscription billing)
# ANTHROPIC_API_KEY=your-anthropic-key-here
```

For the Telegram channel (macOS), also add:

```sh
RECENSE_TELEGRAM_TOKEN=123456:ABC-your-bot-token-here
```

Keys are never logged or stored outside this file. The scheduler and hooks read them from the environment at runtime via the SDK defaults.

### Cold-start seed

Before the sleep pass can consolidate anything there must be nodes in the graph. `recense init` offers a one-shot seed at the end of the wizard (`[y/N]`, default No). You can also run it later:

```sh
recense seed
```

The seed reads your existing memory files (configured via `RECENSE_COLD_START_MEMORY_DIR` and `RECENSE_COLD_START_CLAUDE_FILE`), extracts entity and fact claims, and writes them into the SQLite graph.

**One-shot:** once the seeder finishes successfully it sets a `seeded` meta flag. Re-running against the same database is a no-op; it exits 0 without re-extracting anything.

**Safe no-op on misconfiguration:** if neither source path resolves to any files (for example, you ran it before setting the env vars), the seeder exits 0 *without* burning the one-shot flag. Fix the paths and re-run.

**Lock-guarded:** `recense seed` acquires the shared single-writer lock before opening the database. It is safe to run while the Telegram watcher or the hourly sleep-pass is active; they wait or skip their cycle rather than colliding.

---

## Interfaces

recense is a pure memory system: any agent or channel can sit on top of it. Three tiers of reach:

| Tier | How | Deploy needed? |
|------|-----|----------------|
| Local | Claude Code hooks (ambient), stdio MCP server (deliberate) | No |
| Channel | Telegram bot (always-on watcher, macOS) | No |
| Remote | `recense serve` HTTP API / MCP-over-HTTP | Yes — same clone, any host |

### Claude Code hooks

The hooks wire ambient memory into every Claude Code session. The SessionStart hook injects relevant memory at session start (LLM-free, fast); turn capture feeds the episodic log as you work. Wired automatically by `recense init`. See the command reference below.

### MCP server (stdio)

`recense mcp` starts a stdio MCP server that gives any local MCP client (Claude Code, Claude Desktop, standalone agents) deliberate on-demand access to the same `recense.db` the hooks use. The client spawns the process per its config entry, so there's zero deployment. Three tools: `memory_search`, `memory_add`, `memory_ask`. See [docs/mcp.md](docs/mcp.md) for registration config and full tool semantics.

If you are coming from `@modelcontextprotocol/server-memory`, here is how the vocabularies map:

| server-memory tool | recense equivalent | Notes |
|--------------------|--------------------|-------|
| `search_nodes` | `memory_search` | Find nodes by query; recense uses graph + vector, not raw JSON |
| `open_nodes` | — no equivalent | Nodes are engine-internal; search is the read interface by design |
| `add_observations` | `memory_add` | recense writes are episodic; a write becomes a graph fact after hourly consolidation |
| `create_entities` | — no equivalent | No CRUD; recense builds entities via consolidation |
| `read_graph` | — no equivalent | Graph is engine-internal by design |
| `delete_entities` | — no equivalent | No user-initiated deletes; tombstone via sleep pass |
| `delete_observations` | — no equivalent | No user-initiated deletes |
| `delete_relations` | — no equivalent | No user-initiated deletes |
| (new) | `memory_ask` | LLM-composed answer over stored knowledge; no server-memory equivalent |

`memory_add` maps to server-memory's `add_observations`, except writes are episodic and consolidation is deferred to the hourly sleep pass. recense has no user-initiated CRUD or deletes by design.

### Reference client

Any agent or channel can sit on top of recense by calling the REST interface. The reference client shows the template: receive a message, call `/v1/ask` or `/v1/search` with a Bearer token, present provenance correctly, and fail closed when configuration is absent. See [docs/reference-client.md](docs/reference-client.md).

### Telegram channel

The Telegram channel is the recommended query surface on macOS. You DM your bot a question and get a memory-grounded answer.

> **macOS only.** The always-on watcher (`recense watcher` / `setup-watcher.sh`) uses launchd and is not supported on Linux in v2.0.

**Step 1 — Create a bot**

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. BotFather gives you a token that looks like `123456:ABC-telegram-token`; copy it

**Step 2 — Get your numeric user ID**

Message [@userinfobot](https://t.me/userinfobot) on Telegram. It replies with your numeric user ID (for example `123456789`). You will need this for the allowlist.

**Step 3 — Put the token in sleep.env**

Add the line to `~/.config/recense/sleep.env`:

```sh
RECENSE_TELEGRAM_TOKEN=123456:ABC-your-bot-token-here
```

**Step 4 — Configure the channel in `src/lib/config.ts`**

Open `src/lib/config.ts` and find the `telegram` section in `DEFAULT_CONFIG`. Set:

```ts
telegram: {
  enable: true,
  allowlist: [123456789],   // your numeric Telegram user ID
  pollIntervalMs: 2_000,
},
```

**The allowlist is fail-closed.** An empty `allowlist` (`[]`) means the watcher answers no one; it starts fully silent until you add at least one ID. Unlisted senders are silently ignored, so the surface never confirms it exists to an unknown sender.

After editing, rebuild: `npm run build`.

**Step 5 — Install the always-on watcher**

```sh
bash scripts/setup-watcher.sh
```

`setup-watcher.sh` does the following:

1. Builds the project (`npm run build`) and verifies the compiled watcher CLI exists
2. Adds `RECENSE_WATCHER_JS` to `~/.config/recense/sleep.env` (additive; does not clobber your existing API keys or token)
3. Renders the launchd plist template, lints it with `plutil`, and bootstraps the `com.recense.watcher` KeepAlive job via `launchctl`
4. Prints rollback instructions

The watcher runs as a `KeepAlive` job, so launchd restarts it automatically if it exits.

Alternatively, run it directly in a terminal (with sleep.env sourced):

```sh
source ~/.config/recense/sleep.env
node dist/src/adapter/watcher-cli.js --db /Users/<you>/.config/recense/recense.db
```

**Step 6 — Verify**

DM your bot a question. You should receive a reply within a few seconds. Schema-grounded inferences carry a trailing `(inferred)` marker; direct fact recalls are unmarked.

To check the watcher log:

```sh
tail -f /tmp/recense-watcher.log
```

Note: the bot only answers while your Mac is awake. This is a local self-hosted service, not a cloud process.

### Optional: iMessage channel (advanced)

The iMessage channel is macOS-only and requires Full Disk Access for the `node` binary to read `~/Library/Messages/chat.db`.

**Important caveat:** if you use your own phone number on the same Apple ID as the Mac, the watcher sees its own outbound replies as new inbound messages, a self-echo loop. To avoid this, the iMessage channel realistically needs a dedicated Apple ID with a separate handle. This is why the Telegram channel is the recommended surface.

To use iMessage:

1. Grant Full Disk Access to your `node` binary: **System Settings → Privacy & Security → Full Disk Access**, add `$(which node)`
2. In `src/lib/config.ts`, set `channel.enable = true`, `channel.chatDbPath`, and `channel.allowlist` with your E.164 handle(s) or Apple ID email(s)
3. Rebuild: `npm run build`
4. Re-run `bash scripts/setup-watcher.sh`; the watcher auto-selects iMessage when Telegram is not configured

### Privacy stance

recense is a **read-only query surface**. It answers questions from allowlisted senders; it never ingests your message history. The only write the watcher performs per query is an ephemeral inferred episode logged under the single-writer lock (origin `inferred`, salience 0, never promoted to a graph fact). Your conversation history is never read by the memory engine; the channel delivers only the inbound question text.

---

## Command reference

| Command | Description |
|---------|-------------|
| `recense init` | Guided bootstrap wizard; run once after clone, or re-run to update config |
| `recense doctor` | Health audit: DB, API keys, scheduler, hooks, Node ABI |
| `recense scheduler install` | macOS: register the launchd sleep-pass agent. Linux: prints `recense scheduler run` guidance |
| `recense scheduler status` | Check whether the scheduler is registered / running |
| `recense scheduler run` | Linux: start the hourly sleep-pass in the foreground (stops when the process exits) |
| `recense recall` | Query memory from the command line |
| `recense seed` | One-shot cold-start seed from existing memory files |
| `recense ingest` | Run the source adapter pass (email, transcripts, Obsidian vault) |
| `recense sleep-pass` | Run one consolidation pass immediately |
| `recense snapshot` | Export a DB snapshot |
| `recense watcher` | Start the Telegram / iMessage query watcher (macOS only) |
| `recense mcp` | Start a stdio MCP server exposing memory_search / memory_add / memory_ask to any local MCP client. Requires `--db <path>`. |
| `recense hook session-start \| turn-capture \| stop` | Claude Code hook handlers; wired automatically by `recense init` |

---

## Supported platforms

| Platform | Scheduler | Claude Code hooks | Query channel |
|----------|-----------|-------------------|---------------|
| **macOS** (full support) | launchd — always-on, survives reboots | ✓ | Telegram (launchd KeepAlive) · iMessage (optional, see above) |
| **Linux** | `recense scheduler run` — foreground, stops with process¹ | ✓³ | — (channel watcher is macOS-only in v2.0) |
| **Windows** | WSL — community-supported² | WSL² | WSL² |

¹ **Linux scheduler caveat:** `recense scheduler run` starts an hourly croner tick in the foreground. It stops when your terminal session ends; there is no background daemon or reboot-survival on Linux in v2.0. Reboot-survival via a systemd unit is planned for v2.1. Until then, restart `recense scheduler run` manually after reboots.

² **Windows:** native Windows is out of scope. Under WSL2 the engine, hooks, and foreground scheduler are *expected* to work, but this path is **not covered by CI or an install smoke**; community reports welcome. The channel watcher (Telegram/iMessage) behaves as on Linux (not supported in v2.0).

³ **Linux verification scope:** the engine, hooks, and scheduler are exercised by the CI build and unit suite on `ubuntu-22.04` (PORT-02). An end-to-end `recense init` install smoke on a fresh Linux machine is not yet in CI (planned); the install path is unit-tested, not yet integration-tested.

---

## What this is not

- **Single-user, single-tenant only.** Not built for multi-user or production traffic. "Someone hosts memory for their product's users" means N separate deployments, one per user. Namespace-based multi-tenancy is out of scope.
- **Hourly consolidation latency.** A fact added now is not searchable until the next sleep pass, up to 60 minutes later. The episodic log captures it immediately, but graph consolidation (where belief-correction and schema induction run) is deferred. Within-session "I just told you that" recall of *new* facts is a real UX gap versus write-on-message systems.
- **Extraction is an LLM prompt.** Claim extraction quality depends on the extraction model. Ambiguous, ironic, or non-binary input may produce noisy or empty claims. The allocation gate and provenance guards bound the damage, but bad input still yields bad claims.
- **Scale ceiling around thousands of nodes.** Retrieval is brute-force cosine over a single SQLite file in one Node process. It works well up to roughly 5K nodes; beyond that, a vector index (sqlite-vec) is needed. Not designed for high-volume agent fleets.
- **One maintainer, best-effort.** Not backed by a company. Issue response time is best-effort; standard OSS bus-factor caveats apply.

---

## Deep links

- [docs/evals.md](docs/evals.md) — full eval methodology, case-set description, judge-validation evidence, and caveats
- [docs/mcp.md](docs/mcp.md) — MCP server registration config and tool semantics
- [docs/server-mode.md](docs/server-mode.md) — `recense serve` HTTP API reference
- [docs/reference-client.md](docs/reference-client.md) — reference client template and provenance handling
- [docs/tray-app.md](docs/tray-app.md) — menu-bar tray app: build from source, lifecycle, Gatekeeper caveat

---

## License

MIT — see [LICENSE](LICENSE).
