/**
 * ingest-project CLI tests (Phase 30 Plan 02).
 *
 * Covers the two tasks in 30-02-PLAN.md:
 *
 * Task 1 — pure decision surface (flag parse, scope resolution, dry-run plan,
 *   README desc, DB resolution). Transport + DB MOCKED — no real `claude -p` calls,
 *   no write to the live brain.
 *
 * Task 2 — survey loop, recordEvent feed, refusal retry, --dry-run, --consolidate,
 *   dispatcher wiring surface (all with transport + DB mocked).
 *
 * Engine invariants tested:
 *  - Every episode is origin:'observed' (NEVER 'asserted_by_user') — T-30-06
 *  - isRefusalOrToolFailure responses are retried once then skipped — T-30-07
 *  - --dry-run writes 0 rows — T-30-05
 *  - --scope threads via synthetic cwd (NOT a no-op) — INGEST-02 / RESEARCH Pitfall 3
 *  - OPENAI_API_KEY pre-flight ONLY under --consolidate — Seam 5
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

// ── Task 1: pure helpers ──────────────────────────────────────────────────────

describe('parseIngestArgs', () => {
  it('parses positional dir + all flags', async () => {
    const { parseIngestArgs } = await import('../src/adapter/ingest-project-cli');
    const result = parseIngestArgs(['/repo', '--scope', 'my-clone', '--dry-run', '--consolidate']);
    expect(result.dir).toBe('/repo');
    expect(result.scope).toBe('my-clone');
    expect(result.dryRun).toBe(true);
    expect(result.consolidate).toBe(true);
  });

  it('defaults flags to false when absent', async () => {
    const { parseIngestArgs } = await import('../src/adapter/ingest-project-cli');
    const result = parseIngestArgs(['/repo']);
    expect(result.dryRun).toBe(false);
    expect(result.consolidate).toBe(false);
    expect(result.scope).toBeUndefined();
    expect(result.desc).toBeUndefined();
  });

  it('parses --db and --desc', async () => {
    const { parseIngestArgs } = await import('../src/adapter/ingest-project-cli');
    const result = parseIngestArgs(['/repo', '--db', '/tmp/x.db', '--desc', 'a cool project']);
    expect(result.db).toBe('/tmp/x.db');
    expect(result.desc).toBe('a cool project');
  });
});

describe('resolveSurveyScope', () => {
  it('derives scope from dir basename when no --scope (home-rooted dir)', async () => {
    const { resolveSurveyScope } = await import('../src/adapter/ingest-project-cli');
    // /Users/vtx/foo → cwdToScope('/Users/vtx/foo') === 'foo'
    const user = homedir().split('/').pop() ?? 'vtx';
    const homeRoot = homedir().startsWith('/Users') ? '/Users' : '/home';
    const dir = `${homeRoot}/${user}/foo`;
    expect(resolveSurveyScope({ dir })).toBe('foo');
  });

  it('returns --scope value when set (Pitfall 3: non-home-rooted dir)', async () => {
    const { resolveSurveyScope } = await import('../src/adapter/ingest-project-cli');
    expect(resolveSurveyScope({ dir: '/tmp/checkout', scope: 'my-clone' })).toBe('my-clone');
  });
});

describe('resolveSurveyCwd — the real --scope thread (RESEARCH Pitfall 3)', () => {
  it('returns real dir as cwd when no --scope', async () => {
    const { resolveSurveyCwd } = await import('../src/adapter/ingest-project-cli');
    const user = homedir().split('/').pop() ?? 'vtx';
    const homeRoot = homedir().startsWith('/Users') ? '/Users' : '/home';
    const dir = `${homeRoot}/${user}/foo`;
    expect(resolveSurveyCwd({ dir })).toBe(dir);
  });

  it('returns synthetic home-rooted cwd when --scope set', async () => {
    const { resolveSurveyCwd } = await import('../src/adapter/ingest-project-cli');
    const cwd = resolveSurveyCwd({ dir: '/tmp/checkout', scope: 'my-clone' });
    // Must NOT be the original dir — it must be home-rooted
    expect(cwd).not.toBe('/tmp/checkout');
    expect(cwd).toMatch(/^\/(?:Users|home)\//);
  });

  it('cwdToScope round-trip: cwdToScope(resolveSurveyCwd({dir:/tmp/checkout, scope:my-clone})) === my-clone', async () => {
    const { resolveSurveyCwd } = await import('../src/adapter/ingest-project-cli');
    const { cwdToScope } = await import('../src/lib/scope');
    const cwd = resolveSurveyCwd({ dir: '/tmp/checkout', scope: 'my-clone' });
    expect(cwdToScope(cwd)).toBe('my-clone');
  });
});

describe('deriveRepoDesc', () => {
  it('reads first heading from README.md', async () => {
    const { deriveRepoDesc } = await import('../src/adapter/ingest-project-cli');
    const dir = mkdtempSync(join(tmpdir(), 'ingest-test-'));
    writeFileSync(join(dir, 'README.md'), '# My Project\n\nSome description here.\n');
    const desc = await deriveRepoDesc(dir);
    expect(desc).toMatch(/My Project/);
  });

  it('falls back to dir basename when no README', async () => {
    const { deriveRepoDesc } = await import('../src/adapter/ingest-project-cli');
    const dir = mkdtempSync(join(tmpdir(), 'ingest-test-'));
    const desc = await deriveRepoDesc(dir);
    expect(desc).toBe(dir.split('/').pop());
  });

  it('--desc override wins over README', async () => {
    const { deriveRepoDesc } = await import('../src/adapter/ingest-project-cli');
    const dir = mkdtempSync(join(tmpdir(), 'ingest-test-'));
    writeFileSync(join(dir, 'README.md'), '# Ignored\n');
    const desc = await deriveRepoDesc(dir, 'explicit description');
    expect(desc).toBe('explicit description');
  });
});

describe('resolveTargetDb', () => {
  it('returns live brain default when no --db (D-04 — spike live-refuse guard NOT carried)', async () => {
    const { resolveTargetDb } = await import('../src/adapter/ingest-project-cli');
    const { defaultDbPath } = await import('../src/adapter/runtime-config');
    // Must return the live brain, NOT null / undefined / a scratch DB
    const result = resolveTargetDb(['/repo']);
    expect(result).toBe(defaultDbPath());
  });

  it('returns --db value when specified (D-06)', async () => {
    const { resolveTargetDb } = await import('../src/adapter/ingest-project-cli');
    const result = resolveTargetDb(['/repo', '--db', '/tmp/x.db']);
    expect(result).toBe('/tmp/x.db');
  });
});

// ── Task 2: survey loop, recordEvent, dry-run, refusal, --consolidate ────────

describe('runSurveyAndFeed — origin invariant (T-30-06)', () => {
  it('records episodes with origin:observed, NEVER asserted_by_user', async () => {
    const { runSurveyAndFeed } = await import('../src/adapter/ingest-project-cli');
    const recorded: Array<{ origin: string; source: string; cwd: string }> = [];
    const mockPipeline = {
      recordEvent: (params: { origin: string; source: string; cwd: string }) => {
        recorded.push({ origin: params.origin, source: params.source, cwd: params.cwd });
      },
    };
    // Mock transport that returns a simple multi-line response for each area
    const mockSurvey = vi.fn().mockResolvedValue(
      'The architecture uses event sourcing for audit trails.\nConventions require tests before merging changes.\nDecisions were made to keep runtime deps minimal.',
    );

    await runSurveyAndFeed({
      dir: '/tmp/repo',
      scope: 'my-clone',
      repoDesc: 'test repo',
      pipeline: mockPipeline as any,
      surveyArea: mockSurvey,
      dryRun: false,
    });

    expect(recorded.length).toBeGreaterThan(0);
    for (const r of recorded) {
      expect(r.origin).toBe('observed');
      expect(r.origin).not.toBe('asserted_by_user');
      expect(r.source).toBe('project-survey');
    }
  });

  it('uses resolveSurveyCwd-derived cwd for scope threading', async () => {
    const { runSurveyAndFeed } = await import('../src/adapter/ingest-project-cli');
    const { cwdToScope } = await import('../src/lib/scope');
    const recorded: Array<{ cwd: string }> = [];
    const mockPipeline = {
      recordEvent: (params: { cwd: string }) => { recorded.push({ cwd: params.cwd }); },
    };
    const mockSurvey = vi.fn().mockResolvedValue('The architecture uses event sourcing for audit trails.');

    await runSurveyAndFeed({
      dir: '/tmp/checkout',
      scope: 'my-clone',
      repoDesc: 'test repo',
      pipeline: mockPipeline as any,
      surveyArea: mockSurvey,
      dryRun: false,
    });

    expect(recorded.length).toBeGreaterThan(0);
    for (const r of recorded) {
      // scope must thread via cwd, not just be set on a separate field
      expect(cwdToScope(r.cwd)).toBe('my-clone');
    }
  });
});

describe('runSurveyAndFeed — refusal retry (T-30-07, D-07)', () => {
  it('retries once on refusal and skips the area when second attempt also fails', async () => {
    const { runSurveyAndFeed } = await import('../src/adapter/ingest-project-cli');
    const recorded: Array<{ origin: string }> = [];
    const mockPipeline = {
      recordEvent: (params: { origin: string }) => { recorded.push(params); },
    };
    // 'architecture' refuses twice; other areas succeed
    let callCount = 0;
    const mockSurvey = vi.fn().mockImplementation(async (area: string) => {
      if (area === 'architecture') {
        callCount++;
        return "I'm sorry, I cannot access that directory.";
      }
      return 'The module uses an event-driven approach for better decoupling.';
    });

    const result = await runSurveyAndFeed({
      dir: '/tmp/repo',
      scope: 'my-clone',
      repoDesc: 'test repo',
      pipeline: mockPipeline as any,
      surveyArea: mockSurvey,
      dryRun: false,
    });

    // architecture was attempted twice (initial + 1 retry) then skipped
    expect(callCount).toBe(2);
    // 0 episodes from architecture area
    expect(result.skippedAreas).toContain('architecture');
    // other areas produced episodes
    expect(recorded.length).toBeGreaterThan(0);
    for (const r of recorded) {
      expect(r.origin).toBe('observed');
    }
  });

  it('records episode on second attempt success after first refusal', async () => {
    const { runSurveyAndFeed } = await import('../src/adapter/ingest-project-cli');
    const recorded: Array<{ content: string }> = [];
    const mockPipeline = {
      recordEvent: (params: { content: string }) => { recorded.push(params); },
    };
    let attempt = 0;
    const mockSurvey = vi.fn().mockImplementation(async (area: string) => {
      if (area === 'architecture') {
        attempt++;
        if (attempt === 1) return "I'm sorry, I cannot access that directory.";
        return 'The architecture uses a layered approach separating concerns.';
      }
      return 'Conventions follow the established patterns in the codebase.';
    });

    const result = await runSurveyAndFeed({
      dir: '/tmp/repo',
      scope: 'my-clone',
      repoDesc: 'test repo',
      pipeline: mockPipeline as any,
      surveyArea: mockSurvey,
      dryRun: false,
    });

    // architecture succeeded on retry — not in skippedAreas
    expect(result.skippedAreas).not.toContain('architecture');
    // episode from retry should be present
    const archEps = recorded.filter(r => r.content.includes('layered approach'));
    expect(archEps.length).toBeGreaterThan(0);
  });
});

describe('runSurveyAndFeed — --dry-run (T-30-05, D-05)', () => {
  it('calls survey transport but writes 0 rows (recordEvent never called)', async () => {
    const { runSurveyAndFeed } = await import('../src/adapter/ingest-project-cli');
    let recordEventCallCount = 0;
    const mockPipeline = {
      recordEvent: () => { recordEventCallCount++; },
    };
    const mockSurvey = vi.fn().mockResolvedValue(
      'The architecture uses event sourcing for audit trails.\nConventions require tests before merging.',
    );

    const result = await runSurveyAndFeed({
      dir: '/tmp/repo',
      scope: 'test-scope',
      repoDesc: 'test repo',
      pipeline: mockPipeline as any,
      surveyArea: mockSurvey,
      dryRun: true,
    });

    // transport called (so per-area counts can be reported)
    expect(mockSurvey).toHaveBeenCalled();
    // but NO DB writes
    expect(recordEventCallCount).toBe(0);
    // per-area counts available for the dry-run summary
    expect(result.perAreaCounts).toBeDefined();
    for (const count of Object.values(result.perAreaCounts)) {
      expect(typeof count).toBe('number');
    }
  });
});

describe('OPENAI_API_KEY pre-flight — gated on --consolidate only (Seam 5)', () => {
  it('does NOT require OPENAI_API_KEY on the default (non-consolidate) path', async () => {
    const { checkOpenAiKeyIfConsolidate } = await import('../src/adapter/ingest-project-cli');
    // Should not throw when consolidate=false, regardless of key presence
    const env: NodeJS.ProcessEnv = {}; // no key
    expect(() => checkOpenAiKeyIfConsolidate(false, env)).not.toThrow();
  });

  it('throws / exits when --consolidate is set and OPENAI_API_KEY is missing', async () => {
    const { checkOpenAiKeyIfConsolidate } = await import('../src/adapter/ingest-project-cli');
    const env: NodeJS.ProcessEnv = {}; // no key
    expect(() => checkOpenAiKeyIfConsolidate(true, env)).toThrow();
  });

  it('does NOT throw when --consolidate is set and OPENAI_API_KEY is present', async () => {
    const { checkOpenAiKeyIfConsolidate } = await import('../src/adapter/ingest-project-cli');
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'test-key' };
    expect(() => checkOpenAiKeyIfConsolidate(true, env)).not.toThrow();
  });
});
