/**
 * Survey observation pure helpers (Phase 30 Plan 01).
 *
 * Extracted from scripts/spike/survey-feeder.ts into a real importable module
 * so Plan 02 can wire them into the ingest-project-cli command without re-deriving.
 *
 * PURE MODULE: no DB, no I/O, no claude calls. All exports are pure functions.
 * The spike file (scripts/spike/survey-feeder.ts) is left as-is (throwaway).
 */

// ── Survey areas (D-06 calibrated, carried verbatim from the spike) ───────────

/**
 * The five INGEST-03 survey areas. Each is surveyed independently with its own
 * session id so per-area genuine counts can be measured (29-CALIBRATION).
 */
export const SURVEY_AREAS = [
  'architecture',
  'conventions',
  'decisions',
  'current-state',
  'gotchas',
] as const;

export type SurveyArea = (typeof SURVEY_AREAS)[number];

/**
 * Maximum observations accepted from a single area's survey response. A compliant
 * response is ~10-20 belief lines; this backstops a non-compliant agent dumping hundreds
 * of fragments (the gotchas area returned 407 on the first spike run).
 *
 * Carried verbatim from survey-feeder.ts.
 */
export const MAX_OBS_PER_AREA = 25;

// ── splitObservations ─────────────────────────────────────────────────────────

/**
 * Split a survey agent response into episode-sized records: one belief-line per record.
 *
 * Defensive against non-compliant responses: strips bullet/number markers, drops lines
 * too short or too code-like to be a why-level belief, then caps per area. Chunking
 * granularity is the spike's discretion (CONTEXT.md); the Plan-02 judge is the real gate.
 *
 * Carried verbatim from scripts/spike/survey-feeder.ts.
 */
export function splitObservations(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()) // strip bullet/number markers
    .filter(line => {
      if (line.length < 20) return false;        // too short to be a why-level belief
      if (!line.includes(' ')) return false;     // single token = not a sentence
      if (/[;{}]\s*$/.test(line)) return false;  // ends like a code line
      if (/=>|\brequire\(/.test(line)) return false; // arrow fn / require() call = code
      return true;
    })
    .slice(0, MAX_OBS_PER_AREA);                 // backstop a runaway response
}

// ── isRefusalOrToolFailure ────────────────────────────────────────────────────

/**
 * Detect refusal / apology / tool-access-failure responses BEFORE ingest (D-07).
 *
 * Pattern-matches the canonical failure phrasings from the spike calibration:
 * - "cannot access" (tool-access flake, the decisions-area failure)
 * - "i'm sorry" / "i am sorry" (model apology)
 * - "no genuine observations" (the exact spike apology line that was ingested as a "fact")
 * - "unable to access" (tool failure variant)
 * - "permission denied" (filesystem-level tool failure)
 *
 * Also treats empty / whitespace-only responses as failures — never ingest them.
 *
 * Returns true if the text looks like a refusal or tool failure (skip/retry, never ingest).
 * Returns false if the text looks like a genuine observation response.
 */
export function isRefusalOrToolFailure(text: string): boolean {
  if (!text || !text.trim()) return true; // empty / whitespace-only = failure
  const lower = text.toLowerCase();
  if (lower.includes('cannot access')) return true;
  if (lower.includes("i'm sorry")) return true;
  if (lower.includes('i am sorry')) return true;
  if (lower.includes('no genuine observations')) return true;
  if (lower.includes('unable to access')) return true;
  if (lower.includes('permission denied')) return true;
  return false;
}

// ── buildSurveyPrompt ─────────────────────────────────────────────────────────

/**
 * Parameters for building the survey prompt. Generalizes the spike's hardcoded
 * SURVEY_CWD and package description into caller-supplied values so the same prompt
 * logic works for any arbitrary repo.
 */
export interface SurveyPromptParams {
  /** Absolute path to the surveyed repo root. Replaces the spike's hardcoded SURVEY_CWD. */
  repoDir: string;
  /** One-line description of the repo (from README or --desc override). Replaces the hardcoded package description. */
  repoDesc: string;
}

/**
 * Build the per-area survey prompt (D-08). This exact shape is a Phase-29 calibration
 * output — the 4 healthy areas keep the calibrated base text byte-identical to
 * 29-CALIBRATION Input 1; `gotchas` gets an additional why-level steering clause per D-08.
 *
 * Load-bearing framing lines that must stay intact:
 * - "Write WHY, NOT WHAT" — the per-area genuine ratio depends on this
 * - The explicit "MUST NOT contain" quality gate (maps 1:1 to D-07 noise categories)
 * - The ~15 / hard-ceiling-20 curation cap (prevents runaway enumeration)
 * - "one belief per line, standalone sentence, no markers" (feeds the claim extractor)
 *
 * Generalized from scripts/spike/survey-feeder.ts: `repoDir` replaces `/Users/vtx/usage`,
 * `repoDesc` replaces the hardcoded parenthetical package description.
 */
export function buildSurveyPrompt(area: SurveyArea, params: SurveyPromptParams): string {
  const { repoDir, repoDesc } = params;
  const baseLines = [
    `You are surveying the local code repository at ${repoDir} (${repoDesc}).`,
    `Use your Read, Grep, and Glob tools to read the real repo: README.md, AGENTS.md, DESIGN.md,`,
    `PLAN.md, and the app/, bin/, lib/, plugin/, and scripts/ directories.`,
    ``,
    `Report SUMMARIZED OBSERVATIONS about this ONE area: "${area}".`,
    ``,
    `Write WHY, NOT WHAT. Emit why-level semantic knowledge a senior engineer would tell a`,
    `new teammate: architecture rationale, conventions and the reasons behind them, design`,
    `decisions and their tradeoffs, the current state of the project, and gotchas.`,
    ``,
    `STRICT QUALITY GATE — your output MUST NOT contain:`,
    `  - any raw code lines or code snippets,`,
    `  - import/dependency graphs or dependency lists ("file X imports Y"),`,
    `  - structural trivia (file listings, "module A calls module B"),`,
    `  - config dumps or boilerplate.`,
    `Only summarized, why-level semantic knowledge belongs in the output.`,
    ``,
    `Report ONLY the ~15 most important, highest-value beliefs for this area (hard ceiling: 20).`,
    `Do NOT exhaustively enumerate every minor point — curate the why-level insights that matter.`,
    ``,
    `Format: natural-language belief statements, roughly ONE belief per line, each a complete`,
    `standalone sentence. No headers, no bullets, no numbering, no preamble — just the belief`,
    `lines. If you have nothing genuine to say for this area, return an empty response.`,
  ];

  if (area === 'gotchas') {
    // D-08 gotchas tightening: extra why-level steering clause to steer away from structural
    // "what" trivia. The gotchas area returned 13/18 noise in the spike; the gate catches it
    // correctly but the fix is upstream at the prompt. Inserted after the base quality gate.
    const insertIdx = baseLines.findIndex(l => l.startsWith('Only summarized'));
    baseLines.splice(
      insertIdx + 1,
      0,
      ``,
      `For the gotchas area specifically: focus on a senior dev's hard-won warnings, NOT a list of what files do. Capture the non-obvious traps, the "why did we do it this way" surprises, the decisions that look wrong until you understand the constraint behind them.`,
    );
  }

  return baseLines.join('\n');
}
