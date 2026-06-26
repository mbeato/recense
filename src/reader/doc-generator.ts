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
 *
 * Schema-thesis path (CORPUS-01, Plan 28-02): buildSchemaDocPrompt + generateDocForSchema
 * add a schema-anchored generation path. The schema's generalization is the thesis; its
 * abstracted facts/entities are the evidence. The FACT_REF citation-verify + canonicalize loop
 * and the empty-output throw guard are shared between the scope and schema paths via the
 * internal verifyCitations() helper — NOT duplicated.
 */
import Database from 'better-sqlite3';
import { newId } from '../lib/hash';
import type { SemanticStore } from '../db/semantic-store';
import type { ModelProvider } from '../model/provider';
import { gatherFacts, gatherFactsForSchema, gatherFactsForSubject, gatherNeighborDocs } from './doc-gather';
import type { GatherSchemaParams, GatherSubjectParams, SiblingDoc } from './doc-gather';

// ── Shared citation-verify + canonicalize helper ──────────────────────────
//
// Factored out of generateDoc so the schema path (generateDocForSchema) can
// reuse it without duplicating the FACT_REF regex or the resolution logic.
// The helper is intentionally NOT exported (internal implementation detail).
//
// The single definition of the FACT_REF regex here is the authoritative one
// referenced by both scope and schema generation paths. Do NOT add a second
// FACT_REF definition in this file.

/** Internal result of the citation-verify + doc-ref resolve pass. */
interface VerifyResult {
  /** Prose rewritten to canonical full UUIDs for both fact and doc refs. */
  canonicalMarkdown: string;
  /** Unique fact node ids whose recense://fact/<id> verified to a live node. */
  uniqueVerified: string[];
  inventedCount: number;
  tombstonedCount: number;
  /** Unique live doc node ids resolved from recense://doc/<id> refs in the prose. */
  linkedDocRefs: string[];
}

/**
 * Shared citation-verify + doc-ref canonicalize pass.
 *
 * 1. Extract recense://fact/<id> refs from `md`; resolve via exact-then-unique-prefix
 *    against live node rows; canonicalize prose to full UUIDs; count invented/tombstoned.
 * 2. Extract recense://doc/<id> refs; resolve against live doc nodes; canonicalize prose.
 *
 * All SQL is read-only (T-28-SC). No DB writes.
 */
function verifyCitations(db: Database.Database, md: string): VerifyResult {
  // ── Fact citations ───────────────────────────────────────────────────────
  // Accept both full 36-char UUIDs and 8+-char hex prefixes (D-05 robustness).
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

  // Rewrite each resolved recense://fact/<raw> link to its full canonical UUID so the
  // persisted node.value, the cites edges, and the reader's {36} regex all agree.
  // Replace the COMPLETE recense://fact/<id> token (not a bare substring) to avoid
  // mangling a prefix that is a substring of another id elsewhere in the prose.
  const canonicalMarkdown = md.replace(FACT_REF, (_whole, rawId: string) => {
    const full = canonical.get(rawId);
    return full ? `recense://fact/${full}` : _whole; // leave invented refs untouched
  });

  // verifiedFactIds may contain duplicates if two different truncations resolved to the
  // same canonical node — dedup so citationCount and cites edges count unique facts.
  const uniqueVerified = [...new Set(verifiedFactIds)];

  // ── Doc citations ────────────────────────────────────────────────────────
  // doc-refs are resolved EXACTLY like fact-refs: the model may TRUNCATE doc ids the same
  // way it truncates fact ids. We resolve each ref by exact id then UNIQUE-PREFIX against
  // LIVE (tombstoned=0) type='doc' nodes; ambiguous/unknown refs are DROPPED (no edge,
  // like invented fact-refs). Resolved refs are CANONICALIZED in the prose to the full doc
  // id so node.value, the doc_link edges, AND the reader's ?id= click all agree on full ids.
  const DOC_REF = /recense:\/\/doc\/([a-z0-9-]+)/g;
  const rawDocRefs = [...new Set([...canonicalMarkdown.matchAll(DOC_REF)].map(m => m[1]!))];

  // Resolution statements scoped to LIVE doc nodes only (in-set guard at the source).
  const getDocExact = db.prepare(
    "SELECT id FROM node WHERE id = ? AND type = 'doc' AND tombstoned = 0",
  );
  const getDocByPrefix = db.prepare(
    "SELECT id FROM node WHERE id LIKE ? AND type = 'doc' AND tombstoned = 0 LIMIT 2",
  );

  // raw doc-ref → canonical full doc id (only for refs that resolve to a live doc).
  const docCanonical = new Map<string, string>();
  const resolvedDocIds: string[] = [];
  for (const raw of rawDocRefs) {
    let row = getDocExact.get(raw) as { id: string } | undefined;
    if (!row) {
      const likePattern = raw.replace(/[%_]/g, '') + '%';
      const matches = getDocByPrefix.all(likePattern) as Array<{ id: string }>;
      if (matches.length === 1) row = matches[0];
      // 0 matches → unknown; >1 → ambiguous. Both DROP the ref (no edge).
    }
    if (!row) continue; // dangling/ambiguous doc-ref → not linked
    docCanonical.set(raw, row.id);
    resolvedDocIds.push(row.id);
  }

  // Rewrite each resolved recense://doc/<raw> link to its full canonical doc id so the
  // persisted prose, the doc_link edges, and the reader's ?id= click all agree.
  const fullyCanonicalMarkdown = canonicalMarkdown.replace(DOC_REF, (_whole, rawId: string) => {
    const full = docCanonical.get(rawId);
    return full ? `recense://doc/${full}` : _whole; // leave unresolved refs untouched
  });

  // Dedup: two truncations of the same doc → one edge.
  const linkedDocRefs = [...new Set(resolvedDocIds)];

  return {
    canonicalMarkdown: fullyCanonicalMarkdown,
    uniqueVerified,
    inventedCount,
    tombstonedCount,
    linkedDocRefs,
  };
}

// ── Shared "related docs" block builder ──────────────────────────────────

function buildRelatedDocsBlock(siblings: SiblingDoc[]): string {
  if (siblings.length === 0) return '';
  return `\n\nRELATED DOCS (deep-dives connected to this one — chapters, subjects, and project hubs): each line is [<docId>] <slug>: <title>.
${siblings.map(s => `[${s.id}] ${s.slug}: ${s.title}`).join('\n')}

When the prose discusses a topic that one of these related docs covers, link to it INLINE at the first point you mention that topic, written as [the phrase in context](recense://doc/<docId>) using the EXACT id above. Weave the links into the sentences themselves — do NOT collect them into a trailing "related"/"references" section. Only link a doc that genuinely relates to what you are writing; never invent a link or an id.`;
}

// ── Prompt builders ───────────────────────────────────────────────────────

/**
 * Build the doc-generation prompt for a project scope (factored out for testability — READER-04).
 *
 * Includes a RELATED DOCS block listing the OTHER live deep-dives so the model can
 * cross-link to them with `recense://doc/<id>` refs (which become doc_link edges). The
 * block is OMITTED entirely when there are no sibling docs (don't confuse the model).
 *
 * @param slug      The project slug being generated.
 * @param factBlock Pre-formatted "[<uuid>] <fact>" lines.
 * @param siblings  Other live docs the model may link to (may be empty).
 */
export function buildDocPrompt(slug: string, factBlock: string, siblings: SiblingDoc[]): string {
  const relatedBlock = buildRelatedDocsBlock(siblings);

  return `You are generating a human-readable PROJECT DEEP-DIVE from a set of atomic memory facts.

You are given FACTS about "${slug}". Each line is: [<uuid>] <fact text>

FACTS:
${factBlock}${relatedBlock}

Write a structured markdown deep-dive about "${slug}". Use only the sections the facts can support (e.g. One-liner, Infrastructure, Pipelines/Operations, State, Open questions).

HARD RULES:
1. Every substantive claim MUST cite the fact id(s) it draws from, inline, as a markdown link: [the cited phrase](recense://fact/<uuid>). Use the exact uuid from the bracket.
2. Use ONLY the provided facts. Do NOT add any outside knowledge or invent details. If you cannot cite it from a fact above, do not write it.
3. If facts conflict, note the conflict and cite both.
4. Prefer specific, interview-defensible detail over generic prose.

Output ONLY the markdown deep-dive, no preamble.`;
}

/**
 * Build the doc-generation prompt for a schema-anchored doc (CORPUS-01, D-09).
 *
 * Frames the schema's human label as the THESIS: the schema IS the generalization (the
 * abstraction the brain formed from its evidence). The abstracted facts below are the
 * evidence — the body of the doc must demonstrate the generalization, citing every claim.
 *
 * Reuses the same HARD RULES and RELATED DOCS block as buildDocPrompt so all generation
 * paths share identical citation behaviour and doc-link semantics.
 *
 * @param schemaLabel  Human-readable label of the schema (the thesis).
 * @param factBlock    Pre-formatted "[<uuid>] <fact>" lines (schema's evidence).
 * @param siblings     Other live docs the model may link to (may be empty).
 */
export function buildSchemaDocPrompt(
  schemaLabel: string,
  factBlock: string,
  siblings: SiblingDoc[],
): string {
  const relatedBlock = buildRelatedDocsBlock(siblings);

  return `You are generating a human-readable SCHEMA DEEP-DIVE from a set of atomic memory facts.

This deep-dive's thesis is a generalization that the memory engine abstracted from experience:
"${schemaLabel}"

The FACTS below are the evidence this generalization was abstracted from. Each line is: [<uuid>] <fact text>

FACTS:
${factBlock}${relatedBlock}

Write a structured markdown deep-dive whose thesis is the generalization above. Every section should demonstrate, explain, or elaborate on that thesis using the evidence facts. Use only the sections the facts can support (e.g. Core Pattern, Examples, Implications, Open Questions).

HARD RULES:
1. Every substantive claim MUST cite the fact id(s) it draws from, inline, as a markdown link: [the cited phrase](recense://fact/<uuid>). Use the exact uuid from the bracket.
2. Use ONLY the provided facts. Do NOT add any outside knowledge or invent details. If you cannot cite it from a fact above, do not write it.
3. If facts conflict, note the conflict and cite both.
4. Prefer specific, interview-defensible detail over generic prose.

Output ONLY the markdown deep-dive, no preamble.`;
}

// ── Type definitions ──────────────────────────────────────────────────────

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
  /**
   * Unique target doc node IDs parsed from recense://doc/<id> refs in the generated prose.
   * Only IDs that appear in the markdown are returned here — writeDoc is responsible for
   * filtering to live nodes (dangling refs are skipped FK-safely inside the transaction).
   */
  linkedDocRefs: string[];
}

// ── Generation functions ──────────────────────────────────────────────────

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
  opts: { semanticK?: number; onPhase?: (phase: string) => void } = {},
): Promise<GenerateDocResult> {
  const { db, store, provider } = deps;

  // ── 1. Gather facts + sibling docs ─────────────────────────────────────────
  opts.onPhase?.('gathering');
  const facts = await gatherFacts({ db, store, provider }, slug, { semanticK: opts.semanticK });

  // Build the factBlock: one line per fact, format "[<uuid>] <value>" (verbatim from slice)
  const factBlock = facts.map(f => `[${f.id}] ${f.value}`).join('\n');

  // Gather this doc's GRAPH-NEIGHBOR docs (containment/reference) as inline-link candidates
  // (Feature B). Feeding only genuinely-related neighbors — not every doc — is what lets the
  // model link sibling chapters inline in context instead of treating links as a trailing list.
  const siblingDocs = gatherNeighborDocs(db, slug);

  // ── 2. Build generation prompt (incl. RELATED DOCS block when siblings exist) ──
  const prompt = buildDocPrompt(slug, factBlock, siblingDocs);

  // ── 3. Generate via judge-tier model (D-04) ────────────────────────────────
  // D-04: use provider.generate directly (the provider's generateConfig is set to judgeConfig
  // by the CLI caller via DefaultModelProvider({ generateConfig: judgeConfig, ... })).
  // No new docModel/genModel config var.
  opts.onPhase?.('generating');
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

  // ── 4. Citation-verify + canonicalize (shared helper — NOT duplicated) ────
  opts.onPhase?.('verifying');
  const verified = verifyCitations(db, md);

  return {
    markdown: verified.canonicalMarkdown,
    docId: newId(),
    citedFactIds: verified.uniqueVerified,
    citationCount: verified.uniqueVerified.length,
    invented: verified.inventedCount,
    tombstoned: verified.tombstonedCount,
    linkedDocRefs: verified.linkedDocRefs,
  };
}

// ── Hub + Subject prompt builders (Phase 39.1, D-01/D-04) ────────────────────

/**
 * Build the doc-generation prompt for a project hub (D-04: synthesized overview + linked index).
 *
 * The hub prompt augments buildDocPrompt with a SUBJECT DOCS section that lists each
 * subjectDoc as a `recense://doc/<docId>` ref (NOT a bare name string). This is load-bearing
 * for D-04 navigability: verifyCitations resolves these refs into linkedDocRefs, and
 * writeDoc (Plan 02/03) turns them into doc_link edges — a bare name produces prose, not links.
 *
 * Resolution notes:
 *  - subjectDocs entries with {name, docId} are passed ALREADY resolved by the caller
 *    (the generator supplies docIds, not slugs, because they come from node_doc.node_id).
 *  - The model is instructed to emit ONE index line per subject, formatted exactly as
 *    a recense://doc/<docId> ref so verifyCitations can extract them.
 *  - Full subject doc bodies are NOT included in the prompt (Open Question 2 — names + one
 *    summary line only). Hub provides navigation-layer overview; subjects hold the depth.
 *
 * @param scope       Project scope slug (e.g. 'brain-memory').
 * @param factBlock   Pre-formatted "[<uuid>] <fact>" lines.
 * @param siblings    Other live docs the model may link to (may be empty).
 * @param subjectDocs Resolved subject docs { name: string; docId: string }[].
 */
export function buildHubDocPrompt(
  scope: string,
  factBlock: string,
  siblings: SiblingDoc[],
  subjectDocs: Array<{ name: string; docId: string }>,
): string {
  // Exclude the index-listed subjects from the related block so a chapter isn't double-listed
  // (it already appears, with its link form, in the SUBJECT DOCS index below). The related
  // block then carries only the hub's OTHER neighbors (e.g. cross-project references).
  const indexedIds = new Set(subjectDocs.map(s => s.docId));
  const relatedBlock = buildRelatedDocsBlock(siblings.filter(s => !indexedIds.has(s.id)));

  const subjectIndexBlock = subjectDocs.length > 0
    ? `\n\nSUBJECT DOCS (named deep-dives for this project — MUST link to each using recense://doc/<docId>):
${subjectDocs.map(s => `  [${s.docId}] ${s.name}`).join('\n')}

When writing the index section, include ONE line per subject formatted EXACTLY as:
  [subject name](recense://doc/<docId>)
using the exact docId shown above. Do NOT write bare subject names without a recense://doc/ link — the link is how this index becomes navigable.
Additionally, when the OVERVIEW prose first discusses a subject's topic, link that subject INLINE in the sentence (same [name](recense://doc/<docId>) form) — the subjects must appear inline in context, not only collected in the index list.`
    : '';

  return `You are generating a human-readable PROJECT HUB OVERVIEW from a set of atomic memory facts.

You are given FACTS about "${scope}". Each line is: [<uuid>] <fact text>

FACTS:
${factBlock}${relatedBlock}${subjectIndexBlock}

Write a structured markdown hub overview about "${scope}". The hub must include:
1. A synthesized overview section: what this project is, its key purpose, current state.
2. An index section listing each subject deep-dive with a navigable recense://doc/<docId> link.

Use only the sections the facts can support.

HARD RULES:
1. Every substantive claim MUST cite the fact id(s) it draws from, inline, as a markdown link: [the cited phrase](recense://fact/<uuid>). Use the exact uuid from the bracket.
2. Use ONLY the provided facts. Do NOT add any outside knowledge or invent details. If you cannot cite it from a fact above, do not write it.
3. If facts conflict, note the conflict and cite both.
4. Prefer specific, interview-defensible detail over generic prose.
5. Each subject doc MUST appear in the index as a recense://doc/<docId> link (NOT a bare name). Missing a subject or using a bare name is a defect.

Output ONLY the markdown hub overview, no preamble.`;
}

/**
 * Build the doc-generation prompt for a subject doc (D-02: LLM-named, content-driven).
 *
 * Mirrors buildSchemaDocPrompt but frames subjectName (NOT a schema UUID label) as the
 * thesis. The subject name is a human-readable content-driven name (e.g. "sleep pass",
 * "retrieval", "config") proposed by the subject-naming LLM call in the promoter.
 *
 * @param scope       Project scope slug.
 * @param subjectName Human-readable subject name (e.g. 'retrieval', 'sleep pass').
 * @param factBlock   Pre-formatted "[<uuid>] <fact>" lines.
 * @param siblings    Other live docs the model may link to (may be empty).
 */
export function buildSubjectDocPrompt(
  scope: string,
  subjectName: string,
  factBlock: string,
  siblings: SiblingDoc[],
): string {
  const relatedBlock = buildRelatedDocsBlock(siblings);

  return `You are generating a human-readable SUBJECT DEEP-DIVE from a set of atomic memory facts.

This deep-dive's thesis is a named subject area for the project "${scope}":
"${subjectName}"

The FACTS below are the evidence for this subject. Each line is: [<uuid>] <fact text>

FACTS:
${factBlock}${relatedBlock}

Write a structured markdown deep-dive whose thesis is the subject above. Every section should demonstrate, explain, or elaborate on that subject using the evidence facts. Use only the sections the facts can support (e.g. Core Concepts, How It Works, Key Decisions, Open Questions).

HARD RULES:
1. Every substantive claim MUST cite the fact id(s) it draws from, inline, as a markdown link: [the cited phrase](recense://fact/<uuid>). Use the exact uuid from the bracket.
2. Use ONLY the provided facts. Do NOT add any outside knowledge or invent details. If you cannot cite it from a fact above, do not write it.
3. If facts conflict, note the conflict and cite both.
4. Prefer specific, interview-defensible detail over generic prose.

Output ONLY the markdown deep-dive, no preamble.`;
}

// ── Hub + Subject generation functions (Phase 39.1, D-01/D-04) ───────────────

/**
 * Generate a project hub doc (D-04: synthesized overview + linked subject index).
 *
 * Hub-specific behavior:
 *  - The hub markdown MUST contain a recense://doc/<docId> ref per subjectDocs entry
 *    so verifyCitations populates linkedDocRefs and writeDoc (Plan 02/03) writes a
 *    doc_link edge per subject — bare subject name strings produce prose, not links.
 *  - Throws on empty model output (same guard as generateDoc — never persists an empty hub).
 *
 * Read-only: no strengthen, setEmbedding, or markActive (T-28-SC invariant).
 *
 * @param deps        Injected DB + store + provider.
 * @param scope       Project scope slug (e.g. 'brain-memory').
 * @param subjectDocs Resolved subject docs { name, docId }[] for the linked index.
 * @param opts        Optional tuning.
 */
export async function generateDocForHub(
  deps: GenerateDeps,
  scope: string,
  subjectDocs: Array<{ name: string; docId: string }>,
  opts: { semanticK?: number } = {},
): Promise<GenerateDocResult> {
  const { db, store, provider } = deps;

  // ── 1. Gather facts + sibling docs ────────────────────────────────────────
  const facts = await gatherFacts({ db, store, provider }, scope, { semanticK: opts.semanticK });
  const factBlock = facts.map(f => `[${f.id}] ${f.value}`).join('\n');
  // Graph-neighbor docs (Feature B) — the hub's chapter children + cross-project references.
  // buildHubDocPrompt excludes the index-listed subjects so they aren't double-listed.
  const siblingDocs = gatherNeighborDocs(db, scope);

  // ── 2. Build hub prompt (overview + navigable subject index) ──────────────
  const prompt = buildHubDocPrompt(scope, factBlock, siblingDocs, subjectDocs);

  // ── 3. Generate via judge-tier model ──────────────────────────────────────
  const md = await provider.generate(prompt, { maxTokens: 4000 });

  // ── 3b. Fail loud on empty output — NEVER persist an empty hub doc ─────────
  if (md.trim().length === 0) {
    throw new Error(
      'hub doc generation returned empty output (likely a headless timeout or subprocess failure) — not persisting',
    );
  }

  // ── 4. Citation-verify + canonicalize (shared helper — NOT duplicated) ────
  // verifyCitations also extracts linkedDocRefs from recense://doc/<id> refs in the
  // markdown — these are what writeDoc (Plan 02/03) turns into doc_link edges.
  const verified = verifyCitations(db, md);

  return {
    markdown: verified.canonicalMarkdown,
    docId: newId(),
    citedFactIds: verified.uniqueVerified,
    citationCount: verified.uniqueVerified.length,
    invented: verified.inventedCount,
    tombstoned: verified.tombstonedCount,
    linkedDocRefs: verified.linkedDocRefs,
  };
}

/**
 * Generate a subject doc (D-02: LLM-named, content-driven subject deep-dive).
 *
 * Subject-specific behavior:
 *  - Gathers facts via gatherFactsForSubject (union of abstracts members across schemaIds).
 *  - Frames subjectName (NOT a schema UUID label) as the thesis (D-02).
 *  - Same citation-verify + empty-guard + GenerateDocResult shape as all generators.
 *
 * Read-only: no strengthen, setEmbedding, or markActive (T-28-SC invariant).
 *
 * @param deps    Injected DB + store + provider.
 * @param params  Subject identity: scope, subjectName, schemaIds, and optional centroid.
 * @param opts    Optional tuning (semanticK passed to gatherFactsForSubject).
 */
export async function generateDocForSubject(
  deps: GenerateDeps,
  params: { scope: string; subjectName: string; schemaIds: string[] } & Partial<Pick<GatherSubjectParams, 'centroid'>>,
  opts: { semanticK?: number } = {},
): Promise<GenerateDocResult> {
  const { db, store, provider } = deps;
  const { scope, subjectName, schemaIds, centroid = null } = params;

  // ── 1. Gather facts via subject's schema set ───────────────────────────────
  // gatherFactsForSubject: union of abstracts members across ALL schemaIds, D-37-gated.
  const facts = await gatherFactsForSubject(
    { db, store, provider },
    { schemaIds, centroid, subjectName },
    { semanticK: opts.semanticK },
  );

  const factBlock = facts.map(f => `[${f.id}] ${f.value}`).join('\n');

  // Graph-neighbor docs (Feature B) — this subject's hub parent + sibling-subject references,
  // resolved by the subject's own slug ('scope:name'). When the doc graph hasn't been derived
  // yet (or the stub doesn't exist), gatherNeighborDocs returns [] and the block is omitted.
  const siblingDocs = gatherNeighborDocs(db, `${scope}:${subjectName}`);

  // ── 2. Build subject-thesis prompt ────────────────────────────────────────
  const prompt = buildSubjectDocPrompt(scope, subjectName, factBlock, siblingDocs);

  // ── 3. Generate via judge-tier model ──────────────────────────────────────
  const md = await provider.generate(prompt, { maxTokens: 4000 });

  // ── 3b. Fail loud on empty output ─────────────────────────────────────────
  if (md.trim().length === 0) {
    throw new Error(
      'subject doc generation returned empty output (likely a headless timeout or subprocess failure) — not persisting',
    );
  }

  // ── 4. Citation-verify + canonicalize (shared helper — NOT duplicated) ────
  const verified = verifyCitations(db, md);

  return {
    markdown: verified.canonicalMarkdown,
    docId: newId(),
    citedFactIds: verified.uniqueVerified,
    citationCount: verified.uniqueVerified.length,
    invented: verified.inventedCount,
    tombstoned: verified.tombstonedCount,
    linkedDocRefs: verified.linkedDocRefs,
  };
}

/**
 * Schema-anchored generation path (CORPUS-01, Plan 28-02).
 *
 * Like generateDoc but re-anchored to a schema node (D-09):
 *  - Gathers facts via gatherFactsForSchema (evidence-spine + centroid-seeded semantic + entity-hop)
 *  - Builds the prompt via buildSchemaDocPrompt (thesis = schema's generalization)
 *  - Runs the EXACT same citation-verify + canonicalize + empty-guard core via verifyCitations()
 *  - Returns the same GenerateDocResult shape (compatible with writeDoc, the CLI, and the reader)
 *
 * Self-confirmation guard (T-28-SC): read-only like generateDoc — no strengthen, setEmbedding,
 * or any write on source schema or its facts. The caller (CLI) composes with writeDoc.
 *
 * @param deps    Injected DB + store + provider.
 * @param params  Schema identity: id, label, and precomputed centroid (null → skip semantic).
 * @param opts    Optional tuning (semanticK passed to gatherFactsForSchema).
 */
export async function generateDocForSchema(
  deps: GenerateDeps,
  params: GatherSchemaParams & { schemaLabel: string },
  opts: { semanticK?: number; onPhase?: (phase: string) => void } = {},
): Promise<GenerateDocResult> {
  const { db, store, provider } = deps;

  // ── 1. Gather facts + sibling docs ────────────────────────────────────────
  // Uses gatherFactsForSchema (not gatherFacts): spine = abstracts-edges from schemaId.
  opts.onPhase?.('gathering');
  const facts = await gatherFactsForSchema(
    { db, store, provider },
    { schemaId: params.schemaId, centroid: params.centroid, schemaLabel: params.schemaLabel },
    { semanticK: opts.semanticK },
  );

  const factBlock = facts.map(f => `[${f.id}] ${f.value}`).join('\n');

  // Graph-neighbor docs (Feature B) — the schema-chapter's containment/reference neighbors,
  // resolved by its slug (= schemaId). Excludes its own node; [] when no graph derived yet.
  const siblingDocs = gatherNeighborDocs(db, params.schemaId);

  // ── 2. Build schema-thesis prompt ──────────────────────────────────────────
  const prompt = buildSchemaDocPrompt(params.schemaLabel, factBlock, siblingDocs);

  // ── 3. Generate via judge-tier model ──────────────────────────────────────
  opts.onPhase?.('generating');
  const md = await provider.generate(prompt, { maxTokens: 4000 });

  // ── 3b. Fail loud on empty output — guard preserved from scope path ────────
  if (md.trim().length === 0) {
    throw new Error(
      'doc generation returned empty output (likely a headless timeout or subprocess failure) — not persisting',
    );
  }

  // ── 4. Citation-verify + canonicalize (shared helper — NOT duplicated) ────
  opts.onPhase?.('verifying');
  const verified = verifyCitations(db, md);

  return {
    markdown: verified.canonicalMarkdown,
    docId: newId(),
    citedFactIds: verified.uniqueVerified,
    citationCount: verified.uniqueVerified.length,
    invented: verified.inventedCount,
    tombstoned: verified.tombstonedCount,
    linkedDocRefs: verified.linkedDocRefs,
  };
}
