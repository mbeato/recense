# Feature Research — v10.0 Action Proposals

**Domain:** Email-triggered belief updates + domain-neutral action-proposal contracts (context-layer-proposes / system-of-record-confirms split)
**Researched:** 2026-07-29
**Confidence:** MEDIUM overall — HIGH for architecture/contract-shape findings (grounded in specs: CloudEvents, JSON Patch RFC 6902, MCP tool-call, plus recense's own shipped code); LOW-MEDIUM for consumer-product behavior (job trackers/CRMs publish no methodology, only marketing claims); MEDIUM for confidence-threshold/UX findings (peer-reviewed HCI papers exist but are general-AI, not domain-specific)

---

## Context: What's Already Built vs. What's New

This research covers **only** the five new surfaces named in `PROJECT.md`'s v10.0 scope. It explicitly does not re-cover ground v4.0's research (`.planning/research/v4.0-FEATURES.md`) already settled: proactive surfacing (`/v1/surface`), notification-fatigue guards, Telegram HITL plumbing (inline keyboard, edit/reject/snooze, audit trail, per-server allowlist, typed destructive confirm), or any-MCP execution. That machinery is **reused**, not rebuilt. Read `clients/telegram/proposal-engine.ts` and `clients/telegram/types.ts` alongside this file — they are the shipped "tool-shaped" half of the pattern this milestone extends to a second, "belief-shaped" kind.

Also out of deep research scope here (per PROJECT.md, pure extension of shipped machinery, LOW complexity, no new domain question): **multi-inbox email ingest onboarding** (per-account `gmail.query` scoping reuses the existing per-account `GmailAdapter`/cursor/`· Acct:` fan-out from v4.0 TEMP-04).

---

## Feature Area 1: Email → Status-Change Intent Classification

**What the feature does:** In the offline sleep pass, decide whether an ingested email episode implies a status change to a tracked entity (e.g., a job application). The hot path stays LLM-free — this classification happens where recense already pays LLM cost (extraction).

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Sender-domain / structural pre-filter before the LLM call | Every comparable system (job trackers, CRM email-sync) uses cheap pre-filtering before expensive classification — reduces LLM calls on obviously-irrelevant mail (newsletters, receipts) | LOW | Reuses the existing per-source extraction-prompt-variant pattern proven in v4.0 (`GMAIL_EXTRACTION_PROMPT` variants selected by heuristic). Domain patterns exist but are **not reliable as a sole signal** — see Anti-Features below. |
| Thread-continuity linking (Gmail `threadId`/`References` header) | Job trackers and CRM tools alike use "this email is a reply in a thread that started with an application/deal" as a strong prior for *which entity* the email is about — this is really an entity-resolution signal riding along with classification | LOW-MEDIUM | Recense already ingests Gmail headers; `threadId` isn't currently exploited for grouping. Cheap, high-value addition — feeds Feature Area 2 as much as Feature Area 1. |
| Subject-line / boilerplate keyword heuristic as a coarse routing signal | ATS and CRM vendor templates are highly formulaic ("Thank you for applying to...", "we have decided to move forward with other candidates", "Application Update") — this is well-documented boilerplate, not a novel signal | LOW | Feed as a cheap feature into the extraction prompt, not as a standalone rule engine (see anti-feature below). |
| LLM read as the actual classification decision (offline, in sleep pass) | Every signal above is a prior, not a verdict — date expressions, negation ("not moving forward" vs "moving forward"), and vendor-specific phrasing genuinely require contextual LLM reading; this exactly matches the v4.0 research's finding for temporal extraction ("rule-based NER fails on these") | MEDIUM | Extends the existing per-source extraction-prompt-variant seam (Gmail episodic-variant precedent from v4.0). This is the actual new prompt-engineering work of this feature area. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Classification stays LLM-free on the hot path, entirely in the sleep pass | No comparable consumer tool (Simplify, Teal, Huntr, JobShinobi) publishes an architecture split between "ingest" and "decide" — they're black boxes. Recense's split lets classification quality improve without touching the online read path | LOW (already the architecture) | This is really an engine-invariant carried forward, not new work — flag as differentiator because it's genuinely uncommon in the ecosystem, not because it costs anything new. |
| Classification is entity-grounded via the whole graph, not just the current email | A generic ATS/CRM tool classifies one email in isolation. Recense can pull the 1-hop neighborhood of a candidate entity (prior applications, prior emails to the same company) into the classification context — disambiguates "which of the 3 Google roles this candidate applied to" | MEDIUM | Reuses `/v1/search`-style memory-grounded parameterization, same pattern proposal-engine.ts already does for tool-shaped proposals (T-SEC-03 delimiter-fencing must carry over — see Pitfalls-adjacent note below). |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| A maintained "ATS vendor fingerprint" ruleset (sender-domain → vendor → status-meaning lookup table) | Feels like free, deterministic signal — Greenhouse/Lever/Workday domains look stable | **Companies can and do whitelabel ATS mail** through their own verified domain (Greenhouse explicitly supports sending "no-reply@yourcompany.com" after domain verification — confirmed on Greenhouse's own support docs). A fingerprint table built today silently degrades as companies configure custom domains, and it's an unbounded, never-finished maintenance burden (dozens of ATS vendors, each changing templates). LOW confidence in any specific fingerprint remaining stable. | Treat sender domain as one weak prior feature fed into the LLM read, never as a standalone routing table. The LLM already reads far more signal (body text) than a domain string can encode. |
| Real-time / webhook-triggered classification on email arrival | Lower latency, "feels responsive" | Directly contradicts the shipped hourly sleep-pass invariant and the "online paths stay LLM-free" constraint reaffirmed for v10.0 in PROJECT.md | Sleep pass on existing schedule; a rejection/offer email sitting unclassified for up to an hour is an acceptable trade — this mirrors the v4.0 precedent (temporal facts also wait for the sleep pass) |
| Building a comprehensive "email intent taxonomy" (dozens of intent labels: interview-scheduling, recruiter-outreach, rejection, offer, withdrawal, ghosting-inferred, etc.) | More labels = more precision, feels thorough | Every extra label is a new decision boundary the LLM must get right and a new case the belief-gating logic must handle; PROJECT.md scopes the lifecycle to exactly four states (applied/interviewing/rejected/offer) — a wider taxonomy is scope creep that doesn't serve the demonstrated contract | Keep the classification output binary-ish: "does this episode imply one of the four tracked transitions, and if so which" — anything else is `no_change` |

### Dependencies on Existing Recense Capabilities
- Pluggable `SourceAdapter` seam + per-account Gmail fan-out (v4.0 TEMP-04) — email episodes already arrive salience-gated and secrets-redacted
- Per-source extraction-prompt-variant pattern (v4.0 Gmail episodic-variant precedent) — the mechanism this reuses
- Sleep-pass scheduler — classification runs here, not online

---

## Feature Area 2: Entity Resolution Against an Externally-Owned Canonical List

**What the feature does:** Decide *which* tracked application/company/role an email is about — where the canonical ID space for "which application" may belong to a consumer system (jobfill), not to recense.

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Recense resolves the email to *its own* internal entity node first | This is a prerequisite for emitting anything coherent, and it is **already mostly solved**: v9.0 shipped union candidate generation (entity-keyed + BM25 + dense) specifically so the reconsolidation judge fires on real contradictions. The same candidate generation resolves "which existing entity node does this email's company/role mention match" | LOW (reuse) | The genuinely new piece is exposing the resolved node (or "no confident match" state) to the proposal-emit step, not building resolution logic from scratch. |
| Proposal carries a stable reference *and* a human/fuzzy descriptor, not a foreign-system ID | Master-data-management practice draws a hard line: the **system of record** owns and creates IDs in its own domain; other systems reference entities by descriptor/business-key, never by minting or assuming the SoR's internal ID (verified via MDM/golden-record literature — Semarchy, Tilores, D&B docs on golden records) | LOW | Maps directly to the "recense has zero knowledge of consumer's schema" constraint: recense emits `{company: "Acme Corp", role: "Backend Engineer", recense_node_id: "..."}` — the consumer's adapter does its own fuzzy match against its own canonical list using the descriptor, keyed secondarily by recense's own stable node id for idempotent re-delivery. |
| Thread-continuity as a resolution signal (see Feature Area 1) | Same-thread email is near-certain to be about the same application; this is stronger evidence than semantic similarity alone | LOW | Cheap addition to the existing dense/BM25/entity-keyed candidate union — thread ID becomes another candidate-generation channel, same shape as the existing three. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Descriptor-based resolution, not ID-mirroring or live query | This is the actual architectural decision the roadmap needs, and prior art strongly favors it over the two alternatives (see Anti-Features). No comparable OSS memory engine documents this pattern for a personal-scale tool — recense would be establishing it, not following a template | LOW (once entity resolution above exists, this is just what goes in the payload) | This is the answer to PROJECT.md's open discuss-phase question ("who owns the canonical list") — see recommendation below. |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Recense mirrors/caches the consumer's full canonical entity list | Feels like it would make matching "exact" instead of fuzzy | Creates a sync problem (staleness the moment jobfill adds/renames an application), tight coupling (a schema/format change in jobfill breaks recense's mirror), and **directly violates** the "recense has zero knowledge of consumer's schema" requirement — the mirror *is* consumer schema knowledge | Emit a descriptor; let the consumer's own adapter — which already knows its own IDs — do the match. This is exactly the MDM "golden record does not replace system of record" boundary. |
| Recense queries the consumer live at classification/proposal time ("which entity is this?") | Would in principle give a maximally accurate match | Adds a network dependency and availability coupling recense has never had (engine has always been fully self-contained + offline-computable); violates PROJECT.md's explicit "no message bus for a personal tool — keep it dead simple" framing; also inverts the intended data-flow direction (producer calling into consumer is a tighter coupling than consumer pulling from producer) | Keep the interface one-directional: recense emits (or exposes via a queue/read endpoint), consumer pulls and resolves on its own schedule — same shape as the shipped `/v1/surface` (LLM-free ranked read, consumer decides what to do with it) |
| A generic "identity resolution" subsystem modeled on customer-data-platform tools (Segment-style identity graphs, deterministic + probabilistic merge rules, survivorship policies) | Sounds like the "proper" enterprise solution | Massive over-build for a single-consumer, single-user, personal-scale system — that machinery exists to reconcile *many* systems of record with each other; here there is exactly one producer and (initially) one consumer | The existing v9.0 entity-dedup/candidate-generation machinery, already tuned on real data, is sufficient. Don't import enterprise-MDM concepts (survivorship rules, golden-record governance workflows) wholesale. |

### Recommendation for the Open Question (canonical-list ownership)
Prior art across MDM/CDP and CloudEvents/MCP-shaped systems converges on one pattern that survives multiple consumers: **the producer never assumes or mirrors the consumer's ID space.** Recense should resolve to its *own* stable entity reference (existing entity-dedup machinery) and emit a rich-enough descriptor (company, role, evidence text, thread reference) that any consumer adapter — jobfill today, something else tomorrow — can run its own match logic. This keeps recense's "zero knowledge of consumer schema" claim literally true rather than aspirational.

### Dependencies on Existing Recense Capabilities
- v9.0 union candidate generation (entity-keyed + BM25 + dense) — RECON-01..04 — this is the resolution engine, already validated (368 real contradicts fired on LongMemEval-KU; belief-correction 84.6%, source: `PROJECT.md` v9.0 close notes, HIGH confidence — internal, reproducible via `docs/evals.md`)
- v6.0 entity dedup/prune pass — keeps the internal entity graph clean enough for resolution to be meaningful
- `node_scope` provenance — already distinguishes per-account/source origin, useful for multi-inbox disambiguation

---

## Feature Area 3: Belief-Gated Status Lifecycle ("The Differentiator")

**What the feature does:** Model status transitions (applied → interviewing → rejected → offer) as beliefs subject to `supersedes` and PE-gated three-way reconsolidation, so one ambiguous email cannot flip status — it must HOLD.

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| A default-to-HOLD outcome on ambiguous evidence | Every credible practice this research found — from ML-ops confidence-threshold guides to hardware hysteresis/debounce design to the job-tracker domain's own ambiguity (see below) — treats "don't act on weak/single evidence" as baseline hygiene, not a differentiator in itself | LOW (reuse) | This is **already the existing PE-gated three-way update** (HOLD / tombstone-reconcile / append-new) from Phase 2/v9.0. No new mechanism — new work is defining what "status" evidence maps onto this existing gate. |
| A small, closed status vocabulary (4 states, per PROJECT.md) | Consumer-facing job trackers converge on roughly this granularity too (Applied/Interviewing/Offer/Rejected is the common denominator across Teal, Huntr, JobShinobi feature descriptions found in this research) — a wider taxonomy is the consumer's job to layer on top, not recense's | LOW | Keep the belief's own vocabulary minimal; the consumer adapter maps recense's 4 states onto however many stages its own schema has (e.g., jobfill might split "interviewing" into phone/onsite — that split lives in jobfill, not recense). |
| Genuinely decisive evidence should still transition state without artificial delay | The job-tracking domain itself has genuinely decisive emails (a plain-text human rejection, an explicit offer letter) alongside genuinely ambiguous ones (Greenhouse's "Application Received" boilerplate, which — per direct research finding — "can sit for weeks without meaning much," and Workday's "Under Consideration" vs. "No Longer Under Consideration" which the same source calls a real, decisive signal). Hold-everything-forever is as wrong as flip-on-anything. | LOW (reuse) | The existing PE-magnitude-vs-effective-strength gate already encodes "how much evidence is enough" as a continuous function, not a fixed rule — this is more principled than most of what the researched ecosystem does (see differentiator below). |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| PE-gated reconsolidation *as* the hold-vs-propose decision, not a bolted-on confidence-threshold knob | This is the actual "belief layer earns its keep" claim from PROJECT.md. Generic classifier deployments (per this research) hand-tune a single global numeric threshold (commonly cited informal band: ~0.75–0.90 for human-review routing — **source: workforceplaybook.ai guide, a vendor/marketing explainer, not peer-reviewed; LOW confidence, cited only as evidence of common industry practice, not as a number to adopt**) and separately flag that raw LLM-reported confidence is often miscalibrated ("a model that reports 0.9 confidence might actually be right only 70% of the time" — same source, same caveat). Recense's existing PE-vs-strength gate is a more principled answer because it weighs new evidence against the *accumulated* strength of the existing belief, not a single static cutoff. | MEDIUM | New work: define what counts as "PE" for a status claim (a rejection email contradicting an "interviewing" belief should register high PE; a vague "still under review" email should not). This is prompt/extraction design work, not new reconsolidation-engine work. |
| Analogy to hysteresis/debounce in control systems | Not domain-specific prior art, but a well-established general engineering pattern: state machines use two distinct thresholds (or repeated confirming signal) specifically to prevent "flapping" on noisy input near a boundary (verified via general hardware/embedded-systems sources — hysteresis comparators, thermostat setpoint deadbands). Recense's HOLD state is architecturally the same idea, applied to belief updates instead of voltage thresholds. | N/A (already built) | Cite as validating analogy for the roadmap's confidence, not as literal domain prior art — label MEDIUM confidence, general-engineering source, not job-tracking-specific. |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| A standalone numeric confidence-threshold config (a "0.8 slider") layered on top of / parallel to PE-gating | Every generic ML-ops guide surfaced by this research defaults to this pattern, so it *looks* like industry standard | It duplicates a decision the engine already makes more soundly (PE magnitude vs. accumulated strength), and it reintroduces the exact miscalibration risk the research flags — a single global cutoff can't distinguish "genuinely decisive rejection email" from "high LLM confidence on a boilerplate acknowledgment." Building it would be adding a second, weaker gate next to a stronger one that already exists. | Feed the LLM's raw confidence into the proposal payload as informational metadata only (see Feature Area 5) — never as the programmatic gate. Let PE-vs-strength remain the sole gate, as it already is for every other belief type in recense. |
| Requiring N (e.g. 2) independent confirming emails before any transition, as a hard rule | "Two-signal confirmation" sounds like an obviously-safe pattern (and is a real pattern in fraud detection / alerting) | Over-rigid for this domain: some single emails (an explicit written offer, a "we regret to inform you" rejection) are unambiguous and users would rightly be frustrated by an artificial one-email delay; a fixed-N rule can't distinguish that from an ambiguous "still reviewing" email | Same as above — let PE magnitude do this job continuously rather than bolting on a discrete debounce counter |
| A rich multi-stage lifecycle (phone-screen, technical-interview, onsite, panel, reference-check, etc.) inside recense's belief model | More granularity looks like more value | Directly contradicts PROJECT.md's explicit 4-state scope and the "recense has zero knowledge of consumer's schema" boundary — a richer taxonomy is consumer-schema knowledge leaking into the producer | Recense's belief stays at the 4-state granularity named in scope; any finer staging is the consumer adapter's interpretation of recense's coarse signal plus its own data |

### Dependencies on Existing Recense Capabilities
- PE-gated three-way reconsolidation (HOLD / tombstone-reconcile / append-new) — UPDATE-01..05, Phase 2, hardened further in v9.0 (HARD-01..04) — this is the entire mechanism; v10.0 supplies the domain mapping, not the mechanism
- `supersedes` typed predicate (shipped) — the exact primitive named in PROJECT.md for status transitions
- Union candidate generation (v9.0 RECON-01..04) — needed so the judge actually sees the prior status belief as a candidate when a new status-implying email arrives (this is precisely the "judge fires zero on real contradictions" failure mode v9.0 fixed — status drift is a textbook contradiction case this machinery was built for)

---

## Feature Area 4: Domain-Neutral Proposal Emit Seam

**What the feature does:** `{entity, proposed_change, evidence_episode, confidence}` — a producer→consumer contract where recense has zero knowledge of the consumer's schema and never writes the consumer's DB.

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| A stable envelope separating routing/identity metadata from payload | CloudEvents (CNCF spec, HIGH confidence — official spec docs) is the clearest prior art: required fields (`id`, `source`, `type`, `specversion`) plus optional `time`/`subject`/`dataschema` form the envelope, and the **payload** (`data`) is explicitly left for the producer/consumer to define between themselves — CloudEvents does not try to standardize business semantics, only the envelope | LOW | recense's proposed shape already mirrors this instinct at a smaller scale: `evidence_episode` ≈ a provenance pointer, `entity`/`proposed_change` ≈ the domain-specific payload, `confidence` ≈ metadata. Keep it this size; don't grow toward full CloudEvents (see Anti-Features). |
| A closed, small vocabulary for `proposed_change`, not path-addressed patches | **JSON Patch (RFC 6902)** was investigated as a candidate shape and is the **wrong model here**: it expresses operations against *paths into a known document structure* (`/status`, `/interviews/0/date`) — which presupposes the producer knows the consumer's document shape. That directly violates "recense has zero knowledge of consumer's schema." JSON Merge Patch has the same presupposition at a coarser grain. | LOW | Use a flat, semantic key-value triple instead: `{field: "status", from: "applied", to: "rejected"}` in **recense's own vocabulary** — the consumer adapter is responsible for mapping recense's generic field/value names onto its own schema, exactly as an MCP tool's `inputSchema` is owned by the tool, not the caller. |
| `evidence_episode` as an auditable pointer, not embedded proof | Every HITL/audit pattern examined (recense's own shipped `source:'hitl'` audit trail; CQRS/event-sourcing's convention of an event carrying enough identity to trace back to its cause) treats provenance as a reference, letting the full record live in the existing episodic log rather than being duplicated into the proposal | LOW (reuse) | Recense already has an episodic log with IDs; `evidence_episode` is just a foreign-key-shaped reference into it, following the exact same audit precedent as v4.0's `source:'hitl'` episodes. |
| Proposal identity + expiry fields (id, createdAt, maxTtlMs) | Already a solved, shipped shape — `StoredProposal` in `clients/telegram/types.ts` already carries exactly this (immutable id, createdAt, maxTtlMs, dueAt) for tool-shaped proposals, and CQRS command literature independently converges on "command must carry enough identity for idempotent, once-only handling" | LOW (reuse) | Don't redesign this shape for the belief-shaped kind — extend `StoredProposal`/its engine-side analogue with a `kind: 'tool' \| 'belief'` discriminator instead of inventing a parallel structure. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| The contract is provably domain-neutral because recense's own belief vocabulary (applied/interviewing/rejected/offer) is *generic enough to not be jobfill's schema* | This is the actual claim the milestone is trying to prove out — a producer that emits `{field, from, to}` in its own small vocabulary, with the consumer owning the translation, is exactly the same seam shape as MCP's tool-call contract (`{name, arguments}` where the *tool* owns `inputSchema`) — which is prior art recense has **already implemented once**, for tool-shaped proposals, in this exact codebase | LOW-MEDIUM (mirrors proven code) | The strongest complexity-reduction finding in this research: `proposal-engine.ts`'s validation pattern (D-02 confident-or-null, T-SEC-04 re-validation on edit) is directly portable to the belief-shaped kind — same shape, different vocabulary. |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Adopting the full CloudEvents envelope (specversion, dataschema URIs, content-type negotiation, extension attributes) | "It's the standard, use the standard" | CloudEvents exists to let *many* producers and *many* consumers interoperate across organizational boundaries without prior coordination — recense has exactly one producer and (initially) one hand-written in-repo consumer adapter. The versioning/negotiation machinery solves a problem this milestone doesn't have. PROJECT.md explicitly says "no message bus for a personal tool — keep it dead simple." | Borrow only the *conceptual* separation (envelope vs. payload) — not the spec's field count or versioning ceremony |
| A message bus / event broker (Kafka-style topics, retry/DLQ semantics) for the proposal contract | "Proposals are events, use event infrastructure" | Directly named as a rejected pattern in PROJECT.md's open-question framing. A single-writer local table read over HTTP/CLI (the existing `/v1/surface` shape) has zero new infrastructure and matches recense's whole architecture (single-tenant, no new runtime deps) | A `proposals` table (or extension of the existing surface table) read via the existing `brain serve` HTTP surface or CLI — same pattern as `/v1/surface` |
| JSON Patch / RFC 6902-style path-addressed operations for `proposed_change` | Looks more "standard" and expressive (supports move/test/remove) | As detailed above, presupposes shared knowledge of the target document's structure — the single clearest schema-knowledge leak this research found. Also RFC 6902's atomicity/ordering semantics (array indices, `test` ops) are solving a document-patching problem recense doesn't have (a status label is not a document) | Flat `{field, from, to}` semantic triple in recense's own small closed vocabulary |
| A generic CQRS "command bus" abstraction (command versioning, replay, saga orchestration) | Feels architecturally rigorous | Massive over-build: CQRS command buses exist to guarantee exactly-once delivery and ordering across distributed aggregates at scale; here there is one producer, one local reference consumer, and delivery is "consumer reads a table/endpoint on its own schedule" | Keep the `StoredProposal`-style shape (id + immutable payload + expiry) that recense already ships; no bus, no replay log |

### Recommended Field Set (synthesized from the above)

```
{
  id,                    // stable proposal id, mirrors StoredProposal.id
  kind: 'belief',        // discriminator alongside existing 'tool' kind
  entity: {
    recense_node_id,     // recense's own stable reference (Feature Area 2)
    descriptor: {...}    // company/role/etc. — human-readable, fuzzy-matchable by consumer
  },
  proposed_change: {
    field: 'status',      // recense's own small closed vocabulary
    from: 'applied',
    to: 'rejected'
  },
  evidence_episode: episode_id,   // pointer into existing episodic log
  confidence: 0.0-1.0,            // informational only — never the programmatic gate (Feature Area 3)
  createdAt, maxTtlMs             // reuse StoredProposal shape
}
```

### Dependencies on Existing Recense Capabilities
- `/v1/surface` LLM-free read pattern (v4.0) — the emit seam is architecturally this pattern, extended
- `StoredProposal` shape (`clients/telegram/types.ts`) — id/expiry/immutable-payload conventions transfer directly
- Episodic log — `evidence_episode` references it, no new storage needed
- `docs/reference-client.md` adopter-template precedent (v3.0 CLIENT-03) — the in-repo reference consumer adapter follows the same pattern already used for the Telegram client extraction

---

## Feature Area 5: HITL Approval for Belief-Shaped Proposals

**What the feature does:** Extend the existing v4.0 Telegram HITL machinery (Approve/Edit/Reject/Snooze, audit trail, expiry, rate cap) to a second proposal *kind* — belief-shaped instead of tool-shaped.

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Same four-action taxonomy (Approve/Edit/Reject/Snooze) | Directly reuses the shipped, founder-validated v4.0 pattern; n8n's own HITL documentation (checked as an independent industry reference) converges on the same small action set (approval buttons / free text / custom form) for gated tool calls — recense already matches or exceeds this | LOW (reuse) | No new interaction pattern needed at the taxonomy level — only the payload rendered inside it changes. |
| One proposal surfaced at a time, batched into digest for non-urgent items | Already the settled v4.0 finding (see `v4.0-FEATURES.md` Feature Area 4 Anti-Features: "Multiple pending proposals simultaneously... cognitive overload") — this research found nothing in the wider ecosystem (n8n, LangGraph HITL, Salesforce Einstein Activity Capture) that contradicts it; if anything, n8n's own docs describe gating individual tool calls one at a time by design | LOW (reuse, no new research needed) | Do not re-litigate this — it was already settled and is domain-general, not tool-shaped-specific. |
| Audit log excluded from consolidation (`source:'hitl'`) | Already shipped invariant, and directly required again here — a belief-shaped approval/rejection must not itself become evidence that strengthens the belief it just adjudicated (this is the same D-43 self-confirmation concern, now applied to belief-shaped proposals instead of tool-shaped ones) | LOW (reuse) | This is arguably *more* load-bearing for belief-shaped proposals than tool-shaped ones — an approved status-change proposal describes the exact same content as the belief update itself, so the self-confirmation risk is more direct. Flag as a verification-criterion carryover, not new design. |
| Edit affordance appropriate to a closed vocabulary | For tool-shaped proposals, "Edit" means patching arbitrary JSON args against a tool's `inputSchema` (`proposal-engine.ts`'s `validateEditedArgs`). For belief-shaped proposals, the editable surface is much smaller: which entity this is about (if resolution/Feature-Area-2 picked the wrong one), or which of the 4 target statuses is correct (if classification picked the wrong transition) | LOW-MEDIUM | This is genuinely simpler than the tool-shaped edit path (closed enum choices vs. arbitrary schema-typed args), not harder — a real complexity *reduction* relative to what's already shipped. |

### Differentiators

None identified specific to this feature area — HITL interaction design itself is commodity (n8n, LangGraph, and recense's own v4.0 all converge on the same shape). The differentiator lives entirely in Feature Area 3 (what's being approved, not how approval works). This area is pure extension/plumbing.

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Showing the raw LLM-reported confidence number to the user (e.g., "87.3% confident") | Feels transparent, "let the user judge for themselves" | Two independent findings argue against precision-theater here: (1) miscalibrated AI confidence is *undetectable* by users and measurably increases inappropriate reliance (arxiv 2402.07632, peer-reviewed HCI study — MEDIUM confidence, general-AI not domain-specific); (2) raw classifier confidence is frequently uncalibrated in practice ("0.9 confidence, actually right 70% of the time" — workforceplaybook.ai, LOW confidence, vendor guide). A precise-looking decimal invites a false sense of rigor recense cannot back up empirically at this stage. | Show a coarse categorical signal instead ("this looks clear-cut" vs. "worth double-checking") or simply show the evidence excerpt and let the human read it — the existing Feature-Area-4 `confidence` field stays informational/internal, not necessarily user-facing at all in v1 |
| A separate, distinct bot flow or UI surface for belief-shaped proposals ("job-application mode") | Feels like the two kinds are different enough to deserve their own presentation | Forks the client for no functional reason; the whole point of the milestone is a **generic** proposal machinery with two kinds flowing through one pipe — a UI fork undermines the "domain-neutral" claim at the one place a user actually sees it | Single unified inline-keyboard flow with a `kind` discriminator controlling only the rendered payload text, not the interaction shape |
| Auto-approving high-confidence belief proposals ("if confidence > X, just apply it, skip the human") | "Reduce friction for the obvious cases" | Directly contradicts the milestone's own premise (system-of-record *confirms*, always) and the already-shipped v4.0 anti-feature "auto-approve after timeout... violates the core HITL invariant" — this would apply equally or more strongly here, since a belief-shaped auto-apply writes state, not just fires a reversible tool call | Keep every belief-shaped proposal gated; if approval volume becomes a real problem later, that's a v10.x UX question (e.g. bulk-approve UI), not a bypass of the gate itself |

### Dependencies on Existing Recense Capabilities
- Telegram inline keyboard + Approve/Edit/Reject/Snooze handlers (v4.0, Phase 23) — direct reuse, add `kind` branch
- `proposal-engine.ts` validation pattern (D-02 confident-or-null, T-SEC-03 delimiter-fencing, T-SEC-04 edit re-validation) — directly portable pattern, not portable code (belief-shaped payloads are much simpler: closed enums, not arbitrary tool `inputSchema`)
- `StoredProposal` shape + expiry/rate-cap machinery — extend with `kind` discriminator rather than duplicating
- `source:'hitl'` audit-exclusion invariant — must hold for the new kind exactly as it holds for the old one

---

## Feature Dependencies

```
[Multi-inbox email ingest — reuse, no new work]
    └──feeds──> [Sleep-pass intent classification (Feature Area 1)]
                    └──requires──> [Internal entity resolution — v9.0 candidate generation, REUSE]
                    │                   └──feeds──> [Descriptor emitted in proposal (Feature Area 2)]
                    │
                    └──feeds──> [Status-claim extraction]
                                    └──gated-by──> [PE-gated reconsolidation — v9.0/Phase-2 machinery, REUSE]
                                                       └──produces──> [Belief-shaped status update (HOLD or transition)]
                                                                          └──triggers──> [Domain-neutral proposal emit (Feature Area 4)]
                                                                                             └──consumed-by──> [In-repo reference adapter]
                                                                                             └──gated-by──> [HITL approval, 'belief' kind (Feature Area 5)]
                                                                                                                └──audit──> [Episodic log, source:'hitl', consolidation-excluded]

[StoredProposal shape + 4-action taxonomy] (v4.0, shipped)
    └──extended-by (kind discriminator)──> [Feature Area 5]

['supersedes' typed predicate] (shipped)
    └──used-by──> [Feature Area 3]
```

### Dependency Notes

- **Feature Area 3 is downstream of Feature Areas 1 and 2, but is the smallest amount of genuinely new mechanism** — it reuses the existing PE-gate wholesale; the new work is entirely in mapping the job-status domain onto it (what counts as contradicting evidence for a status belief).
- **Feature Area 4 (the emit seam) is architecturally a sibling of the shipped `/v1/surface`** — same "LLM-free read endpoint over a state table" shape, not a new architectural pattern.
- **Feature Area 5 is the cheapest area in this milestone** — it's a `kind` branch on already-shipped, founder-validated machinery, not new design.
- **The one place genuinely deep new work concentrates is Feature Area 1** (the classification prompt) and the domain-mapping half of Feature Area 3 (what job-status evidence maps onto PE magnitude) — this is where roadmap research-time should be budgeted, not on the contract shape or HITL UX, both of which have strong, directly-reusable prior art already in this codebase.

---

## MVP Definition for v10.0

Per PROJECT.md, scope is already fixed (producer + in-repo reference adapter; live jobfill wiring is out of scope). "MVP" here means: what within the fixed scope is genuinely new build work vs. what is reuse-with-a-discriminator.

### Launch With (v10.0 gate — matches PROJECT.md's target features)

- [ ] Sleep-pass intent classification prompt (new prompt-engineering work, extends the existing per-source extraction-prompt-variant seam)
- [ ] Internal entity resolution exposed as a stable reference + descriptor in the proposal payload (near-total reuse of v9.0 candidate generation; new work is just the exposure)
- [ ] Status-vocabulary mapping onto the existing `supersedes`/PE-gate mechanism (new domain mapping, zero new reconsolidation-engine work)
- [ ] Domain-neutral proposal table/endpoint with the recommended field set (new table + endpoint, architecturally a sibling of `/v1/surface`)
- [ ] In-repo reference consumer adapter (thin, isomorphic to `docs/reference-client.md`)
- [ ] `kind: 'belief'` branch on the existing Telegram HITL flow (extend, not fork)

### Explicitly Deferred (per PROJECT.md, not v10.0)

- [ ] Real jobfill wiring (separate repo, later)
- [ ] Calendar ingest as a proposal source (deliberately out of scope — belongs as its own thing)
- [ ] Any numeric confidence-threshold auto-apply path (contradicts the milestone's own premise — see Feature Area 5 anti-features)

### Future Consideration (v10.x+, only after real approve/reject outcome data exists)

- [ ] Calibrating the `confidence` field against actual approve/reject outcomes (the research found no way to responsibly do this without outcome data — see Feature Area 3)
- [ ] Bulk-approve UX if proposal volume becomes a real friction point
- [ ] A second reference consumer beyond jobfill, to genuinely stress-test "domain-neutral" against a second schema

---

## Feature Prioritization Matrix

| Feature | User/Product Value | Implementation Cost | Priority |
|---------|--------------------|----------------------|----------|
| Sleep-pass intent classification prompt | HIGH | MEDIUM | P1 |
| Internal entity resolution exposure | HIGH | LOW (reuse) | P1 |
| Status-vocabulary → PE-gate mapping | HIGH (the differentiator) | MEDIUM | P1 |
| Domain-neutral proposal table/endpoint | HIGH (proves the core claim) | LOW-MEDIUM | P1 |
| In-repo reference adapter | HIGH (proves end-to-end) | LOW | P1 |
| HITL `kind:'belief'` extension | HIGH | LOW | P1 |
| Coarse (non-numeric) confidence display | MEDIUM | LOW | P2 |
| Confidence calibration against outcomes | MEDIUM | MEDIUM (needs data first) | P3 |
| Bulk-approve UX | LOW | MEDIUM | P3 |

---

## Sources

### Prior art / specs (HIGH confidence — official documentation)
- [CloudEvents primer](https://github.com/cloudevents/spec/blob/main/cloudevents/primer.md), [CloudEvents spec v1.0.1](https://github.com/cloudevents/spec/blob/v1.0.1/spec.md) — envelope-vs-payload separation, required/optional field set
- [JSON Patch vs JSON Merge Patch — Zuplo](https://zuplo.com/learning-center/json-patch-vs-json-merge-patch), [JSON Patch and JSON Merge Patch — erosb](https://erosb.github.io/json-patch-vs-merge-patch/) — RFC 6902/7386 semantics; grounds the finding that path-addressed patches presuppose shared schema knowledge
- [Greenhouse Recruiting no-reply email addresses — official support docs](https://support.greenhouse.io/hc/en-us/articles/17675865619099-Greenhouse-Recruiting-no-reply-email-addresses) — confirms both the fixed `greenhouse-mail.io` domains AND that companies can send from their own verified domain (grounds the anti-fingerprinting finding)

### Codebase (HIGH confidence — read directly)
- `clients/telegram/proposal-engine.ts` — shipped tool-shaped proposal validation pattern (D-02, T-SEC-01/03/04)
- `clients/telegram/types.ts` — `StoredProposal`/`AllowlistEntry`/`ProposalAction` shapes
- `.planning/PROJECT.md` — v10.0 scope, engine invariants, open discuss-phase questions
- `.planning/research/v4.0-FEATURES.md`, `.planning/research/v4.0-SUMMARY.md` — settled HITL/surfacing findings, explicitly not re-derived here

### Industry practice (MEDIUM confidence — verified via multiple independent sources, or single credible source with clear methodology caveats)
- [n8n: Human-in-the-loop automation](https://blog.n8n.io/human-in-the-loop-automation/), [n8n docs: Human-in-the-loop for AI tool calls](https://docs.n8n.io/advanced-ai/human-in-the-loop-tools/) — tool-level gating, one-at-a-time approval, three response-type pattern
- [Master Data Management golden record — Semarchy](https://semarchy.com/blog/what-are-golden-data-records/), [D&B: What is a golden record](https://www.dnb.com/en-us/resources/master-data/what-are-golden-records-in-master-data-management.html), [Tilores: real-time entity resolution for MDM](https://tilores.io/solutions/master-data-management) — system-of-record vs. golden-record boundary, deterministic vs. fuzzy matching
- [Understanding the Effects of Miscalibrated AI Confidence on User Trust — arXiv 2402.07632](https://arxiv.org/abs/2402.07632) — peer-reviewed; miscalibration undetectable by users, increases inappropriate reliance
- [The Impact of Confidence Ratings on User Trust in LLMs — ACM UMAP Adjunct 2026](https://dl.acm.org/doi/10.1145/3708319.3734178) — confidence display effects on reliance calibration

### Consumer-product claims (LOW confidence — marketing copy / no published methodology; used only to establish qualitative behavior and complaints, never as accuracy numbers)
- [Simplify Copilot — Chrome Web Store listing](https://chromewebstore.google.com/detail/simplify-copilot-autofill/pbanhockgagggenencehbnadejlgchfc) — ATS coverage claim ("100+ ATS"), no accuracy figures published
- [Sorce: How to Check Job Application Status](https://www.sorce.jobs/articles/job-application-status) — source of the "Greenhouse statuses intentionally vague," "Lever has no candidate portal," "Workday Under Consideration is decisive" qualitative findings; no methodology disclosed, treat as informed commentary not measured data
- [JobShinobi vs Huntr vs Teal comparison](https://www.jobshinobi.com/compare/huntr-vs-teal-vs-careerflow-job-tracker) — email-forwarding-based auto-detection feature description; no accuracy claims found
- [workforceplaybook.ai: Confidence Thresholds Explained](https://workforceplaybook.ai/guides/confidence-thresholds-explained) — vendor guide citing the ~0.75–0.90 human-review band and the "0.9 confidence, 70% actually right" calibration caveat; **explicitly unverified, no cited study, used only to characterize common (and commonly flawed) industry practice, not adopted as a threshold recommendation**

### Explicitly searched but no usable finding
- No published, methodology-disclosed accuracy number exists for any consumer job-tracker's or CRM's email→status-change classification (Simplify, Teal, Huntr, JobShinobi, HubSpot, Attio) — every claim found was a feature description, not a measured result. **This absence is itself a finding**: recense would have no external accuracy bar to beat or cite, and should not manufacture one.

---

*Feature research for: v10.0 Action Proposals (recense)*
*Researched: 2026-07-29*
