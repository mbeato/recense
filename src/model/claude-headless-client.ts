/**
 * Headless `claude -p` transport behind the AnthropicLike seam (QUICK-260617-qat).
 *
 * Spike 003 validated (A/B on the founder's Max subscription): extract→Haiku +
 * judge→Sonnet via the first-party `claude` binary in print mode beats the paid
 * Haiku-API judge AND is ToS-clean on a subscription with NO API key. This transport
 * plugs in behind the existing AnthropicLike type so AnthropicJudge / the extractor /
 * DefaultModelProvider.generate are UNCHANGED — only createAnthropicClient routes to it
 * when modelProvider === 'claude-headless' (opt-in via env ONLY; default stays 'anthropic').
 *
 * BILLING SAFEGUARD (load-bearing): Claude Code prefers ANTHROPIC_API_KEY over the
 * subscription login when that env var is present — so forwarding process.env verbatim
 * silently bills the API instead of the Max subscription (the 2026-06-17 incident:
 * ~/.claude/settings.json env-injects the key). The spawn env DELETES ANTHROPIC_API_KEY
 * and ANTHROPIC_AUTH_TOKEN so `claude -p` falls back to the stored OAuth/subscription
 * login. The unit test asserts this strip — it is the whole point of the transport.
 *
 * ISOLATION (load-bearing): runs from os.tmpdir() — a NEUTRAL cwd with no project
 * CLAUDE.md and no brain-memory hooks. Critically this avoids re-firing recense's own
 * Stop-hook sleep pass, which would recurse. `--system-prompt` REPLACES Claude Code's
 * coding-agent system prompt with a neutral JSON-only instruction; the full production
 * judge/extract prompt is the only semantic input (the user turn).
 *
 * Faithfulness note: the validated API judge pins temperature 0; the CLI exposes no
 * temperature knob, so this transport CANNOT pin it (spike 003a measured the determinism
 * cost). params.temperature / params.max_tokens are accepted and ignored.
 *
 * Logic ported verbatim from .planning/spikes/003-headless-judge/claude-headless.cjs
 * (claudeHeadlessRaw). On timeout / non-zero exit / spawn error this returns empty text
 * (NOT a throw): parseVerdict('') → SAFE 'unrelated' and parseClaims('') → [] are the
 * production fail-safes, so a transient `claude` failure degrades that one call instead
 * of crashing the always-on sleep pass.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import type { EngineConfig } from '../lib/config';
import type { AnthropicLike } from './anthropic-client';

/**
 * Neutral replacement for Claude Code's coding-agent system prompt. Deliberately
 * minimal — all judge/extract semantics live in the user message (matches the API
 * path, where the whole prompt is the user turn and system was effectively empty).
 * Exported so the unit test can assert the argv carries it.
 */
export const NEUTRAL_SYSTEM =
  'Output only the direct answer to the user message. No preamble, no commentary, no tool use, no markdown fences unless the user asks for them.';

/** Default per-call timeout; env-overridable via RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Build the `claude -p` argv. Exported for the unit test so the flag set + model are
 * asserted without spawning a real process.
 *
 * `--setting-sources project` (load-bearing): hooks/CLAUDE.md/skills live in the USER
 * settings source (~/.claude/settings.json). Loading only `project` (and we run from a
 * neutral tmpdir = no project settings) drops EVERY global hook — critically the global
 * `UserPromptSubmit` turn-capture and `SessionStart` inject hooks. Without this, each
 * internal `claude -p` extract/judge call is itself captured as a new "user" episode
 * (self-ingestion loop) and gets recalled context injected into its prompt. The neutral
 * cwd alone does NOT prevent this — those hooks are global (cwd-independent). OAuth /
 * subscription auth is a SEPARATE source, unaffected (only `--bare` disables OAuth — which
 * is why `--bare` can't be used on the Max subscription).
 *
 * `--tools none` + `--strict-mcp-config` + `--exclude-dynamic-system-prompt-sections`
 * trim the Claude Code harness (~28.6K → ~5.5K tokens/call) and make the remainder
 * cacheable; the judge/extractor need no tools and no MCP.
 */
export function buildHeadlessArgs(model: string, systemPrompt: string): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--model', model,
    '--system-prompt', systemPrompt,
    '--setting-sources', 'project',
    '--tools', 'none',
    '--strict-mcp-config',
    '--exclude-dynamic-system-prompt-sections',
  ];
}

/** Coerce an Anthropic message `content` (string | content-block array) to its text. */
function messageContentToText(content: Anthropic.MessageCreateParamsNonStreaming['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('');
}

/**
 * Construct the AnthropicLike client whose messages.create shells out to `claude -p`.
 * Pure construction — no process is spawned until messages.create is awaited.
 */
export function createClaudeHeadlessClient(config: EngineConfig): { client: AnthropicLike; model: string } {
  const model = config.claudeHeadlessModel;
  const bin = process.env['RECENSE_CLAUDE_BIN'] || 'claude';
  const timeoutRaw = process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS'];
  const parsed = timeoutRaw ? parseInt(timeoutRaw, 10) : NaN;
  const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;

  const client: AnthropicLike = {
    messages: {
      create(params): Promise<Anthropic.Message> {
        const useModel = params.model || model;
        const prompt = messageContentToText(params.messages[0]?.content ?? '');
        const args = buildHeadlessArgs(useModel, NEUTRAL_SYSTEM);

        return new Promise<Anthropic.Message>(resolve => {
          // BILLING GUARD: strip the keys so `claude -p` uses the Max subscription, not the API.
          const childEnv = { ...process.env };
          delete childEnv['ANTHROPIC_API_KEY'];
          delete childEnv['ANTHROPIC_AUTH_TOKEN'];

          const shape = (text: string): Anthropic.Message =>
            ({ content: [{ type: 'text', text }] } as unknown as Anthropic.Message);

          const child = spawn(bin, args, {
            // Neutral cwd: no project CLAUDE.md, no brain-memory hooks (incl. the recense
            // Stop-hook sleep pass — running in-repo would recurse).
            cwd: os.tmpdir(),
            env: childEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          let stdout = '';
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs);

          child.stdout.on('data', d => { stdout += d; });
          // stderr is drained but not surfaced on stdout (keeps the parsed result clean).
          child.stderr.on('data', () => {});
          child.on('error', () => {
            clearTimeout(timer);
            resolve(shape('')); // spawn failure → empty text → production fail-safe
          });
          child.on('close', code => {
            clearTimeout(timer);
            if (timedOut || code !== 0) {
              resolve(shape(''));
              return;
            }
            // --output-format json → stdout is a JSON envelope; the answer is `.result`.
            let text = '';
            try {
              const envelope = JSON.parse(stdout) as { result?: unknown };
              text = typeof envelope.result === 'string' ? envelope.result : '';
            } catch {
              text = ''; // unparseable envelope → fail-safe empty
            }
            resolve(shape(text));
          });

          child.stdin.write(prompt);
          child.stdin.end();
        });
      },
    },
  };

  return { client, model };
}
