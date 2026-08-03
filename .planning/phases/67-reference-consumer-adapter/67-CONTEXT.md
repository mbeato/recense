# Phase 67: Reference Consumer Adapter - Context

**Gathered:** 2026-08-03 (auto mode — decisions are the recommended defaults, grounded in the roadmap's own tight specification, the clients/telegram precedent, and the 64/66 carry-forwards; audit trail in 67-DISCUSSION-LOG.md)
**Status:** Ready for planning

<domain>
## Phase Boundary

A thin in-repo consumer (`clients/proposal-reference/`, a **structural sibling of `clients/telegram/`**) proves the Phase 66 emit-seam contract end-to-end: it reads pending proposals over the authenticated HTTP surface and maps them onto its own local rows, without recense ever knowing its schema and without the adapter ever importing an engine module (CONSUME-01/02). The contract is documented in `docs/reference-client.md` well enough that a third party (jobfill, later, in its own repo) could build against it (CONSUME-03).

Out of phase: the live jobfill integration (its own repo, later); Telegram belief-kind extension (Phase 68); any new engine/serve capability — the adapter consumes the frozen v66 contract as-is; entity-anchored recall (Phase 69).

Hard prerequisite satisfied: Phase 66 complete (verification 5/5) — stable, versioned HTTP contract exists (`GET /v1/proposals`, `POST /v1/proposals/:id/approve|reject`, 16-column frozen record with `schema_version`).

</domain>

<decisions>
## Implementation Decisions

### Adapter shape & local-row mapping (CONSUME-01)
- **D-01:** `clients/proposal-reference/` mirrors `clients/telegram/`'s structural contract verbatim: own directory, own `tsconfig.json` (same compilerOptions shape; **no `paths` into `src/`**), own `tests/` subdir, own dist. It is a **pure HTTP consumer**: base URL + Bearer token config (env/config file mirroring telegram's config.ts conventions), calls only `GET /v1/proposals` and `POST /v1/proposals/:id/approve|reject`.
- **D-02:** "Maps onto its own local rows" = a deliberately minimal local store in the adapter's own vocabulary (planner discretion: local sqlite via better-sqlite3 — already a runtime dep — or a JSON file; smallest honest thing). The mapping keys on the proposal's **`entity_descriptor` semantically** and stores its OWN local id — demonstrating exactly the consumer-side resolution ARCHITECTURE Q4 assigned to consumers. It records proposal `id` for idempotency (a replayed/re-listed proposal must not create a second local row — EMIT-04's consumer half).
- **D-03:** The adapter demonstrates the full outcome loop: list pending → map/apply to local rows → approve (or reject) via POST → handle the EMIT-07 refusal path (stale/superseded/expired → typed refusal, adapter marks its local row accordingly, never retries a terminal). Handling a 409-class refusal is part of "proving the contract," not an edge case to skip.

### Boundary enforcement (CONSUME-02)
- **D-04:** Zero engine imports, enforced twice: (a) `tsconfig.json` boundary — no `paths`/`references` into `src/`; (b) a **sibling copy** of `clients/telegram/tests/import-boundary.test.ts` scanning `clients/proposal-reference/` (the existing test only scans telegram; roadmap explicitly requires a copy, not a reuse). Inherit the telegram guard's strictness: the scan covers ALL `.ts` under the adapter dir **including its own tests/** — so the adapter's in-dir tests are HTTP/fixture-only too.
- **D-05:** Because in-dir tests cannot import the engine, the end-to-end PROOF lives at repo level (`tests/` — planner discretion on filename): the repo-level test may use engine modules to seed an `action_proposal` row (ActionProposalStore) and drive the serve surface, but the ADAPTER under test is exercised only through its public entry (HTTP against the served routes). This mirrors how the phase goal reads: the adapter proves the contract "without recense knowing the consumer's schema" — and equally without the consumer knowing recense's internals.

### Contract documentation (CONSUME-03)
- **D-06:** `docs/reference-client.md` gains a proposal-consumer section following the existing adopter-template pattern (the file already has "API contract" / "Fail-closed pattern" sections for the memory client — mirror that structure). It MUST document: the 16-field record verbatim (incl. `belief_node_id` per 66's D-02a), `schema_version` gating (consumers version-gate, never assume), deterministic id + replay semantics (safe re-delivery), auth (Bearer, identical-401 discipline), the approve/reject outcome semantics incl. every refusal status and that terminals are durable, and the **two mandatory carry-forwards**: (a) `entity_node_id`/`belief_node_id` are NOT stable foreign keys across belief-correction (tombstone-and-mint — 64's D-08 caveat, explicitly assigned to this phase's docs), and (b) the `change_from`/`change_to` **type asymmetry** (`from` = verbatim prior belief value, often a sentence; `to` = closed `IntentStatus` token; consumers must NOT chain from/to across proposals to reconstruct a timeline — 66-04's bolded carry-forward).
- **D-07:** The docs teach the fail-closed consumer posture the telegram section already models: unknown `schema_version` → stop; unknown `kind` → skip; refusal → terminal, don't retry; never render model prose as the decision surface (quote is data).

### Claude's Discretion
- Local store choice (sqlite vs JSON) and adapter file layout within the sibling-structure lock.
- Repo-level e2e test filename/harness details (D-05 constraint locked).
- Whether the adapter ships a tiny CLI entry (`node clients/proposal-reference/dist/index.js list|sync`) mirroring telegram's script conventions — nice for founder demos, not required.
- Exact docs section placement within reference-client.md's existing structure.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — CONSUME-01..03 (incl. the scope-edge preamble: producer seam + thin in-repo reference consumer; jobfill later, own repo)
- `.planning/ROADMAP.md` — Phase 67 entry (goal + the three success criteria, which are unusually implementation-specific and are themselves locked)

### v10.0 research
- `.planning/research/SUMMARY.md` — "Phase 7: Reference Consumer Adapter" (mirrors clients/telegram structural contract verbatim; skip research-phase) 
- `.planning/research/PITFALLS.md` — Pitfall 10 (domain-neutrality: the adapter's local schema must live entirely on the adapter's side of the line)

### Upstream phase context (decisions this phase consumes)
- `.planning/phases/66-domain-neutral-proposal-emit-seam/66-CONTEXT.md` — D-02/D-02a (frozen 16-field contract), D-07 (deterministic id semantics), D-10 (refusal semantics), D-12 (quote is data)
- `.planning/phases/66-domain-neutral-proposal-emit-seam/66-04-SUMMARY.md` — the bolded change_from/change_to asymmetry carry-forward REQUIRED in this phase's docs
- `.planning/phases/64-entity-resolution-hardening/64-CONTEXT.md` — D-08 (node id not a stable FK; the caveat this phase's docs own)

### Code seams (live source is source of truth)
- `clients/telegram/` — the structural contract to mirror (tsconfig.json shape, config conventions, tests/ layout)
- `clients/telegram/tests/import-boundary.test.ts` — the guard to copy (scans ALL .ts incl. tests/)
- `src/db/action-proposal-store.ts` — `ACTION_PROPOSAL_FIELDS` (the frozen record the docs transcribe; repo-level e2e seeds through this)
- `src/adapter/serve-cli.ts` — the routes + auth discipline the adapter consumes; `src/adapter/memory-ops.ts` — typed refusal errors → HTTP statuses
- `docs/reference-client.md` — existing adopter-template structure ("API contract", "Fail-closed pattern" sections) the new section mirrors
- `tests/proposal-routes.test.ts` — route behavior fixtures the e2e can crib

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **clients/telegram/** — complete structural template: tsconfig (module commonjs, outDir dist, exclude tests), config/env conventions, import-boundary guard.
- **Phase 66 route tests** — request/response fixtures for every proposal endpoint incl. refusal statuses.
- **better-sqlite3** — already a runtime dep if the local store goes sqlite (net-zero new deps holds either way).

### Established Patterns
- Agents/clients live outside the engine (clients/, not src/) — enforced per-client via its own tsconfig + import-boundary test (STATE.md engine invariant, verbatim).
- Fail-closed consumer posture documented per client in reference-client.md.
- Convention-enforced invariants fail — the boundary is a test, not a review note.

### Integration Points
- Consumes only the authenticated `/v1/proposals` surface from Phase 66 — no engine seam changes anywhere.
- `docs/reference-client.md` — the only shared artifact touched.
- Downstream: Phase 68 (telegram belief-kind) is parallel-safe — zero file overlap with this phase (68 touches clients/telegram/, this touches clients/proposal-reference/ + docs).

</code_context>

<specifics>
## Specific Ideas

- The milestone's thesis is "context-layer proposes / system-of-record confirms." This adapter IS the demo of that split — the local rows are the "system of record," and the adapter's code showing descriptor-keyed mapping + own-id ownership is what a jobfill engineer will copy first. Optimize for readability of that mapping over cleverness.
- The e2e proof should include one full refusal round-trip (approve a proposal whose belief has moved → 409-class → local row marked, no retry) — that's the part a naive consumer gets wrong.

</specifics>

<deferred>
## Deferred Ideas

- Live jobfill integration — jobfill's own repo, later (scope edge locked 2026-07-29).
- Telegram belief-kind, batching, approval-rate stats — Phase 68.
- Push-based delivery / webhooks — unscoped this milestone.
- 65-HUMAN-UAT founder items — untouched, still open.

### Reviewed Todos (not folded)
Same four keyword-noise matches as 63-66 (scores 0.4-0.6, generic keywords). None folded; all stay pending.

</deferred>

---

*Phase: 67-Reference Consumer Adapter*
*Context gathered: 2026-08-03*
