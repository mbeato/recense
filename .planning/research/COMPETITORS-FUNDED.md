# Competitive Landscape: Funded Startups in AI Agent Memory

**Researched:** 2026-06-10
**Mode:** Competitive landscape (VC-funded / YC players in agent memory / memory-as-a-service)
**Overall confidence:** MEDIUM-HIGH (funding figures and pricing verified against current sources; some mechanism details from vendor self-description)

Scope note: brain-memory is open-source, self-hosted, BYO-keys, single-tenant SQLite/TypeScript with sleep-pass consolidation and prediction-error-gated belief updates. This doc maps who is funded to do something adjacent, what they actually ship, and where the white space is.

---

## 1. Mem0 — the category leader by distribution

- **Funding:** $24M total (Seed led by Kindred Ventures; Series A led by Basis Set Ventures, Oct 2025), with Peak XV, GitHub Fund, and **Y Combinator** participating. Angels include Dharmesh Shah, Scott Belsky, and the CEOs of Datadog, Supabase, PostHog, W&B. ([mem0.ai/series-a](https://mem0.ai/series-a), [TechCrunch](https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps/), accessed 2026-06-10)
- **Product:** Hosted memory API ("3 lines of code") + open-source library (`mem0ai/mem0`, Apache-2.0) + OpenMemory MCP (local MCP server) + self-host Docker server.
- **Mechanism:** LLM extraction pipeline over conversations → fact store with multi-store backend (vector + optional graph + key-value). Their 2026 algorithm adds "single-pass hierarchical extraction" and multi-signal retrieval (semantic + keyword + entity). Notably, their own 2026 report says agent-generated facts are treated *equally* with user inputs — the exact self-confirmation risk brain-memory guards against. ([State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026), accessed 2026-06-10)
- **Update/decay:** LLM decides ADD / UPDATE / DELETE / NOOP per extracted fact against retrieved similar memories (conflict resolution is an LLM judgment call at write time, not prediction-error-gated; no evidence ledger). No autonomous decay model documented.
- **Pricing:** Free (10k adds / 1k retrievals/mo) → Starter $19 → Growth $79 → Pro $249 → enterprise usage-based. Startup program: 3 months free Pro under $5M raised. ([mem0.ai/pricing](https://mem0.ai/pricing), accessed 2026-06-10)
- **Target:** Agent developers (B2D), moving up to enterprise. Native integrations in CrewAI, Flowise, Langflow; AWS partnership claimed.
- **Traction:** 41k+ GitHub stars, 14M PyPI downloads, API calls 35M (Q1 2025) → 186M (Q3 2025). Self-reported but consistent across outlets. Benchmarks (self-run): LoCoMo 92.5, LongMemEval 94.4.

## 2. Zep — temporal knowledge graph, enterprise wedge

- **Funding:** ~$3.3M from Engineering Capital, Step Function, and angels (Vercel, Google leaders). Founder: Daniel Chalef. Comparatively small raise for its mindshare. ([getzep.com](https://www.getzep.com/), Generational newsletter, accessed 2026-06-10)
- **Product:** Hosted "context engineering platform" + **Graphiti**, their open-source temporal knowledge-graph engine (`getzep/graphiti`, very popular OSS).
- **Mechanism:** Temporally-aware knowledge graph: entities/relationships extracted from chat + business data; **edges carry valid-time intervals — when a fact changes, the old edge is invalidated (not deleted) and a new edge added**. Hybrid retrieval: vector + BM25 + graph traversal, LLM-free at query time. Published architecture paper ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)).
- **Update/decay:** Closest funded analog to belief revision — fact invalidation with provenance and bi-temporal tracking. But it's contradiction-by-LLM-at-ingest, not prediction-error magnitude gating; no schema induction (no abstraction of unstated generalizations).
- **Pricing:** Free (1k credits/mo) → Flex $104/mo (50k credits) → Flex Plus $312/mo → Enterprise (SOC 2 Type II, HIPAA BAA, BYOC self-hosting). ([getzep.com/pricing](https://www.getzep.com/pricing), accessed 2026-06-10)
- **Target:** Enterprise agent teams, regulated industries.
- **Traction:** Graphiti widely adopted/forked (incl. a TypeScript port, GraphZep); claims 94.8% on DMR vs MemGPT's 93.4%; LongMemEval leadership claims contested by Mem0 and Honcho.

## 3. Letta (MemGPT) — stateful-agents platform, not just memory

- **Funding:** $10M seed led by Felicis at $70M post-money (Sept 2024), with Sunflower Capital, Essence VC; Founders Fund-adjacent angels. UC Berkeley BAIR spinout (Charles Packer, Sarah Wooders). No Series A found as of 2026-06-10. ([PR Newswire](https://www.prnewswire.com/news-releases/berkeley-ai-research-lab-spinout-letta-raises-10m-seed-financing-led-by-felicis-to-build-ai-with-memory-302257004.html), [TechCrunch](https://techcrunch.com/2024/09/23/letta-one-of-uc-berkeleys-most-anticipated-ai-startups-has-just-come-out-of-stealth/))
- **Product:** Open-source agent framework (`letta-ai/letta`) + Letta Cloud (credit-based hosted agents) + Agent Development Environment. April 2026: published a "Context Constitution" (principles for agent context management) and launched **Letta Code**, a local personalized coding agent — moving toward end-user products. ([letta.com/blog/our-next-phase](https://www.letta.com/blog/our-next-phase), accessed 2026-06-10)
- **Mechanism:** MemGPT lineage — OS-style virtual context: self-editing memory blocks (core memory) + paged external storage (archival/recall), agent uses tools to edit its own memory. Memory correctness depends on the agent's own judgment; no separate consolidation pass or contradiction gate.
- **Pricing:** Letta Cloud credit-based (~$0.00015/sec per third-party comparison); self-host free (Apache-2.0). (AgentMarketCap 2026 landscape, LOW confidence on exact rates)
- **Target:** Developers building long-running stateful agents; shifting toward prosumer (Letta Code).
- **Traction:** MemGPT paper is the canonical citation for agent memory; large OSS following; pluggable memory backends (can even use Mem0/Zep underneath).

## 4. Supermemory — universal memory API, consumer+dev hybrid

- **Funding:** ~$3M total (pre-seed + $2.6M seed, Oct 2025) led by Susa Ventures, Browder Capital, SF1.vc; angels incl. Jeff Dean (Google), Logan Kilpatrick (OpenAI→DeepMind), David Cramer (Sentry), Cloudflare execs. Founder Dhravya Shah (20, ASU dropout). Tracxn lists a "$26M seed" — this conflicts with TechCrunch and the founder's own "$3 Million" announcement; treat the $26M figure as erroneous/unverified. ([TechCrunch](https://techcrunch.com/2025/10/06/a-19-year-old-nabs-backing-from-google-execs-for-his-ai-memory-startup-supermemory/), [founder tweet](https://x.com/DhravyaShah/status/1975244767199138216), accessed 2026-06-10)
- **Product:** Hosted memory API + connectors (Drive, Notion, Gmail, GitHub, Granola, S3, web crawler) + MCP server + browser plugin. Ingests "any data."
- **Mechanism:** Extraction → custom "vector graph" engine + user profiling; emphasis on ingestion breadth and retrieval speed over belief maintenance. Update/correction semantics not documented publicly.
- **Pricing:** Free ($5 usage) → Pro $19 → Max $100 → Scale $399 (SOC 2, HIPAA, self-host option) → Enterprise (air-gapped). Usage in "SM tokens" $0.001–0.010/1K. ([supermemory.ai/pricing](https://supermemory.ai/pricing), accessed 2026-06-10)
- **Target:** AI app developers + prosumers; customers include Cluely, Montra, Scira, Composio's Rube.
- **Traction:** High social distribution; marquee angels; customer logos but no usage numbers disclosed.

## 5. Plastic Labs (Honcho) — psychology/identity modeling angle

- **Funding:** $5.35M pre-seed led by Variant, White Star Capital, Betaworks; Mozilla Ventures, Greycroft, Seed Club participating (note: Variant is a crypto fund; Plastic has agent-identity/crypto-adjacent positioning). ([PANews](https://www.panewslab.com/en/articles/0w9rpdwo), accessed 2026-06-10)
- **Product:** Open-source memory library + managed API (app.honcho.dev, $100 free credits, dedicated instance per org) + self-hostable FastAPI server.
- **Mechanism:** Differentiated: **theory-of-mind user modeling** — builds a psychological representation of the user (peer modeling: what one peer knows about another), queried via a natural-language "Dialectic" endpoint rather than raw fact retrieval. This is the closest funded player to "infers things the user never stated" — but aimed at personality/preference inference, not general schema induction over arbitrary domains.
- **Update/decay:** Continuous model revision as evidence accrues (their framing); no published prediction-error mechanism.
- **Pricing:** Credit-based managed API; OSS self-host free. Full pricing not published. (MEDIUM confidence)
- **Target:** Developers building personalized/companion/ed-tech agents.
- **Traction:** ~4.3k GitHub stars and trending (May 2026); claims SOTA on three agent-memory benchmarks as of May 2026 (self-reported). ([honcho.dev](https://honcho.dev/), dev.to review, accessed 2026-06-10)

## 6. Cognee — open-source ECL pipeline, Berlin, enterprise-grade

- **Funding:** $7.5M seed (announced Feb 2026) led by Pebblebed (Pamela Vagata, OpenAI co-founder), with 42CAP, Vermilion; angels from DeepMind, n8n, Snowplow. ([cognee.ai blog](https://www.cognee.ai/blog/cognee-news/cognee-raises-seven-million-five-hundred-thousand-dollars-seed), [EU-Startups](https://www.eu-startups.com/2026/02/german-ai-infrastructure-startup-cognee-lands-e7-5-million-to-scale-enterprise-grade-memory-technology/), accessed 2026-06-10)
- **Product:** Open-source platform (`topoteretes/cognee`) + cloud platform (expanding post-raise); plugs into Claude Agent SDK, OpenAI Agents SDK, LangGraph, Google ADK, n8n, Neo4j, Neptune.
- **Mechanism:** ECL pipeline (Extract → Cognify → Load): ingests 38+ source types, builds a knowledge graph + embeddings, unifies relational + vector + graph stores in one engine; supports ontology grounding and feedback-driven search auto-optimization. Roadmap: Rust engine for on-device/edge.
- **Update/decay:** Graph re-cognify on new data; "self-improving memory graph" via user feedback on search. No belief-revision/decay model documented.
- **Pricing:** OSS free; cloud pricing emerging (post-seed). (MEDIUM confidence)
- **Target:** Enterprise data/agent teams; self-host friendly.
- **Traction:** Pipeline runs ~2k → 1M+ in 2025 (500x); live in 70+ companies (self-reported).

## 7. LangMem (LangChain) — strategic free SDK, not a startup

- **Funding:** Not a company — LangChain product (LangChain itself is heavily funded, ~$260M+ total, $1.1B valuation reported 2025; LOW confidence on current figure, not re-verified).
- **Product:** Open-source SDK (MIT, `langchain-ai/langmem`) + free managed long-term memory inside the LangGraph platform.
- **Mechanism:** Tooling for extraction from conversations into semantic/episodic/procedural memory types; storage-agnostic; includes prompt-optimization ("procedural" memory updates agent prompts from feedback). Background "memory manager" consolidates after conversations.
- **Update/decay:** LLM-mediated upsert into stores; no decay or contradiction model beyond overwrite.
- **Pricing:** Free (loss-leader for LangGraph Platform). ([blog.langchain.com/langmem-sdk-launch](https://blog.langchain.com/langmem-sdk-launch/), accessed 2026-06-10)
- **Target:** Existing LangChain/LangGraph developers.
- **Traction:** Distribution via LangChain ecosystem; maturity still described as early in 2026 comparisons.

## 8. OpenMemory — two different things (disambiguation)

- **(a) Mem0's OpenMemory:** local/self-hosted MCP memory server and dashboard from Mem0 ([docs.mem0.ai/openmemory](https://docs.mem0.ai/openmemory/quickstart)). It's a Mem0 product line, not a separate company.
- **(b) CaviraOSS/OpenMemory:** independent open-source project ("self-hosted, framework-free," Hierarchical Memory Decomposition: one canonical node per memory, multi-sector embeddings — episodic/semantic/procedural/emotional, single-waypoint linking). Claimed 2–3x faster and ~10x cheaper than hosted memory APIs. **Not VC-funded**, and the repo now carries a sunsetting notice pointing users at Mem0 self-hosted. ([github.com/caviraoss/openmemory](https://github.com/caviraoss/openmemory), accessed 2026-06-10)
- **Takeaway:** the nearest open-source self-hosted analog to brain-memory effectively died and got absorbed into Mem0's funnel — the self-host OSS slot is genuinely under-occupied.

## 9. Hyperspell — YC F25, memory-from-your-tools

- **Funding:** YC Fall 2025; ~$2.0M raised; Pioneer Fund among first investors. Team of 6, SF. ([ycombinator.com/companies/hyperspell](https://www.ycombinator.com/companies/hyperspell), Extruct, accessed 2026-06-10)
- **Product:** SDK + pre-built connectors (Slack, Gmail, Notion, Drive) feeding an "Agentic Memory Network"; memory bootstrapped from existing workspace data, not just conversations.
- **Mechanism:** Ingest + entity/person/project extraction over connected accounts; details thin (early stage).
- **Pricing:** Not published. **Target:** agent developers who need user-workspace context. **Traction:** early; hiring.

## 10. Papr — predictive memory graph

- **Funding:** Unverified — no confirmed round found; positions as startup with open-source + cloud editions. (LOW confidence on funding status)
- **Product:** Memory API + open-source local version (`Papr-ai/memory-opensource`).
- **Mechanism:** MongoDB + Qdrant + Neo4j memory graph with multi-tier caching and **predictive retrieval** ("Anticipated Context" — push likely-needed context proactively instead of reactive search). Claims #1 on Stanford STaRK (91%+, <100ms). ([platform.papr.ai](https://platform.papr.ai/overview), accessed 2026-06-10)
- **Target:** agent developers. **Traction:** benchmark claims; modest OSS footprint.

## 11. Adjacent 2026 raises (enterprise "context" rather than personal memory)

These compete for the same "agents need memory" budget but aim at org knowledge, not user-belief maintenance:

- **Interloom** (Munich): €14.2M ($16.5M) seed, DN Capital — captures expert tacit knowledge into "permanent memory for AI agents." ([EU-Startups](https://www.eu-startups.com/2026/03/german-startup-interloom-lands-e14-2-million-seed-funding-for-ai-agent-knowledge-infrastructure/), [Fortune](https://fortune.com/2026/03/23/interloom-ai-agents-raises-16-million-venture-funding/), accessed 2026-06-10)
- **Jedify**: $24M Series A (June 2026), Norwest + Snowflake strategic — business-context layer for enterprise agents. ([TechCrunch](https://techcrunch.com/2026/06/10/jedify-raises-24m-to-help-companies-arm-ai-agents-with-context-on-their-business/))
- **SageOx** (Seattle): $15M seed, Canaan — shared memory between human teams and coding agents. ([GeekWire](https://www.geekwire.com/2026/seattles-sageox-lands-15m-to-help-humans-and-ai-agents-work-in-lockstep/))
- **Memobase**: "persistent synaptic layer" with passive hook-based capture and background **"Dream Phase" distillation** for Claude/Cursor/ChatGPT — conceptually closest to a sleep pass; funding status unverified. ([memobase.ai](https://memobase.ai/), accessed 2026-06-10)

## 12. Platform-level memory (the real long-term competitor)

- **OpenAI / ChatGPT — "Dreaming":** April 2025 added reference-all-chats; **June 4, 2026: Dreaming V3 rollout** — a background process that synthesizes memory automatically, *replaces* the saved-memories list, and **updates existing memories as time passes** (explicitly targeting staleness and correctness at hundreds-of-millions-of-users scale). Self-reported evals: factual recall 67.9%→82.8%, accuracy-over-time 52.2%→75.1%. This is sleep-pass consolidation + in-place belief update shipped as a consumer feature. ([openai.com/index/chatgpt-memory-dreaming](https://openai.com/index/chatgpt-memory-dreaming/), gHacks 2026-06-05, accessed 2026-06-10)
- **Anthropic / Claude:** Memory launched Sept 2025 (Team/Enterprise) → Pro/Max Oct 2025. Deliberately simple: synthesized, user-editable Markdown summary (~daily refresh), per-project memory separation, plus an agent-facing **memory tool** (beta, file-based) in the API. Transparent-file philosophy, no vector DB. ([Axios](https://www.axios.com/2025/10/23/anthropic-claude-memory-subscribers), MacRumors, accessed 2026-06-10)
- **Google / Gemini:** Personal Context (auto-memory from past chats, Gemini 2.5 Pro first) + **Personal Intelligence** on Gemini 3 (late 2025): memory grounded in Gmail/Photos/YouTube — distribution-based moat, not a developer API. ([blog.google](https://blog.google/products/gemini/temporary-chats-privacy-controls/), accessed 2026-06-10)

Implication: platform memory is closed, per-platform, non-portable, and non-inspectable. Funded startups sell portability/control to developers. brain-memory's slot is portability/control **plus** mechanism transparency for an individual self-hoster.

---

## Patterns across funded players

**What they all do:**
1. **LLM extraction pipeline at ingest** — every player runs conversations/data through an LLM to extract facts/entities; differences are in what the output lands in (flat fact store vs temporal graph vs user-psychology model).
2. **Hosted API as the business** — even the OSS-first ones (Mem0, Zep/Graphiti, Cognee, Honcho, Letta) monetize a managed cloud; OSS is the funnel. Pricing converges on free tier → $19–104 entry → $249–399 team → enterprise compliance (SOC 2/HIPAA/BYOC).
3. **Benchmark warfare** — LoCoMo / LongMemEval / DMR / STaRK numbers are the marketing currency; everyone claims SOTA on a self-run benchmark; numbers contradict across vendors.
4. **B2D targeting** — sell to agent developers, not end users (exceptions: Letta Code and Supermemory's prosumer tiers are early pivots toward end users).
5. **Graph adoption is rising** — 2024 was vector-RAG memory; 2025–26 consensus moved to knowledge graphs (Zep, Cognee, Supermemory, Papr, Mem0's graph option) with vectors as a retrieval layer.

**What none of them do (white space relevant to brain-memory):**
1. **Prediction-error-gated reconsolidation.** Closest analogs: Zep's temporal edge invalidation (contradiction-at-ingest, no error-magnitude gating) and OpenAI's Dreaming V3 (closed, consumer-only). No developer product gates updates on surprise/expectancy violation or keeps an evidence ledger separating observed from inferred.
2. **Schema induction.** Nobody abstracts unstated generalizations from episodes into testable schemas. Honcho infers psychology (narrow ToM domain); Mem0/Zep store what was said. "The memory forms beliefs you never stated and revises them" is unoccupied.
3. **Self-confirmation guards.** Mem0's 2026 algorithm explicitly weights agent-generated facts equal to user input. No vendor documents provenance-based protection against inferred output strengthening stored beliefs.
4. **Principled decay.** Either nothing decays (accumulate + dedupe) or relevance is purely retrieval-time scoring. No one publishes an evidence-protected forgetting model.
5. **Genuinely local-first single-user OSS.** Every funded player is multi-tenant cloud-first; self-host is the enterprise upsell (BYOC) or an afterthought. The one project squarely in brain-memory's slot (CaviraOSS OpenMemory) sunset itself into Mem0's funnel. SQLite-single-file, BYO-keys, hot-path-LLM-free is not a funded company's product.
6. **LLM-free hot path as a stated guarantee.** Zep's graph search is LLM-free at query time, but most pipelines (and all extraction) burn LLM calls; nobody frames "online path never calls an LLM, all cost in the offline pass" as a product contract.

**Threat ranking for brain-memory:** (1) OpenAI Dreaming V3 — validates and commoditizes the consolidation+update concept at platform scale; (2) Mem0 — distribution and OSS gravity; (3) Zep/Graphiti — closest mechanism (temporal belief tracking) and strong OSS; (4) Honcho — closest on inference-beyond-stated-facts. None threaten the self-hosted single-user Claude Code wedge directly today.

---

## Sources (accessed 2026-06-10)

- https://mem0.ai/series-a · https://mem0.ai/pricing · https://mem0.ai/blog/state-of-ai-agent-memory-2026 · https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps/
- https://www.getzep.com/ · https://www.getzep.com/pricing · https://arxiv.org/abs/2501.13956 · https://github.com/getzep/graphiti
- https://www.prnewswire.com/news-releases/berkeley-ai-research-lab-spinout-letta-raises-10m-seed-financing-led-by-felicis-to-build-ai-with-memory-302257004.html · https://www.letta.com/blog/our-next-phase · https://techcrunch.com/2024/09/23/letta-one-of-uc-berkeleys-most-anticipated-ai-startups-has-just-come-out-of-stealth/
- https://techcrunch.com/2025/10/06/a-19-year-old-nabs-backing-from-google-execs-for-his-ai-memory-startup-supermemory/ · https://supermemory.ai/pricing · https://x.com/DhravyaShah/status/1975244767199138216
- https://www.panewslab.com/en/articles/0w9rpdwo · https://honcho.dev/ · https://github.com/plastic-labs/honcho
- https://www.cognee.ai/blog/cognee-news/cognee-raises-seven-million-five-hundred-thousand-dollars-seed · https://www.eu-startups.com/2026/02/german-ai-infrastructure-startup-cognee-lands-e7-5-million-to-scale-enterprise-grade-memory-technology/
- https://blog.langchain.com/langmem-sdk-launch/ · https://github.com/langchain-ai/langmem
- https://github.com/caviraoss/openmemory · https://docs.mem0.ai/openmemory/quickstart
- https://www.ycombinator.com/companies/hyperspell · https://platform.papr.ai/overview · https://memobase.ai/
- https://www.eu-startups.com/2026/03/german-startup-interloom-lands-e14-2-million-seed-funding-for-ai-agent-knowledge-infrastructure/ · https://techcrunch.com/2026/06/10/jedify-raises-24m-to-help-companies-arm-ai-agents-with-context-on-their-business/ · https://www.geekwire.com/2026/seattles-sageox-lands-15m-to-help-humans-and-ai-agents-work-in-lockstep/
- https://openai.com/index/chatgpt-memory-dreaming/ · https://www.ghacks.net/2026/06/05/openai-upgrades-chatgpt-memory-with-new-dreaming-architecture-for-plus-and-pro-users/ · https://www.axios.com/2025/10/23/anthropic-claude-memory-subscribers · https://blog.google/products/gemini/temporary-chats-privacy-controls/
- Third-party comparisons (lower confidence): https://agentmarketcap.ai/blog/2026/04/10/agent-memory-vendor-landscape-2026-letta-zep-mem0-langmem · https://dev.to/andrew-ooo/honcho-review-plastic-labs-agent-memory-layer-2026-2kb4
