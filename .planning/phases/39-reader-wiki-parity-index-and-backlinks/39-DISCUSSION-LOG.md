# Phase 39: Reader Wiki-Parity — Browsable Index + Surfaced Backlinks - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-21
**Phase:** 39-reader-wiki-parity-index-and-backlinks
**Areas discussed:** Index form, Index layout, Backlink scope, Backlink UI, Index entry point

---

## Index form (WIKI-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Live `/index` route | Server route runs compiled `stmtDocNodes` at request time; always fresh, 0 LLM, 0 write-path; not a node | ✓ |
| Generated index doc node | Real `type='doc'` node, in corpus graph + citable, but adds write-path + LLM regen + can go stale | |
| Hybrid: route + corpus graph | Live route for text list; existing 2D corpus graph as visual index | |

**User's choice:** Live `/index` route.
**Notes:** User hadn't pre-formed an opinion but warmed to the live route after measuring cost. Grounded with live numbers: 23 doc nodes / 8,806 total; the index query is sub-ms over 23 rows, ~400× smaller than the all-nodes payload `/graph` already ships every load; zero LLM. The live route is the *cheaper and cleaner* option, not a compromise — strictly less work than existing viz behavior, and the only one with zero WIKI-03 (write-path) tension.

---

## Index layout (WIKI-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Grouped by scope | Sections: Projects (e.g. tonos) + Schemas (22 schema-anchored docs, labeled via COALESCE) | ✓ |
| Flat list, alphabetical | One A→Z list by resolved label; mixes project doc among schema docs | |
| Flat list, recency-sorted | One list, newest generated_at first | |

**User's choice:** Grouped by scope.
**Notes:** Driven by a data finding surfaced during the cost check — of 23 live docs, only `tonos` has a human-readable scope; the other 22 are schema-anchored with UUID scopes. A flat list reads as 22 loose UUID-ish rows; grouping clusters the schema docs under a readable header (labels via the existing `COALESCE(schema.value, slug)`).

---

## Backlink scope (WIKI-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Docs + citing facts | Doc view: incoming doc→doc links; atom view: docs that cite the fact (reverse `cites` edge) — covers "doc or atom" clause | ✓ |
| Doc→doc links only | Only incoming edges from other doc nodes; ignores the "or atom" clause | |
| All incoming edges | Every `getInEdges` edge regardless of kind — noisy, mixes engine edges | |

**User's choice:** Docs + citing facts.
**Notes:** Reuses the existing reverse-`cites` walk from the Phase 27 staleness path for the atom case. 41 live doc→doc edges back the doc case. "All incoming edges" rejected as noise (would surface `derived_from` / schema-membership engine edges in a browsing surface).

---

## Backlink UI (WIKI-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Section at end of doc | "Referenced by" block appended below doc body, styled like the staleness banner (muted rose/slate) | ✓ |
| Collapsible side panel | Right-side "what links here" panel; adds a new layout region | |
| Inline in atom detail panel | Backlinks only in detail.js atom panel; nothing on doc body | |

**User's choice:** Section at end of doc.
**Notes:** Reads top-to-bottom like a wiki; reuses the staleness-banner visual + fetch precedent; no new layout region; muted palette (not amber).

---

## Index entry point (WIKI-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Toolbar button, like `#btn-corpus` | `#btn-index` sibling button opens the `/index` list | ✓ |
| Route only (no button) | `/index` exists/linkable but no toolbar affordance | |
| Button + every-doc link | Toolbar button plus a "back to index" link in every doc header | |

**User's choice:** Toolbar button, like `#btn-corpus`.
**Notes:** Matches the existing corpus-view precedent; discoverable; minimal viz change beyond the one button.

## Claude's Discretion

- Exact module placement (`modules/index.js` vs folding into existing), `/index` response shape, and CSS class naming — follow corpus.js / staleness-banner precedents.

## Deferred Ideas

- Markdown export of docs (LLM-Wiki gap #3) — roadmap-level deferral; recall + reader replace grep.
- Index as a real doc node (corpus-graph citizen, citable, regenerable) — rejected on WIKI-03 grounds; would be its own future phase.
