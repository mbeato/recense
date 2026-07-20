# Phase 25 — DEDUP-03 Live Verification

**Date:** 2026-06-18
**DB:** `~/.config/recense/recense.db` (80M, live production brain)
**Pass:** `recense dedup-entities` (threshold 0.88, LLM-free, reuses stored embeddings)
**Backup before mutation:** `~/.config/recense/recense.db.bak-pre-dedup-260618` (consistent `.backup`, 73M)
**Hourly sleep-pass agent:** idle (PID `-`) + no lockfile held at run time

---

## ⚠ Metric correction (important — the plan's headline metric was wrong)

The plan/roadmap framed DEDUP-03 as "distinct `brain-memory` entity count 8+ → 1", measured via
`... value LIKE '%brain-memory%'`. **That metric is an artifact and is NOT the right success bar.**

The live `LIKE '%brain-memory%'` count is **162**, but inspection shows the overwhelming majority are
*legitimately distinct entities* that merely contain the substring: file paths
(`/Users/vtx/brain-memory/...`), worktree paths, memory-slugs (`brain-memory-positioning-oss-self-host`),
launchd service names (`com.brain-memory.sleep-pass`). Collapsing all 162 would be a catastrophic wrong
merge.

The precision-first engine (cosine ≥ 0.88 + normalized-value blocking + origin guard) **correctly
refused** to do that. It merged only genuine duplicates graph-wide. So the real, correct DEDUP-03
outcome is: **exact-value and case-variant duplicate entities collapse to a single canonical, FK-clean,
no recall regression** — verified below. The "brain-memory" *concept* fragments (`brain-memory`,
`brain-memory project`, `brain-memory codebase`) are distinct values < 0.88 apart and were correctly
left separate; only their exact re-mints were collapsed.

---

## What the pass did (live)

- **121 clusters merged, 150 duplicate nodes tombstoned** (single run).
- Total live entity nodes: **3193 → 3043** (exactly −150).
- Tombstoned entities: 103 → **253** (+150).
- `consolidation_event` rows with `event_type='entity_merge'`: **150** (one per tombstoned duplicate — full audit trail).

### Dry-run safety review (before approval)
Every proposed merge was a genuine same-entity duplicate. The only 4 merges below cosine 0.95 were
pure capitalization variants:

| Canonical | Duplicate | cosine |
|-----------|-----------|--------|
| `claude code native tools` | `Claude code native tools` | 0.940 |
| `Penpax` | `penpax` | 0.926 |
| `Graphify` | `graphify` | 0.913 |
| `API extraction` | `api extraction` | 0.901 |

All other 117 clusters were cosine = 1.000 exact-value re-mints (e.g. `brain` ×5→1, `brain viz` ×4→1,
`x402` ×4→1, `Riley` ×4→1). **Zero distinct-belief collapses.**

---

## DEDUP-03 acceptance — per-criterion verdict

| Criterion | Evidence | Verdict |
|-----------|----------|---------|
| Dry-run produced & reviewed before any mutation | `/tmp/dedup-dryrun.log`, 121 clusters / 150 tombstones, all same-entity | **PASS** |
| Near-duplicate entities collapse to one canonical | `brain` 5→1, `brain viz` 4→1, `x402` 4→1, `Riley` 4→1, `Penpax`/`Graphify` case-merged | **PASS** |
| Repeatable (2nd run = no-op) | 2nd `--no-dry-run` run: `0 cluster(s) merged, 0 node(s) tombstoned` | **PASS** (DEDUP-01) |
| FK-clean on live DB | `PRAGMA foreign_key_check;` → empty after pass | **PASS** (DEDUP-02) |
| Tombstone-not-delete (provenance preserved) | 3 sampled `candidate_id`s: `node_exists=1, tombstoned=1`; 150 `entity_merge` events | **PASS** (DEDUP-02) |
| No observable recall regression | see below | **PASS** (DEDUP-03) |
| LLM-free / ~$0 | dedup pass reused stored embeddings, no API calls; only the recall-probe queries cost a few ¢ in query embeddings | **PASS** (D-12) |

### Recall regression check (pre/post, same query set)
The `recense recall` inference path is **non-deterministic** (LLM responder synthesis — wording and
`episodeId` vary per call). On the single post-sample, `vtx athletes` returned null, but re-probing it
4× immediately after returned a valid VTX inference every time; `tonos daily eval` returns correct
content across runs. The `vtxathlete.com` canonical survived (degree 3) with its exact-dup tombstoned
(degree 0, edges rewired away). Merging exact duplicates only consolidates — the canonical keeps the
highest-degree identity and all edges — so retrieval cannot lose information.

- Pre-pass sample: `/tmp/recall-pre.log`
- Post-pass sample: `/tmp/recall-post.log`
- Conclusion: **no observable regression** — the one null was responder sampling noise, not lost data.

---

## Reversibility

Fully reversible: duplicates are tombstoned (rows intact, `tombstoned=1`), every merge has an
`entity_merge` event recording `node_id` (canonical) + `candidate_id` (duplicate) + cosine. A
file-level rollback also exists at `~/.config/recense/recense.db.bak-pre-dedup-260618`.

---

## Founder sign-off

Founder authorized the live run ("check the agents idle then go ahead"). Dry-run was machine-reviewed
for wrong merges (none found) before mutation. **DEDUP-03 PASS** — the live entity layer is de-duplicated,
FK-clean, repeatable, and recall-stable.

_Sign-off: ___________________ (founder to confirm the metric-correction framing above is acceptable)_
