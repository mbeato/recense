# Competitive Landscape: OSS / Self-Hosted Agent Memory

**Researched:** 2026-06-10
**Method:** GitHub API (star counts pulled live 2026-06-10), README fetches, web search. Confidence marked per claim. Anything not directly verified is flagged.
**Frame of reference:** brain-memory = OSS, self-host, BYO-keys, SQLite, TypeScript, two-store (episodic + semantic graph + vector), offline sleep-pass consolidation, prediction-error-gated belief updates, LLM-free retrieval. Next milestone: `brain mcp` + `brain serve`.

---

## mem0 (mem0ai/mem0)

- **Repo:** https://github.com/mem0ai/mem0 — **58,271 stars**, Apache-2.0, pushed 2026-06-10. YC S24, VC-backed; OSS is the funnel for their cloud platform.
- **Stores:** Extracted facts as discrete memory units (not raw transcripts), plus entity links across memories. Vector + BM25 + entity indices.
- **Retrieval:** Multi-signal fusion — semantic embedding, BM25 keyword, entity matching scored in parallel; temporal reasoning ranks the right dated instance. Single-pass, no agentic loop. (HIGH — README verified.)
- **Update vs append-only:** **This is the headline finding.** The "New Memory Algorithm (April 2026)" / v3 migration switched to **single-pass ADD-only extraction — "one LLM call, no UPDATE/DELETE. Memories accumulate; nothing is overwritten."** The old ADD/UPDATE/DELETE/NOOP reconciliation loop is gone. They handle staleness at retrieval time via temporal ranking instead of correcting stored beliefs. (HIGH — verbatim from README, 2026-06-10.)
- **Consolidation/decay:** None in v3 OSS. No decay, no consolidation pass.
- **Integration:** Python + npm SDKs; self-hosted REST server via `docker compose` (auth on by default now); skills for Claude Code/Cursor/Codex; CLI with frictionless "agent signs itself up" key minting (`mem0 init --agent`). MCP exists via OpenMemory (below).
- **Setup friction:** Library mode = pip install + OpenAI key. Self-host server = Docker compose + bootstrap wizard. Defaults to OpenAI models.
- **Users:** Largest community in the category; positioned at assistants/support/healthcare personalization.
- **Implication for brain-memory:** The most-starred memory project just *abandoned* in-place belief updates for benchmark-driven append-only. brain-memory's prediction-error-gated reconsolidation is now a clear differentiator, not a me-too feature — and mem0's own pivot is the argument to address ("retrieval-time temporal ranking vs storage-time correction").

## Zep / Graphiti (getzep/graphiti)

- **Repo:** https://github.com/getzep/graphiti — **27,263 stars**, Apache-2.0, pushed 2026-06-10. (getzep/zep repo is now just examples/integrations shell, 4,655 stars, last push 2026-04 — the OSS center of gravity is Graphiti.)
- **Stores:** Temporal "context graph": entities (nodes with evolving summaries), facts as triplet edges with **bi-temporal validity windows**, episodes (raw source data, full provenance), communities. Custom ontology via Pydantic models. Python; requires a graph DB (Neo4j/FalkorDB/etc.).
- **Retrieval:** Hybrid — vector similarity + BM25 full-text + graph traversal fused into one ranked answer, explicitly **no LLM in the retrieval loop**. (HIGH — README.)
- **Update vs append-only:** Closest existing analog to belief revision: when information changes, **old facts are automatically invalidated (validity window closed), not deleted** — temporal history preserved, query "what's true now" or "what was true then." Contradiction handling = automatic fact invalidation. But it's supersession, not prediction-error gating; no surprise signal, no confidence accumulation, no schema induction. (HIGH.)
- **Consolidation/decay:** Incremental ingestion (no batch recompute); community detection/summaries. No decay, no offline sleep pass.
- **Integration:** Python SDK, official **MCP server** (`mcp_server/` in repo, promoted in README for Claude/Cursor), REST service. Backs Zep's commercial "Context Lake."
- **Setup friction:** Moderate-high: Python + a running graph database + LLM key. Heavier than a single SQLite file.
- **Users:** Enterprise-leaning (Zep's customer base); arXiv paper (2501.13956) gives it research credibility.
- **Implication:** The strongest technical competitor on "memory that stays correct." brain-memory's edge vs Graphiti: zero-infra SQLite, schema induction/generalization, prediction-error gating (Graphiti invalidates on any new conflicting assertion — no evidence weighing), TS-native Claude Code hooks.

## Letta (letta-ai/letta)

- **Repo:** https://github.com/letta-ai/letta — **23,243 stars**, Apache-2.0, pushed 2026-05-14. MemGPT lineage; VC-backed with cloud platform.
- **Stores:** Memory **blocks** — labeled strings (e.g. "human", "persona") pinned in-context, plus detached blocks in DB; archival memory (vector store) and recall (conversation history) behind tools.
- **Retrieval:** Agent-driven: the agent calls memory tools to search archival/recall memory. Not LLM-free — memory management is itself agentic.
- **Update vs append-only:** **Memories are agent-editable in place** — blocks are rewritten by the agent via memory tools. (HIGH — docs.)
- **Consolidation:** **Sleep-time agents** — background agents sharing memory blocks with the primary agent that run while idle: consolidate fragmented memories, dedupe/reorganize blocks, derive "learned context," archive stale info. (HIGH — docs.letta.com/guides/agents/architectures/sleeptime.) This is the closest existing "sleep pass" concept; framed as agentic background compute, not a principled neuro-inspired algorithm (no prediction-error gate, no schema induction primitive).
- **Integration:** REST API server (Docker + Postgres), Python/TS SDKs, Letta Code CLI, ADE GUI. MCP supported as a tool-source for agents.
- **Setup friction:** High for a memory layer — it's a full agent *platform* (server + Postgres), not an embeddable memory engine.
- **Implication:** Validates "sleep-time consolidation" as a category concept (good for positioning language). But Letta couples memory to its agent runtime; brain-memory is memory-only and host-agnostic.

## Hindsight (vectorize-io/hindsight)

- **Repo:** https://github.com/vectorize-io/hindsight — **16,131 stars**, MIT, pushed 2026-06-10. By Vectorize.io. Tagline: "Agent Memory That Learns." Fast riser; barely existed in early training data.
- **Stores:** Three biomimetic networks: **World** (facts about the world), **Experience** (the agent's own episodes), **Mental Models / Opinions** (learned understanding formed by *reflecting* on raw memories). Internally: entities, relationships, time series with sparse+dense vectors.
- **Retrieval:** Four parallel strategies (semantic, BM25, graph traversal over entity/temporal/causal links, temporal range) merged via reciprocal rank fusion + cross-encoder rerank.
- **Update vs append-only:** Retain runs LLM extraction + a "normalization" process; reflection derives mental models from raw memories. Whether base facts get corrected in place was not explicit in README (MEDIUM — needs deeper read if treated as direct rival).
- **Consolidation/decay:** Reflection (mental-model formation) is a consolidation-like mechanism. No decay documented.
- **Integration:** REST API + Python/Node SDKs + CLI + drop-in LLM-client wrapper. **No MCP server mentioned in README** (LOW confidence on absence — verify before claiming).
- **Setup friction:** Low: one-command Docker, or embedded Python mode with no server.
- **Implication:** The most direct *conceptual* competitor — episodic/semantic split + reflection-derived generalizations, explicitly brain-flavored marketing. brain-memory's remaining unique ground vs Hindsight: prediction-error-gated updates, decay with evidence guards, SQLite/TS/Claude-Code-hooks-native, single-binary self-host story.

## agentmemory (rohitg00/agentmemory)

- **Repo:** https://github.com/rohitg00/agentmemory — **22,232 stars**, Apache-2.0, pushed 2026-06-10. Tagline: "#1 Persistent memory for AI coding agents based on real-world benchmarks."
- **Stores:** 4-tier hierarchy: working (raw tool observations) → episodic (compressed session summaries) → semantic (extracted facts/patterns) → procedural (workflows). SQLite + in-memory vector index, no external DB.
- **Retrieval:** Triple-stream fusion — BM25 (stemmed + synonyms), vector cosine, knowledge-graph traversal — combined with RRF (k=60). Claims 95.2% R@5 on LongMemEval-S. (MEDIUM — self-reported benchmark.)
- **Update vs append-only:** Append-with-consolidation: dedup in 5-min windows, **contradiction detection and resolution** ("detects and resolves contradictions rather than simply appending"), consolidation at Stop/SessionEnd extracting knowledge graph + reflections. (MEDIUM — README claims, mechanism depth unverified.)
- **Decay:** **Ebbinghaus-curve decay** — frequently accessed items strengthen, stale entries auto-evict. (MEDIUM — README; whether evidence-backed facts are protected from eviction is unknown — a potential weakness to contrast against brain-memory's "never delete evidence-backed facts" guard.)
- **Integration:** Kitchen sink: 12 Claude Code hooks, **53 MCP tools**, **128 REST endpoints** (port 3111), Python/Rust/Node SDKs, 15 installable skills. Auto-detects LLM provider incl. local Ollama.
- **Setup friction:** Low: `npm install -g`, start server, `agentmemory connect claude-code`.
- **Implication:** The closest *product-shape* competitor: SQLite, hooks-native, coding-agent-focused, consolidation + decay + contradiction handling, BYO-keys. Star velocity suggests heavy promotion. Differentiation must be on mechanism quality (prediction-error gating, schema induction, faithfulness guards) and simplicity (53 tools / 128 endpoints is surface-area bloat brain-memory can position against).

## claude-mem (thedotmack/claude-mem)

- **Repo:** https://github.com/thedotmack/claude-mem — **81,600 stars**, Apache-2.0, pushed 2026-06-10. The most-starred project in the entire category; exploded from ~46k (Feb 2026 trending) to 81k+ in ~4 months.
- **Stores:** Tool-use observations captured live, compressed into AI-generated semantic summaries via the Claude Agent SDK. SQLite + FTS5 plus Chroma vector embeddings. No graph, no entities, no beliefs — it's session-compression memory.
- **Retrieval:** 3-layer token-budgeted workflow: `search` (compact ID index, ~50-100 tokens) → `timeline` (chronological context) → `get_observations` (full detail for filtered IDs). Hybrid FTS5 + vector. ~10x token savings claim.
- **Update vs append-only:** Effectively append-only observation log; no belief correction documented. "Endless Mode (biomimetic memory architecture)" exists as a beta flag — watch it. (MEDIUM.)
- **Consolidation/decay:** Compression at capture time; no documented decay or offline consolidation.
- **Integration:** 5 Claude Code lifecycle hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) + 4 MCP search tools + a skill. Now multi-agent: Codex, Gemini, Copilot, OpenCode, OpenClaw.
- **Setup friction:** Lowest in class: `npx claude-mem install` (or `/plugin` marketplace). This one-command install is a large part of why it won.
- **Known issues:** Feb 2026 community security audit rated it HIGH risk — worker HTTP API on port 37777 has **no authentication**; any local process can read stored observations. (MEDIUM — reported by Augment Code writeup.)
- **Implication:** Proof that the Claude Code hook surface + one-command install drives massive adoption — and that the bar on memory *quality* is low (append-only summaries win on distribution, not mechanism). Its auth-less local HTTP port is a cautionary tale for `brain serve`.

## supermemory (supermemoryai/supermemory)

- **Repo:** https://github.com/supermemoryai/supermemory — **26,442 stars**, MIT, pushed 2026-06-10. VC-backed, cloud-first with local-run option. Companion: https://github.com/supermemoryai/claude-supermemory — 2,626 stars, no license file — "Claude Code learns in real-time" plugin.
- **Stores:** Documents/notes/web content + extracted memories; "memory and context engine + app." Primarily a personal-memory product with an API, less an embeddable engine. (MEDIUM — README-level only.)
- **Integration:** API, app, Chrome extension, claude-supermemory plugin for Claude Code, MCP endpoint on the hosted side.
- **Implication:** Competes for the "give Claude memory" mindshare via the hosted route; not a direct self-host architecture rival.

## Cognee (topoteretes/cognee)

- **Repo:** https://github.com/topoteretes/cognee — **17,760 stars**, Apache-2.0, pushed 2026-06-10.
- **Stores:** Knowledge graph + vector embeddings + ontology-grounded entities built from arbitrary documents (ECL — extract/cognify/load — pipeline). Python.
- **Retrieval:** Auto-routing across strategies; two-tier `recall()` (session cache → graph storage fallthrough).
- **Update vs append-only:** Has `remember/recall/forget/improve` API; `improve()` learns from feedback — active optimization, not pure append. Mechanism depth unverified. (MEDIUM.)
- **Consolidation/decay:** Feedback-driven improvement; no documented decay/sleep pass.
- **Integration:** Python SDK, CLI + UI, **MCP server plugin**, Claude Code plugin, managed cloud.
- **Setup friction:** pip + LLM key for basics; multiple optional DB backends (relational + vector + graph) for full setup.
- **Users:** 119 downstream dependents; Deepset AI cited.
- **Implication:** Strong at document→graph ETL ("structured RAG"), weak at belief lifecycle. Different center of gravity (data pipelines vs living memory).

## LangMem (langchain-ai/langmem)

- **Repo:** https://github.com/langchain-ai/langmem — **1,497 stars**, MIT, pushed 2026-06-07.
- **Stores:** Extracted conversation knowledge into LangGraph's BaseStore (semantic embeddings; profile/collection schemas).
- **Retrieval:** Semantic search via store embeddings; tools the agent calls.
- **Update vs append-only:** Background memory manager "extracts, consolidates, and **updates** agent knowledge" — supports in-place update/delete of memory documents. (MEDIUM.)
- **Integration:** Python SDK tied to LangGraph ecosystem. No MCP. No formal releases published.
- **Implication:** Ecosystem-captive utility library, not a standalone product. Low threat outside LangChain users; star count reflects that.

## Memary (kingjulio8238/Memary)

- **Repo:** https://github.com/kingjulio8238/Memary — **2,621 stars**, MIT, **last push 2024-10-22 — effectively dead (~20 months stale)**.
- Knowledge-graph memory (Neo4j) + memory stream/entity-knowledge-store for autonomous agents. Historical interest only.
- **Implication:** None. Useful only as evidence that unmaintained memory projects die fast in this market.

## basic-memory (basicmachines-co/basic-memory)

- **Repo:** https://github.com/basicmachines-co/basic-memory — **3,180 stars**, **AGPL-3.0**, pushed 2026-06-10.
- **Stores:** Plain Markdown files on disk as the source of truth; entities with observations (facts) + wiki-link relations form a traversable graph; FTS + FastEmbed semantic vectors layered on top.
- **Retrieval:** Hybrid full-text + semantic; LLM navigates the graph by following links.
- **Update vs append-only:** Human- and AI-editable in place (`edit_note`, guarded `write_note`); files stay synchronized both ways.
- **Integration:** MCP server (Claude Desktop/Code, Cursor, VS Code, ChatGPT, Obsidian) + CLI; optional cloud.
- **Setup friction:** ~2 min local via `uv`.
- **Implication:** Owns the "files you can read/own forever" trust story. brain-memory's SQLite is opaque by comparison — `brain viz` and export paths matter for the same trust signal. AGPL also limits commercial reuse, leaving room for permissive-license alternatives.

## Official MCP memory server (modelcontextprotocol/servers, src/memory)

- **Repo:** https://github.com/modelcontextprotocol/servers — **87,023 stars** (monorepo of all reference servers, not memory-specific), actively maintained; npm `@modelcontextprotocol/server-memory`.
- **Stores:** Minimal knowledge graph — entities (name, type, observations[]), directed relations (active voice) — persisted to a **single JSONL file** (`MEMORY_FILE_PATH`).
- **Retrieval:** `read_graph` (whole graph!), `search_nodes` (substring match over names/types/observations), `open_nodes`. No embeddings, no ranking.
- **Update vs append-only:** Full CRUD: create entities/relations, add observations, delete entities/observations/relations with cascade. But nothing is automatic — the LLM does all curation through tool calls.
- **Consolidation/decay:** None.
- **Setup:** npx/Docker one-liner; this is the de facto default people try first.
- **Implication:** The baseline every "knowledge graph memory MCP" gets compared to. Its tool vocabulary (entities/relations/observations; create/search/open) is the de facto MCP-memory tool-naming convention — `brain mcp` should feel familiar to anyone who has used it while being obviously more capable (ranked retrieval, automatic consolidation, belief updates).

## OpenMemory — two distinct projects with one name

1. **mem0's OpenMemory** (lives at `mem0ai/mem0/openmemory/` in the mem0 monorepo): self-hosted, local-first **MCP memory server with a dashboard UI**, Docker-compose deployment; cross-client shared memory (Claude Desktop, Cursor, etc.) backed by mem0. Star count not separable from mem0's 58k. (HIGH that it exists there; feature claims MEDIUM.)
2. **CaviraOSS/OpenMemory** — https://github.com/CaviraOSS/OpenMemory — **4,215 stars**, Apache-2.0, pushed 2026-05-29. Independent. Multi-sector memory (episodic/semantic/procedural/emotional/reflective), SQLite or Postgres + vectors, **decay engine with adaptive per-sector forgetting**, temporal KG with valid_from/valid_to, **consolidation + reflection** that reinforce/fade by salience and recency, waypoint graph for associative retrieval with explainable traces. Native MCP + REST + Python/JS SDKs.
- **Implication:** CaviraOSS/OpenMemory is another mechanism-rich small competitor (decay + consolidation + temporal windows in SQLite). At 4.2k stars it shows mechanism depth alone doesn't drive adoption — distribution does.

## Other notable (from "memory MCP server" star search, 2026-06-10)

- **Gentleman-Programming/engram** — 4,261 stars, Go single binary, **SQLite + FTS5, MCP server + HTTP API**, agent-agnostic. Architecturally the nearest "single small self-host binary" analog to `brain serve`. (Surface-level verification only.)
- **DeusData/codebase-memory-mcp** — 3,148 stars: code-intelligence KG, adjacent category.
- **Dataojitori/nocturne_memory** — 1,179 stars: "rollbackable, visual" long-term memory MCP server, anti-vector-RAG pitch.
- **shaneholloman/mcp-knowledge-graph** — 864 stars: maintained fork of the official memory server with project-local storage.
- **doobidoo/mcp-memory-service** — previously a popular MCP memory server with consolidation/decay; **GitHub API now returns 404 (2026-06-10) — repo apparently removed or renamed. Unverified/likely gone.**
- **memvid/claude-brain** — 502 stars, single portable `.mv2` file memory, last push 2026-01; niche.

---

## Table stakes for OSS memory tools (integration surfaces)

Verdict from the field, ordered by necessity:

1. **MCP server — mandatory.** Every credible project ships one (official server, Graphiti, Cognee, basic-memory, agentmemory, both OpenMemorys, claude-mem, engram). It is *the* discovery and listing surface (PulseMCP, mcpservers.org, awesome lists rank by it). A memory tool without MCP is invisible in 2026. `brain mcp` is correctly prioritized.
2. **Claude Code lifecycle hooks — mandatory for the coding-agent segment.** The two fastest growers (claude-mem 81.6k, agentmemory 22.2k) are hook-first: automatic capture at SessionStart/PostToolUse/SessionEnd with zero user effort. MCP alone = pull-based memory the agent must remember to use; hooks = ambient memory. brain-memory already lives here — keep it the primary surface.
3. **HTTP/REST serving mode — expected, not differentiating.** mem0, Letta, Hindsight, agentmemory, OpenMemory all expose REST for non-MCP clients. Modest endpoint surface is fine (agentmemory's 128 endpoints is bloat, not a bar to clear). **Ship it with auth on by default** — claude-mem's unauthenticated :37777 audit finding and mem0's "self-hosted auth now on by default" both show the ecosystem got burned.
4. **One-command install — the single highest-leverage adoption factor.** `npx claude-mem install`, `pip install mem0ai`, `docker run` Hindsight. Anything requiring Neo4j/Postgres (Graphiti, Letta) self-selects into enterprise. brain-memory's SQLite/zero-infra position is a real advantage; protect it.
5. **SDK (npm/pip) — nice-to-have** for the embeddable-engine story; not needed for v1 adoption.
6. **Local/BYO-keys/ownership story — strong differentiator in this niche.** basic-memory (plain markdown), engram (one binary), claude-brain (one file) all lead with data ownership. Pair `brain viz` + a plain-text export with the SQLite store to neutralize "opaque database" objections.

## Adoption drivers (what the most-starred projects do)

1. **Zero-friction install + immediate visible payoff.** claude-mem (81.6k) won the category with `npx claude-mem install` → next session Claude "remembers." Time-to-magic under 2 minutes.
2. **Ride the Claude Code wave specifically.** The breakout projects of late 2025–2026 (claude-mem, agentmemory, claude-supermemory) are all Claude-Code-first, then generalized to Codex/Gemini/Copilot. Plugin-marketplace presence matters.
3. **Benchmark numbers as marketing.** mem0 (LoCoMo 91.6 / LongMemEval 94.8, open-sourced eval harness), agentmemory ("#1 ... based on real-world benchmarks", 95.2% R@5), Hindsight. Publishing reproducible LongMemEval/LoCoMo numbers is now the credibility ante for any "memory that learns" claim — brain-memory's belief-update correctness would benefit from a benchmark nobody else can pass (stale-fact / contradiction-update eval), since LongMemEval saturated in 2026.
4. **Research legitimacy.** Zep/Graphiti (arXiv paper), Letta (MemGPT lineage), mem0 (research page). A short technical writeup of prediction-error-gated reconsolidation would punch above its weight.
5. **Token-efficiency framing.** claude-mem's "10x token savings", mem0's "7K tokens, 0.88s p50". Memory tools are sold partly as cost reducers.
6. **Brain/biomimetic framing sells** — Hindsight ("biomimetic," 16k stars in months), claude-mem's "Endless Mode (biomimetic)", OpenMemory's sectors. The market accepts and rewards neuro-inspired positioning; brain-memory's *faithful* version (mechanisms actually trace to the literature) is a defensible upgrade over competitors' vibes-level usage.
7. **Cautionary pattern:** mechanism-rich but distribution-poor projects stall (CaviraOSS OpenMemory 4.2k, LangMem 1.5k, Memary dead). Mechanism quality alone does not create adoption; install friction and the Claude Code surface do.

### Gap brain-memory occupies (validated by this survey)

No surveyed project combines: (a) **storage-time belief correction gated by prediction error** — mem0 just retreated to append-only; Graphiti supersedes without evidence-weighing; agentmemory claims contradiction resolution but undocumented mechanism; (b) **schema induction** (generalizations the user never stated) — only Hindsight's "mental models" and Letta's sleep-time "learned context" gesture at it; (c) **decay with evidence-backed-fact protection** — agentmemory/OpenMemory decay without documented guards; (d) **LLM-free online path with all LLM cost in an offline sleep pass** — Letta's sleep-time agents are the only comparable separation, inside a heavyweight platform. The combination, in a zero-infra SQLite/TS package on the Claude Code hook surface, is unoccupied.
