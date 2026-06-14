# Recense MCP server

`recense mcp` exposes exactly three tools over stdio: `memory_search`, `memory_add`, and
`memory_ask`. There is nothing to deploy — your MCP client (Claude Code, Claude Desktop, or
any standalone agent speaking stdio MCP) spawns the process from its config entry and talks
JSON-RPC over stdin/stdout. The server reads and writes the same `recense.db` the Claude Code
hooks use.

Unregistering the config entry is the off-switch: stdio servers are client-spawned, so
removing the entry stops all MCP access immediately.

---

## Register with Claude Code

Both forms point `--db` at your live database. **The path must match what `recense init`
pinned** — the DB path you chose in the wizard (the same one the hooks and the sleep-pass
scheduler use). Do not point it at an arbitrary location.

### CLI form

```sh
claude mcp add --scope user --transport stdio recense -- node /path/to/recense/dist/src/adapter/recense.js mcp --db /path/to/recense.db
```

### JSON form (`~/.claude.json`)

```json
{
  "mcpServers": {
    "recense": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/recense/dist/src/adapter/recense.js", "mcp", "--db", "/path/to/recense.db"]
    }
  }
}
```

Replace `/path/to/recense` with your clone's absolute path (the compiled entry point
lives under `dist/` — run `npm run build` first) and `/path/to/recense.db` with the DB path
`recense init` pinned (e.g. `~/.config/recense/recense.db`).

## Register with Claude Desktop

Claude Desktop uses the same `mcpServers` JSON shape in its config file
(**Settings → Developer → Edit Config**, which opens `claude_desktop_config.json`). Paste the
JSON snippet above into that file's `mcpServers` section and restart the app. This is a
documented config path, not a tested integration gate — Claude Code is the verified client.

---

## Tools

### `memory_search { query }`

Semantic search over stored memory. **LLM-free**: the query is embedded (one embedding call)
and matched against the graph+vector store — zero generation calls, ever. Returns structured
results with provenance:

```json
{
  "results": [
    { "value": "…fact text…", "origin": "asserted_by_user", "score": 0.82, "lastUpdatedMs": 1781130884000 }
  ]
}
```

- `value` — the stored fact text
- `origin` — where the fact came from (`asserted_by_user`, `observed`, `inferred`)
- `score` — retrieval relevance/strength signal
- `lastUpdatedMs` — last-access timestamp (epoch ms)

Provenance in every result is deliberate: a consuming agent can weigh a user-asserted fact
differently from an engine inference. Node IDs are not exposed — there is no get-by-id tool
to use them with; search is the read interface.

### `memory_add { content, origin? }`

Record a fact or observation. `origin` is constrained to `asserted_by_user | observed`
(default: `observed`). Passing `inferred` is rejected — that origin is engine-internal, and
accepting it from a client would let agent conclusions masquerade as engine inferences in the
prediction-error-gated update path.

The write lands as an **episode**, not a graph fact. The response is an honest deferred ack:

> stored as episode; becomes searchable after the next consolidation pass (runs hourly)

This is the contract, not a caveat: brain has no inline write-to-graph path. The hourly sleep
pass is the sole graph writer — it consolidates episodes into facts, so an add-then-search
within the hour finding nothing is expected behavior, not a bug.

### `memory_ask { query }`

Ask the memory a question and get an LLM-composed answer over stored knowledge. Returns
structured `{ answer, origin }` with `origin ∈ fact | inferred | none`:

- `origin: "fact"` — answered directly from a stored fact
- `origin: "inferred"` — composed via schema-based inference (a generalization, not a literal stored fact)
- `origin: "none"` — honest no-answer: `{ "answer": null, "origin": "none" }`

`memory_ask` is **always registered**, even when no LLM key is configured — it fails
gracefully at call time with a no-answer rather than disappearing from the tool list. Clients
phrase no-answers themselves; the server returns the machine-unambiguous shape, no text
markers.

---

## Hooks vs MCP

Both layers stay — they are complementary, not alternatives:

- **Hooks are the ambient layer.** The SessionStart hook injects relevant memory at session
  start (LLM-free, fast), and turn capture feeds the episodic log as you work. You never
  invoke them; they just run.
- **MCP is the deliberate layer.** Mid-session, the model explicitly calls
  `memory_search` / `memory_add` / `memory_ask` when it decides memory access is needed —
  on-demand, tool-mediated, visible in the transcript.

No hook functionality moves to MCP. If you only register the MCP server, you get deliberate
access without ambient injection; if you only wire the hooks, you get ambient memory without
mid-session tools. Running both gives the full surface against the same `recense.db`.
