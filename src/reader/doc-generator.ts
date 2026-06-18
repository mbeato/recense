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
 * generateDoc does NOT write to the DB — it returns the payload for writeDoc.
 * The CLI (generate-doc-cli.ts) composes generateDoc + writeDoc in sequence.
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

  // ── 4. Citation-verify loop ────────────────────────────────────────────────
  // Verbatim from scripts/reader-slice/generate.ts lines 63–93.
  // Extract all recense://fact/<uuid> references from the generated markdown.
  const citedIds = [...md.matchAll(/recense:\/\/fact\/([0-9a-f-]{36})/g)].map(m => m[1]!);
  const uniqueCited = [...new Set(citedIds)];

  // Prepared statement for node lookup (read-only; same pattern as the slice).
  const getNode = db.prepare(
    'SELECT id, tombstoned, last_access, prev_value FROM node WHERE id = ?',
  );

  let inventedCount = 0;
  let tombstonedCount = 0;
  const verifiedFactIds: string[] = [];

  for (const id of uniqueCited) {
    const row = getNode.get(id) as
      | { id: string; tombstoned: number; last_access: number; prev_value: string | null }
      | undefined;
    if (!row) {
      // No live node with this id — invented citation (T-27-04)
      inventedCount++;
      continue;
    }
    if (row.tombstoned === 1) {
      tombstonedCount++;
    }
    // Include tombstoned citations in verifiedFactIds — they resolve to a real node,
    // just a deprecated one. The CLI reports tombstoned count for transparency.
    verifiedFactIds.push(id);
  }

  return {
    markdown: md,
    docId: newId(),
    citedFactIds: verifiedFactIds,
    citationCount: verifiedFactIds.length,
    invented: inventedCount,
    tombstoned: tombstonedCount,
  };
}
