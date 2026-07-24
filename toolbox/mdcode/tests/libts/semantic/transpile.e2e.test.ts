// End-to-end golden for the transpile pass: the full file -> IR -> transpile ->
// DDL path over the vendor-dialect fixture, using the REAL sqlglot mechanism.
//
// This is the counterpart to bigquery.e2e.test.ts. That golden
// (`vendor_dialects.bigquery.golden.sql`) captures the DEFAULT pipeline, where
// vendor SQL passes through verbatim with a "not transpiled" warning per field.
// This golden (`vendor_dialects.bigquery.transpiled.golden.sql`) captures the
// same fixture run THROUGH `transpileModel`, so every expression is GoogleSQL.
//
// Because it needs Python + sqlglot, the whole file is gated on
// `sqlglotAvailable()` and skips hermetically. Regenerate the golden with the
// mechanism present:
//
//   KCMD_PYTHON=/path/to/venv/bin/python UPDATE_GOLDENS=1 \
//     npx bun test ./tests/libts/semantic/transpile.e2e.test.ts
//
// Every GoogleSQL expression in the golden was additionally dry-run-validated
// against a real BigQuery instance — see transpile.bigquery.verify.test.ts.

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { loadModels } from '../../../src/libts/semantic/loader';
import { transpileModel, sqlglotTranspiler } from '../../../src/libts/semantic/transpile';
import { generatePropertyGraph } from '../../../src/libts/semantic/bigquery';
import { sqlglotAvailable } from './sqlglot_probe';

const FIXTURES = path.join(__dirname, 'fixtures');
const FIXTURE = 'vendor_dialects.yaml';
const GOLDEN = path.join(FIXTURES, 'vendor_dialects.bigquery.transpiled.golden.sql');

// Builds the transpiled artifact: DDL + a warnings block. The loader's
// "not transpiled to" lines are dropped because the transpile pass supersedes
// them with its own per-expression outcome (a stale contradiction otherwise);
// its transpiled/kept-verbatim notes and any generator warnings are kept.
async function render(): Promise<string> {
  const text = fs.readFileSync(path.join(FIXTURES, FIXTURE), 'utf8');
  const opts = { defaultProject: 'sqlgen-testing', defaultDataset: 'demo' };
  const { models, warnings: loadWarnings } = loadModels(text, opts);
  const { model, warnings: transpileWarnings } =
    await transpileModel(models[0], { target: 'BIGQUERY', transpiler: sqlglotTranspiler });
  const { ddl, warnings: genWarnings } =
    generatePropertyGraph(model, { project: 'sqlgen-testing', dataset: 'demo' });

  const kept = loadWarnings.filter(w => !w.includes('not transpiled to'));
  const warnings = [...kept, ...transpileWarnings, ...genWarnings];
  const warnBlock = warnings.length ? warnings.map(w => `-- ${w}`).join('\n') : '-- (none)';
  return `${ddl}\n-- warnings --\n${warnBlock}\n`;
}


describe('golden DDL: the vendor fixture transpiled to GoogleSQL via sqlglot', () => {
  test.skipIf(!sqlglotAvailable())(FIXTURE, async () => {
    const actual = await render();
    if (process.env.UPDATE_GOLDENS) {
      fs.writeFileSync(GOLDEN, actual);
      return;
    }
    if (!fs.existsSync(GOLDEN)) {
      throw new Error(
        `missing golden ${path.basename(GOLDEN)} — run with sqlglot + UPDATE_GOLDENS=1 to create it`);
    }
    expect(actual).toBe(fs.readFileSync(GOLDEN, 'utf8'));
  });
});
