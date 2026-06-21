---
quick_id: 260620-sf9
slug: sleep-pass-headless-timeout
date: 2026-06-21
status: complete
commit: 7588c7e
---

# Quick Task 260620-sf9 — Sleep-pass headless timeout

## What was done

Added the headless-timeout guard to `src/adapter/sleep-pass-cli.ts` — at the top of `main()`, before `runConsolidation`:

```ts
if (!process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS']) {
  process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS'] = '600000';
}
```

This mirrors the 600s default already set by `generate-doc-cli.ts:129`, `generate-corpus-cli.ts:85`, and `ingest-project-cli.ts:606,777`. The sleep pass was the one corpus-generation entry point still running headless calls at the 120s `DEFAULT_TIMEOUT_MS`.

## Why

Discovered during Phase 32 live verification. The deferred auto-corpus path (32-03's primary trigger: `ingest-project` writes a marker → the scheduled sleep pass consumes it and runs `generateCorpusDocs`) was silently dropping large landing docs. Phase 32-02 introduced landing docs, which carry 100+ citations and take 200s+ to generate — past the 120s sleep-pass default, so the headless call SIGKILLed → empty output → `doc-generator.ts:357` declined to persist → empty stub.

Clean A/B isolating the cause (2026-06-20, /tmp copy of the live brain): the `usage` landing doc stayed empty under the sleep pass (120s) but generated to 24,064 chars / 148 citations via the standalone CLI (600s) — same doc, same data, only the timeout differed.

## Verification

- `grep` confirms the guard in source + compiled dist (`dist/src/adapter/sleep-pass-cli.js:54`).
- `npm run build` clean (tsc).
- `tests/sleep-pass-provider.test.ts` — 22/22 pass (no regression in the sleep-pass entry).
- Conditional guard: an explicit `RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS` env override still wins.

## Notes

- `dist/` is gitignored — only the source change is tracked; dist was rebuilt locally so the live launchd sleep pass (which runs `RECENSE_SLEEP_JS` from this repo's dist) picks it up immediately.
- Self-Check: PASSED.
