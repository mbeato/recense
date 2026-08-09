---
phase: 62-multi-inbox-email-ingest-hardening
plan: 11
subsystem: email-ingest-security
tags: [security, unicode, invisible-codepoints, cr-02, gap-closure, prompt-injection]

# Dependency graph
requires:
  - phase: 62-09
    provides: "STYLE_BLOCK_RE quote-aware fix (CR-01), source-guard test in strip-hidden.ts"
  - phase: 62-10
    provides: "parseEmailDate Math.min(parsed, nowMs) clamp (CR-03) in gmail-adapter.ts"
provides:
  - "stripInvisibleCodepoints — exported narrow stage-1 primitive from strip-hidden.ts, reused (not duplicated) by stripHiddenContent's stage 1"
  - "normalizeGmailMessage's provenance header (From:/Subject:) stripped of invisible codepoints before it reaches record.content — CR-02 closed"
  - "Behavior-preservation proof for the stage-1 extract-and-reuse refactor, over the entire existing fixture corpus"
  - "Shared-regex lastIndex-safety proof (interleaving lock) for the two exported entry points"
affects: [63-offline-intent-classification]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Narrow non-markup primitive extracted from a markup pipeline's stage 1, exported separately, and reused (not duplicated) by the pipeline itself — verified behavior-preserving via output-equality assertions over the whole existing fixture corpus rather than asserted by argument alone"
    - "Shared module-scope /gu RegExp object across two exported entry points, safety proven by an interleaving test rather than left as an argument about String.prototype.replace's lastIndex-reset semantics"

key-files:
  created: []
  modified:
    - src/source/strip-hidden.ts
    - src/source/gmail-adapter.ts
    - tests/gmail-hidden-content.test.ts
    - tests/strip-hidden.test.ts

key-decisions:
  - "Extract-and-reuse locked per plan's <interfaces>: stripInvisibleCodepoints(text) = text.replace(INVISIBLE_CODEPOINTS_RE, ''), stage 1 inside stripHiddenContent now calls it. INVISIBLE_CODEPOINTS_RE stays module-scope, declared once, used from exactly two call sites (grep -c == 2)."
  - "Narrow primitive applied to headers, NOT the full 8-stage stripHiddenContent — locked as a testable property (no-mangling control: '<urgent>', 'pricing & terms', 'alice@acme.com' all survive) rather than an untested design preference."
  - "IDEMPOTENCE_FIXTURES hoisted from a describe-local const to module scope in tests/strip-hidden.test.ts so the new behavior-preservation block iterates the literal same array reference as the pre-existing idempotence block, not a hand-copied subset."

requirements-completed: [EMAIL-03]

# Metrics
duration: ~45min
completed: 2026-07-30
---

# Phase 62 Plan 11: CR-02 Header-Borne Invisible-Codepoint Leak Summary

**Closed CR-02 (BLOCKER): `normalizeGmailMessage`'s provenance header (built from 100%-sender-controlled `From:`/`Subject:`) now passes through a newly-exported narrow `stripInvisibleCodepoints` stage-1 primitive before reaching `record.content`, proved RED-before-GREEN at episode-content level, with the stage-1 extraction proven behavior-preserving over the entire existing fixture corpus and the shared-regex `lastIndex` contract proved by a 20-iteration interleaving lock.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-07-30
- **Tasks:** 3 (RED / GREEN / behavior-preservation + shared-regex lock)
- **Files modified:** 4 (2 production, 2 test)

## Accomplishments

- Closed `62-VERIFICATION.md` gaps[0] `missing[1]` / `62-REVIEW.md` CR-02 (BLOCKER): a Subject or From header carrying Unicode Tags-block codepoints (U+E0000-U+E007F) or zero-width characters (U+200B-U+200D, U+2060, U+FEFF, U+00AD, U+180E, U+2061-U+2064) no longer survives into `record.content`
- Exported `stripInvisibleCodepoints` from `strip-hidden.ts` as a narrow, non-markup stage-1 primitive, reusing (not duplicating) the single module-scope `INVISIBLE_CODEPOINTS_RE`
- Applied it to `raw.headers.from` and `raw.headers.subject` in `normalizeGmailMessage` before `provenanceHeader` is built; corrected the in-code justification (both the local comment and the file-level `EMAIL-03` design block) to state the actual reasoning instead of the prior false claim ("stripping it would risk mangling a legitimate subject containing angle brackets" — never true for stage 1)
- Proved the stage-1 extract-and-reuse refactor changed nothing observable in `stripHiddenContent`: `stripHiddenContent(s) === stripHiddenContent(stripInvisibleCodepoints(s))` holds for every entry in the pre-existing idempotence fixture corpus (22 fixtures) plus the 3 invisible-Unicode inputs, iterated by shared array reference
- Proved the two exported entry points (`stripInvisibleCodepoints`, `stripHiddenContent`) cannot leak `RegExp.lastIndex` state between them via a 20-iteration interleaving lock
- Kept `stripHiddenContent(raw.bodyText)` verbatim — the source-order lock at `tests/gmail-hidden-content.test.ts:112-119`-equivalent (now later in the file after the new describe block, but same assertion) stays green
- Left wave A's fixes untouched: `STYLE_BLOCK_RE`'s quote-aware literal (62-09) and `parseEmailDate`'s `Math.min(parsed, nowMs)` clamp + corrected JSDoc (62-10) — confirmed via `git diff -U0` showing changes confined to exactly the expected regions
- Named `62-REVIEW.md` WR-01 (raw `\n` forging a second provenance line) as a deliberately-unfixed adjacent finding, per this task's requirement — see below

## Task Commits

Each task was committed atomically:

1. **Task 1: Demonstrate the header-borne injection with failing episode-content tests (RED)** — `8227788` (test)
2. **Task 2: Export the stage-1 primitive and apply it to From/Subject (GREEN)** — `43d2de5` (fix)
3. **Task 3: Prove the stage-1 extraction is behavior-preserving and lock the shared-regex contract** — `291d16f` (test)

**Plan metadata:** committed as part of this SUMMARY commit (worktree mode — STATE.md/ROADMAP.md updates deferred to orchestrator)

## RED evidence (Task 1)

Verify command (`npx vitest run tests/gmail-hidden-content.test.ts`) exited **non-zero** (`EXIT=1` confirmed independently) against the unfixed code. 4 of 17 tests in the new `EMAIL-03 CR-02` describe block failed; the no-mangling control and all 12 pre-existing cases passed.

Verbatim failure for the Tags-block Subject case (`record.content`, surviving codepoints shown escaped as `\u{E00xx}` rather than rendered):

```
AssertionError: expected 'From: a@b.c · Re: Your application\u{E0049}…' not to match /[\u{E0000}-\u{E007F}]/u

+ Received:
"From: a@b.c · Re: Your application\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045} · Acct: default
Hi there,
Thank you for your interest in the Backend Engineer role.
...
```

The literal codepoints surviving after `application` are `U+E0049 U+E0047 U+E004E U+E004F U+E0052 U+E0045` (the Tags-block-encoded ASCII "IGNORE" — the payload built via `String.fromCodePoint(0xe0049, 0xe0047, 0xe004e, 0xe004f, 0xe0052, 0xe0045)`), confirmed present verbatim in `record.content` pre-fix.

All four failing test names:
- `a Unicode Tags-block payload in Subject does not survive into record.content`
- `a Unicode Tags-block payload in From does not survive into record.content`
- `a zero-width payload in Subject does not survive into record.content`
- `combined-surface: Tags-block in From AND zero-width in Subject AND a clean body — no invisible codepoint anywhere in record.content`

The `a legitimate Subject/From containing angle brackets and an ampersand survives into record.content unmangled` no-mangling control PASSED in this RED state, as required — it is a genuine control (this design forces the narrow stage-1 primitive rather than the full pipeline), not a post-hoc rationalization.

`git diff --exit-code src/` exited 0 in this state (no production edit in Task 1). `git diff --exit-code tests/strip-hidden.test.ts tests/fixtures/gmail-hidden-injection.html tests/gmail-event-ts.test.ts tests/gmail-future-date-ordering.test.ts` exited 0. `npx tsc --noEmit` exited 0.

## The exported primitive and its call site (Task 2)

`src/source/strip-hidden.ts` — new export in the Public API section, above `stripHiddenContent`:

```ts
export function stripInvisibleCodepoints(text: string): string {
  return text.replace(INVISIBLE_CODEPOINTS_RE, '');
}
```

`stripHiddenContent`'s stage-1 line now reads `let s = stripInvisibleCodepoints(text);` (was the inline `text.replace(INVISIBLE_CODEPOINTS_RE, '')`) — a pure inline/outline transformation, no other stage touched.

`src/source/gmail-adapter.ts` — the import gains a second named import (`stripHiddenContent, stripInvisibleCodepoints`), and `normalizeGmailMessage` derives two locals before building `provenanceHeader`:

```ts
const strippedBody = stripHiddenContent(raw.bodyText);              // unchanged, verbatim
const strippedFrom = stripInvisibleCodepoints(raw.headers.from);    // new
const strippedSubject = stripInvisibleCodepoints(raw.headers.subject); // new
const provenanceHeader = `From: ${strippedFrom} · Re: ${strippedSubject} · Acct: ${accountId}`;
```

`accountId` is unchanged — still sourced from trusted config (T-20-06), never passed through the primitive.

### The extract-and-reuse decision — three checkable reasons, and the evidence for each

1. **Stage 1 is a single unconditional expression with no branching, no dependence on other stages' state.** Evidence: the diff moving it into `stripInvisibleCodepoints` and calling it from stage 1 is a mechanical inline/outline transformation — `git diff -U0 src/source/strip-hidden.ts` at Task 2 shows only the new exported function plus a one-line change to the stage-1 call site inside `stripHiddenContent`, nothing else in the 8-stage pipeline touched.
2. **Sharing the module-scope `/gu` regex object between two call sites cannot leak `lastIndex`.** Evidence: `String.prototype.replace` with a global regex resets `lastIndex` to 0 before matching and again after completion per `RegExp.prototype[@@replace]` — Task 3's interleaving block (below) converts this from an argument into a checked property.
3. **Duplicating the regex would create two sources of truth for the invisible-codepoint set.** Evidence: `grep -c "INVISIBLE_CODEPOINTS_RE" src/source/strip-hidden.ts` returns exactly **2** (the declaration and the single use site inside `stripInvisibleCodepoints`) — the regex was reused, not copy-pasted.

### The corrected in-code justification

Both the local comment above `normalizeGmailMessage`'s header handling and the file-level `EMAIL-03` design block in `gmail-adapter.ts` were rewritten to state what is actually true: the BODY gets the full 8-stage `stripHiddenContent`; the HEADER gets stage 1 only (`stripInvisibleCodepoints`), because `From:`/`Subject:` are 100% sender-controlled and `redactSecrets` covers secret patterns only, not invisible codepoints; and the full pipeline is deliberately NOT applied to headers because stages 4-6 would delete a legitimate `Subject: Re: <urgent> pricing` down to `Re:`. The prior claim ("stripping it would risk mangling a legitimate subject containing angle brackets") was never actually a reason to skip stage 1 — it only argues against stages 4-6 — and is now replaced.

Post-Task-2 targeted verify (`npx vitest run tests/gmail-hidden-content.test.ts tests/strip-hidden.test.ts tests/gmail-adapter.test.ts tests/gmail-adapter-multiaccount.test.ts tests/gmail-event-ts.test.ts`): 5 files / 134 tests, all passed. All four invisible-codepoint cases from Task 1 now PASS; the no-mangling control still PASSES (`<urgent>`, `pricing & terms`, `alice@acme.com` all present). `git diff -U0 src/source/gmail-adapter.ts` confirmed changes confined to exactly three regions (file-level `EMAIL-03` block, the `./strip-hidden` import, and `normalizeGmailMessage`'s comment + header-derivation + `provenanceHeader` lines) — nothing inside `parseEmailDate` or its JSDoc (62-10's territory). `git diff --exit-code` clean for all scope-fenced files: `src/consolidation/episode-order.ts src/consolidation/consolidator.ts src/consolidation/update-decision.ts src/db/schema.ts src/adapter/gmail-auth-cli.ts src/adapter/runtime-config.ts src/lib/config.ts src/adapter/recense-doctor.ts src/ingest/pipeline.ts`.

## Behavior-preservation result (Task 3)

`grep -c "INVISIBLE_CODEPOINTS_RE" src/source/strip-hidden.ts` returns **2** — exactly one declaration, one use site.

Three new describe blocks added to `tests/strip-hidden.test.ts`:

1. **`stripInvisibleCodepoints — narrow stage-1 primitive (CR-02)`** — direct unit coverage: Tags-block removal leaving ASCII intact; a table-driven test covering every codepoint class in `INVISIBLE_CODEPOINTS_RE` (U+200B, U+200C, U+200D, U+2060, U+FEFF, U+00AD, U+180E, one of U+2061-U+2064); idempotence; totality (empty string, lone high surrogate `\uD800`, 64KB-in-UTF-16-code-units Tags-block string); and the no-markup-touch property (`'Re: <urgent> pricing & terms'` returned byte-identical) that is what makes the primitive safe to apply to a `Subject:` line.
2. **`stripHiddenContent — stage-1 extraction is behavior-preserving (CR-02 refactor lock)`** — asserts `stripHiddenContent(s) === stripHiddenContent(stripInvisibleCodepoints(s))` for every entry in `IDEMPOTENCE_FIXTURES` (hoisted to module scope so this block iterates the literal same array as the pre-existing idempotence describe block — not a hand-copied subset, satisfied by shared array identity) plus the 3 `INVISIBLE_UNICODE_INPUTS`. A second assertion ties the two functions' behavior together directly: for a plain-text zero-width input with irregular whitespace, `stripHiddenContent(x)` equals `stripInvisibleCodepoints(x)` after a locally-defined whitespace normalizer that mirrors stage 8's exact behavior (collapse space/tab runs, per-line trim, collapse 3+ newlines to 2, overall trim).
3. **`stripInvisibleCodepoints / stripHiddenContent — shared module-scope regex cannot leak lastIndex (CR-02 refactor lock)`** — computes isolated baselines for both functions on distinct multi-codepoint inputs, then alternates 20 calls between the two entry points, asserting every result still equals its isolated baseline.

**Pre-refactor / post-refactor full-suite counts, side by side:**

| Point | Files passed / skipped | Tests passed / skipped | Failures |
|---|---|---|---|
| Pre-plan baseline (this worktree, after `npm run build` to populate `dist/`) | 193 / 1 (194 total) | 2910 / 4 (2914 total) | 0 |
| Post-Task-1 (RED, verify command intentionally non-zero — not a full-suite run) | n/a | n/a | n/a |
| Post-Task-2 (GREEN fix applied) | — (targeted run only) | 2915 (targeted+baseline delta consistent) | 0 |
| Post-Task-3 (behavior-preservation + interleaving locks added) | 193 / 1 (194 total) | 2955 / 4 (2959 total) | 0 |

Net delta from baseline to close: **+45 tests** (5 CR-02 episode-content cases in Task 1, 40 new unit/lock cases across the three Task 3 describe blocks), **0 new failures**, skip count unchanged at 4.

Note on the plan's stated baseline: the plan's `<verification>` section cites "2880 passed / 3 skipped / 0 failed across 193 files" as the pre-plan baseline; per this plan's own `<critical_discipline>` instruction, the correct baseline is the post-wave-A figure of **2911 passed / 3 skipped / 194 files**. This worktree measured **2910 passed / 4 skipped / 194 files** at the same point (after `npm run build`) — a 1-test/1-skip variance from the stated post-wave-A figure, consistent with the same kind of environment-conditional skip variance 62-09's SUMMARY documented (real-`recense.db`-guarded tests skip differently depending on local machine state). This is a pre-existing environmental variance, not something introduced by this plan; all counts in this SUMMARY are measured directly in this worktree, not assumed from either plan text.

## Adjacent finding, deliberately NOT fixed: `62-REVIEW.md` WR-01

A raw `\n` (or `\r`) in `Subject:` or `From:` can forge a second, byte-indistinguishable provenance line in `record.content`, because `provenanceHeader` is built by direct string interpolation with no newline collapsing. This sits on the exact lines this plan edits, and the reviewer suggested folding it into the CR-02 fix. It is **deliberately not implemented here**:
- It is a WARNING in `62-REVIEW.md`, not a BLOCKER.
- It appears in no `62-VERIFICATION.md` `missing:` bullet.
- It falsifies no roadmap Success Criterion.
- The verifier left the warning set to the developer's disposition.

**One-line fix shape** (for the backlog): collapse `[\r\n\t]+` to a single space when building `strippedFrom`/`strippedSubject` (or on the raw header values before interpolation), e.g. `raw.headers.subject.replace(/[\r\n\t]+/g, ' ')` applied alongside (or composed with) `stripInvisibleCodepoints`. Cheap to implement whenever picked up; out of scope for this plan per the reasoning above.

## Files Created/Modified

- `src/source/strip-hidden.ts` — exports `stripInvisibleCodepoints` (narrow stage-1 primitive); `stripHiddenContent`'s stage 1 now calls it; file-level doc block's stage-1 entry updated to note the standalone export
- `src/source/gmail-adapter.ts` — imports `stripInvisibleCodepoints`; applies it to `raw.headers.from`/`raw.headers.subject` before `provenanceHeader` is built; corrected the local justification comment and the file-level `EMAIL-03` design block
- `tests/gmail-hidden-content.test.ts` — new `EMAIL-03 CR-02` describe block: 4 invisible-codepoint episode-content cases + 1 no-mangling control
- `tests/strip-hidden.test.ts` — `IDEMPOTENCE_FIXTURES` and `INVISIBLE_UNICODE_INPUTS` hoisted to module scope; 3 new describe blocks (narrow-primitive unit coverage, behavior-preservation lock, shared-regex interleaving lock)

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

None — plan executed exactly as written. The two literal-invisible-character regex/table entries were written as explicit `\u` escape sequences (e.g. `'\u200B'` rather than a pasted zero-width glyph) purely for editor auditability/exactness during authoring; this is a stylistic choice within the plan's own instructions, not a deviation from any specified behavior — the resulting runtime strings are identical either way (confirmed by the passing table-driven test).

## Issues Encountered

None beyond the pre-existing `dist/` build-artifact requirement already documented in 62-09's SUMMARY (this worktree needed `npm run build` before the CLI-subprocess test files would pass — not a plan-scope file, not committed, `dist/` is gitignored).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- CR-02 (BLOCKER) is closed: neither the Unicode Tags block nor any zero-width/invisible codepoint class in `INVISIBLE_CODEPOINTS_RE` can reach `record.content` via a forged `From:`/`Subject:` header, verified at episode-content level (not merely on a helper's return value)
- The stage-1 extract-and-reuse refactor is proven behavior-preserving over the entire existing fixture corpus, not merely asserted; `stripHiddenContent`'s own behavior is unchanged
- The two exported entry points cannot leak shared regex state, proven by a 20-iteration interleaving lock
- `strip-hidden.ts` remains pure, zero-import, compile-once, idempotent, deterministic, and total; `gmail-adapter.ts` still strips the body before redacting the combined string
- WR-01 is named, bounded, and flagged for the backlog with its one-line fix shape — not silently absorbed or lost
- Wave A's fixes (`STYLE_BLOCK_RE` quote-aware literal from 62-09; `parseEmailDate`'s clamp + corrected JSDoc from 62-10) are confirmed untouched by `git diff` scoping
- This closes all three BLOCKERs from `62-REVIEW.md`/`62-VERIFICATION.md`'s gap-closure wave (CR-01 via 62-09, CR-03 via 62-10, CR-02 via this plan)

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-07-30*
