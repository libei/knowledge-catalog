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


// A two-hop fan-out model (order_items -> orders -> customers) parsed from YAML
// text, then generated into property-graph DDL.
//
// This fixture was executed against a live BigQuery instance (project
// `sqlgen-testing`): the generated `CREATE OR REPLACE PROPERTY GRAPH` was
// accepted, and its measures were validated with GRAPH_EXPAND + AGG against a
// plain-SQL control. For the `west` region the graph returned total_revenue 135
// and order_count 3 (not 4) — confirming that the loaded `order_count` lands on
// the `orders` node and is deduplicated per order despite the order_items
// fan-out. These text assertions pin the same behavior without a live instance.
const SALES_YAML = `
version: 0.2.0.dev0
semantic_model:
  - name: sales_graph
    datasets:
      - name: customers
        source: customers
        primary_key: [customer_id]
        fields:
          - { name: customer_id, expression: { dialects: [{ dialect: BIGQUERY, expression: customers.customer_id }] } }
          - { name: region, expression: { dialects: [{ dialect: BIGQUERY, expression: customers.region }] } }
      - name: orders
        source: orders
        primary_key: [order_id]
        fields:
          - { name: order_id, expression: { dialects: [{ dialect: BIGQUERY, expression: orders.order_id }] } }
          - { name: customer_id, expression: { dialects: [{ dialect: BIGQUERY, expression: orders.customer_id }] } }
      - name: order_items
        source: order_items
        primary_key: [order_item_id]
        fields:
          - { name: order_item_id, expression: { dialects: [{ dialect: BIGQUERY, expression: order_items.order_item_id }] } }
          - { name: order_id, expression: { dialects: [{ dialect: BIGQUERY, expression: order_items.order_id }] } }
          - { name: amount, expression: { dialects: [{ dialect: BIGQUERY, expression: order_items.amount }] } }
    relationships:
      - { name: orders_customers, from: orders, to: customers, from_columns: [customer_id], to_columns: [customer_id] }
      - { name: orderitems_orders, from: order_items, to: orders, from_columns: [order_id], to_columns: [order_id] }
    metrics:
      - name: total_revenue
        expression: { dialects: [{ dialect: BIGQUERY, expression: "SUM(order_items.amount)" }] }
      - name: order_count
        expression: { dialects: [{ dialect: BIGQUERY, expression: "COUNT(orders.order_id)" }] }
`;

describe('end-to-end: a model parsed from YAML text generates property-graph DDL', () => {
  const { models, warnings } = loadModels(SALES_YAML, { defaultProject: 'p', defaultDataset: 'd' });
  const { ddl } = generatePropertyGraph(models[0], { project: 'p', dataset: 'd' });

  test('exactly one clean model loads (no warnings)', () => {
    expect(models).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test('entities become keyed node tables over their base tables', () => {
    expect(ddl).toContain('`p.d.customers` AS customers');
    expect(ddl).toContain('KEY(order_item_id)');
  });

  test('the metric becomes an inline measure on its owning entity', () => {
    expect(ddl).toContain('MEASURE(SUM(amount)) AS total_revenue');
  });

  test('a count metric lands on its own entity node, not the fan-out table', () => {
    // order_count counts orders, so it must sit on the `orders` node (keyed by
    // order_id) — this is what makes GRAPH_EXPAND + AGG return 3 orders for the
    // west region rather than 4 (the order_items count). Verified live.
    const ordersBlock = ddl.slice(ddl.indexOf('AS orders\n'), ddl.indexOf('AS order_items'));
    expect(ordersBlock).toContain('MEASURE(COUNT(order_id)) AS order_count');
  });

  test('relationships become edge tables referencing the node labels', () => {
    expect(ddl).toContain('SOURCE KEY(order_id) REFERENCES orders(order_id)');
    expect(ddl).toContain('DESTINATION KEY(customer_id) REFERENCES customers(customer_id)');
  });
});
