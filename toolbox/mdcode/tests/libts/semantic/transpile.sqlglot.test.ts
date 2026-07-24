// Tests for the real sqlglot mechanism (src/libts/semantic/transpile.ts:
// sqlglotTranspiler), which shells out to Python.
//
// Two layers:
//   1. A *mechanism-invariant* test that always runs (even with sqlglot absent):
//      the adapter must return exactly one result per request, each with `sql`
//      XOR `error`, and must never throw. This exercises spawn + JSON + the
//      Python ImportError branch in the exact CI environment.
//   2. A *transformation* test gated on `sqlglotAvailable()`: a concrete
//      Snowflake -> BigQuery rewrite, asserted leniently for version robustness.

import { describe, test, expect } from 'bun:test';
import { sqlglotTranspiler, TranspileRequest } from '../../../src/libts/semantic/transpile';
import { sqlglotAvailable } from './sqlglot_probe';

const REQUESTS: TranspileRequest[] = [
  { id: '0', dialect: 'SNOWFLAKE', expression: "IFF(orders.o_orderstatus = 'F', 1, 0)" },
  { id: '1', dialect: 'SNOWFLAKE', expression: 'NVL(orders.o_clerk, x)' },
  { id: '2', dialect: 'POSTGRES', expression: 'orders.o_comment::text' },
];


describe('the sqlglot adapter honors its contract regardless of environment', () => {
  test('returns one result per request, each sql XOR error, never throwing', async () => {
    const results = await sqlglotTranspiler(REQUESTS, 'BIGQUERY');
    expect(results).toHaveLength(REQUESTS.length);
    // Every request id is represented exactly once.
    expect(results.map(r => r.id).sort()).toEqual(['0', '1', '2']);
    for (const r of results) {
      const hasSql = r.sql !== undefined;
      const hasErr = r.error !== undefined;
      expect(hasSql).not.toBe(hasErr); // exactly one is set
    }
  });

  test('an empty request list resolves to an empty result (no subprocess)', async () => {
    expect(await sqlglotTranspiler([], 'BIGQUERY')).toEqual([]);
  });

  test('a missing interpreter degrades to per-request errors, not a throw', async () => {
    const prev = process.env.KCMD_PYTHON;
    process.env.KCMD_PYTHON = '/nonexistent/python-binary-xyz';
    try {
      const results = await sqlglotTranspiler(REQUESTS, 'BIGQUERY');
      expect(results).toHaveLength(REQUESTS.length);
      expect(results.every(r => r.error !== undefined && r.sql === undefined)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.KCMD_PYTHON;
      else process.env.KCMD_PYTHON = prev;
    }
  });
});


describe('sqlglot performs the expected Snowflake -> BigQuery transformation', () => {
  test.skipIf(!sqlglotAvailable())('IFF becomes IF and keeps the entity qualifier', async () => {
    const [res] = await sqlglotTranspiler(
      [{ id: '0', dialect: 'SNOWFLAKE', expression: "IFF(orders.o_orderstatus = 'F', 1, 0)" }],
      'BIGQUERY');
    expect(res.error).toBeUndefined();
    // Leniently: IFF -> IF, and the `orders.` qualifier survives (the guard relies
    // on this). Avoid asserting exact whitespace for version robustness.
    expect(res.sql).toContain('IF(');
    expect(res.sql).not.toContain('IFF(');
    expect(res.sql).toContain('orders.o_orderstatus');
  });
});
