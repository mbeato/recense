---
phase: 65-belief-gated-status-drift-provenance-distinctness-fix
plan: 04
subsystem: source-ingest
tags: [drift-03, provenance-distinctness, gmail]
dependency-graph:
  requires:
    - src/source/strip-quoted.ts (stripQuotedForwarded, isNearEmptyResidual — Plan 65-02)
    - src/lib/config.ts (provenanceMinResidualChars, provenanceDistinctnessEnabled — Plan 65-03)
  provides:
    - src/source/provenance-key.ts (COLLAPSED_GMAIL_PROVENANCE_KEY, normalizeSenderDomain, deriveGmailProvenanceKey)
  affects:
    - Plan 65-06 (gmail-adapter/ingest-cli wiring — the intended caller of deriveGmailProvenanceKey)
    - Plan 65-10 (dry-run harness — will report composed-key distribution before enablement)
tech-stack:
  added: []
  patterns:
    - Pure two-import module (only ./strip-quoted and ./strip-hidden), no EngineConfig/DB/clock
      import — mirrors strip-quoted.ts's zero-dependency-surface discipline one level up
key-files:
  created:
    - src/source/provenance-key.ts
    - tests/provenance-key.test.ts
  modified: []
decisions:
  - "normalizeSenderDomain's reject list drops the plan action-text's literal 'contains no .'
    condition — the plan's own behavior spec requires normalizeSenderDomain('Weird <a@b>,
    Second <c@d.com>') to return 'b' (no dot), which directly contradicts that reject
    condition. Followed the explicit locked example; every other reject condition (length,
    charset, leading/trailing '.'/'-', consecutive dots) is enforced as written and is
    independently sufficient for every adversarial case the plan names. Documented in the
    module header as an implementation note, not silently."
metrics:
  duration: ~50min
  completed: 2026-08-03
---

# Phase 65 Plan 04: Provenance-Distinctness Key Derivation Summary

Built the DRIFT-03 provenance-distinctness key derivation — a pure, two-import module (`src/source/provenance-key.ts`) that composes `ingest:gmail:<normalized-sender-domain>:<gmail-thread-id>` from a `From:` header, Gmail's server-assigned `threadId`, and body text, failing closed to the shared pre-Phase-65 collapsed key (`ingest:gmail`) on every unparseable or non-independent path. This is the single function that decides whether `countDistinctProvenance` can ever fire on Gmail-only evidence (today it structurally cannot — the collapsed `session_id` makes `distinctCount` stuck at 1), while simultaneously closing the inverse farming vector where forwarded/quoted duplication would otherwise manufacture false independence.

## What Was Built

**`src/source/provenance-key.ts`** — three exports, two imports (`./strip-quoted`, `./strip-hidden`), zero other dependencies:

- `COLLAPSED_GMAIL_PROVENANCE_KEY = 'ingest:gmail'` — the pre-Phase-65 literal, reused as the shared fail-closed fallback.
- `normalizeSenderDomain(fromHeader)`: strips invisible codepoints first (mirroring `gmail-adapter.ts:517`), extracts the first `<...>`-bracketed address (or the whole trimmed string if none), takes everything after the LAST `@`, lowercases, strips one trailing FQDN dot, and rejects (never repairs) on empty/oversized/bad-charset/leading-or-trailing-dot-or-hyphen/consecutive-dots shapes.
- `deriveGmailProvenanceKey({ fromHeader, threadId, bodyText, minResidualChars })`: runs the D-07 residual gate FIRST (`stripQuotedForwarded` + `isNearEmptyResidual` from Plan 65-02) — a pure forward/quote collapses regardless of sender/thread — then validates the domain and the thread id (`[A-Za-z0-9_-]{1,64}`, `:` excluded as the separator), composing the final key only when both checks pass.

**`tests/provenance-key.test.ts`** — 71 test cases across six `describe` blocks: `normalizeSenderDomain` (11), `deriveGmailProvenanceKey` (7), `DRIFT-03 locked pair (D-07)` (9, review-blocking per its own header comment), `adversarial From: header handling` (4), `adversarial threadId handling` (5), `no message id leakage` (35, one `it.each` iteration per fixture plus a non-vacuousness guard). All fixtures are built once at module scope (not inside `it()` callbacks) and iterated by the leakage loop, per the plan's "build the fixture list once" requirement.

## Exact Key Format Shipped

`ingest:gmail:<normalized-sender-domain>:<gmail-thread-id>` — e.g. `ingest:gmail:acme.com:abc123`. Collapsed fallback: `ingest:gmail` (identical to the pre-Phase-65 literal, and a strict prefix of every composed key).

## Discretionary Choices and Rationale (CONTEXT.md D-01)

1. **Domain, not full address.** A mailbox can mint unlimited local parts (`a+1@`, `a+2@`); keying on domain caps the farming surface at "control N domains" — the same bar as controlling N Claude Code sessions. Honest cost: two different humans at the same company corroborating the same status count as ONE provenance. Deliberately conservative — under-count, never over-count.
2. **accountId excluded.** The same thread landing in two of the founder's own inboxes is one piece of evidence, not two.
3. **Plaintext, not hashed.** The sender domain already appears verbatim in `episode.content`'s provenance header (`gmail-adapter.ts:521`), so no new disclosure; a readable key keeps Plan 65-10's dry-run human-reviewable.
4. **`ingest:gmail` prefix preserved.** Extends rather than replaces the existing literal, so `session_id` values stay operator-legible and the collapsed key stays a strict prefix.

## Mutation Check Results

**Mutation check #1 (residual gate skipped):** Temporarily removed the D-07 residual-gate early-return from `deriveGmailProvenanceKey` (derived straight from domain+thread, ignoring `stripQuotedForwarded`/`isNearEmptyResidual`). Re-ran the suite: **5 tests went red** — the three `Direction B` variants (pure forward, quote, near-miss) plus the near-miss-based threshold-0 test's first assertion — each now producing 3 distinct keys instead of the required 1, because domain+thread alone can't detect that the three messages are copies of one forwarded thread. **Direction A and every other test stayed green** (66/71 passed), confirming the residual gate — not sender/thread variation — is what makes Direction B collapse. Reverted; 71/71 green again.

**Mutation check #2 (per-message unique fallback):** Temporarily changed the two `normalizeSenderDomain === null` / bad-`threadId` fail paths to return `` `${COLLAPSED}:unparseable:${rawValue}` `` instead of the shared `COLLAPSED_GMAIL_PROVENANCE_KEY`. Re-ran the suite: **9 tests went red** — the 300-char-domain case, the colon-domain case, and all 5 adversarial-threadId cases (empty, colon, path-traversal, 200-char), each now producing a per-message-unique string instead of the shared collapsed key, restoring exactly the farmable "distinct value per unparseable message" shortcut the "dangerous shortcuts" table bans. Reverted; 71/71 green again.

## Verification

- `npm run typecheck` — exit 0
- `npx vitest run tests/provenance-key.test.ts` — 71/71 passed
- `npx vitest run tests/no-ats-domain-table.test.ts` — 3/3 passed, no vendor domain token introduced
- `npx vitest run tests/strip-quoted.test.ts tests/strip-hidden.test.ts tests/gmail-adapter.test.ts tests/gmail-hidden-content.test.ts` — 465 passed / 1 expected-fail (the same pre-existing, unrelated fail noted in 65-02's SUMMARY) — no collateral regression
- `grep -rn "provenance-key" src/ | grep -v "^src/source/provenance-key.ts"` — empty, no call site yet, by design
- Task 1 source-level greps (export count = 3, import count = 2, banned-pattern count = 0, `stripInvisibleCodepoints` count = 2, `COLLAPSED_GMAIL_PROVENANCE_KEY` count = 7) — all pass

## Deviations from Plan

**1. [Rule 1 - internal plan inconsistency] `normalizeSenderDomain`'s reject list drops the literal "contains no '.'" condition.**
- **Found during:** Task 1 implementation.
- **Issue:** The plan's `<action>` text lists "contains no '.'" as a reject condition for `normalizeSenderDomain`, but the plan's own `<behavior>` block requires `normalizeSenderDomain('Weird <a@b>, Second <c@d.com>')` to return `'b'` — a domain with no dot — not `null`. The two statements in the same plan directly contradict each other.
- **Fix:** Followed the explicit locked input/output example (the literal test the acceptance criteria and Task 2 build on) rather than the prose reject-list line. Every other reject condition in the plan (253-char bound, `[a-z0-9.-]` charset, leading/trailing `.`/`-`, consecutive dots) is enforced exactly as written and independently rejects every adversarial case the plan names — dropping only the no-dot check does not weaken any other named guarantee.
- **Files modified:** `src/source/provenance-key.ts` (documented inline as an "Implementation note" in the module header, not silently resolved).
- **Commit:** `1fe6d3a`

## Known Stubs

None. This module is fully wired to its documented contract; it has no call site yet by design (Plan 65-06 wires it into gmail ingest).

## Threat Flags

None — this plan's threat model (T-65-04-SPOOF, T-65-04-FARM, T-65-04-FRAG, T-65-04-DISPLAY, T-65-04-SHORTCUT, T-65-04-DOMTBL, T-65-04-DISCLOSE, T-65-SC) is fully accounted for by the design already documented in the plan; no new surface was introduced beyond what the plan anticipated. The one live-tested threat worth calling out: T-65-04-DISPLAY's adversarial RFC 2047 case (`'=?utf-8?q?Spoofed_Name?= <fake@evil.test>, Real Person <real@acme.com>'`) resolves to `evil.test` under the pinned "first bracket wins" semantics — asserted explicitly in the suite, not incidental.

## Self-Check: PASSED

- FOUND: `src/source/provenance-key.ts`
- FOUND: `tests/provenance-key.test.ts`
- FOUND commit `1fe6d3a` (feat(65-04): add provenance-key.ts DRIFT-03 key derivation)
- FOUND commit `c370ba2` (test(65-04): add D-07 locked-pair unit suite for provenance-key.ts)
