// Behavior specification for the semantic-model loader
// (src/libts/semantic/loader.ts).
//
// The loader reads the subset of an open, AI-first semantics format needed to
// normalize a model into the IR. Each test names one behavior. Focused tests use
// `fromDocument` with object literals; the end-to-end block parses YAML text and
// runs the loaded model through the BigQuery generator to prove the full
// file -> IR -> DDL path.
//

import { describe, test, expect } from 'bun:test';
import { loadModels, fromDocument } from '../../src/libts/semantic/loader';
import { generatePropertyGraph } from '../../src/libts/semantic/bigquery';

// Shorthand for the format's per-dialect expression object.
function expr(expression: string, dialect = 'BIGQUERY') {
  return { dialects: [{ dialect, expression }] };
}


describe('dataset source strings parse into structured table refs', () => {
  const { models } = fromDocument({
    semantic_model: [{
      name: 'm',
      datasets: [
        { name: 'a', source: 'proj.ds.tbl', primary_key: ['id'], fields: [] },
        { name: 'b', source: 'ds.tbl', primary_key: ['id'], fields: [] },
        { name: 'c', source: 'tbl', primary_key: ['id'], fields: [] },
      ],
    }],
  }, { defaultProject: 'P', defaultDataset: 'D' });
  const [a, b, c] = models[0].entities;

  test('a three-part source becomes project.dataset.table', () => {
    expect(a.dataSource).toEqual({ project: 'proj', dataset: 'ds', table: 'tbl' });
  });

  test('a two-part source becomes dataset.table, project from defaults', () => {
    expect(b.dataSource).toEqual({ project: 'P', dataset: 'ds', table: 'tbl' });
  });

  test('a bare table fills both project and dataset from defaults', () => {
    expect(c.dataSource).toEqual({ project: 'P', dataset: 'D', table: 'tbl' });
  });

  test('a query-like source is kept verbatim with a warning', () => {
    const { models, warnings } = fromDocument({
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: 'SELECT 1 FROM t', primary_key: ['id'], fields: [] }] }],
    });
    expect(models[0].entities[0].dataSource.table).toBe('SELECT 1 FROM t');
    expect(warnings.some(w => w.includes('looks like a query'))).toBe(true);
  });

  test('a dataset without a primary key warns (its KEY would be empty)', () => {
    const { warnings } = fromDocument({
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: 'a', fields: [] }] }],
    });
    expect(warnings.some(w => w.includes('no primary_key'))).toBe(true);
  });
});


describe('per-dialect expressions collapse to a single string', () => {
  function metricDoc(dialectList: Array<{ dialect: string; expression: string }>) {
    return {
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'orders', source: 'orders', primary_key: ['id'], fields: [] }],
        metrics: [{ name: 'mx', expression: { dialects: dialectList } }],
      }],
    };
  }

  test('the preferred dialect (BIGQUERY) is chosen with no warning', () => {
    const { models, warnings } = fromDocument(metricDoc([
      { dialect: 'ANSI_SQL', expression: 'SUM(orders.a)' },
      { dialect: 'BIGQUERY', expression: 'SUM(orders.b)' },
    ]));
    expect(models[0].metrics[0].expression).toBe('SUM(orders.b)');
    expect(warnings.some(w => w.includes('dialect'))).toBe(false);
  });

  test('ANSI_SQL is the fallback when the preferred dialect is absent', () => {
    const { models, warnings } = fromDocument(metricDoc([
      { dialect: 'ANSI_SQL', expression: 'SUM(orders.a)' },
    ]));
    expect(models[0].metrics[0].expression).toBe('SUM(orders.a)');
    expect(warnings.some(w => w.includes("using 'ANSI_SQL'"))).toBe(true);
  });

  test('otherwise the first listed dialect is used, with a warning', () => {
    const { models, warnings } = fromDocument(metricDoc([
      { dialect: 'SNOWFLAKE', expression: 'SUM(orders.a)' },
    ]));
    expect(models[0].metrics[0].expression).toBe('SUM(orders.a)');
    expect(warnings.some(w => w.includes("using 'SNOWFLAKE'"))).toBe(true);
  });

  test('an explicit dialect option overrides the default preference', () => {
    const { models } = fromDocument(metricDoc([
      { dialect: 'SNOWFLAKE', expression: 'SF' },
      { dialect: 'BIGQUERY', expression: 'BQ' },
    ]), { dialect: 'SNOWFLAKE' });
    expect(models[0].metrics[0].expression).toBe('SF');
  });
});


describe('relationships map onto the direct-FK IR convention', () => {
  const { models } = fromDocument({
    semantic_model: [{
      name: 'm',
      datasets: [
        { name: 'orders', source: 'orders', primary_key: ['order_id'], fields: [] },
        { name: 'customers', source: 'customers', primary_key: ['customer_id'], fields: [] },
      ],
      relationships: [{
        name: 'orders_customers', from: 'orders', to: 'customers',
        from_columns: ['customer_id'], to_columns: ['customer_id'],
      }],
    }],
  });
  const rel = models[0].relationships[0];

  test('the source end carries the from-dataset primary key', () => {
    expect(rel.source).toEqual({
      entity: 'orders',
      joinKeys: { relationshipColumns: ['order_id'], entityColumns: ['order_id'] },
    });
  });

  test('the destination end carries from_columns -> to_columns', () => {
    expect(rel.destination).toEqual({
      entity: 'customers',
      joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] },
    });
  });

  test('no association dataSource is set (it is a direct foreign key)', () => {
    expect(rel.dataSource).toBeUndefined();
  });

  test('an unresolved from/to dataset produces a warning', () => {
    const { warnings } = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'orders', source: 'orders', primary_key: ['order_id'], fields: [] }],
        relationships: [{
          name: 'r', from: 'orders', to: 'ghost',
          from_columns: ['g_id'], to_columns: ['id'],
        }],
      }],
    });
    expect(warnings.some(w => w.includes("'to' dataset 'ghost'"))).toBe(true);
  });

  test('mismatched from_columns/to_columns arity warns (invalid join keys)', () => {
    const { warnings } = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'orders', source: 'orders', primary_key: ['order_id'], fields: [] },
          { name: 'customers', source: 'customers', primary_key: ['a', 'b'], fields: [] },
        ],
        relationships: [{
          name: 'r', from: 'orders', to: 'customers',
          from_columns: ['x', 'y'], to_columns: ['a'],
        }],
      }],
    });
    expect(warnings.some(w => w.includes('different lengths'))).toBe(true);
  });
});


describe('metrics infer their referenced entities from the expression', () => {
  test('entities are derived from the qualifiers present in the expression', () => {
    const { models } = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'order_items', source: 'order_items', primary_key: ['id'], fields: [] }],
        metrics: [{ name: 'total_revenue', expression: expr('SUM(order_items.amount)') }],
      }],
    });
    expect(models[0].metrics[0].entities).toEqual(['order_items']);
  });

  test('a metric referencing no known entity warns', () => {
    const { warnings } = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'order_items', source: 'order_items', primary_key: ['id'], fields: [] }],
        metrics: [{ name: 'weird', expression: expr('SUM(unknown.x)') }],
      }],
    });
    expect(warnings.some(w => w.includes('references no known entity'))).toBe(true);
  });

  test('a qualifier inside a string literal is not counted as a reference', () => {
    // 'customers.region' is data, not a column reference, so the metric must be
    // attributed only to order_items.
    const { models } = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'order_items', source: 'order_items', primary_key: ['id'], fields: [] },
          { name: 'customers', source: 'customers', primary_key: ['id'], fields: [] },
        ],
        metrics: [{
          name: 'tagged',
          expression: expr("CONCAT(SUM(order_items.amount), 'customers.region')"),
        }],
      }],
    });
    expect(models[0].metrics[0].entities).toEqual(['order_items']);
  });
});


describe('document-level handling', () => {
  test('a mismatched version warns but still loads', () => {
    const { models, warnings } = fromDocument({
      version: '9.9.9',
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: 'a', primary_key: ['id'], fields: [] }] }],
    });
    expect(models).toHaveLength(1);
    expect(warnings.some(w => w.includes('differs from the supported'))).toBe(true);
  });

  test('unknown/extra fields outside the subset are ignored, not errors', () => {
    const { models } = fromDocument({
      semantic_model: [{
        name: 'm',
        ai_context: { instructions: 'ignored' },
        custom_extensions: [{ vendor_name: 'X', data: '{}' }],
        datasets: [{
          name: 'a', source: 'a', primary_key: ['id'],
          unique_keys: [['id']],
          fields: [{
            name: 'id', label: 'ignored', dimension: { is_time: false },
            expression: expr('a.id'),
          }],
        }],
      }],
    });
    expect(models[0].entities[0].fields[0].name).toBe('id');
  });

  test('duplicate dataset names warn (only one node table can carry the label)', () => {
    const { warnings } = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'orders', source: 'a', primary_key: ['id'], fields: [] },
          { name: 'orders', source: 'b', primary_key: ['id'], fields: [] },
        ],
      }],
    });
    expect(warnings.some(w => w.includes("duplicate dataset name 'orders'"))).toBe(true);
  });

  test('a document without semantic_model throws', () => {
    expect(() => fromDocument({ foo: 'bar' })).toThrow(/Semantic model load error/);
  });

  test('unparseable input throws', () => {
    expect(() => loadModels('{ this is : not valid')).toThrow(/load error/);
  });
});


// End-to-end: parse YAML text, then generate BigQuery DDL from the loaded model.
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
`;

describe('end-to-end: a loaded model generates BigQuery property-graph DDL', () => {
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

  test('relationships become edge tables referencing the node labels', () => {
    expect(ddl).toContain('SOURCE KEY(order_id) REFERENCES orders(order_id)');
    expect(ddl).toContain('DESTINATION KEY(customer_id) REFERENCES customers(customer_id)');
  });
});
