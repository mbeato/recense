# Quick Task 260809-2fo: WR-03 indent-tolerance fix + WR-01 rationale correction Summary

Fixed `stripQuotedForwarded`'s idempotence and boundary-leak defects for indented mailer
quoting (any leading horizontal whitespace, not just `{0,3}`/column-0), and corrected two
overstated farming-bar rationale comments — clearing the two CODE items of Phase 65's review
debt gating the `provenanceDistinctnessEnabled` enablement decision.

## What Changed

**Task 1 (RED):** Added 5 new `FIXTURES` entries (4-space-indented quote, own-text-above
indented quote, indented `On ... wrote:` attribution, indented forward banner, indented
signature delimiter) plus a `WR-03 regression: indented quotes and boundaries` describe block
with 11 explicit value/idempotence assertions to `tests/strip-quoted.test.ts`. RED run: 13
failures, all matching the planner's reproduction table; 0 pre-existing regressions (57
passed).

**Task 2 (GREEN):** Two coordinated edits to `src/source/strip-quoted.ts`:
1. `QUOTE_LINE_RE`, `ATTRIBUTION_RE`, `FORWARD_MARKER_RE`, `SIGNATURE_DELIM_RE` now anchor on
   `[ \t]*` (arbitrary leading horizontal whitespace) instead of `{0,3}` / column-0. Kept the
   bounded `[^\n]{0,200}` catastrophic-backtracking guard on `ATTRIBUTION_RE` untouched.
2. Step 4's `.trim()` replaced with a per-line trailing-horizontal-whitespace strip
   (`line.replace(/[ \t\r]+$/, '')`) plus leading/trailing empty-line dropping via `start`/`end`
   index advance, so a surviving line's LEADING indentation is preserved rather than being
   re-anchored to column 0 (the mechanical cause of the idempotence breach — a re-anchored
   line only manufactures a fresh boundary/quote match on a SECOND pass).

Doc comments (Contract idempotence bullet, algorithm step 4, all four regex docblocks) updated
to describe the new indent-tolerant / indentation-preserving behavior and cite 65-REVIEW WR-03.

GREEN: all 156 tests across `strip-quoted.test.ts` + `provenance-key.test.ts` +
`gmail-provenance-key.test.ts` pass, zero drift on any pre-existing fixture value. Typecheck
clean. `git diff --stat src/` showed `strip-quoted.ts` as the only changed source file for
this task.

**Task 3 (comment-only):**
- `src/source/provenance-key.ts`'s "Domain, not full address" bullet rewritten to state the
  real bar: the composed key is `(sender domain, Gmail threadId)`, so distinctness is
  per-thread not per-domain; a `threadId` is server-assigned (uncollidable) but
  sender-mintable at zero cost (any fresh Subject + no `In-Reply-To` starts a new thread); the
  `From:` domain is itself sender-asserted; the residual gate only suppresses duplicated
  content, so N freshly-worded emails clear it. States plainly why `provenanceDistinctnessEnabled`
  ships dark and points at 65-REVIEW WR-01 / the founder's enablement review (65-HUMAN-UAT 1-3).
- `src/source/gmail-adapter.ts`'s `RawGmailMessage.threadId` docblock no longer claims
  `threadId` is "the one component of the key not under the sender's control" — server
  assignment prevents choosing/colliding a `threadId`, not minting unlimited new ones. Kept
  the load-bearing D-04 instruction (never reconstruct lineage from `References`/
  `In-Reply-To`).

Comment-only grep gate (`git diff -U0 ... | grep non-comment-non-blank | wc -l`) returned `0`
— zero executable lines changed. All four Task-3 suites (`provenance-key`,
`gmail-provenance-key`, `gmail-adapter`, `session-id-provenance-consumers`) green (114 tests),
typecheck clean.

## Verification

- `npx vitest run tests/strip-quoted.test.ts tests/provenance-key.test.ts tests/gmail-provenance-key.test.ts tests/gmail-adapter.test.ts tests/session-id-provenance-consumers.test.ts` — 184/184 passed.
- `npm run typecheck` — clean.
- `git diff --stat` (base..HEAD) — exactly 4 files: `tests/strip-quoted.test.ts`,
  `src/source/strip-quoted.ts`, `src/source/provenance-key.ts`, `src/source/gmail-adapter.ts`.
- `git diff tests/strip-quoted.test.ts` — additions only (no pre-existing assertion edited,
  weakened, or deleted).
- `dist/` was absent at execution time, so `tests/drift-05-harness-smoke.test.ts` skipped by
  design (per quick task 260809-1vg's dist-gate). Recorded per plan verification item 5.
- Full suite (`npx vitest run`): 4020 passed, 6 expected-fail, 33 skipped, 0 unexpected
  failures, 237 test files passed / 5 skipped.

## Deviations from Plan

None — plan executed exactly as written. All three tasks matched their `<action>` /
`<behavior>` specs; the prototype patch described in Task 2's `<behavior>` block (indent
tolerance + non-re-anchoring trim) is exactly what was implemented, and it produced zero drift
against every pre-existing fixture as the planner predicted.

## Scope Fences Honored

- No change to key composition, `THREAD_ID_RE`, thresholds, or `contradictionNBySource`.
- No change to `stripHiddenContent`, `normalizeGmailMessage`'s content path, or `pipeline.ts`.
- No change to `EXCESS_BLANK_LINES_RE` or its comment (IN-03, separate finding — left
  untouched despite sitting two lines from edited code).
- No new runtime dependencies.
- WR-02, WR-04, IN-01/02/03/04/05 untouched.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, file-access patterns, or schema changes were
introduced. All four STRIDE register entries (T-2fo-01..04, T-2fo-SC) were addressed exactly
as scoped: T-2fo-01/02 mitigated via Task 2's indent-agnostic matching + non-re-anchoring
trim; T-2fo-03 accepted-this-task via Task 3's accurate documentation (key-composition fix
remains the founder's enablement decision); T-2fo-04 preserved verbatim (bounded
`[^\n]{0,200}` spans, 200k over-cap guard, all totality/fuzz tests still green).

## Note for the Milestone Audit

This clears the two CODE items of the v10.0 audit tech-debt list for 65-REVIEW. It does NOT
resolve 65-HUMAN-UAT items 1-3 — the `provenanceDistinctnessEnabled` ENABLE/HOLD decision and
the threadId-in-key vs `contradictionNBySource.gmail` question remain open and are the
founder's call, now made against an accurate in-file threat statement.

## Self-Check: PASSED

- FOUND: tests/strip-quoted.test.ts
- FOUND: src/source/strip-quoted.ts
- FOUND: src/source/provenance-key.ts
- FOUND: src/source/gmail-adapter.ts
- FOUND commit: 9d8348b (test: RED)
- FOUND commit: b5bbc1f (feat: GREEN)
- FOUND commit: b49bef4 (docs: WR-01 rationale)
