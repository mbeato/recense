---
phase: 27-reader-layer
plan: "02"
subsystem: reader-core
tags: [doc-generation, lifecycle-exempt, single-writer, tdd, citation-verify, gather]
dependency_graph:
  requires: [v11-schema, node-doc-sidecar, upsertNodeDoc, getNodeDoc]
  provides: [gatherFacts, generateDoc, writeDoc, generate-doc-cli, READER-01]
  affects:
    - src/reader/doc-gather.ts
    - src/reader/doc-generator.ts
    - src/consolidation/doc-writer.ts
    - src/adapter/generate-doc-cli.ts
    - src/adapter/recense.ts
tech_stack:
  added: []
  patterns:
    - scope-union-semantic-entity-hop-gather
    - verbatim-slice-prompt-reuse
    - citation-verify-loop
    - lifecycle-exempt-node-write
    - single-IMMEDIATE-transaction
    - fts-suppression-after-upsert
    - judge-tier-as-generate-head
    - idempotent-cli-with-force-flag
key_files:
  created:
    - src/reader/doc-gather.ts
    - src/reader/doc-generator.ts
    - src/consolidation/doc-writer.ts
    - src/adapter/generate-doc-cli.ts
    - tests/doc-gather.test.ts
    - tests/doc-writer.test.ts
    - tests/doc-generator.test.ts
  modified:
    - src/adapter/recense.ts
decisions:
  - "gatherFacts takes optional retriever dep so CandidateRetriever is created from db internally (simpler than requiring caller to inject it)"
  - "generateDoc is read-only (no DB writes) — the CLI composes generateDoc+writeDoc; this preserves testability without a real DB"
  - "citation-verify loop includes tombstoned resolved IDs in citedFactIds (tombstoned count reported separately) — caller decides what to display"
  - "FTS suppression: after upsertNode sets the FTS row, a DELETE WHERE node_id=? removes it in the same IMMEDIATE transaction"
  - "Truncated-id robustness (D-05 live bug): accept 8+-char hex prefixes, resolve via unique-prefix match (ambiguous=invented), canonicalize prose to full UUIDs so node.value/cites/reader-regex agree"
  - "Empty-output guard (D-05 timeout bug): doc-gen raises headless timeout to 600s (env-overridable, scoped to CLI — shared client fail-safe untouched); generateDoc THROWS on empty output so no silent empty doc is persisted"
  - "One-live-doc-per-slug: writeDoc tombstones any prior live doc for the slug in-transaction so --force supersedes instead of appending"
metrics:
  duration: "~95 min (incl. two D-05 live-bug fixes)"
  completed: "2026-06-18"
  tasks_completed: 4
  files_changed: 8
---

# Phase 27 Plan 02: Doc-Generation Core Summary

**One-liner:** scope+semantic+entity-hop fact gather → judge-tier cited markdown deep-dive → lifecycle-exempt type='doc' node (no embed/decay/FTS/training) via single-writer IMMEDIATE transaction + lock-guarded `recense generate-doc` CLI.

## What Was Built

### Task 1: doc-gather (scope ∪ semantic ∪ entity-hop)

- `src/reader/doc-gather.ts` exporting `gatherFacts(deps, slug, opts?)`.
- Three gather sources unioned by id:
  1. **Scope**: `JOIN node_scope ns ON ns.scope = ? AND n.type='fact' AND n.tombstoned=0 ORDER BY n.s DESC` — project-attributed facts (D-01 spine).
  2. **Semantic**: `provider.embed([slug])` → `retriever.hybridTopk(queryVec, slug, k=60)` → filter to `type='fact'` live nodes — embedding breadth beyond literal name matches (D-01).
  3. **Entity-hop**: entity-name `LIKE '%slug%'` → 1-hop fact neighbors via edge JOIN — augmentation (allowed per D-01).
- Dedup into `Map<id, {via: string}>`, tagging sources as 'scope', 'semantic', 'linked', and '+'-joined combinations.
- Tombstoned facts excluded from all sources.
- Lexical `LIKE` on `fact.value` DROPPED as spine (D-01).
- `CandidateRetriever` created internally from `db` if not injected (cleaner caller API).
- 6 tests in `tests/doc-gather.test.ts` all green.

### Task 2: doc-writer (lifecycle-exempt) + doc-generator (cite + verify)

**doc-writer** (`src/consolidation/doc-writer.ts`, exporting `writeDoc`):
- Single `db.transaction().immediate()` wrapping:
  1. `store.upsertNode({ type:'doc', origin:'inferred', s:0, c:1.0, ... })` — `origin='inferred'` forces `training_eligible=0` at the SQL layer.
  2. `stmtFtsDelete.run(docId)` — FTS suppression: removes the doc node from `node_fts` immediately after `upsertNode` auto-synced it, so markdown body never pollutes BM25 keyword search.
  3. `store.upsertNodeDoc({ node_id, slug, generated_at:now, updated_at:now })` — `generated_at` preserved as write-once by `ON CONFLICT` SQL.
  4. `store.upsertNodeScope({ node_id, scope:slug, updated_at:now })` — project provenance.
  5. `store.upsertEdge({ src:docId, dst:factId, rel:'cites', kind:'cites', w:1.0, last_access:now })` per unique cited fact.
- No `setEmbedding` call → `embedding` stays NULL.
- No `upsertNodeTemporal` call → not a temporal/actionable node.
- No raw node/edge SQL — all writes through SemanticStore primitives only (T-27-07).
- 8 tests in `tests/doc-writer.test.ts` all green.

**doc-generator** (`src/reader/doc-generator.ts`, exporting `generateDoc`):
- Calls `gatherFacts`, builds `factBlock` as `[<uuid>] <value>` lines.
- Generation prompt reused **verbatim** from `scripts/reader-slice/generate.ts` lines 30–45 (the exact prompt that produced 19/19 resolved citations, 0 invented on the Tonos slice).
- Calls `provider.generate(prompt, { maxTokens: 4000 })` — provider's `generateConfig` must be set to `judgeConfig` by the CLI caller (D-04).
- Citation-verify loop (verbatim from slice lines 63–93): extracts `recense://fact/<uuid>` IDs, queries `node WHERE id=?`, counts invented (no row) and tombstoned (row.tombstoned=1).
- Invented IDs excluded from `citedFactIds`; tombstoned IDs included but counted separately.
- Returns `{ markdown, docId, citedFactIds, citationCount, invented, tombstoned }`.
- **Does NOT write to DB** — pure data transformation; CLI composes with writeDoc.
- 4 tests in `tests/doc-generator.test.ts` all green.

### Task 3: recense generate-doc CLI + dispatcher wiring

- `src/adapter/generate-doc-cli.ts`: lock-guarded, write-capable CLI.
  - Validates DB path BEFORE `acquireLock` (WR-02).
  - Idempotent by default: existing doc node for slug → exits with cached result (no LLM call, D-02/T-27-06). `--force` regenerates.
  - Builds `judgeConfig` via `resolveProviderOverlay(env, 'RECENSE_JUDGE_PROVIDER')` (same pattern as sleep-pass).
  - `new DefaultModelProvider({ generateConfig: judgeConfig, judgeConfig, embedConfig })` (D-04 — no new docModel/genModel var).
  - Calls `generateDoc` then `writeDoc` in sequence; releases lock in `finally` on every path (T-25-07).
  - Emits JSON line `{ nodeId, slug, generated_at, citationCount, invented, tombstoned, cached }`.
  - `require.main === module` guard: importing the module never auto-runs (verified by `node -e require(...)` test).
- `src/adapter/recense.ts`: added `case 'generate-doc': spawnScript('generate-doc-cli.js', process.argv.slice(3)); break;` and updated usage string.
- `npx tsc --noEmit` clean.

### Task 4: D-05 Prose Quality Spot-Check + citation-resolution bug

**D-05 prose quality: PASS.** Live verification ran `generate-doc tonos` against
`~/.config/recense/recense.db`. The generated deep-dive is well-structured and specific —
clears the `out/tonos.md` baseline on aesthetics.

**Citation-resolution bug: FOUND + FIXED** (commit `6960a5c`).

- **Before (buggy):** `generate-doc tonos` returned `{"citationCount":0,"invented":0,"tombstoned":0}`
  with **0 cites edges** — yet the generated markdown contained **71 inline `recense://fact/<id>`
  references**. The pre-existing tonos doc node (`218260d4-3cbb-456e-8101-f6cdc4ba6bb8`,
  value_len=8900) had **0 cites edges** (verified directly against the live DB).
- **Root cause:** the env judge model (`RECENSE_JUDGE_PROVIDER=claude-headless`) emitted **truncated
  ids** (first 8 hex chars only, e.g. `recense://fact/e751c852`) instead of full UUIDs. `e751c852`
  is the real prefix of live fact `e751c852-9a05-4394-9397-bf18955d6ae5` (value matches the cited
  claim) — the model WAS grounding citations in real facts, just shortening the ids. The strict
  `{36}` verify regex dropped all 71 truncated refs → 0 verified, 0 invented, 0 cites edges. The
  slice's Sonnet run complied with full UUIDs (19/19); the production env model does not, and a
  prompt-level "use the exact uuid" instruction cannot prevent it.
- **Fix (robustness, not prompt-nagging — any model may truncate):**
  1. Broadened the capture regex to accept an 8+-char hex prefix OR a full UUID:
     `recense://fact/([0-9a-f][0-9a-f-]{6,35})`.
  2. Resolve each ref: exact id match first, else UNIQUE-prefix match (`id LIKE '<prefix>%'`
     returning exactly one live row, `LIMIT 2` to detect ambiguity). Zero matches OR ambiguous (>1)
     → invented.
  3. Canonicalize the prose: rewrite each resolved `recense://fact/<prefix>` link to the full
     canonical UUID so `node.value`, the `cites` edges, and the reader's `{36}` regex (27-03 reader.js)
     all agree. doc-writer persists the canonicalized markdown (no doc-writer change needed — it
     already writes the returned body).
  4. Dedup `citedFactIds` so two truncations of the same fact → one cite edge.
  5. Tombstoned handling unchanged: tombstoned still resolve → included in `citedFactIds`, counted
     in `tombstoned`.
- **Tests:** +4 doc-generator cases — prefix resolve+canonicalize, unknown-prefix=invented,
  ambiguous-prefix=invented (no edge), full+prefix-of-same-fact dedup. All 22 27-02 tests green;
  `npx tsc --noEmit` clean.

**Empty-doc timeout bug: FOUND + FIXED** (commit `809a0f7`). The first `--force` re-run produced
an EMPTY doc node — and the root cause was NOT model non-determinism but a **swallowed timeout**:

- **Root cause:** the shared headless `claude -p` client (`src/model/claude-headless-client.ts`,
  `DEFAULT_TIMEOUT_MS = 120_000`) returns EMPTY content on timeout / non-zero exit / spawn failure —
  its production fail-safe (`parseVerdict('')` → SAFE 'unrelated', `parseClaims('')` → []), which the
  always-on sleep pass relies on. Doc-gen emits ~4000 tokens of cited prose (live run took ~122s:
  19:54:20 → 19:56:22), crossed the 120s timeout, got SIGKILL'd, and the empty string was persisted
  as a silent "successful" 0-citation doc (`97dc7e6a-…`, len 0). The earlier good run took ~100s,
  under the limit.
- **Three scoped fixes** (the shared client's empty-on-failure fail-safe is left UNCHANGED — the
  sleep pass depends on it):
  1. **Raise the doc-gen timeout** (`generate-doc-cli.ts`): default
     `RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS` to `600000` (10min) if unset, before building the provider.
     Env-overridable; matches the sleep-pass slowness precedent. Scoped to doc-gen only.
  2. **Fail loud on empty output** (`doc-generator.ts`): after `provider.generate`, if the markdown
     is empty/whitespace-only, THROW (`'…empty output (likely a headless timeout or subprocess
     failure) — not persisting'`). The CLI catch logs it + exits non-zero; NO empty doc is written,
     and the prior doc (if any) is left untouched.
  3. **--force supersedes, never appends** (`doc-writer.ts`): `writeDoc` now tombstones any prior
     live `type='doc'` node for the slug inside the same IMMEDIATE transaction, before the new write,
     so there is at most ONE live doc per slug. FK-safe — tombstone leaves the node row + its
     node_doc/node_scope/cites edges intact (the row still exists, just `tombstoned=1`).
- **Tests:** +2 doc-generator (empty + whitespace-only → throws, nothing written), +3 doc-writer
  (supersede retires prior, FK-clean after supersede, different-slug docs coexist). **27 tests green;
  tsc clean.**

**Live items PENDING USER AUTHORIZATION (not blocking — confirmation of unit-tested fixes):**

1. **DB cleanup of two stray tonos doc nodes.** The live DB has exactly two stray test-artifact doc
   nodes (verified read-only): `218260d4-…` (len 8900, the truncated-id run, 0 cites) and
   `97dc7e6a-…` (len 0, the empty-timeout run, 0 cites). A FK-consistent hard-delete script is ready
   (children first: edge/node_doc/node_scope/node_fts, then the node row, in one transaction).
2. **Live `generate-doc tonos --force` re-verify.** Paid/stateful (one OpenAI embed + one
   subscription `claude -p` generate). With the 600s timeout it should complete and report
   `citationCount` ~30–71 with a matching `cites`-edge count, leaving exactly ONE live tonos doc.

The auto-mode classifier correctly blocked BOTH the cleanup hard-delete and the `--force` re-run as
coordinator-authorized live mutations of a stateful service — coordinator consent carries no user
authority. Both are confirmation of fixes already proven by the 27 unit tests; they do not block
plan closure.

**Billing-leak note:** the `~/.claude/settings.json` `ANTHROPIC_API_KEY` injection (which would make
`claude -p` silently bill the API) is confirmed closed (0 occurrences). The headless client also
strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from its spawn env (verified in source), so a live
run uses the Max-subscription OAuth, not API billing.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] CandidateRetriever injection pattern**
- **Found during:** Task 1 GREEN (test failure — tests passed `{ db, store, provider }` but `GatherDeps` required `retriever`)
- **Issue:** The PLAN.md said "call store.hybridTopk(...)" but SemanticStore has no `hybridTopk` — it's on `CandidateRetriever`. Injecting `retriever` as a required dep made all test calls fail since they didn't include it.
- **Fix:** Made `retriever` optional in `GatherDeps` (created from `db` internally if not provided). Simpler caller API; still testable via injection.
- **Files modified:** `src/reader/doc-gather.ts`, `tests/doc-gather.test.ts`
- **Commit:** `e9c919d`

**2. [Rule 1 - Bug] Truncated fact-id citations silently dropped (D-05 live verification)**
- **Found during:** Task 4 D-05 live verification (`generate-doc tonos` against the live DB)
- **Issue:** The env judge model (`claude-headless`) emitted 8-char hex prefixes (`recense://fact/e751c852`)
  instead of full UUIDs. The strict `{36}` verify regex dropped all 71 real citations → `citationCount=0`,
  0 cites edges. The model was correctly grounding citations in real facts (`e751c852` = prefix of live
  fact `e751c852-9a05-4394-9397-bf18955d6ae5`) — it just shortened the ids.
- **Fix:** Broadened the regex to accept 8+-char prefixes, resolve via exact-then-unique-prefix match
  (ambiguous/unknown → invented), and canonicalize the prose to full UUIDs so node.value / cites edges /
  the reader's `{36}` regex all agree. Dedup citedFactIds. doc-writer needed no change (persists the
  returned canonicalized markdown).
- **Files modified:** `src/reader/doc-generator.ts`, `tests/doc-generator.test.ts`
- **Commit:** `6960a5c`

**3. [Rule 1 - Bug] Empty doc persisted on a swallowed headless timeout (D-05 second live run)**
- **Found during:** Task 4 D-05 live `--force` re-run (produced an empty 0-citation doc node)
- **Issue:** The shared headless `claude -p` client returns EMPTY content on timeout (120s default)
  / non-zero exit / spawn failure — its production fail-safe. Doc-gen's ~4000-token generation took
  ~122s, crossed 120s, got SIGKILL'd, and the empty string was persisted as a silent "successful"
  doc. Also `--force` appended a 2nd live doc node instead of retiring the prior one.
- **Fix (three scoped changes; shared client fail-safe UNCHANGED):** (1) raise the doc-gen headless
  timeout to 600s (env-overridable) in the CLI; (2) THROW in `generateDoc` on empty/whitespace-only
  output so no empty doc is ever persisted; (3) `writeDoc` tombstones any prior live doc for the slug
  in-transaction so there is at most ONE live doc per slug.
- **Files modified:** `src/adapter/generate-doc-cli.ts`, `src/reader/doc-generator.ts`,
  `src/consolidation/doc-writer.ts`, `tests/doc-generator.test.ts`, `tests/doc-writer.test.ts`
- **Commit:** `809a0f7`

## Known Stubs

None. All four tasks complete (Task 4 prose quality = pass; both live bugs = found+fixed+unit-tested).
The two pending live items (stray-doc cleanup + `--force` re-verify) are confirmation of unit-tested
fixes, pending the actual user's authorization (live/paid mutations) — not stubs.

## Threat Flags

None beyond what's in the plan's `<threat_model>`:
- T-27-03 (prompt injection): verbatim hard-rules prompt + citation-verify loop mitigates.
- T-27-04 (invented citations): verify loop excludes non-resolving IDs from `citedFactIds`.
- T-27-05 (D-43 self-confirmation): `generateDoc` is read-only; no `strengthen`/`setEmbedding`/`markActive` calls on gathered facts.
- T-27-06 (LLM spend): idempotent-by-default CLI; single generate call; no auto-batch.
- T-27-07 (single-writer): all writes through SemanticStore primitives in one IMMEDIATE transaction + shared lock.

## Self-Check: PASSED

- `src/reader/doc-gather.ts` — FOUND
- `src/reader/doc-generator.ts` — FOUND (truncated-id resolution + canonicalization)
- `src/consolidation/doc-writer.ts` — FOUND
- `src/adapter/generate-doc-cli.ts` — FOUND
- `src/adapter/recense.ts` — FOUND (generate-doc case added)
- `tests/doc-gather.test.ts` — FOUND, 6 tests pass
- `tests/doc-writer.test.ts` — FOUND, 11 tests pass (8 original + 3 supersede)
- `tests/doc-generator.test.ts` — FOUND, 10 tests pass (4 original + 4 prefix-resolution + 2 empty-guard)
- Total 27 tests pass; `npx tsc --noEmit` clean
- Commits `fe39ae4`, `e9c919d`, `59dce5b`, `71edd98`, `744c152`, `6960a5c`, `809a0f7` — all verified in git log

## Pending (live confirmation only — needs USER authorization; not blocking closure)

The D-05 prose quality gate PASSED. Both correctness bugs it surfaced are FIXED + unit-tested
(truncated-id resolution `6960a5c`; empty-timeout + supersede `809a0f7`; 27 tests green, tsc clean).
Two live items remain, BOTH blocked by the auto-mode classifier as coordinator-authorized live
mutations of a stateful service (coordinator consent ≠ user authority):

1. **Stray-doc cleanup** — hard-delete the two test-artifact tonos doc nodes (`218260d4-…` len 8900,
   `97dc7e6a-…` len 0; both 0 cites). FK-consistent delete script is ready.
2. **`generate-doc tonos --force` re-verify** — with the 600s timeout, expect `citationCount` ~30–71,
   matching `cites`-edge count, and exactly ONE live tonos doc.

Both confirm fixes already proven by unit tests; they do not block plan closure. If the user
authorizes: build is already current (`dist` has the fixes); source `~/.config/recense/sleep.env`,
run the cleanup script, then `node dist/src/adapter/recense.js generate-doc tonos --force --db
~/.config/recense/recense.db`, and record the final numbers here.
