/**
 * clients/telegram/scripts/deepseek-smoke.ts
 *
 * One-shot live DeepSeek smoke test — validates the DEEPSEEK_MODEL string and
 * json_object support (Assumptions A1/A2 from Phase 23 RESEARCH.md, Risk 1).
 *
 * Usage (after tsc):
 *   tsc -p clients/telegram/tsconfig.json
 *   DEEPSEEK_API_KEY=<key> node clients/telegram/dist/scripts/deepseek-smoke.js
 *
 * Required env:
 *   DEEPSEEK_API_KEY   — your DeepSeek bearer key (NEVER printed — H-13 / T-13-05)
 *
 * Optional env (override defaults):
 *   DEEPSEEK_MODEL     — model ID (default: deepseek-chat)
 *   DEEPSEEK_BASE_URL  — API base URL (default: https://api.deepseek.com/v1)
 *                        Override to https://api.deepinfra.com/v1/openai for DeepInfra.
 *
 * Exits 0 on success (JSON parsed, model reached), non-zero on HTTP error or
 * missing API key. A wrong model string or base URL produces an HTTP 4xx and
 * exits 1, surfacing the A1/A2 assumption failure clearly.
 *
 * CLIENT-01: zero src/ imports — enforced by clients/telegram/tsconfig.json.
 */

import {
  callDeepSeek,
  buildProposalPrompt,
  validateProposal,
} from '../proposal-engine';
import type { DeepSeekConfig } from '../proposal-engine';
import type { McpToolDescriptor } from '../mcp-client';
import type { SurfaceItem } from '../memory-client';

// ---------------------------------------------------------------------------
// Config from env — API key NEVER logged (H-13 / T-13-05)
// ---------------------------------------------------------------------------

const apiKey = process.env['DEEPSEEK_API_KEY'] ?? '';
if (apiKey === '') {
  console.error('[smoke] ERROR: DEEPSEEK_API_KEY is not set — set it before running.');
  process.exit(1);
}

const model = process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat';
const baseUrl = process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com/v1';

const config: DeepSeekConfig = { apiKey, baseUrl, model };

// Only non-sensitive config is echoed (key is masked).
console.log('[smoke] config:');
console.log(`[smoke]   model:   ${model}`);
console.log(`[smoke]   baseUrl: ${baseUrl}`);
console.log('[smoke]   apiKey:  *** (not logged)');

// ---------------------------------------------------------------------------
// Fixed synthetic P0 surface item (no live memory required)
// ---------------------------------------------------------------------------

const syntheticItem: SurfaceItem = {
  node_id: 'smoke-node-001',
  value: 'Send follow-up email to alice@example.com about the Q3 budget review',
  due_at: new Date(Date.now() + 3_600_000).toISOString(), // 1 hour from now
  action_type: 'send_email',
  tier: 0,    // P0 — bypasses quiet hours
  score: 0.95,
};

// ---------------------------------------------------------------------------
// Fixed two-tool allowlist: one candidate match + one decoy (no live MCP call)
// ---------------------------------------------------------------------------

const allowedTools: McpToolDescriptor[] = [
  {
    name: 'send_email',
    inputSchema: {
      type: 'object',
      properties: {
        to:      { type: 'string' },
        subject: { type: 'string' },
        body:    { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'create_calendar_event',
    inputSchema: {
      type: 'object',
      properties: {
        title:    { type: 'string' },
        start_at: { type: 'string' },
        end_at:   { type: 'string' },
      },
      required: ['title', 'start_at', 'end_at'],
    },
  },
];

// ---------------------------------------------------------------------------
// Fixed synthetic /v1/search results (provides email parameterization context)
// ---------------------------------------------------------------------------

const syntheticSearchResults: unknown[] = [
  {
    node_id: 'ctx-001',
    value: 'alice@example.com is Alice Chen, head of finance at Acme Corp.',
    score: 0.91,
  },
  {
    node_id: 'ctx-002',
    value: 'Q3 budget review scheduled 2026-06-20; Alice requested a written follow-up.',
    score: 0.87,
  },
];

// ---------------------------------------------------------------------------
// Main smoke run
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  console.log('\n[smoke] Building proposal prompt (no network)...');
  const { systemPrompt, userPrompt } = buildProposalPrompt(
    syntheticItem,
    syntheticSearchResults,
    allowedTools,
  );

  console.log('[smoke] Calling DeepSeek (one live call)...');
  const startMs = Date.now();

  let rawJson: string | null;
  try {
    rawJson = await callDeepSeek(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      config,
    );
  } catch (err: unknown) {
    // HTTP errors (wrong model string, bad base URL, quota exhausted, auth failure)
    // surface here — exits non-zero so the A1/A2 validation failure is unambiguous.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n[smoke] ERROR: DeepSeek call failed — ${msg}`);
    console.error('[smoke]   Check DEEPSEEK_MODEL, DEEPSEEK_BASE_URL, and DEEPSEEK_API_KEY.');
    process.exit(1);
  }

  const elapsedMs = Date.now() - startMs;

  // --- Raw response ---

  console.log('\n[smoke] --- RAW DEEPSEEK RESPONSE ---');
  if (rawJson === null) {
    console.log('(null — choices[0].message.content was empty)');
  } else {
    console.log(rawJson);
  }
  console.log('[smoke] --- END RAW RESPONSE ---\n');

  // --- Parse check ---

  let parsedOk = false;
  if (rawJson !== null) {
    try {
      JSON.parse(rawJson);
      parsedOk = true;
    } catch {
      // Intentional: parsedOk remains false
    }
  }
  console.log(`[smoke] JSON parsed:        ${parsedOk ? 'YES' : 'NO'}`);

  // --- validateProposal check ---

  const proposal = validateProposal(rawJson, allowedTools);
  if (proposal.tool !== null) {
    console.log('[smoke] validateProposal:   ACCEPTED');
    console.log(`[smoke]   tool: ${proposal.tool}`);
    console.log(`[smoke]   args: ${JSON.stringify(proposal.args)}`);
  } else {
    console.log('[smoke] validateProposal:   REJECTED ({tool:null}) — D-02 fallback would apply');
    console.log('[smoke]   This may mean: the model chose not to fill all required args,');
    console.log('[smoke]   or selected a tool not in the allowlist. Review raw JSON above.');
  }

  // --- Cost note ---

  console.log(`\n[smoke] latency: ${elapsedMs}ms`);
  console.log('[smoke] cost note:');
  console.log('[smoke]   deepseek-chat pricing: ~$0.27/1M input tokens, ~$1.10/1M output tokens.');
  console.log('[smoke]   This smoke call (~500 input + ~80 output tokens) ≈ $0.0003 total.');
  console.log('[smoke]   Full production proposal budget: $0.01–$0.05 per call.');

  // --- Summary ---

  console.log('\n[smoke] ============================');
  if (!parsedOk) {
    console.log('[smoke] RESULT: FAIL — response did not parse as JSON.');
    console.log('[smoke]   json_object mode may not be supported for this DEEPSEEK_MODEL.');
    console.log('[smoke]   A1/A2 NOT validated. Try model "deepseek-chat" at api.deepseek.com/v1.');
    process.exit(1);
  }
  if (proposal.tool !== null) {
    console.log('[smoke] RESULT: PASS — JSON parsed + validateProposal ACCEPTED a full proposal.');
    console.log('[smoke]   A1/A2 VALIDATED: model string + json_object mode are functional.');
  } else {
    console.log('[smoke] RESULT: PASS (partial) — JSON parsed; validateProposal returned {tool:null}.');
    console.log('[smoke]   A1/A2 VALIDATED: DeepSeek is reachable and json_object mode works.');
    console.log('[smoke]   The null-tool result is a D-02 output, not an API failure.');
  }
  console.log('[smoke] ============================');
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[smoke] FATAL: ${msg}`);
  process.exit(1);
});
