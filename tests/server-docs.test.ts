/**
 * tests/server-docs.test.ts — filesystem smoke test for SERVE-03 deployment artifacts.
 *
 * Asserts both docs/server-mode.md and the systemd service templates exist
 * and contain their load-bearing markers. Pure filesystem check — no server start,
 * no file-ownership overlap with serve-cli.test.ts.
 *
 * Convention pin (12-06): both templates must use ${VAR} placeholders (not angle-bracket
 * tokens) so the guide's envsubst commands work verbatim.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

const GUIDE_PATH              = join(ROOT, 'docs', 'server-mode.md');
const TEMPLATE_PATH           = join(ROOT, 'scripts', 'brain-serve.service.template');
const SCHEDULER_TEMPLATE_PATH = join(ROOT, 'scripts', 'brain-scheduler.service.template');

function readDoc(p: string): string {
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8');
}

/** Return only non-comment lines (lines not starting with '#') */
function unitBody(content: string): string {
  return content.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');
}

// ---------------------------------------------------------------------------
// scripts/brain-serve.service.template
// ---------------------------------------------------------------------------

describe('scripts/brain-serve.service.template', () => {
  it('file exists', () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
  });

  it('contains ExecStart= with serve and --host 0.0.0.0', () => {
    const content = readDoc(TEMPLATE_PATH);
    expect(content).toContain('ExecStart=');
    expect(content).toContain('serve');
    expect(content).toContain('--host 0.0.0.0');
  });

  it('contains Environment=BRAIN_MEMORY_NODE_BIN= (ABI pin)', () => {
    const content = readDoc(TEMPLATE_PATH);
    expect(content).toContain('Environment=BRAIN_MEMORY_NODE_BIN=');
  });

  it('contains EnvironmentFile= (sleep.env source)', () => {
    const content = readDoc(TEMPLATE_PATH);
    expect(content).toContain('EnvironmentFile=');
  });

  it('uses ${VAR} placeholders (envsubst-compatible)', () => {
    const content = readDoc(TEMPLATE_PATH);
    expect(content).toMatch(/\$\{[A-Z_]+\}/);
  });

  it('unit body has no <UPPER_SNAKE> angle-bracket tokens (envsubst-incompatible)', () => {
    const body = unitBody(readDoc(TEMPLATE_PATH));
    expect(body).not.toMatch(/<[A-Z_]+>/);
  });
});

// ---------------------------------------------------------------------------
// scripts/brain-scheduler.service.template
// ---------------------------------------------------------------------------

describe('scripts/brain-scheduler.service.template', () => {
  it('file exists', () => {
    expect(existsSync(SCHEDULER_TEMPLATE_PATH)).toBe(true);
  });

  it('contains ExecStart= with scheduler run', () => {
    const content = readDoc(SCHEDULER_TEMPLATE_PATH);
    expect(content).toContain('ExecStart=');
    expect(content).toContain('scheduler run');
  });

  it('contains Environment=BRAIN_MEMORY_NODE_BIN= (ABI pin)', () => {
    const content = readDoc(SCHEDULER_TEMPLATE_PATH);
    expect(content).toContain('Environment=BRAIN_MEMORY_NODE_BIN=');
  });

  it('contains EnvironmentFile= (sleep.env source)', () => {
    const content = readDoc(SCHEDULER_TEMPLATE_PATH);
    expect(content).toContain('EnvironmentFile=');
  });

  it('uses ${VAR} placeholders (envsubst-compatible)', () => {
    const content = readDoc(SCHEDULER_TEMPLATE_PATH);
    expect(content).toMatch(/\$\{[A-Z_]+\}/);
  });

  it('unit body has no <UPPER_SNAKE> angle-bracket tokens (envsubst-incompatible)', () => {
    const body = unitBody(readDoc(SCHEDULER_TEMPLATE_PATH));
    expect(body).not.toMatch(/<[A-Z_]+>/);
  });
});

// ---------------------------------------------------------------------------
// docs/server-mode.md
// ---------------------------------------------------------------------------

describe('docs/server-mode.md', () => {
  it('file exists', () => {
    expect(existsSync(GUIDE_PATH)).toBe(true);
  });

  it('has minimum 80 lines', () => {
    const lines = readDoc(GUIDE_PATH).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(80);
  });

  it('documents loopback default (127.0.0.1)', () => {
    expect(readDoc(GUIDE_PATH)).toContain('127.0.0.1');
  });

  it('documents --host 0.0.0.0 opt-in for remote exposure', () => {
    expect(readDoc(GUIDE_PATH)).toContain('--host 0.0.0.0');
  });

  it('documents reverse proxy (reverse_proxy)', () => {
    expect(readDoc(GUIDE_PATH)).toContain('reverse_proxy');
  });

  it('documents BRAIN_SERVE_TOKEN lifecycle', () => {
    expect(readDoc(GUIDE_PATH)).toContain('BRAIN_SERVE_TOKEN');
  });

  it('documents BRAIN_MEMORY_NODE_BIN ABI pin', () => {
    expect(readDoc(GUIDE_PATH)).toContain('BRAIN_MEMORY_NODE_BIN');
  });

  it('documents token rotation (## section)', () => {
    const content = readDoc(GUIDE_PATH);
    // Must have a ## section header about rotation
    expect(content).toMatch(/##\s+Token rotation/i);
  });

  it('documents no-CORS rationale (mentions CORS)', () => {
    expect(readDoc(GUIDE_PATH)).toContain('CORS');
  });

  it('references the scheduler for reboot-survival', () => {
    const content = readDoc(GUIDE_PATH);
    expect(content).toContain('scheduler');
  });

  it('contains multiple ## section headers', () => {
    const headers = readDoc(GUIDE_PATH).split('\n').filter(l => l.startsWith('## '));
    expect(headers.length).toBeGreaterThanOrEqual(4);
  });

  it('contains envsubst command for brain-serve template', () => {
    expect(readDoc(GUIDE_PATH)).toContain('envsubst < scripts/brain-serve.service.template');
  });

  it('contains envsubst command for brain-scheduler template', () => {
    expect(readDoc(GUIDE_PATH)).toContain('envsubst < scripts/brain-scheduler.service.template');
  });
});
