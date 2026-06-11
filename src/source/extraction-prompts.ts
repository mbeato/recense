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
import { EXTRACTION_PROMPT } from '../model/claim-extractor';

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
  {"type":"entity","value":"Jane Doe is the founder","links":["brain-memory project"]},
  {"type":"fact","value":"Never inflate metrics","links":[]},
  {"type":"entity","value":"brain-memory project"}
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
  {"type":"entity","value":"Jane Doe is the founder","links":["brain-memory project"]},
  {"type":"fact","value":"Never inflate metrics","links":[]},
  {"type":"entity","value":"brain-memory project"}
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

Return ONLY a valid JSON array — no preamble, no explanation, no markdown fences.

Example:
[
  {"type":"entity","value":"Jane Doe is the founder","links":["brain-memory project"]},
  {"type":"fact","value":"User's daily commute is 45 minutes each way"},
  {"type":"fact","value":"User attended the React Summit conference in Amsterdam"},
  {"type":"fact","value":"User prefers dark roast coffee in the morning"},
  {"type":"entity","value":"brain-memory project"}
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
 * @param source - Source adapter name (e.g. 'gmail', 'granola', 'obsidian', 'claude-code').
 */
export function promptForSource(source: string): string {
  if (source === 'gmail') return GMAIL_EXTRACTION_PROMPT;
  if (TRANSCRIPT_SOURCES.has(source)) return TRANSCRIPT_EXTRACTION_PROMPT;
  if (source === 'conversation') return CONVERSATION_EXTRACTION_PROMPT;
  // obsidian, claude-code, and all unknown sources → existing conversation extractor
  // (T-06-09: unknown/spoofed source values fall back safely — no crash, no privilege gain)
  return EXTRACTION_PROMPT;
}
