/**
 * Reader-slice GENERATE + VERIFY step (THROWAWAY / de-risk).
 *
 * Inverts the existing extraction path (facts → doc, not doc → facts):
 *   1. Read the gathered fact-set JSON (from gather.ts).
 *   2. Prompt the real ModelProvider (Anthropic, Sonnet) to write a deep-dive that
 *      CITES every claim with recense://fact/<uuid>.
 *   3. VERIFY: extract every cited id, confirm each resolves to a live, non-tombstoned
 *      fact in the db (catches invented citations) and report staleness signals.
 *
 * This is the make-or-break test of the vision: does the brain produce a doc that
 * reads like the vault deep-dive, with citations that actually ground to atoms?
 *
 * Usage: ANTHROPIC_API_KEY=... tsx scripts/reader-slice/generate.ts /tmp/gather-tonos.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../../src/lib/config';
import { DefaultModelProvider } from '../../src/model/provider';

const DB = process.env.RECENSE_DB || '/Users/vtx/.config/recense/recense.db';
const gatherPath = process.argv[2] || '/tmp/gather-tonos.json';
const gathered = JSON.parse(readFileSync(gatherPath, 'utf8')) as {
  term: string;
  facts: Array<{ id: string; value: string; c: number; origin: string }>;
};

const factBlock = gathered.facts.map(f => `[${f.id}] ${f.value}`).join('\n');

const prompt = `You are generating a human-readable PROJECT DEEP-DIVE from a set of atomic memory facts.

You are given FACTS about "${gathered.term}". Each line is: [<uuid>] <fact text>

FACTS:
${factBlock}

Write a structured markdown deep-dive about "${gathered.term}". Use only the sections the facts can support (e.g. One-liner, Infrastructure, Pipelines/Operations, State, Open questions).

HARD RULES:
1. Every substantive claim MUST cite the fact id(s) it draws from, inline, as a markdown link: [the cited phrase](recense://fact/<uuid>). Use the exact uuid from the bracket.
2. Use ONLY the provided facts. Do NOT add any outside knowledge or invent details. If you cannot cite it from a fact above, do not write it.
3. If facts conflict, note the conflict and cite both.
4. Prefer specific, interview-defensible detail over generic prose.

Output ONLY the markdown deep-dive, no preamble.`;

const config = { ...DEFAULT_CONFIG, dbPath: DB, anthropicModel: 'claude-sonnet-4-6' };
const provider = new DefaultModelProvider({
  generateConfig: config,
  judgeConfig: config,
  embedConfig: config,
});

async function main() {
const generatedAt = Date.now();
console.error(`[generate] model=${config.anthropicModel} facts=${gathered.facts.length} term=${gathered.term}`);
const md = await provider.generate(prompt, { maxTokens: 4000 });

mkdirSync('scripts/reader-slice/out', { recursive: true });
const outPath = `scripts/reader-slice/out/${gathered.term}.md`;
writeFileSync(outPath, md, 'utf8');

// ── VERIFY citations ────────────────────────────────────────────────────────
const db = new Database(DB, { readonly: true, fileMustExist: true });
const getNode = db.prepare(
  'SELECT id, tombstoned, last_access, prev_value FROM node WHERE id=?',
);
const citedIds = [...md.matchAll(/recense:\/\/fact\/([0-9a-f-]{36})/g)].map(m => m[1]!);
const uniqueCited = [...new Set(citedIds)];

let resolved = 0,
  invented = 0,
  tombstoned = 0,
  stale = 0;
const problems: string[] = [];
for (const id of uniqueCited) {
  const row = getNode.get(id) as
    | { id: string; tombstoned: number; last_access: number; prev_value: string | null }
    | undefined;
  if (!row) {
    invented++;
    problems.push(`INVENTED (no such fact): ${id}`);
    continue;
  }
  resolved++;
  if (row.tombstoned) {
    tombstoned++;
    problems.push(`TOMBSTONED fact cited: ${id}`);
  }
  if (row.last_access > generatedAt) {
    stale++; // can't happen on a fresh gen, but this is the staleness predicate the reader uses
  }
}
db.close();

const providedIds = new Set(gathered.facts.map(f => f.id));
const citedFromProvided = uniqueCited.filter(id => providedIds.has(id)).length;
const coverage = ((citedFromProvided / gathered.facts.length) * 100).toFixed(0);

console.error('\n──────── VERIFY ────────');
console.error(`wrote: ${outPath}`);
console.error(`citations: ${citedIds.length} total, ${uniqueCited.length} unique`);
console.error(`resolved to live facts: ${resolved}/${uniqueCited.length}`);
console.error(`invented (hallucinated id): ${invented}`);
console.error(`tombstoned cited: ${tombstoned}`);
console.error(`fact coverage: ${citedFromProvided}/${gathered.facts.length} provided facts cited (${coverage}%)`);
if (problems.length) console.error('PROBLEMS:\n  ' + problems.join('\n  '));
else console.error('✓ every citation resolves to a live, non-tombstoned fact');
}

main().catch(err => {
  console.error('[generate] FAILED:', err?.message || err);
  process.exit(1);
});
