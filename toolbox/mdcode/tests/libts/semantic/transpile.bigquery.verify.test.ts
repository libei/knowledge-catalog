// Verifies every transpiled expression against a REAL BigQuery instance.
//
// This is the automated form of the manual check behind the transpiled golden:
// load the vendor fixture, transpile it with sqlglot, then dry-run each resulting
// GoogleSQL expression against BigQuery (project sqlgen-testing). A dry run type-
// checks the SQL and costs nothing (0 bytes scanned). Each expression is wrapped
// in a typed CTE that stands in for the source tables, so a fragment like
// `IF(orders.o_orderstatus = 'F', ...)` becomes a runnable query.
//
// It is double-gated — on sqlglot AND on `KCMD_BQ_VERIFY=1` (plus working `bq`
// auth) — so it never runs in CI or hermetically:
//
//   KCMD_BQ_VERIFY=1 KCMD_PYTHON=/path/to/venv/bin/python \
//     npx bun test ./tests/libts/semantic/transpile.bigquery.verify.test.ts

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadModels } from '../../../src/libts/semantic/loader';
import { transpileModel, sqlglotTranspiler } from '../../../src/libts/semantic/transpile';
import { sqlglotAvailable } from './sqlglot_probe';

const FIXTURES = path.join(__dirname, 'fixtures');
const PROJECT = 'sqlgen-testing';

// Typed stand-ins for the fixture's source tables, so a qualified expression
// fragment can be SELECTed and type-checked in isolation.
const CTE =
  'WITH orders AS (SELECT CAST(NULL AS INT64) AS o_orderkey, ' +
  'CAST(NULL AS INT64) AS o_custkey, CAST(NULL AS DATE) AS o_orderdate, ' +
  'CAST(NULL AS DATE) AS o_shipdate, CAST(NULL AS NUMERIC) AS o_totalprice, ' +
  'CAST(NULL AS STRING) AS o_orderstatus, CAST(NULL AS STRING) AS o_clerk, ' +
  'CAST(NULL AS STRING) AS o_comment), ' +
  'customer AS (SELECT CAST(NULL AS INT64) AS c_custkey, ' +
  'CAST(NULL AS STRING) AS c_name, CAST(NULL AS NUMERIC) AS c_acctbal, ' +
  'CAST(NULL AS STRING) AS c_mktsegment, CAST(NULL AS STRING) AS c_phone) ';

const enabled = process.env.KCMD_BQ_VERIFY === '1' && sqlglotAvailable();

// Transpile the fixture and collect every (label, GoogleSQL expression) pair.
function transpiledExpressions(): Promise<Array<{ label: string; expr: string }>> {
  const text = fs.readFileSync(path.join(FIXTURES, 'vendor_dialects.yaml'), 'utf8');
  const { models } = loadModels(text, { defaultProject: PROJECT, defaultDataset: 'demo' });
  return transpileModel(models[0], { target: 'BIGQUERY', transpiler: sqlglotTranspiler })
    .then(({ model }) => {
      const out: Array<{ label: string; expr: string }> = [];
      for (const e of model.entities) {
        for (const f of e.fields) out.push({ label: `field ${e.name}.${f.name}`, expr: f.expression });
      }
      for (const m of model.metrics) out.push({ label: `metric ${m.name}`, expr: m.expression });
      return out;
    });
}

function dryRun(sql: string): { ok: boolean; detail: string } {
  const r = spawnSync('bq',
    [`--project_id=${PROJECT}`, 'query', '--dry_run', '--use_legacy_sql=false', sql],
    { encoding: 'utf8', timeout: 90_000 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: output.includes('successfully validated'), detail: output.trim().split('\n').pop() ?? '' };
}


describe('every transpiled expression is valid GoogleSQL against real BigQuery', () => {
  test.skipIf(!enabled)('each fixture expression dry-runs successfully', async () => {
    const items = await transpiledExpressions();
    expect(items.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const { label, expr } of items) {
      const { ok, detail } = dryRun(`${CTE}SELECT ${expr} FROM orders, customer`);
      if (!ok) failures.push(`${label}: ${expr}\n    ${detail}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
