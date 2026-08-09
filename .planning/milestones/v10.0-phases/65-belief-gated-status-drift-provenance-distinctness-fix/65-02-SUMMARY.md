---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
plan: 02
subsystem: source-ingest
tags: [drift-03, quote-stripping, provenance-distinctness]
dependency-graph:
  requires: []
  provides:
    - src/source/strip-quoted.ts (stripQuotedForwarded, isNearEmptyResidual)
  affects:
    - Plan 65-04 (provenance-distinctness key derivation — the intended caller)
    - Plan 65-03 (config.provenanceMinResidualChars — the threshold isNearEmptyResidual consumes)
    - Plan 65-10 (dry-run harness — residual-length distribution reporting)
tech-stack:
  added: []
  patterns:
    - Boundary-first stripping (stop at first attribution/forward/signature line) rather
      than quote-line-only filtering, mirroring strip-hidden.ts's compile-once regex
      discipline and four-guarantee contract (Pure/Idempotent/Total/Monotone)
key-files:
  created:
    - src/source/strip-quoted.ts
    - tests/strip-quoted.test.ts
  modified: []
decisions:
  - "Placed at src/source/strip-quoted.ts (sibling of strip-hidden.ts), not
    src/consolidation/strip-quoted.ts as 65-PATTERNS.md sketched — the distinctness key
    must derive at INGEST since Gmail's threadId never reaches episode.content (per the
    plan's own placement-note discretion)"
  - "Boundary detection checks each line singly against ATTRIBUTION_RE/FORWARD_MARKER_RE/
    SIGNATURE_DELIM_RE, plus a two-line sliding window against ATTRIBUTION_RE to catch
    mailer soft-wrapped attribution lines split across two physical lines"
metrics:
  duration: ~35min
  completed: 2026-08-03
---

# Phase 65 Plan 02: Quoted/Forwarded-Content Detector Summary

Built the D-06 quoted/forwarded-content detector — a zero-import, zero-dependency, pure/idempotent/total/monotone pair of functions (`stripQuotedForwarded`, `isNearEmptyResidual`) that reduce an email body to the author's own newly-written text and judge whether what remains is too small to count as independent evidence, closing the DRIFT-03 farming vector before the provenance-distinctness key (Plan 65-04) exists to exploit it.

## What Was Built

**`src/source/strip-quoted.ts`** — two exported functions, six module-scope compile-once regexes, zero imports:
- `stripQuotedForwarded(text)`: walks lines top-down, stops at the FIRST line matching an `On ... wrote:` attribution boundary, a forwarded-message banner, or an RFC 3676 signature delimiter (`-- `); drops everything from that line onward; then drops any remaining `>`-quoted lines from the surviving prefix. The "stop at first boundary" ordering is deliberate — it catches Outlook-style quoted originals that carry NO `>` prefixes at all, which a quote-line-only filter would leak through.
- `isNearEmptyResidual(text, minNonWhitespaceChars)`: counts non-whitespace characters only; `minNonWhitespaceChars = 0` disables the gate (always `false`). Kept separate from the stripper per the plan's `stripInvisibleCodepoints`/`stripHiddenContent` precedent, so Plan 65-10's dry-run harness can report the residual-length distribution independently of the pass/fail judgement.
- **`MAX_QUOTE_STRIP_CODE_UNITS = 200,000`** — inputs over this bound return `''` immediately (fail-closed toward LESS residual, since under-counting only delays a belief update while over-counting manufactures false independence).

**`tests/strip-quoted.test.ts`** — 49 test cases (27 hand-written `it` blocks + 22 from two `it.each` loops over an 11-entry shared `FIXTURES` array), all green.

## Measurements (per plan `<output>` spec)

- **`MAX_QUOTE_STRIP_CODE_UNITS` shipped value:** `200_000` code units.
- **Gmail-style fixture residual:** `"Thanks for the update, I appreciate hearing back."`
- **Outlook-style fixture residual:** `"Got it, thank you."` (original body carries NO `>` prefixes — proves the boundary rule, not the quote-line rule, does the work)
- **2 MB wall-clock measurement:** `0.04ms` — the input (2,097,152 code units) exceeds `MAX_QUOTE_STRIP_CODE_UNITS` and hits the over-cap fail-closed guard before any regex runs, well under the 2000ms backtracking-guard bound asserted in the test.
- **Task 2 mutation-check result:** Temporarily narrowed the boundary check to `FORWARD_MARKER_RE` only (removed `SIGNATURE_DELIM_RE`/`ATTRIBUTION_RE` from the `if` condition and deleted the two-line attribution-window fallback). Re-ran the suite: **5 tests went red** — `Gmail-style: residual excludes the quoted original body`, `strips at an On ... wrote: attribution boundary`, `a one-word comment above a quote yields that one word as the residual`, `genuine new status content above a quote is preserved and is not near-empty`, and `recognizes a signature delimiter (RFC 3676) as a boundary` — each leaking the quoted/signed original text into the residual instead of stopping at the boundary. Reverted the mutation (restored from a pre-mutation copy) and re-ran: all 49 tests green again.

## Verification

- `npm run typecheck` — exit 0
- `npx vitest run tests/strip-quoted.test.ts` — 49/49 passed
- `npx vitest run tests/strip-hidden.test.ts tests/gmail-hidden-content.test.ts tests/gmail-adapter.test.ts` — 416 passed / 1 expected-fail (pre-existing, unrelated to this plan) — EMAIL-03 path untouched
- `grep -rn "strip-quoted" src/ | grep -v "^src/source/strip-quoted.ts"` — empty (no call site yet, by design)

## Deviations from Plan

None — plan executed exactly as written. The two-line sliding-window fallback for mailer-soft-wrapped attribution lines (not explicitly spelled out in the plan's algorithm steps, but implied by "must tolerate the line wrapping that real mailers insert") was added as an implementation detail within Task 1's own `ATTRIBUTION_RE` instructions, not a deviation from any locked decision.

## Known Stubs

None. This module is fully wired to its documented contract; it has no call site yet by design (Plan 65-04 wires it into the provenance-distinctness key derivation).

## Threat Flags

None — this plan's threat model (T-65-02-FARM, T-65-02-DOS, T-65-02-EVADE, T-65-02-UNI, T-65-SC) is fully accounted for in the design already documented in the plan; no new surface was introduced beyond what the plan anticipated.

## Self-Check: PASSED

- FOUND: `src/source/strip-quoted.ts`
- FOUND: `tests/strip-quoted.test.ts`
- FOUND commit `aab783f` (feat(65-02): add strip-quoted.ts quoted/forwarded-content detector)
- FOUND commit `35e6249` (test(65-02): add table-driven strip-quoted.ts unit suite)
