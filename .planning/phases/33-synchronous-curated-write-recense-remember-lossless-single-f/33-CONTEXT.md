# Phase 33: Synchronous Curated Write (recense remember) - Context

**Gathered:** 2026-06-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Give recense a **synchronous, lossless, curated WRITE path** — `recense remember "<fact>" [--scope <s>]` — so that ALL deliberate facts/memory flow through the brain and nothing else, closing the customer-zero "replaces MEMORY.md" promise. recense already owns the READ path (session-start fires `recall`); deliberate writes still leak to native Claude Code `.md` memory files because the only existing write paths are passive-lossy (turn-capture → hourly sleep-pass, ~84–90% KU) and batch ingest/import-memory (lossy LLM extraction).

The new path: store the fact **VERBATIM** (no lossy extraction) as a curated node, then run a synchronous "mini sleep-pass" — embed → retrieve neighbor beliefs → judge contradiction (reuse `update-decision.ts` routing + `sink.ts`) → **update-in-place on contradiction, else insert** — ~1 judge LLM call (~2–5s, subscription-billed, ~$0 marginal). This in-place reconsolidation is the differentiator vs. appending to a flat file.

**In scope:**
- `recense remember "<fact>" [--scope <s>]` CLI subcommand + dispatcher wiring (REMEMBER-01).
- Synchronous verbatim store + in-place reconsolidation on write (REMEMBER-02).
- Curated/evidence-backed marking: decay never kills it; sleep pass never re-extracts/mangles it.
- Global CLAUDE.md hard directive + settings.json kill-switch investigation; archive of native `.md` memory (REMEMBER-03).
- One-time migration of the 12 `~/.claude/projects/-Users-vtx-brain-memory/memory/*.md` files through the NEW verbatim `remember` (write → verify → archive).

**Out of scope (do NOT add here):**
- Any new lossy-extraction path (the existing `import-memory` / turn-capture stay as-is).
- Multi-tenancy / retrieval scoping changes — retrieval stays GLOBAL; scope is attribution only (999.3).
- The v6.0 project-onboarding phases (29–32) — Phase 33 is **standalone**, depends only on the already-live consolidation/judge/sink machinery + the semantic-store write primitive + the embedder.

Requirements delivered: **REMEMBER-01, REMEMBER-02, REMEMBER-03** (to formalize in plan).
</domain>

<decisions>
## Implementation Decisions

### In-place update UX (REMEMBER-02 — the differentiator)
- **D-01: Auto-apply + report-after.** When the judge flags a `remember` as contradicting an existing belief and routes to tombstone-reconcile, **apply the in-place update immediately**, then print what changed:
  ```
  ✓ reconsolidated [brain-memory]
    updated: "api budget ~$14-15 left" → "api budget is ~$8 left"
    (was tombstoned; 1 neighbor judged, PE=reconcile)
  ```
  Trusts the eval-backed judge; no blocking prompt; this is an explicit ~2–5s write, NOT the LLM-free hot path, so a judge call is acceptable here (per roadmap correctness note). On a plain insert (no contradiction), print a terse stored/insert line naming the resolved scope.
- **D-02: `--confirm` is a future opt-in, not default.** A confirm-before-overwrite flag may be added later; the default is auto-apply. Do not build a confirmation prompt into the default path.

### Curated-fact authority & precedence (REMEMBER-02 correctness)
- **D-03: High-resistance seeding, NOT a hard origin-guard.** Curated `remember` facts ride the existing `origin='asserted_by_user'` (same origin the Obsidian vault uses) and are **seeded with high resistance** (high `s`/`c` → high `s·c`) so that passive `observed` facts from turn-capture→sleep-pass struggle to overwrite them through normal PE routing. We deliberately did NOT add a hard "observed-can-never-tombstone-asserted" guard (rejected as over-engineering) — protection is via resistance, not an absolute rule.
  - **Planner flag:** decide the concrete seeded `s`/`c` values (fresh-node default is `s=0.1, c=0.5` → resistance `0.05`, which is far too weak for a curated fact). The seed must make curated facts meaningfully resist passive observed contradictions while staying compatible with D-04.
- **D-04: An explicit `remember` FORCE-reconciles its contradictions.** Because curated facts seed high-resistance (D-03), a later **explicit correction** (`remember "budget is now $8"` contradicting an earlier curated belief) would otherwise hit that high resistance and route to HOLD — silently dropping the correction and making the D-01 preview a lie. So: when the judge flags an explicit `remember` as a contradiction, it must **always at least reconcile** (tombstone old + set new). The user is deliberately asserting the new value; it must land. High-resistance protection applies to the PASSIVE direction (sleep pass), force-apply applies to the EXPLICIT direction (`remember`).
  - This mirrors the spirit of the existing D-19 provenance-distinct force-destabilization, but here a single explicit user write is sufficient to force it.
- **D-05: Decay/eviction-exempt (locked by roadmap).** A curated fact's node must survive lazy decay + AND-gated eviction, and the sleep pass must never re-extract or mangle it. Reuse existing evidence-backed/source-type semantics; **add a node column only if a reused field cannot carry it.** Note: `hard_keep` exists on `episode` but NOT on `node`; `node` has `training_eligible`. Planner: confirm whether `origin='asserted_by_user'` alone is the decay/eviction shield, or a node-level flag is required.

### Native-memory cutover (REMEMBER-03)
- **D-06: Hard directive in GLOBAL `~/.claude/CLAUDE.md`.** "All deliberate facts/memory → `recense remember`; never write native `.md` memory files." Placed globally (every project), not just brain-memory's project CLAUDE.md — native Claude Code memory is a global feature, the brain is one global DB, and a `remember` from any project lands correctly (scope-tagged, retrieval global). This fully closes the "replaces MEMORY.md" promise across all of customer-zero. Additive directive — overrides the harness native-memory protocol per instruction-priority rules.
- **D-07: settings.json kill-switch = investigate + apply-if-real.** Research whether `settings.json` (or a hook) can actually disable native file-based memory writes. If a genuine switch exists, set it as belt-and-suspenders on top of D-06. If none exists, the global directive carries it alone and the finding is documented. Do NOT block the phase on an uncertain capability; do NOT build a heavyweight PreToolUse-deny hook unless research shows it's the only real mechanism.

### One-time migration (REMEMBER-03)
- **D-08: Per-file node-exists-by-hash verify gate (deterministic, not cosine).** For each of the 12 `.md` files: run `remember` (verbatim), then directly confirm a non-tombstoned node exists whose value matches the verbatim text (value/`value_hash` exact-content check) BEFORE touching that file. Recall round-trips are rejected as the gate — `recense recall` is cosine-gated and unreliable for a delete gate (per the cosine-weakness lessons). Strict **write → verify → archive per file** order.
- **D-09: Archive, don't hard-delete.** Move each verified `.md` to a backup dir (e.g. `~/.claude/projects/-Users-vtx-brain-memory/memory/.migrated/`) rather than `rm` — a safety net (per the planning-dir-no-safety-net lesson). Hard-delete the archive later once the brain is trusted. The flat `MEMORY.md` index itself is the thing the brain replaces, so it gets archived too in the cutover (SessionStart already fires `recense recall` first, making the index vestigial).
- **D-10: Migrated memories scoped `brain-memory` (cwd-derived).** All 12 get scope `brain-memory` via the default `cwdToScope` mechanic. The handful that are genuinely cross-project (e.g. `user-email`, `research-single-agent-not-fanout`) are low-harm to mis-scope since retrieval is global; per-file hand-scoping was rejected as not worth the manual cost.

### Claude's Discretion (planner/researcher decides)
- **`remember-cli.ts` shape + dispatcher wiring.** Add a `remember` case to `src/adapter/recense.ts` (lazy-require or `spawnScript`, matching the `recall`/`import-memory` patterns). Because the path holds the write lock and runs the judge synchronously, in-process `require('./remember-cli')` may fit better than a spawned subprocess — planner's call. Update the usage string.
- **How the synchronous mini-pass reuses the consolidation machinery.** The roadmap locks "reuse `update-decision.ts` + `sink.ts`," but the exact assembly — does `remember` construct a one-candidate path through `Consolidator.applyDecision`'s contradict branch, or a thinner bespoke embed→top-k→judge→route→apply loop that calls the same pure routing + sink functions — is an architecture call. Either way: verbatim value (no extract), the existing PE routing, atomic per-write `db.transaction`, and a `ConsolidationSink` event.
- **Embedder + top-k neighbor retrieval for the write.** Reuse the same embedder + brute-force cosine neighbor lookup the sleep pass uses; planner picks the neighbor `k` and any cosine floor for "which existing beliefs the judge sees."
- **Lock scope.** The synchronous reconsolidation writes the graph, so it needs the global write lock (the same `tmpdir/recense-sleep.lock` the sleep pass uses) — held only for the brief per-write transaction, NOT across a long pass. Confirm interaction with a concurrent hourly sleep pass (acquireLock fast-fails, no queue).
- **Judge transport for the contradiction call.** The headless Sonnet judge via `claude -p` (`--setting-sources project`, API-key strip) — the same non-deterministic, subscription-billed transport the sleep pass uses. Validate any judge-prompt tweak on the local 35b temp-0 (no temp-0 on headless).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### ROADMAP / requirements
- `.planning/ROADMAP.md` §"Phase 33: Synchronous Curated Write" — goal, 6-item scope/deliverables, correctness guards.
- `.planning/REQUIREMENTS.md` — REMEMBER-01/02/03 wording (to be formalized).

### Reconsolidation machinery to reuse (locked by roadmap)
- `src/consolidation/update-decision.ts` — `routeContradiction` (HOLD/reconcile/append-new PE routing), `isOscillation` (D-20), `countDistinctProvenance` (D-19). PURE functions; reuse verbatim. **D-04 force-reconcile must be layered at the call site, not by mutating these.**
- `src/consolidation/sink.ts` — `ConsolidationSink` interface + `SQLiteConsolidationSink`; emit exactly one event per applyDecision branch INSIDE the per-write `db.transaction` (D-48 atomicity). `contradict_reconcile` is the in-place-update event type.
- `src/consolidation/consolidator.ts` — `applyDecision` contradict branch + the eviction/decay logic (the reference for in-place update + how `asserted_by_user`/evidence-backed is treated). Read to decide D-05 (decay shield) and whether to route through it or build the thinner loop.
- `src/consolidation/run-sleep-pass.ts` — `runConsolidation`, `resolveNodeScope`/`stampNodeScopes` (scope attribution at consolidation). The synchronous write needs the same scope-stamping.

### Write primitive, schema, scope
- `src/db/semantic-store.ts` — the owned semantic graph write primitive + `getMeta/setMeta`. Verbatim node creation, embedding (BLOB), `value_hash` for the D-08 gate.
- `src/db/schema.ts` — `node` table (origin CHECK `observed|asserted_by_user|inferred`; `s` default 0.1, `c` default 0.5, `training_eligible`, `prev_value`/`prev_ts`, `tombstoned`); `episode` has `hard_keep` but `node` does NOT. SCHEMA_VERSION=12 — a new column = a migration branch.
- `src/lib/scope.ts` — `cwdToScope` (D-10 scope derivation, `--scope` override).
- `.planning/phases/999.3-scope-aware-provenance-memory-importer/999.3-CONTEXT.md` — scope = provenance not tenancy; `node_scope` sidecar; derive-from-cwd at consolidation. Curated `remember` facts must get a `node_scope` row too.

### CLI / dispatcher patterns to match
- `src/adapter/recense.ts` — the command dispatcher (lazy-require + `spawnScript`, D-87). Add the `remember` case + usage string.
- `src/adapter/import-memory-cli.ts` — the 999.3 importer: `recordEvent` with `cwd`/`source`/`external_id`. The LOSSY path `remember` replaces for deliberate writes; reuse its scope-tagging shape, NOT its extraction.
- `src/adapter/turn-capture-cli.ts` — the passive lossy write path `remember` complements (NOT replaces — turn-capture stays for ambient observed memory).
- `src/adapter/recall-cli.ts` — the existing read surface; the verify-gate (D-08) does NOT use it (cosine-gated), but it's the symmetric read counterpart.
- `src/adapter/runtime-config.ts` — `resolveDbPath` (default live DB `~/.config/recense/recense.db`), dirty-sentinel helpers.
- `src/adapter/lockfile.ts` — `acquireLock`/`releaseLock` (global write lock for the synchronous reconsolidation).
- `src/model/claude-headless-client.ts` — `createClaudeHeadlessClient` (subscription-billed Sonnet judge, `--setting-sources project`, API-key strip).

### Migration target
- `~/.claude/projects/-Users-vtx-brain-memory/memory/` — the 12 `.md` memory files + `MEMORY.md` index to migrate (D-08/09) and the global directive target's sibling.
- `~/.claude/CLAUDE.md` — where the D-06 global directive lands.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`update-decision.ts` (pure routing) + `sink.ts`** — the entire PE-gated reconsolidation decision + event-emit surface is written, tested, eval-backed. Phase 33 assembles a synchronous one-candidate path over it (D-04 force-reconcile layered at the call site).
- **`asserted_by_user` origin** — already the curated origin (Obsidian vault, D-61 there). Curated `remember` rides it; no new origin enum value.
- **999.3 scope infra** — `cwdToScope` + `node_scope` sidecar + `resolveNodeScope`/`stampNodeScopes` mint scope-tagged facts; the write just needs the right `cwd`/scope and to stamp.
- **Headless Sonnet judge transport** — `claude -p` subscription-billed, self-ingestion-guarded (`--setting-sources project`), API-key-stripped — already in place.

### Established Patterns
- **Lazy-require / spawnScript dispatcher** (`recense.ts` D-87) — add the `remember` case.
- **Atomic per-write `db.transaction`** wrapping graph mutation + its `ConsolidationSink.emit` (D-48) — the synchronous write must preserve this.
- **Global write lock fast-fails (no queue)** (`recense-sleep.lock`) — hold it only for the brief per-write transaction; a concurrent hourly sleep pass means the lock can be momentarily contended (per the global-write-lock memory).
- **`value_hash`** on `node` — the deterministic key for the D-08 per-file verify gate.

### Integration Points
- `recense.ts` dispatcher (new `remember` command + usage string).
- Semantic-store write primitive (verbatim node create + embed).
- `update-decision.ts` routing + `sink.ts` event (the reconsolidation core).
- `node_scope` via scope-stamping (attribution, `[scope]` recall prefix).
- `~/.claude/CLAUDE.md` (global directive) + the native-memory dir (migration + archive).
</code_context>

<specifics>
## Specific Ideas

- **The area-1 preview is the contract.** The founder approved the exact `updated: "<prev>" → "<now>"` report format with a one-line judge/PE annotation — the in-place update must surface visibly, not silently.
- **Two-direction precedence is deliberate (D-03 + D-04):** high resistance shields curated facts from the PASSIVE sleep-pass direction; explicit `remember` force-reconciles in the EXPLICIT direction. They are not symmetric, and that asymmetry is the whole correctness design — neither a hard origin-guard nor uniform PE routing was wanted.
- **Verify-before-archive is non-cosine on purpose.** The founder explicitly rejected recall round-trips for the delete gate because recall is cosine-gated; a deterministic `value_hash`/content check is the gate.
- **Archive, not delete, and MEMORY.md goes too.** Safety-net framing (planning-dir-no-safety-net lesson); the flat index is vestigial once recall fires at SessionStart.
</specifics>

<deferred>
## Deferred Ideas

- **`--confirm` (confirm-before-overwrite) flag** — captured as a future opt-in (D-02); default stays auto-apply.
- **Per-file hand-scoping of cross-project memories** — rejected for the migration (D-10); revisit only if global retrieval ever surfaces mis-scope harm.
- **Heavyweight PreToolUse-deny hook for native `.md` memory** — only if D-07 research shows no real settings.json switch exists; not a default deliverable.
- **Multi-fact input splitting** — `remember` stores one verbatim fact per call; splitting a multi-fact blob would reintroduce lossy extraction and was not requested. Out of scope.

### Reviewed Todos (not folded)
None — no pending todos matched this phase.

</deferred>

---

*Phase: 33-synchronous-curated-write-recense-remember-lossless-single-f*
*Context gathered: 2026-06-20*
