/**
 * ColdStartSeeder — INGEST-03 one-shot cold-start seeding (D-04/05/06/07).
 *
 * Reads per-file memory bodies + CLAUDE.md, LLM-extracts entity/fact nodes
 * and relation edges, writes them through the owned write primitive as
 * origin=asserted_by_user facts, and guards against a second run with a
 * persisted meta flag.
 *
 * Threat mitigations:
 *  - T-04-PATH: fs.realpathSync(candidatePath) validates each file's real path
 *    is inside the resolved real memory dir — catches symlink traversal.
 *  - T-04-ASYNC: All extractor.extract() awaits run BEFORE any synchronous DB
 *    write. No async/await inside db.transaction (Pitfall 1).
 *  - T-04-WRITE: All node writes go through store.upsertNode (owned write
 *    primitive). No raw INSERT INTO node anywhere in this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SemanticStore } from '../db/semantic-store';
import type { ClaimExtractor, ExtractedClaim } from '../model/claim-extractor';
import type { EngineConfig } from '../lib/config';
import { realClock, type Clock } from '../lib/clock';
import { newId } from '../lib/hash';

interface FileSource {
  resolvedPath: string;
  frontmatterType: string;
}

export class ColdStartSeeder {
  private readonly clock: Clock;

  constructor(
    private readonly store: SemanticStore,
    private readonly extractor: ClaimExtractor,
    private readonly config: EngineConfig,
    clock: Clock = realClock, // D-12: injectable for tests; real clock for production
  ) {
    this.clock = clock;
  }

  /**
   * Seed the graph from the founder's memory.
   * One-shot: if meta 'seeded' is already set, returns immediately (D-07).
   */
  async seed(): Promise<void> {
    // D-07: One-shot guard — return immediately if already seeded
    if (this.store.getMeta('seeded') !== null) return;

    // Collect source files (with path traversal protection)
    const sources = this.collectSources();

    // D-81: If no source files resolved (empty config / paths not set), throw so the CLI
    // adapter can log a user-friendly message. The throw happens BEFORE setMeta('seeded'),
    // preserving the one-shot guard for a later correctly-configured run.
    if (sources.length === 0) {
      throw new Error(
        'brain-seed: no source files resolved — set BRAIN_MEMORY_COLD_START_MEMORY_DIR / ' +
          'BRAIN_MEMORY_COLD_START_CLAUDE_FILE (or configure coldStartMemoryDir/coldStartClaudeFile) ' +
          'and re-run. The one-shot seeded flag has NOT been set.',
      );
    }

    // T-04-ASYNC: All async extractor.extract() calls happen OUTSIDE any DB
    // transaction, collected into a plain array first (Pitfall 1).
    const allFileResults: Array<{ claims: ExtractedClaim[] }> = [];
    for (const source of sources) {
      const body = fs.readFileSync(source.resolvedPath, 'utf8');
      const claims = await this.extractor.extract(body, source.frontmatterType);
      allFileResults.push({ claims });
    }

    // Phase 2: Write all nodes synchronously (T-04-WRITE: only via upsertNode).
    // Track each claim's assigned ID so wikilinks reference the correct node.
    const allClaimsWithIds: Array<{ claim: ExtractedClaim; id: string }> = [];
    const valueToId = new Map<string, string>();

    for (const { claims } of allFileResults) {
      for (const claim of claims) {
        const id = newId();
        // T-04-WRITE: owned write primitive only — no raw INSERT INTO node
        this.store.upsertNode({
          id,
          type: claim.type,
          value: claim.value,
          origin: 'asserted_by_user', // D-06: user-asserted = trustworthy
          c: 0.8,                      // D-06: high confidence (user-asserted)
          s: 0.1,                      // D-06: neutral/low strength (not yet accessed)
          tombstoned: false,
          // embedding left dirty (embedded_hash = null) — D-06; Phase 2 CONSOL-02 re-embeds
        });
        allClaimsWithIds.push({ claim, id });
        valueToId.set(claim.value, id); // last writer wins for duplicate values
      }
    }

    // Phase 3: Create wikilink edges using each claim's own assigned ID as src (D-05)
    for (const { claim, id: srcId } of allClaimsWithIds) {
      if (!claim.links || claim.links.length === 0) continue;
      for (const linkTarget of claim.links) {
        const dstId = valueToId.get(linkTarget);
        if (!dstId || dstId === srcId) continue; // skip missing targets and self-links
        this.store.upsertEdge({
          src: srcId,
          dst: dstId,
          rel: 'links_to',
          w: 0.1,
          kind: 'relation',
        });
      }
    }

    // D-07: Set the one-shot seeded flag with an ISO timestamp
    // D-12: clock.nowMs() — never Date.now() directly
    this.store.setMeta('seeded', new Date(this.clock.nowMs()).toISOString());
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Enumerate source files from memory dir + CLAUDE.md file (D-04). */
  private collectSources(): FileSource[] {
    const sources: FileSource[] = [];

    // Memory dir: enumerate .md files (excluding MEMORY.md)
    try {
      const resolvedDir = path.resolve(this.config.coldStartMemoryDir);
      // Resolve real path to handle the case where coldStartMemoryDir itself is a symlink
      const realDir = fs.realpathSync(resolvedDir);

      const filenames = fs.readdirSync(realDir).sort(); // sort for deterministic order
      for (const filename of filenames) {
        if (!filename.endsWith('.md')) continue;
        if (filename === 'MEMORY.md') continue; // D-04: MEMORY.md is an index pointer, not content

        const candidatePath = path.join(realDir, filename);

        // T-04-PATH: Resolve real path (follows symlinks) and assert it is inside realDir
        let realPath: string;
        try {
          realPath = fs.realpathSync(candidatePath);
        } catch {
          continue; // broken symlink or inaccessible — skip
        }

        // A valid member path must start with realDir + separator
        if (!realPath.startsWith(realDir + path.sep)) {
          continue; // symlink points outside the memory dir — skip (T-04-PATH)
        }

        const frontmatterType = this.parseFrontmatterType(realPath) ?? 'reference';
        sources.push({ resolvedPath: realPath, frontmatterType });
      }
    } catch {
      // Dir doesn't exist or isn't readable — skip gracefully
    }

    // CLAUDE.md: included as a separate source (D-04)
    if (this.config.coldStartClaudeFile) {
      try {
        const resolvedClaudeFile = fs.realpathSync(
          path.resolve(this.config.coldStartClaudeFile),
        );
        fs.accessSync(resolvedClaudeFile, fs.constants.R_OK);
        sources.push({ resolvedPath: resolvedClaudeFile, frontmatterType: 'reference' });
      } catch {
        // File doesn't exist or isn't readable — skip gracefully
      }
    }

    return sources;
  }

  /** Extract the frontmatter `type` field from a .md file, if present. */
  private parseFrontmatterType(filePath: string): string | null {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      // Match `type: <value>` inside a YAML frontmatter block (between --- delimiters)
      const match = /^---[\s\S]*?^type:\s*(\S+)/m.exec(content);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }
}
