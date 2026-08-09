/**
 * dist-build.ts (260809-1vg, Task 1) — shared build-presence gate for tests that spawn
 * compiled `dist/` output. `pretest` builds `dist/` before `npm test`, but a bare
 * `npx vitest run` in a fresh worktree does not — this makes those tests skip with an
 * actionable reason instead of failing with a confusing subprocess crash.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

/** True only when EVERY given repo-root-relative path exists (survives a partial/stale build). */
export function hasDistEntries(...relFromRepoRoot: string[]): boolean {
  return relFromRepoRoot.every((rel) => existsSync(join(REPO_ROOT, rel)));
}

/** Single-line, self-explaining skip reason naming the FIRST missing path and the remedy. */
export function distSkipReason(...relFromRepoRoot: string[]): string {
  const missing = relFromRepoRoot.find((rel) => !existsSync(join(REPO_ROOT, rel)));
  return `dist/ build missing (${missing ?? relFromRepoRoot[0]}) — run "npm run build" first`;
}
