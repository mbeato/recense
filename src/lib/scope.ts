/**
 * scope — pure cwd → provenance-scope derivation (Plan 999.3-01, D-S3).
 *
 * Single-tenant PROVENANCE, NOT tenancy (D-S1): `scope` records which project a fact
 * originated in. It is a derived sidecar annotation surfaced for display only — it NEVER
 * feeds retrieval ranking/score/filter. These helpers are pure (no DB, no I/O) so they
 * are trivially unit-testable and safe to call on the hot consolidation path.
 *
 * Mapping (D-S3 + CONTEXT cwd→scope section):
 *  - A "known project root" is a directory directly under the user's home
 *    (e.g. /Users/vtx/brain-memory → 'brain-memory'). The slug is that segment, lowercased.
 *  - Personal/non-project origins → 'global': the home dir itself, the resume project,
 *    an empty/whitespace/undefined cwd, or any path NOT under a recognized home root.
 *  - Untrusted-path defense (T-S3-01): no path is trusted as a project unless it sits
 *    directly under a home prefix; everything else defaults to 'global'.
 */

/** The default attribution for non-project / personal / unknown origins. */
export const GLOBAL_SCOPE = 'global';

/**
 * Project slugs that are personal rather than product projects → always 'global'.
 * Kept deliberately small and documented (D-S3): the resume project carries Max's
 * job-search material, which is personal context that should surface everywhere.
 */
const PERSONAL_SLUGS = new Set<string>(['resume']);

/**
 * Matches a path directly under a unix home root and captures the first segment below it.
 *  - group 1 = the project segment immediately under /Users/<user> or /home/<user>.
 *  - When the path IS the home dir (no trailing segment), group 1 is undefined → 'global'.
 * Machine-independent: keys off the /Users|/home/<user>/ shape, not os.homedir(), so the
 * derivation is stable across the dev machine and CI.
 */
const HOME_PROJECT_RE = /^\/(?:Users|home)\/[^/]+(?:\/([^/]+))?/;

/**
 * Normalize a session cwd to a single provenance scope (D-S3).
 *
 * @param cwd  The episode's working directory ('' for global/email/unknown origins).
 * @returns    A lowercase project slug, or 'global'.
 */
export function cwdToScope(cwd: string | undefined): string {
  if (!cwd) return GLOBAL_SCOPE;
  const trimmed = cwd.trim().replace(/\/+$/, ''); // strip trailing slashes
  if (trimmed === '') return GLOBAL_SCOPE;

  const m = HOME_PROJECT_RE.exec(trimmed);
  // Not under a recognized home root → untrusted/unknown → global (T-S3-01).
  if (!m) return GLOBAL_SCOPE;

  const segment = m[1];
  // Home dir itself (no project segment) → global.
  if (!segment) return GLOBAL_SCOPE;

  const slug = segment.toLowerCase();
  if (PERSONAL_SLUGS.has(slug)) return GLOBAL_SCOPE;
  return slug;
}

/**
 * Collapse a node's contributing-episode scopes into one attribution (D-S3).
 *
 * One distinct project → that slug. More than one distinct project, OR none, → 'global'.
 * 'global' contributors are not projects, so they never count toward the distinct-project
 * tally: a node touched by one VTX episode and one global episode stays 'vtx'.
 *
 * @param scopes  Per-contributing-episode scopes (already mapped via cwdToScope).
 */
export function resolveNodeScope(scopes: string[]): string {
  const distinctProjects = new Set(scopes.filter(s => s && s !== GLOBAL_SCOPE));
  if (distinctProjects.size === 1) {
    return [...distinctProjects][0]!;
  }
  return GLOBAL_SCOPE;
}
