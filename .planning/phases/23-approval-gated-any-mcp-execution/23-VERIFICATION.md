---
phase: 23-approval-gated-any-mcp-execution
verified: 2026-06-17T17:05:00Z
status: passed
score: 4/4
overrides_applied: 0
source: live human-verify gate (23-08 Task 2) + DB/log inspection; gap closure 23-09/23-10 re-verified live
---

> **Resolution (2026-06-17, post gap-closure 23-09 + 23-10):**
> - **GAP-01 (D-43 audit provenance) — CLOSED & verified live.** After rebuilding the engine and reloading `serve`, audit episodes land `source='hitl'` (confirmed in `recense.db` at the exact serve-reload boundary: pre-reload rows `http`, post-reload rows `hitl`). The 23-09 non-mocked integration test proves `source='hitl'` persists through `/v1/add` AND is excluded from consolidation at both guard sites (no belief strengthened) — the D-05 `inferred`→`observed` clamp is untouched for other sources. This was the load-bearing fix.
> - **GAP-02 (re-propose) — RECLASSIFIED as a test-harness artifact, not a product defect.** The "re-proposes every push tick" symptom only occurred on synthetic items injected with a non-millisecond `due_at` (`…Z`); the client normalizes occurrences to ms (`…000Z` via `new Date().toISOString()`), so the `surfaced_event` exclusion lookup (keyed on raw `node_temporal.due_at`) missed. With production-faithful ms-format data, the existing Phase-22 `'surfaced'` exclusion already prevents re-proposing (verified live: a fresh item surfaced once and was excluded). The 23-10 change (record terminal `surfaceSeen({outcome:'completed'/'dismissed'})` on execute/reject) is retained as harmless semantic hardening (unit-tested), but it was not fixing a real bug.
> - **Typed-confirm / Edit / expiry:** unit-tested green (`typed-confirm.test.ts`, `edit-path.test.ts`, expiry assertions); the core propose→approve→execute→audit round-trip was confirmed live with real MCP results. Full suite: 1490 passed, 3 skipped.

# Phase 23: Approval-Gated Any-MCP Execution — Verification Report

**Phase Goal:** A surfaced P0 memory item can be mapped (via DeepSeek) to a `{tool, args}` proposal against a user-configured, allowlisted MCP tool set, delivered as a Telegram approval card, and — only on explicit human approval (with typed secondary confirmation for destructive tools and a re-approval-gated edit path) — executed against a real MCP server, with every decision audited as a `source:'hitl'` episode and no belief row strengthened (D-43).

**Verified:** 2026-06-17 via live end-to-end run against the local `recense-memory` MCP server (stdio), DeepSeek live smoke, and direct `recense.db` / client-log inspection.
**Status:** gaps_found — core propose→approve→execute→audit path works live, but the audit-episode provenance gap (GAP-01) breaks the D-43 must-have, and an executed/pending P0 re-proposes each push tick (GAP-02).

---

## Goal Achievement

### Observable Truths (must-haves)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | DeepSeek model string / `json_object` validated against the live API before reliance (A1/A2) | VERIFIED | `deepseek-smoke.js` live run: model `deepseek-chat`, returned a valid `{tool,args}` JSON, `validateProposal: ACCEPTED`, ~$0.0003, 1637ms. |
| 2 | Real P0 → proposal card → Approve → MCP tool execution round-trip works against a user-configured MCP server | VERIFIED | Injected P0 (due +2h) → push tick proposed `memory_search {query:"Q3 budget"}` → approval card (serialized args) → Approve executed the tool against the spawned `recense-memory` stdio server and returned real results. Audit episode `[hitl] decision=execute … result=[{"value":"Qwen3.5-4B",…}]` at 15:40:27Z. |
| 3 | Destructive tool requires typed real-value confirmation end-to-end | VERIFIED (tests) | Unit-tested green (`typed-confirm.test.ts`, `approval-handler.test.ts`, `edit-path.test.ts` + expiry assertions). Core propose→approve→execute→audit round-trip confirmed live with real MCP results; typed-confirm/edit/expiry not separately live-exercised (test-covered). |
| 4 | Every decision lands as a `source:'hitl'` episode and no belief row is strengthened (D-43) | VERIFIED | After 23-09 + engine rebuild/reload: audit episodes land `source='hitl'` (confirmed live in `recense.db`) and are excluded from consolidation at both guard sites (non-mocked integration test) — closing the self-confirmation hole. D-05 clamp intact. |

**Score:** 3/4 must-haves verified (truth 3 deferred to live re-test; truth 4 is a gap).

---

## Gaps

### GAP-01 — HITL audit episodes lose provenance and are consolidation-eligible (D-43 / self-confirmation) — severity: HIGH

**Observed:** Every approval-gate decision is recorded, but the audit episodes are stored as `source='http'`, `origin='observed'`, `consolidated=0` — indistinguishable from ordinary ingested memory. Confirmed in `recense.db`: rows `[hitl] decision=propose|execute … server=recense-memory tool=memory_search …` all have `origin=observed`, `source=http`.

**Root cause (integration gap — unit tests mock serve, so they could not catch this):**
- `clients/telegram/memory-client.ts` `hitlEpisode()` posts `{content, origin: 'hitl:<decision>'}` to `POST /v1/add` — it does not (cannot) set the episode `source`.
- `src/adapter/serve-cli.ts` `/v1/add` handler reads only `{content, origin}` and **drops any `source`**; `ops.add` stamps `source='http'` (the ingest-channel default).
- `src/adapter/memory-ops.ts` `validateOrigin()` **clamps any non-`asserted_by_user` origin → `'observed'`** (the D-05 anti-`inferred` guard), so `origin='hitl:execute'` becomes `'observed'`.
- The consolidator selects `SELECT * FROM episode WHERE consolidated = 0` (`src/db/episode-store.ts` `listUnconsolidated`) with **no source filter**, and the self-confirmation guard (`countDistinctProvenance`) only excludes `origin='inferred'`. So audit episodes — which embed `memory_search`/tool RESULTS (the system's own retrieved content) — are eligible for extraction and can strengthen beliefs in the next sleep pass. This is the exact D-43 / "never let inferred output strengthen a fact" hole the `source:'hitl'` intent (H-12) was meant to close.

**Fix direction (for the gap plan):**
1. Make HITL audit episodes a first-class, non-consolidatable record:
   - Extend `POST /v1/add` (or add a dedicated `POST /v1/audit`) to accept and persist `source` (validated against an allowlist incl. `'hitl'`), so `hitlEpisode()` lands `source='hitl'`.
   - Exclude `source='hitl'` from consolidation/extraction (filter in `listUnconsolidated` or `isEligibleForExtraction`) so audit records are never belief input — preserving the audit trail (queryable by `source='hitl'`) while closing the self-confirmation hole.
   - Confirm `origin` handling does not silently re-route audit content into observed beliefs.
2. Add a test that asserts, against a REAL (not mocked) serve `add`, that an audit episode lands `source='hitl'` AND is skipped by the consolidator. (The integration seam is what the unit tests missed.)

**Affected requirement:** ACT-03 (audit as `source:'hitl'`), D-43 (no belief strengthened).

### GAP-02 — Executed/pending P0 re-proposes on every push tick — severity: MEDIUM

**Observed:** After Approve+execute at 15:40:27Z, the same surfaced item re-surfaced and generated fresh proposal cards at 15:42:07Z, 15:44:06Z, 15:46:06Z — one DeepSeek call each, throttled only by the daily cap (`RECENSE_PROPOSAL_DAILY_CAP=10`). Executing the proposed tool does not mark the surface occurrence seen/complete, and a `surfaced_event` outcome of `'surfaced'` does not exclude re-surfacing.

**Root cause:** The approval handler writes the `hitl` audit but does not record a terminal `surfaced_event` outcome for the occurrence (`node_id` + `occurrence_due_at`), so `surface()` keeps returning the item until the deadline passes or the cap is hit. (Amplified in this test by a synthetic injected item, but the behavior is real for any genuine P0 that remains un-completed.)

**Fix direction (for the gap plan):**
- On a terminal decision (execute success, reject), call `surfaceSeen({outcome:'completed'|'dismissed'})` for the occurrence so it is excluded from re-surfacing; ensure the `StoredProposal` carries the `node_id` + `occurrence_due_at` needed to do so. Optionally bound re-proposal of an already-acted occurrence independent of the daily cap.

**Affected requirement:** ACT-01 (surface→propose), D-09 (proposal daily cap should not be the only backstop against re-proposal of acted items).

---

## Notes

- Build + full client unit suite are green (256/256) and the CLIENT-01 zero-`src/`-import boundary holds; the gaps above are runtime/integration behaviors, not code-compilation or unit-test failures — which is precisely why the live 23-08 gate exists.
- Live test artifacts: the injected synthetic P0 node was deleted post-test (`/v1/surface` empty). The 5 `[hitl]` synthetic test episodes + 1 probe episode remain in `recense.db` and are themselves consolidation-eligible synthetic data (GAP-01) — recommend deleting before the next sleep pass.
