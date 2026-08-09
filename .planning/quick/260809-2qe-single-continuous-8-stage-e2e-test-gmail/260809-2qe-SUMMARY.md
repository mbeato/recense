# Quick Task 260809-2qe: Single Continuous 8-Stage E2E Test (Gmail -> Telegram) Summary

One new file, `tests/full-chain-e2e.test.ts` (617 lines), drives a fixture Gmail message's raw
bytes through all 8 stages — normalize/strip, ingest pipeline, consolidation (classify/resolve/
drift), proposal emission, proposal store, `/v1/proposals` HTTP surface, Telegram approval — in
a single continuous `it`, closing the v10.0 milestone-audit WARNING (§3 seam 8) that the chain
was previously proven only by composition across three separate test files.

## What Changed

**Task 1 (stages 1-6):** Wrote `tests/full-chain-e2e.test.ts` with the harness copied verbatim
from the three existing e2e files (`tests/proposal-reference-e2e.test.ts`,
`tests/action-proposal-emission.test.ts`, `tests/drift-belief-correction-e2e.test.ts`,
`tests/gmail-adapter.test.ts`'s `FakeGmailFetcher` shape). A file-backed temp DB (P-1), a
`FakeClock` seeded at real `Date.now()` (P-2), stock `provenanceDistinctnessEnabled: false`
(P-3), a single mid-band contradiction recipe at magnitude 0.06 routing to
`contradict_reconcile` (P-4), and two separate `runPullPhase`/`consolidate()` cycles scripted
off a queued `FakeGmailFetcher` (P-5). Two fixture Gmail messages: a plain-text mint email and
an HTML contradiction email carrying a `display:none` hidden canary, a zero-width character
(U+200B) in the Subject header, and a quoted tail. Asserted stages 1 (strip conservation), 2
(ingest join fields), 3-5 (tombstone/mint/drift-event), and 6 (the emit->store join: recomputed
`proposalId`, `evidence_episode` -> episode -> gmail `external_id`, byte-identical
`evidence_quote`, hidden-token non-conservation, `expires_at` in the future per the P-2 guard).

**Task 2 (stages 7-8):** Extended the SAME `it` — closed the engine-half DB handle before
`createBrainHttpServer` opened its own (mirrors `proposal-reference-e2e.test.ts`'s setup/seed
handle split), stood up the real HTTP server against a fail-if-called `ModelProvider`, ran
`runBeliefBridgePass` against the real `/v1/proposals` route, found the approve button
(`callback_data` starting `3|`, label containing the transition target `'rejected'` — APPROVE-
01), decoded it with the real `decodeBeliefCallbackData`, drove `handleBeliefProposalAction`,
and asserted the server-side proposal settled to `'approved'`, the local Telegram row went
`'terminal'`, and the id captured at emission (Task 1) equals the id listed over HTTP and the
id now approved — the emit->store join extended across the HTTP seam, asserted against the
captured constant rather than a re-query.

**Task 3 (gates + audit closure):** `npm run typecheck` was already green (no
`noUncheckedIndexedAccess` fallout in the new file — the suite idiom's non-null-assert-after-
guard pattern was applied preemptively wherever an array index needed it). Full suite green,
no new failures. Updated `.planning/v10.0-MILESTONE-AUDIT.md` §3 item 8 (now "WIRED directly")
and §6 Tech Debt Aggregate headline (dropped the 8-stage-test line, added a resolved-gap
pointer), plus a new `resolved_gaps` entry (`SEAM-08-E2E`) in the frontmatter and removal of
the now-resolved bullet from the `milestone-wide` `tech_debt` items list. **This file is left
uncommitted per the orchestrator's instructions.**

## Verification

- `npx vitest run tests/full-chain-e2e.test.ts` — 1/1 passed, both after Task 1's stages-1-6-only
  revision and after Task 2's full 8-stage extension.
- `npm run typecheck` — green across both tsconfig projects, before and after the extension.
- `npx vitest run` (full suite) — 238 test files passed / 5 skipped (243), 4021 tests passed / 6
  expected-fail / 33 skipped (4060), 0 unexpected failures. No failures attributable to the new
  file; no neighbor destabilized.
- `git diff --stat -- src/` — EMPTY across both task commits. No `src/` seam gap was
  discovered; every seam this file drives already existed with the exact shape the interfaces
  section described.
- **Non-vacuity check (required by plan `<verification>`):** temporarily changed the stage-6
  assertion `expect(row.evidence_episode).toBe(episode1!.id)` to assert against `episode0!.id`
  (message 1's episode, the wrong one) and re-ran the test. Result: **FAILED** as expected —
  `AssertionError: expected '046ea79b-...' to be '85d6061f-...'` (the mint episode's uuid vs the
  contradiction episode's uuid), proving the assertion is load-bearing, not decorative. Reverted
  via `git checkout -- tests/full-chain-e2e.test.ts` (file was already committed at that point);
  re-ran and confirmed the test passes again with the original assertion restored.

## Deviations from Plan

**1. Split the single continuous `it` into two commits by writing two file revisions, not one.**
The plan's Task 1/Task 2 split describes "Task 2 extends the SAME `it`" as a narrative
sequencing instruction, not literally two separate diffs to commit. To honor the
`task_commit_protocol`'s atomic-per-task-commit requirement without leaving an
intermediate broken/uncommitted state, I wrote a stages-1-6-only revision of the file first
(ending the `it` after the stage 6 assertions, with matching trimmed imports/finally block),
verified it independently (`npx vitest run` + `npm run typecheck`, both green), committed it as
Task 1, then extended the same file in place to the full 8-stage version, re-verified, and
committed the extension as Task 2. Net result is byte-identical to writing the file once — the
Task 2 commit's diff is exactly the stage 7-8 addition (150 insertions / 23 deletions, mostly
new imports and the extended try/finally). Not a Rule 1-3 fix; recorded because it deviates from
a literal single-shot read of the plan's task boundaries.

No other deviations — every P-1..P-5 design pin held exactly as specified:
- **P-1** (file-backed temp DB): confirmed necessary — `createBrainHttpServer` opens its own
  handle on `dbPath`.
- **P-2** (`FakeClock(Date.now())`): confirmed necessary — seeding the customary
  `Date.UTC(2026,0,1)` would have made the emitted proposal's `expires_at` already past against
  the server's `realClock`, silently emptying stage 7. Not hit in practice because the pin was
  followed from the start, but the comment documenting the reasoning is in place at the
  construction site as instructed.
- **P-3** (stock dark `provenanceDistinctnessEnabled`): `episode.session_id ===
  COLLAPSED_GMAIL_PROVENANCE_KEY` asserted and held on the first try.
- **P-4** (magnitude 0.06 mid-band reconcile): resistance arithmetic (0.1*0.5=0.05,
  ratio=0.06/0.05=1.2, inside [0.8, 2.0)) matched `contradict_reconcile` exactly as predicted.
- **P-5** (two pulls, two `consolidate()` passes, one reused adapter instance): the
  `cursor:gmail:default` seam round-tripped through the `FakeMetaStore` correctly across both
  cycles with no extra wiring needed.

No `src/` seam gap was discovered or reported — every interface in the plan's `<interfaces>`
section matched live source exactly (verified by reading `src/source/gmail-adapter.ts`,
`src/adapter/ingest-cli.ts`, `src/consolidation/action-proposal-sink.ts`,
`src/db/action-proposal-store.ts`, `clients/telegram/belief-bridge.ts`,
`clients/telegram/belief-proposal-client.ts`, `clients/telegram/push-codec.ts` directly before
writing the fixture).

## Scope Fences Honored

- Zero `src/` changes (verified via `git diff --stat -- src/` after each task commit).
- No new runtime dependencies.
- No mocking of any seam the composed suites exercise for real — GmailAdapter, runPullPhase,
  IngestionPipeline, Consolidator.consolidate(), SQLiteConsolidationSink,
  SQLiteActionProposalSink over a real ActionProposalStore, createBrainHttpServer, and the real
  Telegram belief-bridge functions are all genuine, not mocked.
- LLM calls stayed stubbed exactly as the existing e2e files stub them: content-keyed
  `MarkerProvider` offline (extraction + judge), fail-if-called `ModelProvider` online (proves
  the HTTP + Telegram bridge path never invokes an LLM).

## Known Stubs

None. No hardcoded empty values, no placeholder text, no unwired data sources — every value the
test asserts on comes from a real seam's real output.

## Threat Flags

None beyond the plan's own `<threat_model>` register (T-2qe-01..03, T-2qe-SC), all of which were
addressed exactly as scoped:
- T-2qe-01 (information disclosure): fixture emails use only invented tokens
  (`RECENSE-HIDDEN-CANARY`, `Acme Corp`, `HR <hr@acme-corp.example>`) — no real inbox export, no
  founder PII, no real OAuth values anywhere in the file.
- T-2qe-02 (tampering, test temp artifacts): temp DB/lock paths are `os.tmpdir()`-scoped with
  unique `Date.now()` + random suffixes, unlinked in the `finally` block (each unlink wrapped in
  its own try/catch, resilient to partial-failure cleanup); `RECENSE_LOCK_PATH` is set and
  deleted per test.
- T-2qe-03 (elevation of privilege via assertion strength): the hidden-canary absence assertion
  (`expect(row.evidence_quote).not.toContain(HIDDEN_TOKEN)`) is a real security-property check,
  proven non-vacuous by the required non-vacuity check above (a different assertion in the same
  block was shown to actually fail when wrong).
- T-2qe-SC (package legitimacy): no package installs in this task — every import is a repo
  dependency or a first-party module.

No new network endpoints, auth paths, file-access patterns, or schema changes were introduced
beyond what the plan's threat model already scoped.

## Self-Check: PASSED

- FOUND: tests/full-chain-e2e.test.ts
- FOUND commit: fe2e994 (test: stages 1-6)
- FOUND commit: 838f878 (test: stages 7-8)
- CONFIRMED: `git status --short -- src/` empty (no src/ changes)
- CONFIRMED: `.planning/v10.0-MILESTONE-AUDIT.md` modified and left uncommitted (`git status --short` shows ` M .planning/v10.0-MILESTONE-AUDIT.md`)
