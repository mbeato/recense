/**
 * cwd → scope derivation helper tests (Plan 999.3-01, D-S3).
 *
 * Pure functions, no DB. Two helpers:
 *   - cwdToScope(cwd): normalize a session cwd to a project slug or 'global'.
 *   - resolveNodeScope(scopes[]): collapse a node's contributing-episode scopes
 *     to a single attribution — one distinct project → that slug; >1 distinct
 *     project OR none → 'global'.
 *
 * D-S3: a known project (direct child of the user's home) → its slug; personal/home/
 * empty/unknown cwd → 'global'; a node spanning >1 project → 'global'.
 */
import { describe, it, expect } from 'vitest';
import { cwdToScope, resolveNodeScope } from '../src/lib/scope';

describe('cwdToScope', () => {
  it('maps a known project root to its slug', () => {
    expect(cwdToScope('/Users/vtx/VTX')).toBe('vtx');
    expect(cwdToScope('/Users/vtx/brain-memory')).toBe('brain-memory');
  });

  it('lowercases the slug', () => {
    expect(cwdToScope('/Users/vtx/Tonos')).toBe('tonos');
  });

  it('uses the project segment for a deeper path under the project root', () => {
    expect(cwdToScope('/Users/vtx/brain-memory/src/db')).toBe('brain-memory');
    expect(cwdToScope('/Users/vtx/VTX/apps/web')).toBe('vtx');
  });

  it('returns global for empty string', () => {
    expect(cwdToScope('')).toBe('global');
  });

  it('returns global for whitespace-only', () => {
    expect(cwdToScope('   ')).toBe('global');
  });

  it('returns global for the home directory itself', () => {
    expect(cwdToScope('/Users/vtx')).toBe('global');
    expect(cwdToScope('/Users/vtx/')).toBe('global');
  });

  it('returns global for undefined', () => {
    expect(cwdToScope(undefined)).toBe('global');
  });

  it('returns global for the resume project (personal origin)', () => {
    expect(cwdToScope('/Users/vtx/resume')).toBe('global');
  });

  it('returns global for an unknown / non-home cwd (untrusted path, T-S3-01)', () => {
    expect(cwdToScope('/tmp/whatever')).toBe('global');
    expect(cwdToScope('/opt/project')).toBe('global');
  });

  it('supports a linux-style home prefix', () => {
    expect(cwdToScope('/home/vtx/brain-memory')).toBe('brain-memory');
    expect(cwdToScope('/home/vtx')).toBe('global');
  });
});

describe('resolveNodeScope', () => {
  it('returns the single distinct non-global scope', () => {
    expect(resolveNodeScope(['vtx'])).toBe('vtx');
  });

  it('collapses repeated identical scopes to that scope', () => {
    expect(resolveNodeScope(['vtx', 'vtx'])).toBe('vtx');
  });

  it('returns global when contributing episodes span more than one project', () => {
    expect(resolveNodeScope(['vtx', 'putyouon'])).toBe('global');
  });

  it('returns global for no contributing scopes', () => {
    expect(resolveNodeScope([])).toBe('global');
  });

  it('returns global when every contributing scope is global', () => {
    expect(resolveNodeScope(['global', 'global'])).toBe('global');
  });

  it('keeps the single project scope when mixed with global (global is not a project)', () => {
    expect(resolveNodeScope(['vtx', 'global'])).toBe('vtx');
  });
});
