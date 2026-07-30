---
phase: 62-multi-inbox-email-ingest-hardening
reviewed: 2026-07-29T00:00:00Z
depth: deep
files_reviewed: 12
files_reviewed_list:
  - src/adapter/gmail-auth-cli.ts
  - src/adapter/ingest-cli.ts
  - src/adapter/recense-doctor.ts
  - src/adapter/recense.ts
  - src/adapter/runtime-config.ts
  - src/consolidation/consolidator.ts
  - src/consolidation/episode-order.ts
  - src/db/episode-store.ts
  - src/db/schema.ts
  - src/ingest/pipeline.ts
  - src/lib/config.ts
  - src/lib/types.ts
  - src/source/gmail-adapter.ts
  - src/source/source-adapter.ts
  - src/source/strip-hidden.ts
findings:
  critical: 1
  warning: 1
  info: 0
  total: 2
status: issues_found
---

# Phase 62: Code Review Report

**Reviewed:** 2026-07-29
**Depth:** deep
**Files Reviewed:** 15 (see `files_reviewed_list`; count in `findings` frontmatter reflects reviewed-with-findings scope)
**Status:** issues_found

## Summary

Reviewed all new and modified Phase 62 source files (OAuth loopback CLI, the hidden-content
stripper, the slot-preserving reorder, and the schema/pipeline/adapter plumbing that threads
`event_ts` end to end). Most of the phase is careful, well-reasoned work: the loopback OAuth
catcher's state-comparison/length-guard logic is correct and fail-closed, `parseEmailDate`'s
future-skew clamp genuinely closes the "forge a future date to sort last" attack, and
`orderEpisodesForConsolidation` is a true permutation that never moves a null-`event_ts` row
and preserves the D-03/D-10 replay-priority slot structure exactly as documented — all
verified by tracing the code and by targeted reproduction scripts, not just reading the prose.

One finding is a genuine BLOCKER: `stripHiddenContent`'s tag/attribute regexes are not
quote-aware, so a start tag whose attribute value contains a literal, unescaped `>` character
before a real `style="display:none"` (or `hidden`/`aria-hidden`/harvested class) declaration is
mis-parsed, causes the hiding signature to go undetected, and the "hidden" element's text is
left in the final stripped output as ordinary visible prose. This defeats the module's stated
purpose (EchoLeak-class indirect-injection defense) for a plausible, easy-to-construct payload,
and is not covered by the existing test suite (95/95 tests still pass with the bug present).

A second finding is a WARNING: `schema.ts`'s new `idx_episode_event_ts` index is dead on
arrival — `event_ts` is ordered entirely in application code (`orderEpisodesForConsolidation`),
and grepping the touched source confirms no SQL statement anywhere filters or orders by
`event_ts`. The file's own migration comment for this exact index already names this
possibility ("if 62-05's ordering ends up done in memory instead of in SQL, this index should
be dropped rather than left dead... the file already documents two dead indexes it later had to
remove... do not repeat that silently") — and the phase shipped precisely that outcome.

## Critical Issues

### CR-01: `stripHiddenContent` fails to detect hidden elements when an attribute value contains an unescaped `>`

**File:** `src/source/strip-hidden.ts:100` (`START_TAG_RE`), `:294-330` (`STYLE_ATTR_RE`/`isHiddenStartTag`), `:396-406` (stage 4/5 removal call sites)

**Issue:** `START_TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g` (and the sibling
`ANY_TAG_TOKEN_RE`/`ANY_TAG_RE`) captures a tag's attribute text with `[^<>]*` — a character
class that has no concept of quoted-attribute boundaries. A literal `>` character is legal
inside an HTML quoted attribute value (only `&`, and `"` within a double-quoted value,
strictly need escaping) and is common in real-world mail HTML (a `data-*` attribute, a `title`,
an `alt`, or a CSS string literal like `content:'>'`). When such a character appears in an
attribute **before** the tag's `style="display:none"` (or `hidden`/`aria-hidden="true"`/a
harvested hidden class), the regex match terminates at that embedded `>` instead of the tag's
real closing `>`. The captured `attrs` string handed to `isHiddenStartTag` (`:312-330`) is
truncated before the hiding declaration ever appears in it, so `hasHidingSignature` returns
false, the element is judged NOT hidden, and stage 5 (`:401-406`) records no removal range for
it. The orphaned tag/attribute fragments left over from the truncated match are then absorbed
by stage 6's blanket `<...>` removal, but the genuinely-hidden **text content** between the
real open and close tags is never inside any removed range and survives verbatim into the
LLM's token stream — exactly the indirect-injection vector this module exists to close.

Reproduced directly against the shipped code (not merely reasoned about):

```
input:  <div data-x="a>b" style="display:none">SECRET3</div>
output: b" style="display:none">SECRET3
```

```
input:  <div style="content:'>';display:none">HIDDEN INSTRUCTION PAYLOAD</div>
output: ';display:none">HIDDEN INSTRUCTION PAYLOAD
```

In both cases the div is genuinely `display:none` in any real HTML/CSS renderer (the embedded
`>` sits inside a properly quoted attribute value, which real browsers parse correctly), yet
the payload text is fully preserved in `stripHiddenContent`'s output. This is a distinct defect
from the two named-and-accepted residuals in the file's own doc block (white-on-white text;
externally-linked stylesheets) — it is a hole in the *inline-style/attribute* detection path
that the module explicitly claims to cover, and the 225-line test suite in
`tests/strip-hidden.test.ts` has no case with a `>` character inside a quoted attribute value,
so nothing catches it today.

**Fix:** Make the attribute-scanning regexes quote-aware so a `>` inside a quoted value cannot
prematurely terminate the tag match. Confirmed this direction resolves the reproduction above:

```ts
// Before:
const START_TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g;

// After — attrs may contain arbitrary quoted segments (including '>' and '<'),
// only an UNQUOTED '>' or '<' terminates the tag:
const START_TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)\b((?:"[^"]*"|'[^']*'|[^'"<>])*)>/g;
```

The same quote-aware attribute pattern needs to be applied to `ANY_TAG_TOKEN_RE` (used by
`findMatchingCloseEnd`) and to stage 6's `ANY_TAG_RE` so all three tag-matching regexes stay
consistent (a mismatch between them would reintroduce the same class of boundary bug between
stages). Re-run `tests/strip-hidden.test.ts` plus a new regression case with an embedded `>`
inside a quoted attribute value before `style="display:none"` to confirm the fix.

## Warnings

### WR-01: `idx_episode_event_ts` is a dead index shipped in the same migration that documented the risk

**File:** `src/db/schema.ts:280-288`

**Issue:** The v16 migration adds:

```sql
CREATE INDEX IF NOT EXISTS idx_episode_event_ts
  ON episode(consolidated, event_ts);
```

with a comment acknowledging the index is "SPECULATIVE: if 62-05's ordering ends up done in
memory instead of in SQL, this index should be dropped rather than left dead (the file already
documents two dead indexes it later had to remove... do not repeat that silently)". Plan 62-05
did land the ordering entirely in memory: `orderEpisodesForConsolidation`
(`src/consolidation/episode-order.ts`) sorts the JS array returned by
`EpisodicStore.listUnconsolidated()`, which itself still queries
`ORDER BY hard_keep DESC, salience DESC` (`src/db/episode-store.ts:131-133`) — `event_ts` never
appears in a `WHERE` or `ORDER BY` clause anywhere in the touched source (confirmed by grep
across `src/`). The index is therefore write overhead (maintained on every episode insert) with
zero read benefit, and the phase's own migration comment predicted exactly this outcome without
following through on removing it.

**Fix:** Drop the speculative index, mirroring the v5 migration's dead-index cleanup precedent:

```sql
-- v16 migration: event_ts ordering happens in application code
-- (orderEpisodesForConsolidation), not SQL — no index needed. If a future
-- change adds a SQL-level ORDER BY/WHERE on event_ts, re-add the index then.
DROP INDEX IF EXISTS idx_episode_event_ts;
```

If a genuine future need for the index emerges (e.g., a SQL-level query is added), re-introduce
it at that point rather than carrying it dark from day one.

---

_Reviewed: 2026-07-29_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
