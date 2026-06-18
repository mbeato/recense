/**
 * doc-generator — facts → markdown deep-dive via judge-tier model + citation verify (READER-01).
 *
 * Inverts the extraction path (facts → doc, not doc → facts). Reuses the VERBATIM generation
 * prompt and citation-verify loop from scripts/reader-slice/generate.ts — the exact prompt that
 * produced 19/19 citations resolved, 0 invented on the validated Tonos slice.
 *
 * Design decisions:
 *  D-04: Generation uses judgeConfig as the generateConfig head — NO new docModel/genModel var.
 *        The judge slot is already the strong-tier model in any env.
 *  T-27-03: Prompt injection mitigation — "use ONLY provided facts; cite every claim" hard rule
 *            means injected instructions in a fact value cannot add uncited claims; the citation-
 *            verify loop drops any id that doesn't resolve to a real live fact node.
 *  T-27-04: Invented citation mitigation — verify loop excludes recense://fact/<id> with no
 *            live node from citedFactIds; reports invented count for the CLI to surface.
 *  T-27-05: Self-confirmation (D-43) — generateDoc is read-only; it does NOT call strengthen,
 *            setEmbedding, or markActive on gathered facts. Writing is the CLI's job.
 *
 * Truncated-id robustness (D-05 live-bug fix, 2026-06-18): production env models (e.g. the
 * local 35b judge) emit 8-char hex PREFIXES instead of full 36-char UUIDs. The verify loop
 * accepts both, resolves prefixes via UNIQUE-prefix match (ambiguous → invented), and
 * CANONICALIZES the prose so node.value / cites edges / the reader's {36} regex all agree on
 * full UUIDs. Robustness over prompt-nagging — any model may truncate, the prompt cannot prevent it.
 *
 * generateDoc does NOT write to the DB — it returns the payload for writeDoc.
 * The CLI (generate-doc-cli.ts) composes generateDoc + writeDoc in sequence; the markdown it
 * returns (and writeDoc persists) is the CANONICALIZED body, not the raw model output.
 */
import Database from 'better-sqlite3';
import { newId } from '../lib/hash';
import type { SemanticStore } from '../db/semantic-store';
import type { ModelProvider } from '../model/provider';
import { gatherFacts } from './doc-gather';

/** Injectable deps (testable without real RECENSE_DB). */
export interface GenerateDeps {
  db: Database.Database;
  store: SemanticStore;
  provider: ModelProvider;
}

/** Result returned by generateDoc (payload for writeDoc + CLI reporting). */
export interface GenerateDocResult {
  /** The generated markdown body. */
  markdown: string;
  /** Stable uuid for the doc node (caller uses as docId in writeDoc). */
  docId: string;
  /** Unique live fact IDs whose recense://fact/<id> was verified to resolve. */
  citedFactIds: string[];
  /** Count of unique live citations (invented are excluded). */
  citationCount: number;
  /** Count of cited IDs with no live fact node (hallucinated citations). */
  invented: number;
  /** Count of cited IDs that resolved but are tombstoned. */
  tombstoned: number;
}

/**
 * Gather facts for slug, generate a markdown deep-dive via the judge-tier model,
 * verify every citation, and return the result payload.
 *
 * Does NOT write to the DB — this is a pure data-transformation pipeline.
 * The caller (CLI) is responsible for composing with writeDoc if it wants to persist.
 *
 * @param deps  Injected DB + store + provider.
 * @param slug  Project slug to generate a doc for.
 * @param opts  Optional tuning.
 * @param opts.semanticK  Max semantic gather hits (passed to gatherFacts).
 */
export async function generateDoc(
  deps: GenerateDeps,
  slug: string,
  opts: { semanticK?: number } = {},
): Promise<GenerateDocResult> {
  const { db, store, provider } = deps;

  // ── 1. Gather facts ────────────────────────────────────────────────────────
  const facts = await gatherFacts({ db, store, provider }, slug, { semanticK: opts.semanticK });

  // Build the factBlock: one line per fact, format "[<uuid>] <value>" (verbatim from slice)
  const factBlock = facts.map(f => `[${f.id}] ${f.value}`).join('\n');

  // ── 2. Build generation prompt ─────────────────────────────────────────────
  // Verbatim from scripts/reader-slice/generate.ts lines 30–45.
  // This exact prompt produced 19/19 resolved citations, 0 invented on the Tonos slice.
  const prompt = `You are generating a human-readable PROJECT DEEP-DIVE from a set of atomic memory facts.

You are given FACTS about "${slug}". Each line is: [<uuid>] <fact text>

FACTS:
${factBlock}

Write a structured markdown deep-dive about "${slug}". Use only the sections the facts can support (e.g. One-liner, Infrastructure, Pipelines/Operations, State, Open questions).

HARD RULES:
1. Every substantive claim MUST cite the fact id(s) it draws from, inline, as a markdown link: [the cited phrase](recense://fact/<uuid>). Use the exact uuid from the bracket.
2. Use ONLY the provided facts. Do NOT add any outside knowledge or invent details. If you cannot cite it from a fact above, do not write it.
3. If facts conflict, note the conflict and cite both.
4. Prefer specific, interview-defensible detail over generic prose.

Output ONLY the markdown deep-dive, no preamble.`;

  // ── 3. Generate via judge-tier model (D-04) ────────────────────────────────
  // D-04: use provider.generate directly (the provider's generateConfig is set to judgeConfig
  // by the CLI caller via DefaultModelProvider({ generateConfig: judgeConfig, ... })).
  // No new docModel/genModel config var.
  const md = await provider.generate(prompt, { maxTokens: 4000 });

  // ── 3b. Fail loud on empty output — NEVER persist an empty doc ──────────────
  // The headless `claude -p` client returns EMPTY content on timeout / non-zero exit /
  // spawn failure (its production fail-safe, which the sleep pass relies on). For doc-gen,
  // an empty body is a hard failure — not a valid doc — and must NOT be persisted as a
  // silent "successful" 0-citation node. Throw so the CLI's catch logs it and exits
  // non-zero; the existing doc node (if any) is left untouched. (The CLI also raises the
  // headless timeout to 600s to make a real timeout unlikely; this is the backstop.)
  if (md.trim().length === 0) {
    throw new Error(
      'doc generation returned empty output (likely a headless timeout or subprocess failure) — not persisting',
    );
  }

  // ── 4. Citation-verify + canonicalize loop ─────────────────────────────────
  // Extract all recense://fact/<id> references. The slice's Sonnet emitted full
  // 36-char UUIDs (19/19), but production env models (e.g. the local 35b judge)
  // TRUNCATE ids to an 8+-char hex prefix (e.g. recense://fact/e751c852). A strict
  // {36} regex silently drops every truncated ref → 0 verified, 0 cites edges. So we
  // accept BOTH a full UUID and an 8+-char prefix, resolve via exact-then-unique-prefix,
  // and CANONICALIZE the prose so node.value / cites edges / the reader's {36} regex
  // (27-03) all agree on full UUIDs. Robustness over prompt-nagging — any model may truncate.
  const FACT_REF = /recense:\/\/fact\/([0-9a-f][0-9a-f-]{6,35})/g;
  const citedRaw = [...md.matchAll(FACT_REF)].map(m => m[1]!);
  const uniqueCited = [...new Set(citedRaw)];

  // Resolution statements (read-only):
  //  - exact: direct id match (full UUID case)
  //  - prefix: id LIKE '<prefix>%' — must return EXACTLY one live row to be unambiguous.
  //    LIMIT 2 lets us detect ambiguity (>1 prefix match) cheaply.
  const getNodeExact = db.prepare(
    'SELECT id, tombstoned FROM node WHERE id = ?',
  );
  const getNodeByPrefix = db.prepare(
    'SELECT id, tombstoned FROM node WHERE id LIKE ? LIMIT 2',
  );

  let inventedCount = 0;
  let tombstonedCount = 0;
  const verifiedFactIds: string[] = [];
  // raw-cited-id → canonical full id, for prose rewrite (only for resolved refs).
  const canonical = new Map<string, string>();

  for (const raw of uniqueCited) {
    // 1. Exact match first (full UUID, or an id that happens to equal the raw string).
    let row = getNodeExact.get(raw) as { id: string; tombstoned: number } | undefined;

    // 2. Else unique-prefix match. Escape LIKE metacharacters in the prefix so a literal
    //    match is used (ids are hex+dashes, but guard against '%'/'_' defensively).
    if (!row) {
      const likePattern = raw.replace(/[%_]/g, '') + '%';
      const matches = getNodeByPrefix.all(likePattern) as Array<{ id: string; tombstoned: number }>;
      if (matches.length === 1) {
        row = matches[0];
      }
      // matches.length === 0 → invented; matches.length > 1 → ambiguous → invented.
    }

    if (!row) {
      // No live node, or ambiguous prefix → invented citation (T-27-04).
      inventedCount++;
      continue;
    }

    if (row.tombstoned === 1) {
      tombstonedCount++;
    }
    // Resolved (incl. tombstoned) → record canonical full id + verify.
    canonical.set(raw, row.id);
    verifiedFactIds.push(row.id);
  }

  // ── 5. Canonicalize the prose ──────────────────────────────────────────────
  // Rewrite each resolved recense://fact/<raw> link to its full canonical UUID so the
  // persisted node.value, the cites edges, and the reader's {36} regex all agree.
  // Replace the COMPLETE recense://fact/<id> token (not a bare substring) to avoid
  // mangling a prefix that is a substring of another id elsewhere in the prose.
  const canonicalMarkdown = md.replace(FACT_REF, (whole, rawId: string) => {
    const full = canonical.get(rawId);
    return full ? `recense://fact/${full}` : whole; // leave invented refs untouched
  });

  // verifiedFactIds may contain duplicates if two different truncations resolved to the
  // same canonical node — dedup so citationCount and cites edges count unique facts.
  const uniqueVerified = [...new Set(verifiedFactIds)];

  return {
    markdown: canonicalMarkdown,
    docId: newId(),
    citedFactIds: uniqueVerified,
    citationCount: uniqueVerified.length,
    invented: inventedCount,
    tombstoned: tombstonedCount,
  };
}
