// Behavior specification for the semantic-model loader
// (src/libts/semantic/loader.ts).
//
// The loader reads the subset of an open, AI-first semantics format needed to
// normalize a model into the IR. Each test names one behavior. Focused tests use
// `fromDocument` with object literals; document-level tests parse raw YAML/JSON
// text via `loadModels`. This file asserts only the IR — the BigQuery generator
// is covered by `bigquery.test.ts` (unit) and `bigquery.e2e.test.ts` (file -> DDL).
//

import { describe, test, expect } from 'bun:test';
import { loadModels, fromDocument } from '../../../src/libts/semantic/loader';

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

  test('backtick- or double-quoted identifiers are unquoted', () => {
    const { models } = fromDocument({
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: '`proj`.`ds`.`tbl`', primary_key: ['id'], fields: [] }] }],
    });
    expect(models[0].entities[0].dataSource).toEqual({ project: 'proj', dataset: 'ds', table: 'tbl' });
  });

  test('more than three dotted parts warns, keeping the remainder as the table', () => {
    const { models, warnings } = fromDocument({
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: 'p.d.t.extra', primary_key: ['id'], fields: [] }] }],
    });
    expect(models[0].entities[0].dataSource).toEqual({ project: 'p', dataset: 'd', table: 't.extra' });
    expect(warnings.some(w => w.includes('dotted parts'))).toBe(true);
  });

  test('an explicit project/dataset in the source is not overridden by defaults', () => {
    const { models } = fromDocument({
      semantic_model: [{ name: 'm', datasets: [
        { name: 'a', source: 'realproj.realds.tbl', primary_key: ['id'], fields: [] }] }],
    }, { defaultProject: 'P', defaultDataset: 'D' });
    expect(models[0].entities[0].dataSource).toEqual({ project: 'realproj', dataset: 'realds', table: 'tbl' });
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

  test('dialect names are matched case-insensitively', () => {
    const { models, warnings } = fromDocument(metricDoc([
      { dialect: 'BigQuery', expression: 'SUM(orders.a)' },
    ]), { dialect: 'bigquery' });
    expect(models[0].metrics[0].expression).toBe('SUM(orders.a)');
    expect(warnings.some(w => w.includes('dialect'))).toBe(false);
  });

  test('field expressions select their dialect independently of metrics', () => {
    const { models, warnings } = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'orders', source: 'orders', primary_key: ['id'],
          fields: [
            { name: 'id', expression: expr('orders.id') },
            { name: 'net', expression: {
              dialects: [{ dialect: 'ANSI_SQL', expression: 'orders.gross - orders.tax' }] } },
          ],
        }],
      }],
    });
    const fields = models[0].entities[0].fields;
    expect(fields[0].expression).toBe('orders.id');                  // BIGQUERY, no fallback
    expect(fields[1].expression).toBe('orders.gross - orders.tax');  // ANSI_SQL fallback
    expect(warnings.some(w => w.includes("field 'orders.net'") && w.includes('ANSI_SQL'))).toBe(true);
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

  test('a composite foreign key maps column-for-column', () => {
    const { models, warnings } = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'sales', source: 'sales', primary_key: ['sale_id'], fields: [] },
          { name: 'stores', source: 'stores', primary_key: ['region', 'store_no'], fields: [] },
        ],
        relationships: [{
          name: 'sales_stores', from: 'sales', to: 'stores',
          from_columns: ['region', 'store_no'], to_columns: ['region', 'store_no'],
        }],
      }],
    });
    const rel = models[0].relationships[0];
    // Source end carries the `from` dataset's own PK; destination end carries the
    // full composite FK, column-for-column.
    expect(rel.source.joinKeys).toEqual({
      relationshipColumns: ['sale_id'], entityColumns: ['sale_id'] });
    expect(rel.destination.joinKeys).toEqual({
      relationshipColumns: ['region', 'store_no'], entityColumns: ['region', 'store_no'] });
    expect(warnings.some(w => w.includes('different lengths'))).toBe(false);
  });

  test('the source end falls back to from_columns when the from dataset has no PK', () => {
    const { models, warnings } = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'orders', source: 'orders', fields: [] },  // no primary_key
          { name: 'customers', source: 'customers', primary_key: ['customer_id'], fields: [] },
        ],
        relationships: [{
          name: 'r', from: 'orders', to: 'customers',
          from_columns: ['customer_id'], to_columns: ['customer_id'],
        }],
      }],
    });
    expect(models[0].relationships[0].source.joinKeys).toEqual({
      relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] });
    expect(warnings.some(w => w.includes('no primary_key'))).toBe(true);
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

  test('a metric spanning multiple entities lists them all, in first-seen order', () => {
    // The loader records every referenced entity; the generator is what later
    // decides such a metric cannot be a single MEASURE. No missing-entity warning.
    const { models, warnings } = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets: [
          { name: 'orders', source: 'orders', primary_key: ['id'], fields: [] },
          { name: 'customers', source: 'customers', primary_key: ['id'], fields: [] },
        ],
        metrics: [{
          name: 'ratio',
          expression: expr('SUM(orders.amount) / COUNT(customers.id)'),
        }],
      }],
    });
    expect(models[0].metrics[0].entities).toEqual(['orders', 'customers']);
    expect(warnings.some(w => w.includes('references no known entity'))).toBe(false);
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

  test('each semantic_model entry becomes its own IR model', () => {
    const { models } = fromDocument({
      semantic_model: [
        { name: 'first', datasets: [{ name: 'a', source: 'a', primary_key: ['id'], fields: [] }] },
        { name: 'second', datasets: [{ name: 'b', source: 'b', primary_key: ['id'], fields: [] }] },
      ],
    });
    expect(models.map(m => m.name)).toEqual(['first', 'second']);
  });

  test('model and metric descriptions carry through to the IR', () => {
    const { models } = fromDocument({
      semantic_model: [{
        name: 'm', description: 'a sales model',
        datasets: [{ name: 'orders', source: 'orders', primary_key: ['id'], fields: [] }],
        metrics: [{ name: 'c', description: 'row count', expression: expr('COUNT(orders.id)') }],
      }],
    });
    expect(models[0].description).toBe('a sales model');
    expect(models[0].metrics[0].description).toBe('row count');
  });

  test('JSON text loads identically to YAML (yaml.parse accepts JSON)', () => {
    const json = JSON.stringify({
      semantic_model: [{
        name: 'm',
        datasets: [{ name: 'a', source: 'proj.ds.tbl', primary_key: ['id'], fields: [] }],
      }],
    });
    const { models } = loadModels(json);
    expect(models[0].entities[0].dataSource).toEqual({ project: 'proj', dataset: 'ds', table: 'tbl' });
  });

  test('a document without semantic_model throws', () => {
    expect(() => fromDocument({ foo: 'bar' })).toThrow(/Semantic model load error/);
  });

  test('an empty semantic_model array throws (min one model required)', () => {
    expect(() => fromDocument({ semantic_model: [] })).toThrow(/Semantic model load error/);
  });

  test('unparseable input throws', () => {
    expect(() => loadModels('{ this is : not valid')).toThrow(/load error/);
  });
});
