/**
 * Tests for src/model/typed-predicates.ts
 * TYPED-01a: PREDICATES vocab closed set (12 predicates)
 * TYPED-01b: parseTriples filters out-of-vocab predicates
 */
import { describe, it, expect } from 'vitest';
import {
  PREDICATES,
  PRED_SET,
  parseTriples,
  PREDICATE_GLOSSES,
} from '../src/model/typed-predicates';
import type { Triple, Predicate } from '../src/model/typed-predicates';

describe('PREDICATES', () => {
  it('contains exactly 12 predicates', () => {
    expect(PREDICATES.length).toBe(12);
  });

  it('contains all expected predicates', () => {
    const expected = [
      'built_by',
      'works_on',
      'part_of',
      'uses',
      'depends_on',
      'runs_on',
      'located_in',
      'integrates_with',
      'supersedes',
      'prefers',
      'evaluated',
      'configured_with',
    ];
    for (const pred of expected) {
      expect(PREDICATES).toContain(pred);
    }
  });

  it('starts with built_by and ends with configured_with', () => {
    expect(PREDICATES[0]).toBe('built_by');
    expect(PREDICATES[PREDICATES.length - 1]).toBe('configured_with');
  });
});

describe('PRED_SET', () => {
  it('has size 12', () => {
    expect(PRED_SET.size).toBe(12);
  });

  it('contains all predicates from PREDICATES', () => {
    for (const p of PREDICATES) {
      expect(PRED_SET.has(p)).toBe(true);
    }
  });

  it('does not contain out-of-vocab predicates', () => {
    expect(PRED_SET.has('is_a')).toBe(false);
    expect(PRED_SET.has('links_to')).toBe(false);
    expect(PRED_SET.has('extends')).toBe(false);
    expect(PRED_SET.has('')).toBe(false);
  });
});

describe('PREDICATE_GLOSSES', () => {
  it('has an entry for every predicate in PREDICATES', () => {
    for (const pred of PREDICATES) {
      expect(PREDICATE_GLOSSES[pred as Predicate]).toBeTruthy();
      expect(typeof PREDICATE_GLOSSES[pred as Predicate]).toBe('string');
    }
  });

  it('has exactly 12 entries', () => {
    expect(Object.keys(PREDICATE_GLOSSES).length).toBe(12);
  });

  it('located_in gloss mentions location/storage', () => {
    expect(PREDICATE_GLOSSES['located_in']).toMatch(/located|stored|repo|dir/i);
  });
});

describe('parseTriples', () => {
  it('parses a valid triple with a known predicate', () => {
    const input = '[{"subject":"recense","predicate":"uses","object":"better-sqlite3"}]';
    const result = parseTriples(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual<Triple>({
      subject: 'recense',
      predicate: 'uses',
      object: 'better-sqlite3',
    });
  });

  it('returns [] on empty string', () => {
    expect(parseTriples('')).toEqual([]);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseTriples('{not valid json')).toEqual([]);
    expect(parseTriples('[{bad}]')).toEqual([]);
  });

  it('returns [] on non-array JSON', () => {
    expect(parseTriples('{"subject":"a","predicate":"uses","object":"b"}')).toEqual([]);
  });

  it('drops triples with out-of-vocab predicate', () => {
    const input = '[{"subject":"recense","predicate":"is_a","object":"tool"}]';
    expect(parseTriples(input)).toEqual([]);
  });

  it('drops triples with empty predicate', () => {
    const input = '[{"subject":"recense","predicate":"","object":"tool"}]';
    expect(parseTriples(input)).toEqual([]);
  });

  it('drops triples where subject === object (V5 self-referential guard)', () => {
    const input = '[{"subject":"recense","predicate":"uses","object":"recense"}]';
    expect(parseTriples(input)).toEqual([]);
  });

  it('keeps triple where subject !== object', () => {
    const input = '[{"subject":"recense","predicate":"uses","object":"better-sqlite3"}]';
    const result = parseTriples(input);
    expect(result).toHaveLength(1);
  });

  it('drops triples with empty subject', () => {
    const input = '[{"subject":"","predicate":"uses","object":"better-sqlite3"}]';
    expect(parseTriples(input)).toEqual([]);
  });

  it('drops triples with empty object', () => {
    const input = '[{"subject":"recense","predicate":"uses","object":""}]';
    expect(parseTriples(input)).toEqual([]);
  });

  it('trims whitespace from subject, predicate, object', () => {
    const input = '[{"subject":" recense ","predicate":" uses ","object":" better-sqlite3 "}]';
    const result = parseTriples(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.subject).toBe('recense');
    expect(result[0]?.predicate).toBe('uses');
    expect(result[0]?.object).toBe('better-sqlite3');
  });

  it('keeps valid triples and drops invalid ones in a mixed array', () => {
    const input = JSON.stringify([
      { subject: 'Max', predicate: 'works_on', object: 'recense' },
      { subject: 'recense', predicate: 'is_a', object: 'tool' },      // out-of-vocab
      { subject: 'recense', predicate: 'uses', object: 'recense' },   // self-referential
      { subject: 'recense', predicate: 'uses', object: 'better-sqlite3' },
    ]);
    const result = parseTriples(input);
    expect(result).toHaveLength(2);
    expect(result[0]?.predicate).toBe('works_on');
    expect(result[1]?.predicate).toBe('uses');
    expect(result[1]?.object).toBe('better-sqlite3');
  });

  it('handles all 12 predicates', () => {
    const triples = (PREDICATES as readonly string[]).map(pred => ({
      subject: 'A',
      predicate: pred,
      object: 'B',
    }));
    const result = parseTriples(JSON.stringify(triples));
    expect(result).toHaveLength(12);
    expect(result.map((t: Triple) => t.predicate)).toEqual([...PREDICATES] as Predicate[]);
  });

  it('returns [] when array items are not objects', () => {
    expect(parseTriples('["string", 42, null]')).toEqual([]);
  });
});
