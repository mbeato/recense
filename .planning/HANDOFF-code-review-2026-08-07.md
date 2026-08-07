# Handoff: cross-phase code review + delegated decisions (post phases 65–69)

**Context:** On 2026-08-03 an auto-chain session executed phases 65–69 end-to-end (discuss → plan → execute → per-phase review → verify → complete). All roadmapped phases 62–69 are complete. `main` was left at `3441c20`, clean, 4,014 tests passing, typecheck clean. Each phase already had a standard-depth review with Critical/Warning findings fixed on main (65-REVIEW..69-REVIEW, all `status: fixed`). Read `.planning/STATE.md` and the Current State block of `.planning/PROJECT.md` first — they are current.

## Job 1 — Cross-phase deep review (the gap the per-phase reviews leave)

Per-phase reviews were scoped to each phase's own files. Do ONE deep, cross-file review over the two new end-to-end surfaces as wholes, hunting interaction bugs the per-phase passes couldn't see:

1. **The proposal pipeline end-to-end:** gmail episode → classification/resolution fields → status-drift gating → `maybeEmitProposal` → `action_proposal` → `/v1/proposals` → reference adapter AND telegram belief bridge. Focus: cross-component contract drift (e.g. status vocabularies, id shapes, expiry semantics agreeing at every hop), concurrency between the sleep pass and the serve write path, and whether any invariant test is vacuous when composed.
2. **The retrieval path:** `turn-capture-cli` cwd threading → `ambientRecall` (anchor union dark, nudge/demotion/hops LIVE) → `retrieveRanked` opts → `renderAmbientBlock`; plus `recall --evidence`. Focus: the shipped-ON knobs' interaction with pre-existing consumers (SessionStart bulk path, viz traces), and budget/ordering edge cases.

Use `/gsd-code-review <phase> --depth=deep --files=...` per surface or spawn `gsd-code-reviewer` directly with explicit file lists. Fix Critical + Warning findings on main via the established `gsd-code-fixer` pattern (atomic `fix(NN):` commits, NO Claude attribution — CLAUDE.md hard rule). Engine locks that must survive any fix: `routeContradiction`/`update-decision.ts` byte-unchanged (pe-machinery-lock test), telegram `proposal-store.ts`/`proposal-engine.ts` zero-diff (hash-lock test), D-43 sentinels, online-LLM-free sentinel.

## Job 2 — Delegated decisions (make them; the gates decide, not vibes)

- **69 re-gate with the LLM judge:** run `scripts/eval/recall-audit-gate.cjs` with its documented `--judge` escape hatch (real `OPENAI_API_KEY` + live DB `~/.config/recense/recense.db` + local gitignored eval set — regenerate via the committed `scripts/eval/recall-audit*.py` if absent). If G1/G2/G4 pass under the judge AND G5 (p95 ≤ 2× baseline p95) holds, flip `entityAnchoringEnabled` with a dated annotation per the 69-06 Task 3 protocol; otherwise record the honest null with numbers. History: lexical-proxy runs failed G2 twice (16/51 regressed post-fix); latency now passes (+90ms p95). NEVER commit anything under `scripts/eval/results/`.
- **Doc-link render re-gate:** refresh the eval set from newer transcripts (re-run the committed audit scripts — data stays gitignored). If the refreshed set exercises ≥1 doc-type row, re-gate `ambientDocLinkRenderEnabled` non-vacuously and flip-or-null per protocol. Do not hand-author synthetic prompts into the eval set.
- **strip-hidden perf flake:** the two "stays polynomial (ratio ≤ 8)" cases flaked 3× under parallel agent load on 2026-08-03 (8.7, 10.9 observed; pass in isolation). Decide and implement the smallest honest fix — e.g. raise the ratio bound with a dated comment, or gate those two cases behind a `RECENSE_PERF_TESTS=1` env. Keep them meaningful (they exist to catch quadratic blowup, ~4× per doubling).
- **Stash cleanup:** `stash@{0}` and `stash@{1}` are leftovers from executor incidents. For each: `git stash show -p` , diff against the committed files they claim to duplicate, and drop ONLY if fully superseded; otherwise keep and note.
- **REQUIREMENTS.md drift:** reconcile checkbox/status rows for DRIFT/EMIT/CONSUME/APPROVE/RECALL against the committed VERIFICATION reports (RECALL rows were flagged stale by the 69 verifier). Update table + checkboxes together per the file's own footer rule.
- `.planning/` is gitignored but tracked — use `git add -f <specific paths>`; never `git add .`.

## Founder-only — do NOT decide these

- `65-HUMAN-UAT.md` items 1–3: the `provenanceDistinctnessEnabled` ENABLE/HOLD needs Max's real inbox export + review (D-14), with WR-01 (threadId farming bar) resolved before any ENABLE.
- v10.0 milestone close: recommend `/gsd-audit-milestone` → `/gsd-complete-milestone` when review is clean, but the sign-off is Max's.

## Done means

Cross-phase review report(s) committed with findings fixed; both re-gates run with honest recorded outcomes; flake/stash/requirements housekeeping done; suite + typecheck green; a short summary for Max listing anything that changed a live default.
