// End-to-end tests for the BigQuery destination: real-shaped fixtures run the
// full file -> IR -> DDL path, pinning that the AI-first `ai_context`, field
// `description`/`label`/`dimension.is_time`, and dialect selection survive the
// translation and land as BigQuery `OPTIONS(...)`.
//
// These tests read the corpus fixtures under `fixtures/` (models in the AI-first
// semantics format, neutralized). They pin where descriptions, folded synonyms,
// and time-dimension markers land in the generated property graph, and the
// warnings emitted when an expression has no target-dialect variant.
//
// Unit-level tests for the same generator live in `bigquery.test.ts`.

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { loadModels, LoadOptions } from '../../../src/libts/semantic/loader';
import { generatePropertyGraph } from '../../../src/libts/semantic/bigquery';

const FIXTURES = path.join(__dirname, 'fixtures');

// Loads a fixture file and generates its property-graph DDL in one step, so a
// test can assert over both the load warnings and the emitted DDL.
function build(fixture: string, load: LoadOptions = {}) {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  const opts = { defaultProject: 'sqlgen-testing', defaultDataset: 'demo', ...load };
  const { models, warnings: loadWarnings } = loadModels(text, opts);
  const { ddl, warnings: genWarnings } =
    generatePropertyGraph(models[0], { project: 'sqlgen-testing', dataset: 'demo' });
  return { models, ddl, loadWarnings, genWarnings };
}


describe('star fixture: ai_context and field metadata reach the DDL as OPTIONS', () => {
  const { ddl } = build('star_orders_customer.yaml');

  test('a model description + ai_context instructions become the graph OPTIONS', () => {
    // Model has no synonyms slot, so instructions are folded into the description
    // and emitted as the trailing graph-level OPTIONS (after EDGE TABLES).
    expect(ddl).toContain(
      'OPTIONS(description="Sales orders with customer attributes\\n\\nUse this model for order analysis.");');
  });

  test('a dataset description becomes the node DEFAULT LABEL OPTIONS', () => {
    expect(ddl).toContain('KEY(o_orderkey)\n    OPTIONS(description="One row per order")');
  });

  test('a field description becomes property OPTIONS', () => {
    expect(ddl).toContain('o_orderkey OPTIONS(description="Order identifier")');
  });

  test('a time dimension folds label, is_time marker, and synonyms into one description', () => {
    // o_orderdate has no `description`, so its `label` ("Order Date") seeds the
    // text; is_time adds the marker; field ai_context synonyms are appended.
    expect(ddl).toContain(
      'o_orderdate OPTIONS(description="Order Date\\n\\nTime dimension.\\n\\nSynonyms: order date, date")');
  });

  test('a metric description + synonyms attach to the MEASURE', () => {
    expect(ddl).toContain(
      'MEASURE(SUM(o_totalprice)) AS total_revenue OPTIONS(description="Total order revenue\\n\\nSynonyms: revenue, sales")');
  });

  test('a field with no metadata is emitted bare, with no OPTIONS', () => {
    expect(ddl).toContain('o_custkey,\n');
    expect(ddl).not.toContain('o_custkey OPTIONS');
  });
});


describe('dialect selection warns clearly when the target dialect is absent', () => {
  test('an ANSI-only expression falls back to ANSI with a not-transpiled warning', () => {
    // The star fixture supplies only ANSI_SQL; the default target is BIGQUERY.
    const { loadWarnings } = build('star_orders_customer.yaml');
    expect(loadWarnings).toContain(
      "field 'orders.o_orderkey': no 'BIGQUERY' dialect; using 'ANSI_SQL' expression verbatim (not transpiled to 'BIGQUERY')");
  });

  test('with no ANSI fallback, the first listed dialect is used and named in the warning', () => {
    // The lineitem fixture supplies only DATABRICKS: neither BIGQUERY nor the
    // ANSI_SQL fallback exists, so the loader uses DATABRICKS verbatim and says so.
    const { loadWarnings } = build('lineitem_databricks_ext.yaml');
    expect(loadWarnings).toContain(
      "metric 'revenue': no 'BIGQUERY' or 'ANSI_SQL' dialect; using 'DATABRICKS' expression verbatim (not transpiled to 'BIGQUERY')");
  });

  test('selecting the matching dialect explicitly produces no fallback warning', () => {
    const { loadWarnings } = build('star_orders_customer.yaml', { dialect: 'ANSI_SQL' });
    expect(loadWarnings.filter(w => w.includes('not transpiled'))).toEqual([]);
  });
});


describe('vendor escape hatches are accepted and ignored, not fatal', () => {
  // The lineitem fixture carries custom_extensions at field/relationship/metric/
  // model level and unique_keys on a dataset with no primary_key. None of these
  // are part of the supported subset; the loader must accept and skip them.
  const { models, loadWarnings } = build('lineitem_databricks_ext.yaml');

  test('the model still loads despite custom_extensions and unique_keys', () => {
    expect(models).toHaveLength(1);
    expect(models[0].entities.map(e => e.name)).toEqual(['lineitem', 'orders']);
  });

  test('a dataset with only unique_keys (no primary_key) is warned about', () => {
    expect(loadWarnings).toContain(
      "dataset 'orders': no primary_key; the entity's KEY will be empty (invalid for graph generation)");
  });
});


describe('richer corpus fixtures carry metadata through without breaking', () => {
  test('composite primary keys render as a multi-column node KEY', () => {
    const { ddl } = build('tpcds_retail.yaml');
    expect(ddl).toContain('KEY(ss_item_sk, ss_ticket_number)');
  });

  test('a computed field renders as `<expr> AS <name>` with its description', () => {
    const { ddl } = build('tpcds_retail.yaml');
    expect(ddl).toContain(
      "c_first_name || ' ' || c_last_name AS customer_full_name " +
      'OPTIONS(description="Customer full name (computed field)\\n\\nSynonyms: full name, customer name")');
  });

  test('a relationship with only synonyms still emits an edge-label OPTIONS', () => {
    const { ddl } = build('tpcds_retail.yaml');
    expect(ddl).toContain('OPTIONS(description="Synonyms: customer purchase relationship, who bought")');
  });

  test('cross-dataset ratio metrics are flagged and skipped (Phase B will decompose them)', () => {
    // Until GRAPH_EXPAND decomposition lands, a metric whose aggregate spans two
    // tables cannot be a single MEASURE; the generator must flag it, not drop it
    // silently.
    const { genWarnings } = build('tpcds_retail.yaml');
    expect(genWarnings).toContain(
      "metric 'customer_lifetime_value' spans multiple tables (store_sales, customer); skipped (cannot be a single MEASURE)");
    expect(genWarnings).toContain(
      "metric 'store_productivity' spans multiple tables (store_sales, store); skipped (cannot be a single MEASURE)");
  });

  test('every corpus fixture loads to exactly one model', () => {
    for (const f of ['star_orders_customer.yaml', 'lineitem_databricks_ext.yaml',
                     'tpcds_retail.yaml', 'tpcds_date_edge.yaml']) {
      const { models } = build(f);
      expect(models).toHaveLength(1);
    }
  });
});
