# Phase 46: Reconsolidation Candidate Broadening - Pattern Map

**Mapped:** 2026-06-27
**Files analyzed:** 2 modified files
**Analogs found:** 2 / 2

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/consolidation/consolidator.ts` | service | batch | M1 anchor block in same file (lines 716–754) + `CandidateRetriever.hybridTopk` in `topk.ts` (lines 444–495) | exact |
| `src/lib/config.ts` | config | N/A | `entityAnchorK` declaration + default in same file (interface ~237–248, default ~773–774) | exact |

No new files. `src/retrieval/topk.ts` is an analog source (read-only reference); it is not modified by this phase.

---

## Pattern Assignments

### `src/consolidation/consolidator.ts` (service, batch)

There are five distinct edit sites. Each is described with the pattern to copy.

---

#### Edit site 1 — Import `ftsQueryFromText` (lines 38–39)

**Current import block:**
```typescript
import type { CandidateRetriever } from '../retrieval/topk';
import { cosineSimF32 } from '../retrieval/topk';
```

**Pattern:** extend the named import to include `ftsQueryFromText`:
```typescript
import type { CandidateRetriever } from '../retrieval/topk';
import { cosineSimF32, ftsQueryFromText } from '../retrieval/topk';
```

`ftsQueryFromText` is the mandatory MATCH sanitizer (T-17-02-T). Never pass raw `claim.value` directly to `node_fts MATCH` — always route through this function.

---

#### Edit site 2 — New field declaration (lines 230–231, M1 stmt block)

**Analog pattern** (existing M1 declarations at `consolidator.ts:230–231`):
```typescript
// M1: prepared statements for entity-anchored candidate expansion (T-01-SQL).
// Compiled once in the constructor; sync reads only (T-02-ASYNC — no await, never inside
// a db.transaction). Mirrors the B2 stmtStaleEntityIds precedent in engine.ts:140-158.
private readonly stmtProvenanceSiblingFacts: Statement<[string], { id: string; value: string }>;
private readonly stmtLiveNodesForLinks: Statement<[], { id: string; value: string }>;
```

**New field to add immediately after:**
```typescript
// Phase 46 (D-03): BM25 lexical candidate statement — compiled once (T-01-SQL).
// Mirrors CandidateRetriever.stmtBm25 SQL exactly; lives here because stmtBm25 is private.
// bm25() returns negative-is-better; ORDER BY rank ASC = best-first.
// JOIN node excludes tombstoned rows. MATCH arg MUST be ftsQueryFromText() output (T-17-02-T).
// Sync Phase A read — never inside db.transaction (T-02-ASYNC).
private readonly stmtBm25Candidates: Database.Statement;
```

---

#### Edit site 3 — Constructor initialization (lines 277–289, after M1 stmts)

**Analog pattern** (existing M1 stmt initialization at `consolidator.ts:277–289`):
```typescript
// M1: compile prepared statements once (T-01-SQL).
this.stmtProvenanceSiblingFacts = db.prepare(`
  SELECT DISTINCT f.id, f.value
  FROM consolidation_event a
  JOIN consolidation_event b ON a.episode_id = b.episode_id
  JOIN node f ON b.node_id = f.id
  WHERE a.node_id = ? AND f.type = 'fact' AND f.tombstoned = 0
`);
this.stmtLiveNodesForLinks = db.prepare(
  `SELECT id, value FROM node WHERE tombstoned = 0`
);
```

**New initialization to add immediately after:**
```typescript
// Phase 46 (D-03): BM25 lexical candidate statement.
// SQL matches CandidateRetriever.stmtBm25 (topk.ts:301-306) exactly.
this.stmtBm25Candidates = db.prepare(`
  SELECT f.node_id AS id
  FROM node_fts f JOIN node n ON n.id = f.node_id AND n.tombstoned = 0
  WHERE node_fts MATCH ?
  ORDER BY rank LIMIT ?
`);
```

---

#### Edit site 4 — BM25 fetch after M1 anchor build (~line 754, inside the `else` branch)

**Analog pattern** — the M1 provenance-sibling anchor block immediately before this site (`consolidator.ts:740–754`):
```typescript
// (b) Provenance-sibling anchors — entity-type nodes in cosine top-k
if (anchors.length < this.config.entityAnchorK) {
  for (const c of candidates) {
    const node = this.store.getNode(c.id);
    if (node?.type === 'entity') {
      const siblings = this.stmtProvenanceSiblingFacts.all(c.id);
      for (const sib of siblings) {
        if (!cosineIdSet.has(sib.id) && !anchors.some(a => a.id === sib.id)) {
          anchors.push({ id: sib.id, value: sib.value });
          if (anchors.length >= this.config.entityAnchorK) break; // T-UE6-03 cap
        }
      }
    }
    if (anchors.length >= this.config.entityAnchorK) break;
  }
}
```

**New BM25 block to insert immediately after (after the closing `}` of the anchor block, before the cosineGate line ~756):**
```typescript
// Phase 46 (D-03): BM25 lexical candidate pass.
// Third union member: cosine ∪ M1-anchors (existing) ∪ BM25 (new).
// Phase A sync read — before any db.transaction (T-02-ASYNC invariant).
// ftsQueryFromText is the mandatory MATCH sanitizer (T-17-02-T — never pass raw text).
// Dark-knob: bm25CandidateK=0 reproduces today's exact behavior (D-07).
// FTS-absent fallback: try/catch mirrors topk.ts:hybridTopk lines 460-465.
const bm25Candidates: Array<{ id: string }> = [];
if (this.config.bm25CandidateK > 0) {
  const ftsQuery = ftsQueryFromText(claim.value);
  if (ftsQuery) {
    try {
      const bm25Rows = this.stmtBm25Candidates.all(ftsQuery, this.config.bm25CandidateK) as Array<{ id: string }>;
      for (const row of bm25Rows) {
        if (!cosineIdSet.has(row.id) && !anchors.some(a => a.id === row.id)) {
          bm25Candidates.push(row);
        }
      }
    } catch {
      // FTS table absent or MATCH syntax error — graceful degradation (mirrors topk.ts:hybridTopk)
    }
  }
}
```

---

#### Edit site 5a — D-04 auto-unrelated gate (lines 759–762)

**Current pattern** (`consolidator.ts:756–762`):
```typescript
// UPDATE-02 refined gate: auto-unrelated fires ONLY when cosine gate is true
// AND no anchor candidates exist. When anchors exist, fall through to judge
// escalation regardless of cosine score (M1 distant-contradiction rescue).
const cosineGate = candidates.length === 0 ||
  candidates[0]!.score < this.config.unrelatedSimilarityThreshold;

if (cosineGate && anchors.length === 0) {
```

**Pattern: extend condition to add `bm25Candidates.length === 0` (D-04):**
```typescript
// Phase 46 D-04: extend gate — auto-unrelated fires only when cosine is low,
// no anchors, AND no BM25 candidates. A BM25 lexical hit rescues a low-cosine
// claim into judge escalation exactly like an anchor does. This is the load-bearing
// change that lets the judge see cosine-0.48 contradictions it currently auto-drops.
if (cosineGate && anchors.length === 0 && bm25Candidates.length === 0) {
```

The comment on the `if` branch below it ("low cosine, no anchors → auto-unrelated") should be updated to read "low cosine, no anchors, no BM25 hits → auto-unrelated".

---

#### Edit site 5b — D-02 `judgeCandidates` union assembly (lines 784–790)

**Current pattern** (`consolidator.ts:782–790`):
```typescript
// Escalate to judge — cosine candidates first (D-17 precedence), anchors appended.
// Reads current values from graph (UPDATE-01 "current value").
const judgeCandidates = [
  ...candidates.map(c => ({
    id: c.id,
    value: this.store.getNode(c.id)?.value ?? '',
  })),
  ...anchors, // anchors carry value from SQL / stmtLiveNodesForLinks row
];
```

**Pattern: append BM25 after anchors (D-02 ordering: cosine → anchors → BM25):**
```typescript
// Phase 46 D-02: extend union — cosine → anchors → BM25 (D-02 ordering).
// BM25 candidates are deduped from cosine+anchor ids already above; no additional
// dedup needed here. Value fetched via store (mirrors cosine candidate pattern).
const judgeCandidates = [
  ...candidates.map(c => ({
    id: c.id,
    value: this.store.getNode(c.id)?.value ?? '',
  })),
  ...anchors, // anchors carry value from SQL / stmtLiveNodesForLinks row
  ...bm25Candidates.map(c => ({
    id: c.id,
    value: this.store.getNode(c.id)?.value ?? '',
  })), // BM25 lexical hits (Phase 46 D-02)
];
```

---

#### D-06 Observability counters

**Pattern source:** `this.log()` calls already in consolidator (e.g., `consolidator.ts:913`) and the SEAM-02 log block in `run-sleep-pass.ts:698–705`.

Initialize per-pass counters before the claim loop (alongside `decisionSlots` and `pendingJudges` at ~line 682):
```typescript
// Phase 46 D-06: candidate-source counters (observability only — never gate behavior).
// Verified via RECON-03: judgeFiredContradiction > 0 after adding BM25.
let cosineCandidateTotal = 0;
let anchorCandidateTotal = 0;
let bm25CandidateTotal = 0;
let judgeFiredContradiction = 0;
```

Accumulate inside the claim loop after each source resolves:
```typescript
cosineCandidateTotal += candidates.length;
anchorCandidateTotal += anchors.length;
bm25CandidateTotal += bm25Candidates.length;
```

Increment `judgeFiredContradiction` where contradiction decisions are built (in the judgment result handler, wherever `relation: 'contradict_*'` outcomes are assigned — around lines 1154–1290).

Emit after the episode loop completes via `this.log()`:
```typescript
this.log(
  `RECON-03 candidates: cosine=${cosineCandidateTotal} anchors=${anchorCandidateTotal} bm25=${bm25CandidateTotal} | judgeFiredContradiction=${judgeFiredContradiction}`
);
```

---

### `src/lib/config.ts` (config)

Two edit sites: the `EngineConfig` interface and the `DEFAULT_CONFIG` defaults object.

---

#### Edit site 1 — `EngineConfig` interface (~lines 237–248)

**Analog pattern** — existing `entityAnchorK` declaration (`config.ts:239–248`):
```typescript
/**
 * M1: max anchor candidates appended after cosine top-k for contradiction detection (M1).
 * Anchors come from two sources:
 *   - Link anchors: live nodes whose value contains a wikilink in the claim's links array.
 *   - Provenance-sibling anchors: live fact nodes sharing >=1 consolidation_event episode
 *     with an entity-type node that landed in cosine top-k.
 * Anchors are appended AFTER cosine candidates, deduped by id, and capped at this limit.
 * Default 5 matches candidateK — calibration placeholder (D-13 / T-UE6-03).
 */
entityAnchorK: number;
```

**New property to add immediately after:**
```typescript
/**
 * Phase 46 (D-03): max BM25 lexical candidates appended after cosine+anchor candidates
 * for contradiction detection in the offline sleep pass.
 * BM25 runs over node_fts (FTS5) using ftsQueryFromText(claim.value) — never raw text
 * (T-17-02-T). Deduped against cosine+anchor ids before being appended to judgeCandidates.
 * Default 5 mirrors candidateK/entityAnchorK calibration placeholders (D-03).
 * Dark isolation switch: set to 0 to reproduce pre-Phase-46 behavior exactly (D-07).
 */
bm25CandidateK: number;
```

---

#### Edit site 2 — `DEFAULT_CONFIG` defaults (~lines 773–774)

**Analog pattern** — existing defaults (`config.ts:773–774`):
```typescript
candidateK: 5,
entityAnchorK: 5,
```

**Pattern: add `bm25CandidateK` immediately after `entityAnchorK`:**
```typescript
candidateK: 5,
entityAnchorK: 5,
bm25CandidateK: 5,   // Phase 46 D-03: default ON; set 0 to reproduce pre-46 behavior (D-07)
```

---

## Shared Patterns

### Phase A sync invariant (T-02-ASYNC)

**Source:** `consolidator.ts:716–720` comment block + T-02-ASYNC pattern throughout.

All candidate-generation reads — cosine `topk`, M1 anchor stmts, and the new BM25 stmt — run as synchronous prepared-statement calls in Phase A, before any `db.transaction`. The claim loop that contains all three sources is entirely synchronous up to the `pendingJudges.push(...)` call. The single `await` that crosses the Phase A/B boundary is `judgeBatch` (~line 806+). BM25 reads must follow this: `stmtBm25Candidates.all(...)` is a synchronous better-sqlite3 call, never `await`-ed, never inside a `db.transaction` block.

### FTS-absent graceful fallback

**Source:** `src/retrieval/topk.ts:hybridTopk` lines 459–465:
```typescript
if (ftsQuery) {
  try {
    bm25List = this.stmtBm25.all(ftsQuery, preK) as Array<{ id: string }>;
  } catch {
    // FTS table absent or MATCH syntax error — fall back to cosine only (graceful degradation)
    bm25List = [];
  }
}
```

Mirror this exact try/catch in the consolidator BM25 block. If `node_fts` is absent (older DB schema or test fixture), the catch silently returns an empty array — consolidation continues as pre-Phase-46 behavior without throwing.

### Dark-knob / isolation switch pattern

**Source:** `config.ts:783` comment (`rankStrengthWeight: 0 — ships w=0; no behavior change at merge`) and `DEFAULT_CONFIG` defaults.

`bm25CandidateK: 5` ships on by default (D-07 — the point of the phase). Setting to `0` skips the BM25 block entirely (the `if (this.config.bm25CandidateK > 0)` guard) and reproduces pre-Phase-46 behavior for A/B comparison. This mirrors the `rankStrengthWeight=0` dark-default pattern.

### D-17 fast-path precedence

**Source:** `consolidator.ts:693–714` — the entire fast-path block is in the outer `if (fastPathCandidate)` branch; the M1 anchor block and now BM25 block both live in the `else` branch. No change to this structure. BM25 is appended after the M1 anchor logic, inside the same `else` branch, so D-17 precedence is preserved by construction.

### Union dedup via Set

**Source:** `consolidator.ts:721` — `const cosineIdSet = new Set(candidates.map(c => c.id));`

The `cosineIdSet` Set is already used to dedup anchors from cosine candidates. For BM25, extend the dedup check: exclude any `row.id` that is in `cosineIdSet` OR already in `anchors` (via `.some(a => a.id === row.id)`). The BM25 block runs after anchors are fully built, so `anchors` is complete when the dedup check runs. No separate Set needed; the inline `.some()` check is consistent with the anchor dedup pattern (lines 729, 746).

---

## No Analog Found

None. Both files have exact analogs within the same codebase.

---

## Metadata

**Analog search scope:** `src/consolidation/consolidator.ts`, `src/retrieval/topk.ts`, `src/lib/config.ts`
**Files scanned:** 3 primary + `src/consolidation/run-sleep-pass.ts` (counter log placement reference)
**Pattern extraction date:** 2026-06-27
