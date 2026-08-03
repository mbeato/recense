---
phase: 69-retrieval-upgrade-entity-anchored-ambient-recall
plan: 05
subsystem: api
tags: [recall, cli, evidence, verifiable-output, sqlite]

# Dependency graph
requires: []
provides:
  - "RecallEvidence type + optional RecallResult.evidence field"
  - "recall(query, sessionId, scope, { evidence }) short-circuit in typed and neighborhood branches"
  - "recense recall --evidence CLI flag with an evidence-shaped safe-null on every early exit"
affects: [69-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Evidence short-circuit BEFORE provider.generate, reusing in-memory traversal structures rather than re-deriving them"
    - "Evidence-shaped safe-null constant (NULL_EVIDENCE_RESULT / SAFE_NULL_EVIDENCE_RESULT) mirrors the existing safe-null discipline (WR-03) so callers switching on --evidence never get a shape without the field"

key-files:
  created:
    - tests/recall-evidence.test.ts
  modified:
    - src/recall/index.ts
    - src/adapter/recall-cli.ts

key-decisions:
  - "Insight-surfacing branch is skipped entirely in evidence mode (it's a compose-token optimisation with no traversal to cite) — falls straight through to the neighborhood assembly, which is a real traversal"
  - "rel for 'abstracts'/'schema_rel' evidence edges reuses the already-fetched edge.kind string (rel===kind by construction in schema-induction.ts/schema-relations.ts) rather than issuing a second getOutEdgesWithRel read"
  - "Evidence short-circuit for the neighborhood path is placed AFTER the scope filter but BEFORE trace emission — the activation_trace write must never fire in evidence mode"
  - "When the typed-path anchor node fails to resolve (degenerate case), evidence mode returns the safe-null rather than fabricate a citation for a non-existent node"

patterns-established:
  - "Evidence mode = read traversal structures already in memory, never re-derive; matches the D-07 'reports what recall actually did' requirement"

requirements-completed: [RECALL-04]

duration: ~20min
completed: 2026-08-03
---

# Phase 69 Plan 05: Recall Evidence Mode Summary

**`recense recall --evidence "<q>"` returns cited node ids + traversed edges (recense://<type>/<id> citations) instead of composed prose — zero LLM generate calls, zero writes, prose mode byte-identical.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-08-03
- **Tasks:** 3/3
- **Files modified:** 2 (src/recall/index.ts, src/adapter/recall-cli.ts)
- **Files created:** 1 (tests/recall-evidence.test.ts)

## Accomplishments
- `RecallEngine.recall()` gained an optional `opts.evidence` mode that short-circuits every resolution branch (typed-predicate path and schema-neighborhood path) BEFORE the branch's `provider.generate` call, returning `{ path, nodes, edges }` built from the SAME traversal structures the prose path already assembles in memory — never a re-derivation.
- `recense recall --evidence` is wired end to end: the flag is resolved lock-free (WR-02), threaded to the engine, and every early-exit/catch path (including no-DB-path, no-query, lock-held, and thrown errors) emits an evidence-shaped safe-null JSON so a caller parsing stdout under `--evidence` never receives a shape silently missing the field it switched on.
- Zero-generate, zero-write (episode + `activation_trace`), and prose-mode-unchanged guarantees are locked by 10 new tests, including a structural source guard asserting `evidence` never shares a line with `episodes.append` or `provider.generate`.

## Task Commits

1. **Task 1: RecallEvidence + evidence short-circuit in every resolution branch** - `e71f232` (feat)
2. **Task 2: `--evidence` CLI flag with an evidence-shaped safe-null** - `e8b5ca4` (feat)
3. **Task 3: Zero-generate/zero-write/prose-unchanged locks** - `57b549c` (test, includes a small doc-comment reword in Task 1's file to satisfy the source guard)

## Files Created/Modified
- `src/recall/index.ts` - `RecallEvidence` type, `RecallResult.evidence?` field, `NULL_EVIDENCE_RESULT`, and the evidence short-circuit in the typed and schema-neighborhood branches; insight-surfacing branch skipped under evidence mode
- `src/adapter/recall-cli.ts` - `IS_EVIDENCE` bare-flag resolution, `SAFE_NULL_EVIDENCE_RESULT`, threaded to `engine.recall(..., { evidence })`, header doc updated
- `tests/recall-evidence.test.ts` - 10 `it` blocks: typed-path evidence shape, neighborhood-path evidence shape (including a traversed `schema_rel` sideways hop), exact-zero generate count, zero episode + zero `activation_trace` writes with `episodeId: null`, legacy-field survival, prose-mode-untouched baseline, none-path empty arrays, scope filter still applying, citation-format regex, and the same-line source guard

## Evidence JSON Shape (for downstream callers / 69-06's methodology note)

```typescript
interface RecallEvidence {
  path: 'typed' | 'neighborhood' | 'none';
  nodes: Array<{ id: string; cite: string; type: NodeType; value: string; scope?: string }>;
  edges: Array<{ src: string; rel: string; dst: string; kind: string }>;
}
// RecallResult widened with: evidence?: RecallEvidence
```

- `cite` is always `recense://<type>/<raw node id>` — the full `NodeType` union (`entity|fact|schema|doc|insight`), never a prettified id.
- `path: 'typed'` — `nodes` = [anchor, ...frontier]; `edges` = `{src: anchorId, rel: matchedPredicate, dst: frontierId, kind: 'relation'}` per frontier member.
- `path: 'neighborhood'` — `nodes` = [schemaNode, ...survivingMembers]; `edges` = the real `abstracts` edges that produced each surviving member, plus any traversed `schema_rel` edges (kept even if the related schema contributed zero surviving members — the hop itself was still traversed).
- `path: 'none'` — `nodes: []`, `edges: []` (never an omitted field), returned whenever nothing resolves, or when the post-resolution scope filter empties the assembled neighborhood entirely.
- `scope` on a node entry is present only when `node_scope` has a row for that id (populated via one batched `getNodeScopes` call) — absence means unscoped/global, mirroring the prose path's display convention.
- CLI: `node dist/src/adapter/recall-cli.js --evidence` (no `--db`) exits 0 and prints `{"inference":null,"episodeId":null,"origin":"inferred","evidence":{"path":"none","nodes":[],"edges":[]}}`.

## Decisions Made
- D-07 (69-CONTEXT.md) is satisfied literally: evidence mode is read-only, LLM-free apart from the one cue embed the topk already needs, and reports the traversal recall actually performed — the insight-surfacing shortcut is explicitly excluded because it has no traversal to report.
- Followed the plan's explicit instruction to reuse `edge.kind` as `rel` for `abstracts`/`schema_rel` evidence edges rather than a second `getOutEdgesWithRel` read — verified against `schema-induction.ts`/`schema-relations.ts` that `rel === kind` by construction for both edge kinds, so this is not a behavior approximation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Reworded a doc comment to satisfy the plan's own source-guard test**
- **Found during:** Task 3 (writing the source-guard test specified in Task 3's `<action>`)
- **Issue:** A doc-comment sentence added in Task 1 ("...BEFORE its provider.generate call and returns `evidence: { path, nodes, edges }`...") put the literal substrings `evidence` and `provider.generate` on the same physical line, which is exactly the pattern Task 3's structural guard forbids ("assert that the substring `evidence` never appears on the same line as `episodes.append` or `provider.generate`"). The guard would have failed on the codebase's own code, not a real bug in behavior — but the guard exists specifically to catch this pattern.
- **Fix:** Reworded the sentence to keep the same meaning without the literal `provider.generate` substring appearing on the same line as `evidence` (e.g. "before its LLM-compose call" instead of "before its provider.generate call").
- **Files modified:** `src/recall/index.ts` (doc comment only, no logic change)
- **Verification:** `grep -n "evidence" src/recall/index.ts | grep -i "episodes.append\|provider.generate"` returns nothing; the source-guard test passes.
- **Committed in:** `57b549c` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — doc wording only, no behavior change)
**Impact on plan:** Comment-only; the acceptance criteria (grep count of write-call substrings unchanged from pre-phase, verified against the base commit) held throughout.

## Issues Encountered
None beyond the deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- RECALL-04 is fully satisfied: `recense recall --evidence` ships wired end-to-end, gated by nothing (no dark knob needed per D-07/D-09 — evidence mode is strictly additive and opt-in via the flag, prose remains default).
- The `RecallEvidence` shape documented above is stable for 69-06's eval-gate methodology note to reference if it needs to distinguish verifiable-evidence runs from prose runs.
- No blockers for 69-06 or any other wave-1/2 plan; this plan's files (`src/recall/index.ts`, `src/adapter/recall-cli.ts`, `tests/recall-evidence.test.ts`) are exclusive to 69-05 per the parallel-execution file ownership list.

---
*Phase: 69-retrieval-upgrade-entity-anchored-ambient-recall*
*Completed: 2026-08-03*
