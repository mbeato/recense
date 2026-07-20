# Phase 33 — Native-memory migration evidence

Source: `~/.claude/projects/-Users-vtx-brain-memory/memory/`  ·  Live DB: `~/.config/recense/recense.db`  ·  Scope: `brain-memory`
Verify gate (D-08): deterministic `value_hash` live-node-exists (sha256 of trimmed content; NOT cosine recall), checked BEFORE each archive.  Archive (D-09): moved to `.migrated/` (zero hard-deletes).

| # | File | remember event | resulting live node | status |
|---|------|----------------|---------------------|--------|
| 1 | MEMORY.md | insert→superseded-in-place | 7883b05c-e534-4bfb-8562-94a879f8a203 | retired (D-09): content lives in granular notes + archive |
| 2 | corpus-from-schemas-design.md | unrelated_insert | 6ddd25e5-4482-4af8-ac44-b395857ea28b | live (verified at archive) |
| 3 | corpus-graph-flat-obsidian.md | contradict_reconcile | 436e4649-c904-4ec2-810f-8de4a39422b3 | live (verified at archive) |
| 4 | cosine-weakness-threshold-not-embedder.md | contradict_reconcile | ad5d94fc-91e9-4dfa-9625-065838a51943 | live (verified at archive) |
| 5 | dedup-metric-artifact-validate-live.md | unrelated_insert | 9bebf72e-d6c0-4d8b-aa0b-0be6852341c3 | live (verified at archive) |
| 6 | empty-llm-output-is-masked-error.md | unrelated_insert | 975b24a0-fa98-4ccb-8d73-4223c78c09a7 | live (verified at archive) |
| 7 | graphify-is-codebase-tool-not-memory-rival.md | unrelated_insert | 20928a97-2588-480b-897b-09af1ea6feb9 | live (verified at archive) |
| 8 | recense-db-wal-copy-gotcha.md | unrelated_insert | 6871da26-40e1-4251-b13e-cb2d52c2c966 | live (verified at archive) |
| 9 | recense-global-write-lock.md | unrelated_insert | bd67e161-19f8-4f22-888d-470a2c0e2543 | live (verified at archive) |
| 10 | recense-headless-judge-spike-and-billing.md | unrelated_insert | cd33dfba-2541-4ef6-9395-c9ad7acc775e | live (verified at archive) |
| 11 | recense-manual-run-env-masked-failures.md | unrelated_insert | 296577c1-69ac-4a92-9970-255f21a40275 | live (verified at archive) |
| 12 | recense-phase28-corpus-shipped.md | unrelated_insert | 1c59ea09-ee37-4e81-a451-e9352e5378f0 | live (verified at archive) |
| 13 | recense-phase30-ingest-validation.md | unrelated_insert | 7cf3cb75-7ee8-47fb-9ad1-9c4659d277d3 | live (verified at archive) |
| 14 | recense-token-cost-benefit-eval.md | contradict_reconcile | 7883b05c-e534-4bfb-8562-94a879f8a203 | live (verified at archive) |

**Summary:** 14 files migrated through the verbatim `recense remember` path — 10 unrelated-insert, 3 contradict-reconcile-in-place, 1 insert-then-superseded-in-place. All 14 passed the write→value_hash-verify→archive gate at archive time; all 14 archived (moved, not deleted) to `.migrated/`; 0 remain in the memory dir root; 0 hard-deletes.

**Note on MEMORY.md:** the flat index was inserted and verified-live, then later superseded in place when the final granular file's reconcile judged the index (which quotes that note) as a contradicting neighbor. This is the intended reconsolidation behavior and matches D-09 (the flat `MEMORY.md` index is the artifact being retired). No information lost: the 13 granular notes are live nodes and the archived file is the safety net.

Judge calls ≈ 13 (claude-headless, subscription-billed, ~$0 marginal). Run over 3 passes; two engine/script fixes applied mid-run: (1) remember-cli `--` end-of-options so a verbatim fact beginning with `-`/`---` (frontmatter, list items) is stored not mis-parsed as a flag; (2) migration lock-detection scoped to stderr (a fact containing the literal text "lock held" had false-tripped a content match).
