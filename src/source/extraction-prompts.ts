/**
 * Per-source extraction prompt builders (D-62).
 *
 * promptForSource(source) returns the extraction prompt prefix for a given source.
 * The existing Consolidator call-site appends:
 *   episode.role + '\n\nDocument content:\n' + episode.content
 * after this prefix — unchanged across every source (D-59: zero new extract plumbing).
 *
 * Each prompt maintains the same JSON-array output contract as EXTRACTION_PROMPT so the
 * shared parseClaims parser handles every source's response without modification (D-62).
 *
 * Source routing:
 *   gmail              → email-noise guidance (strip signatures, pleasantries, logistics)
 *   granola/otter/zoom → speaker-attribution guidance (decisions and action items)
 *   obsidian           → EXTRACTION_PROMPT verbatim (curated-markdown extractor)
 *   conversation       → casual-chat prompt (durable facts + personal episodic details)
 *   claude-code / default / unknown → EXTRACTION_PROMPT (existing conversation extractor)
 *
 * Threat mitigation (T-06-09): unknown/spoofed source values fall back to
 * EXTRACTION_PROMPT — no crash, no privilege gain.
 */
import { EXTRACTION_PROMPT, MERGED_EXTRACTION_PROMPT } from '../model/claim-extractor';

/** Transcript source names — speaker-attribution prompt is used for all three. */
const TRANSCRIPT_SOURCES: ReadonlySet<string> = new Set(['granola', 'otter', 'zoom']);

/**
 * Gmail-specific extraction prompt.
 *
 * Targets LLM cost where noise is worst (D-62): guides the extractor to focus on
 * durable facts (people, commitments, decisions) while ignoring low-signal email
 * noise (signatures, pleasantries, scheduling logistics).
 * Output contract identical to EXTRACTION_PROMPT so parseClaims handles the response.
 */
const GMAIL_EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Extract all structured knowledge from the given memory document.

For each item extract:
- "type": "entity" for named people, projects, tools, technologies, and organizations; "fact" for rules, preferences, capabilities, and factual statements
- "value": a concise, self-contained string
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)

Extract durable facts about people, commitments, and decisions; IGNORE email signatures, pleasantries, and scheduling logistics.

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"entity","value":"Jane Doe is the founder","links":["recense project"]},
  {"type":"fact","value":"Never inflate metrics","links":[]},
  {"type":"entity","value":"recense project"}
]

Document type: `;

/**
 * Gmail episodic-variant extraction prompt (D-06, TEMP-03).
 *
 * Activated only when RECENSE_ENABLE_EPISODIC_EMAIL === 'on' (default OFF — D-07 gate).
 * Strict equality is load-bearing: any other truthy value keeps the baseline prompt
 * so the live-write gate cannot be bypassed by accident (T-20-02).
 *
 * SUPERSET of GMAIL_EXTRACTION_PROMPT (D-06 — one prompt, one LLM call, no second pass):
 * emits everything the baseline does PLUS due_at/action_type for date-anchored commitments
 * (flights, deadlines, receipts, appointments, payments, meetings) that the baseline discards.
 * Fields omitted when no concrete date is present — backward-compat preserved for atemporal facts.
 *
 * Output contract: same JSON array; parseClaims + parseClaimsFromArray handle the response.
 * Out-of-enum action_type values are coerced to 'other' by toActionType() (D-02 robustness).
 *
 * Live enable is blocked until the plan-05 offline dry-run A/B gate passes with explicit pass/fail
 * criteria (gated-live-write-needs-real-offswitch lesson — never activate by plan-ordering alone).
 */
const GMAIL_EPISODIC_EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Extract all structured knowledge from the given memory document.

For each item extract:
- "type": "entity" for named people, projects, tools, technologies, and organizations; "fact" for rules, preferences, capabilities, and factual statements
- "value": a concise, self-contained string
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)
- "due_at": ISO-8601 UTC datetime string ONLY for time-sensitive commitments (flights, deadlines, receipts, appointments, payments, meetings). Omit entirely for facts without a concrete date/time.
- "action_type": one of "deadline" | "flight" | "appointment" | "receipt" | "payment" | "meeting" | "other" — include ONLY when due_at is present.

Extract durable facts about people, commitments, and decisions; IGNORE email signatures, pleasantries, and scheduling logistics.
For date-anchored commitments (flights, deadlines, receipts, payments, meetings), ALWAYS include due_at and action_type.

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"entity","value":"Jane Doe is the founder","links":["recense project"]},
  {"type":"fact","value":"Never inflate metrics","links":[]},
  {"type":"fact","value":"Flight AA123 to NYC departs 2026-07-04T08:00:00Z","due_at":"2026-07-04T08:00:00Z","action_type":"flight"},
  {"type":"fact","value":"Invoice from Acme Corp due 2026-06-30","due_at":"2026-06-30T23:59:00Z","action_type":"deadline"}
]

Document type: `;

/**
 * Google Calendar extraction prompt (TEMP-01, TEMP-02).
 *
 * Used unconditionally for source='gcal' (not behind the email flag — calendar temporal
 * is a core TEMP-01 requirement, not an episodic-email extension).
 *
 * Emits ONE durable 'fact' claim per event. The explicit next-occurrence ISO datetime
 * computed deterministically by the CalendarAdapter is already present in the content;
 * the LLM copies it verbatim into due_at — it NEVER expands or computes a recurrence.
 * This preserves D-04: recurrence expansion is the adapter's job, not the extractor's.
 *
 * "date should live in due_at NOT in the value" — so re-ingested occurrences of the
 * same recurring event reconcile to the same node (stable value, updated temporal row).
 *
 * Output contract: same JSON array; parseClaims handles the response.
 */
const GCAL_EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Extract structured knowledge from the given Google Calendar event.

For each event extract ONE item:
- "type": "fact"
- "value": a concise, self-contained description of the event (who, what, purpose) WITHOUT the date — e.g. "Weekly standup with the engineering team" not "Weekly standup on 2026-07-07"
- "links": an array of related entity names referenced in the event (omit if none)
- "due_at": copy the explicit ISO-8601 UTC datetime for the next occurrence VERBATIM from the content — do NOT compute or expand a recurrence rule yourself
- "action_type": one of "appointment" | "meeting" | "deadline" | "flight" | "receipt" | "payment" | "other"

The date belongs in due_at, NOT in value. This allows re-ingested occurrences of the same recurring event to reconcile to the same memory node.

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"fact","value":"Weekly standup with the engineering team","links":["engineering team"],"due_at":"2026-07-07T14:00:00Z","action_type":"meeting"}
]

Document type: `;

/**
 * Transcript-source extraction prompt (Granola / Otter / Zoom).
 *
 * Guides the extractor to focus on decisions and action items while attributing
 * each claim to the named speaker found in the inline speaker header.
 * Output contract identical to EXTRACTION_PROMPT so parseClaims handles the response.
 */
const TRANSCRIPT_EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Extract all structured knowledge from the given memory document.

For each item extract:
- "type": "entity" for named people, projects, tools, technologies, and organizations; "fact" for rules, preferences, capabilities, and factual statements
- "value": a concise, self-contained string — attribute each claim to the named speaker in the inline header
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)

Extract decisions and action items; attribute each claim to the named speaker in the inline header.

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"entity","value":"Jane Doe is the founder","links":["recense project"]},
  {"type":"fact","value":"Never inflate metrics","links":[]},
  {"type":"entity","value":"recense project"}
]

Document type: `;

/**
 * Conversation-source extraction prompt.
 *
 * Targets casual personal chat sessions where the default EXTRACTION_PROMPT
 * under-extracts personal episodic details (events, purchases, durations,
 * quantities, plans, preferences, places, dates). Verified missing fact:
 * "45 minutes each way" commute detail never became a node from a 13KB chat
 * session under the default prompt.
 *
 * Values must be self-contained third-person claims so they are meaningful
 * when recalled without surrounding context ("User's daily commute is 45
 * minutes each way" not "commute is 45 min").
 *
 * Output contract identical to EXTRACTION_PROMPT so parseClaims handles
 * the response without modification (D-62).
 */
const CONVERSATION_EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Extract all structured knowledge from the given memory document.

For each item extract:
- "type": "entity" for named people, projects, tools, technologies, and organizations; "fact" for rules, preferences, capabilities, durable facts, and personal episodic details
- "value": a concise, self-contained third-person claim (e.g. "User's daily commute is 45 minutes each way" not just "commute is 45 min")
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)

Extract BOTH durable facts AND personal episodic details: events attended, purchases made, durations and quantities ("commute is 45 minutes each way"), places visited or mentioned, plans and intentions, dates and schedules, personal preferences, and any fact that the user would want remembered. Values must be self-contained so they are meaningful when recalled without surrounding context.

IMPORTANT: When a statement describes a change or update (using words like "cut to", "moved to", "switched to", "quit", "started", "stopped", "dropped", "no longer"), extract the NEW CURRENT STATE as the fact value — not the change description. Examples:
- "Jordan cut her plan from Professional to Starter" → "Jordan's active subscription is the Starter tier"
- "Sam switched from Ruby to Go for backend work" → "Sam writes backend services in Go"
- "Oliver moved to lunchtime workouts from early-morning gym sessions" → "Oliver works out at lunchtime on weekdays"
- "Priya quit her finance analyst role and now leads product" → "Priya works as a product lead"
- "Marco stopped using Jira and switched to Linear" → "Marco's team tracks tasks in Linear"

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"entity","value":"Jane Doe is the founder","links":["recense project"]},
  {"type":"fact","value":"User's daily commute is 45 minutes each way"},
  {"type":"fact","value":"User attended the React Summit conference in Amsterdam"},
  {"type":"fact","value":"User prefers dark roast coffee in the morning"},
  {"type":"entity","value":"recense project"}
]

Document type: `;

/**
 * Web-article extraction prompt.
 *
 * Targets web pages and online articles: claims, named entities, publication
 * context (author, source, date). Focuses on verifiable facts rather than
 * opinion, and extracts entities that give the claim provenance context.
 * Output contract identical to EXTRACTION_PROMPT so parseClaims handles
 * the response without modification (D-62).
 */
const WEB_EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Extract all structured knowledge from the given memory document.

For each item extract:
- "type": "entity" for named people, organizations, products, technologies, and publications; "fact" for claims, findings, statistics, and verifiable statements
- "value": a concise, self-contained string — include enough context to be meaningful without the surrounding article (e.g. "According to TechCrunch, OpenAI raised $6.6 billion in October 2024" not just "raised $6.6 billion")
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)

Extract claims, findings, named entities, and publication context (author, source, publication date). Prefer verifiable facts over opinion.

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"entity","value":"OpenAI","links":[]},
  {"type":"fact","value":"OpenAI raised $6.6 billion in a funding round in October 2024","links":["OpenAI"]},
  {"type":"fact","value":"The article was published by TechCrunch on 2024-10-02","links":[]}
]

Document type: `;

/**
 * Document extraction prompt (PDFs, formal docs, reports).
 *
 * Targets structured documents: definitions, decisions, requirements, and
 * formal facts. Extracts section-level structure and key terms with their
 * definitions so recalled nodes are immediately useful without re-reading
 * the full document.
 * Output contract identical to EXTRACTION_PROMPT so parseClaims handles
 * the response without modification (D-62).
 */
const DOCUMENT_EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Extract all structured knowledge from the given memory document.

For each item extract:
- "type": "entity" for named people, organizations, products, systems, and defined terms; "fact" for decisions, requirements, definitions, findings, and formal statements
- "value": a concise, self-contained string capturing the complete meaning (e.g. "The document defines 'episodic memory' as short-term storage of recent events" not just "episodic memory definition")
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)

Extract structured facts, definitions, decisions, requirements, and key terms. Each value must be self-contained — meaningful when read in isolation without the source document.

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"entity","value":"EpisodicStore","links":["recense project"]},
  {"type":"fact","value":"EpisodicStore enforces append-only writes with no deletes","links":["EpisodicStore"]},
  {"type":"fact","value":"The spec requires all SQL to use parameterized statements (T-02-SQL)","links":[]}
]

Document type: `;

/**
 * Code-diff extraction prompt.
 *
 * Targets git diffs, patch files, and code-change descriptions. Extracts
 * what changed, which files and components were affected, and the rationale
 * when present. Avoids extracting raw code syntax as claims.
 * Output contract identical to EXTRACTION_PROMPT so parseClaims handles
 * the response without modification (D-62).
 */
const CODE_DIFF_EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Extract all structured knowledge from the given memory document.

For each item extract:
- "type": "entity" for named files, modules, components, functions, classes, and systems; "fact" for changes made, behaviors modified, bugs fixed, and rationale stated
- "value": a concise, self-contained string describing the change in plain language (e.g. "The consolidator's prefetch map type changed from Map<string,string> to Map<string,ExtractedClaim[]>" not raw code)
- "links": an array of OTHER item values referenced via [[WikiLink]] syntax in the document, provided WITHOUT the double brackets (omit if none)

Extract what changed, which files and components are affected, and the stated rationale or motivation. Describe changes in plain language — do not copy raw code as values.

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"entity","value":"consolidator.ts","links":[]},
  {"type":"fact","value":"consolidator.ts: prefetch map now stores ExtractedClaim[] instead of raw strings","links":["consolidator.ts"]},
  {"type":"fact","value":"maxTokens raised to 8192 in all extraction generate() calls to prevent truncation","links":[]}
]

Document type: `;

/**
 * Return the extraction prompt prefix for a given episode source.
 *
 * The consolidator concatenates the returned string with:
 *   episode.role + '\n\nDocument content:\n' + episode.content
 * — this suffix is identical for every source, so the call-site is unchanged.
 *
 * Unknown / unrecognised sources fall back to EXTRACTION_PROMPT (T-06-09 safe fallback).
 *
 * @param source - Source adapter name (e.g. 'gmail', 'granola', 'obsidian', 'claude-code',
 *                 'conversation', 'web', 'document', 'code-diff').
 */
export function promptForSource(source: string): string {
  if (source === 'gmail') {
    // D-06/TEMP-03: episodic-variant superset is activated by strict env equality (T-20-02).
    // RECENSE_ENABLE_EPISODIC_EMAIL=on is the ONLY value that enables the episodic path.
    // Any other value (empty, 'false', 'ON', 'true', etc.) keeps the baseline prompt.
    // Must NOT be enabled in production until the plan-05 offline dry-run A/B gate passes.
    if (process.env['RECENSE_ENABLE_EPISODIC_EMAIL'] === 'on') {
      return GMAIL_EPISODIC_EXTRACTION_PROMPT;
    }
    return GMAIL_EXTRACTION_PROMPT;
  }
  if (source === 'gcal') {
    // TEMP-01/TEMP-02: calendar prompt is unconditional — temporal fields are core for gcal.
    return GCAL_EXTRACTION_PROMPT;
  }
  if (TRANSCRIPT_SOURCES.has(source)) return TRANSCRIPT_EXTRACTION_PROMPT;
  if (source === 'conversation') return CONVERSATION_EXTRACTION_PROMPT;
  if (source === 'web') return WEB_EXTRACTION_PROMPT;
  if (source === 'document') return DOCUMENT_EXTRACTION_PROMPT;
  if (source === 'code-diff') return CODE_DIFF_EXTRACTION_PROMPT;
  // obsidian, claude-code, and all unknown sources → conversation extractor.
  // D-02/D-03 (Phase 37): when RECENSE_TYPED_EXTRACTION_MODE=merged, route to the merged
  // {facts, triples} prompt so one Haiku call emits both facts and typed triples.
  // Dark-default is 'merged'; set to 'separate' to fall back to single-facts extraction
  // (the D-03 fact-quality regression fallback; consolidator handles separate-mode triple call).
  // (T-06-09: unknown/spoofed source values fall back safely — no crash, no privilege gain)
  if (process.env['RECENSE_TYPED_EXTRACTION_MODE'] !== 'separate') {
    return MERGED_EXTRACTION_PROMPT;
  }
  return EXTRACTION_PROMPT;
}
