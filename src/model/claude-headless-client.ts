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
 *
 * USAGE SINK (EVAL-04): optional, installed via setHeadlessUsageSink(fn). When set,
 * on every successful (code 0, parseable envelope) call the sink receives the usage
 * fields from the JSON envelope. The sink is NEVER called on failure/timeout/unparseable
 * paths. A throwing sink is swallowed (try/catch) — it can never affect the production
 * result. Default is null (no sink): zero behavior change, one null check per call.
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

/**
 * Usage payload delivered to the optional sink on each successful headless call.
 * Fields mirror the `claude -p --output-format json` envelope exactly.
 * Declared optional to match real envelope variance (e.g. subscription may omit
 * total_cost_usd in some responses).
 */
export interface HeadlessUsage {
  model: string;
  usage?: Record<string, number>;
  total_cost_usd?: number;
  duration_ms?: number;
}

/**
 * Optional per-call usage sink (EVAL-04). Null by default — zero production cost.
 * Never called on failure, timeout, or unparseable envelope. Throwing sinks are
 * swallowed so they can NEVER affect the production result.
 */
let usageSink: ((u: HeadlessUsage) => void) | null = null;

/**
 * Install or clear the optional usage sink.
 * Pass null to clear (subsequent calls will not invoke the sink).
 * Thread-safety: single-process use; Node.js event loop is single-threaded.
 */
export function setHeadlessUsageSink(fn: ((u: HeadlessUsage) => void) | null): void {
  usageSink = fn;
}

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

/**
 * Survey system prompt. Permits read-only tool use (Read/Grep/Glob) for the survey agent.
 *
 * NEUTRAL_SYSTEM ("no tool use") is correct for the judge/extractor path which must NOT
 * use tools. The survey agent MUST use Read/Grep/Glob to read the target repo; NEUTRAL_SYSTEM
 * would suppress them. This prompt is intentionally minimal — the per-area survey instructions
 * live in the user message (buildSurveyPrompt). Exported for test assertion.
 */
export const SURVEY_SYSTEM =
  'You are a code repository surveyor. Use your Read, Grep, and Glob tools to read the target repository and report summarized why-level observations. Output only the observations, one per line.';

/**
 * Build the `claude -p` argv for the survey agent path.
 *
 * Mirrors `buildHeadlessArgs` but replaces the tool/dir/permission flags per
 * RESEARCH Seam 1 "Exact change required":
 * - `--tools Read Grep Glob` instead of `--tools none` (read-only, no Bash/Write/Edit)
 * - `--add-dir surveyDir` to scope tool access to the target directory
 * - `--permission-mode bypassPermissions` for non-interactive runs
 *
 * KEEPS all load-bearing guards:
 * - `--setting-sources project` (self-ingestion hook guard, load-bearing — cwd-independent)
 * - `--strict-mcp-config`
 * - `--exclude-dynamic-system-prompt-sections`
 *
 * Exported for unit tests so the exact flag set is asserted without spawning a process.
 */
export function buildSurveyHeadlessArgs(model: string, systemPrompt: string, surveyDir: string): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--model', model,
    '--system-prompt', systemPrompt,
    '--setting-sources', 'project',         // KEEP — self-ingestion guard
    '--tools', 'Read', 'Grep', 'Glob',      // CHANGED from 'none' — read-only tool set
    '--add-dir', surveyDir,                  // NEW — scope tool access to target dir
    '--permission-mode', 'bypassPermissions', // NEW — non-interactive; no stdin for prompts
    '--strict-mcp-config',
    '--exclude-dynamic-system-prompt-sections',
  ];
}

/**
 * Construct the AnthropicLike client whose messages.create shells out to `claude -p`
 * with read-only tool access (Read/Grep/Glob) scoped to `surveyDir`.
 *
 * The survey path is ADDITIVE — do NOT mutate `createClaudeHeadlessClient` or
 * `buildHeadlessArgs`. The existing judge/extractor path keeps `--tools none` and
 * `cwd: os.tmpdir()` byte-for-byte unchanged.
 *
 * Design (RESEARCH Pitfall 4 / Test B defensive choice):
 * - `cwd: os.tmpdir()` — neutral cwd, NOT surveyDir. Prevents loading the target repo's
 *   project hooks/CLAUDE.md (a malicious target repo's hooks cannot trigger via `cwd:dir`).
 * - `--add-dir surveyDir` — grants Read/Grep/Glob access to `surveyDir` from the neutral
 *   tmpdir cwd. Live probe confirmed this reads the dir with zero permission_denials.
 *
 * Billing + self-ingestion guards preserved verbatim:
 * - `delete childEnv['ANTHROPIC_API_KEY']` / `ANTHROPIC_AUTH_TOKEN` (subscription billing)
 * - `--setting-sources project` (no global UserPromptSubmit capture hook)
 */
export function createClaudeHeadlessSurveyClient(config: EngineConfig, surveyDir: string): { client: AnthropicLike; model: string } {
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
        const args = buildSurveyHeadlessArgs(useModel, SURVEY_SYSTEM, surveyDir);

        return new Promise<Anthropic.Message>(resolve => {
          // BILLING GUARD: strip the keys so `claude -p` uses the Max subscription, not the API.
          // Preserved verbatim from the default path (load-bearing).
          const childEnv = { ...process.env };
          delete childEnv['ANTHROPIC_API_KEY'];
          delete childEnv['ANTHROPIC_AUTH_TOKEN'];

          const shape = (text: string): Anthropic.Message =>
            ({ content: [{ type: 'text', text }] } as unknown as Anthropic.Message);

          const child = spawn(bin, args, {
            // Defensive neutral cwd (RESEARCH Pitfall 4 / Test B):
            // cwd: os.tmpdir() + --add-dir surveyDir gives read access to surveyDir
            // WITHOUT loading the target repo's project hooks/CLAUDE.md.
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
          child.stderr.on('data', () => {});
          child.on('error', () => {
            clearTimeout(timer);
            resolve(shape(''));
          });
          child.on('close', code => {
            clearTimeout(timer);
            if (timedOut || code !== 0) {
              resolve(shape(''));
              return;
            }
            let text = '';
            try {
              const envelope = JSON.parse(stdout) as {
                result?: unknown;
                usage?: Record<string, number>;
                total_cost_usd?: number;
                duration_ms?: number;
              };
              text = typeof envelope.result === 'string' ? envelope.result : '';
              if (usageSink !== null) {
                try {
                  usageSink({
                    model: useModel,
                    usage: envelope.usage,
                    total_cost_usd: envelope.total_cost_usd,
                    duration_ms: envelope.duration_ms,
                  });
                } catch {
                  // Sink errors are swallowed — best-effort emit guard.
                }
              }
            } catch {
              text = '';
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
              const envelope = JSON.parse(stdout) as {
                result?: unknown;
                usage?: Record<string, number>;
                total_cost_usd?: number;
                duration_ms?: number;
              };
              text = typeof envelope.result === 'string' ? envelope.result : '';
              // EVAL-04 usage sink: invoke on success only (failure/timeout excluded above).
              // Wrapped in try/catch so a throwing sink NEVER affects the production result.
              if (usageSink !== null) {
                try {
                  usageSink({
                    model: useModel,
                    usage: envelope.usage,
                    total_cost_usd: envelope.total_cost_usd,
                    duration_ms: envelope.duration_ms,
                  });
                } catch {
                  // Sink errors are swallowed — best-effort emit guard.
                }
              }
            } catch {
              text = ''; // unparseable envelope → fail-safe empty (sink NOT called)
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
