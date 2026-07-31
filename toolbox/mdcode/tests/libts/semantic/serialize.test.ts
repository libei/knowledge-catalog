// Tests for the IR -> YAML serializer (src/libts/semantic/serialize.ts), the
// inverse of the loader. The core property is a round trip: loading a document,
// serializing the IR back to YAML, and reloading yields an IR-equivalent model.
// Authoring sugar the loader flattens (per-dialect variants, ai_context
// structure, labels, comments) is not reproduced, but everything the IR retains
// round-trips exactly.

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { loadModels, LoadOptions } from '../../../src/libts/semantic/loader';
import { serializeModel, modelDocument } from '../../../src/libts/semantic/serialize';
import { SemanticModel } from '../../../src/libts/semantic/ir';

const FIXTURES = path.join(__dirname, 'fixtures');
const LOAD: LoadOptions = { defaultProject: 'sqlgen-testing', defaultDataset: 'demo' };

// The same corpus the emitter e2e tests use.
const CORPUS = [
  'star_orders_customer.yaml',
  'lineitem_databricks_ext.yaml',
  'tpcds_retail.yaml',
  'tpcds_date_edge.yaml',
  'sales_fanout.yaml',
  'vendor_dialects.yaml',
];

function loadFixtureModels(fixture: string): SemanticModel[] {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  return loadModels(text, LOAD).models;
}

describe('serializeModel round-trips through the loader', () => {
  for (const fixture of CORPUS) {
    test(`${fixture}: IR -> YAML -> IR is stable`, () => {
      for (const model of loadFixtureModels(fixture)) {
        const yamlText = serializeModel(model);
        const reloaded = loadModels(yamlText, LOAD).models;
        expect(reloaded).toHaveLength(1);
        expect(reloaded[0]).toEqual(model);
      }
    });
  }
});

describe('serializeModel document shape', () => {
  const model: SemanticModel = {
    name: 'sales',
    description: 'Sales model',
    entities: [
      { name: 'orders',
        dataSource: { project: 'p', dataset: 'd', table: 'orders' },
        keys: ['order_id'],
        synonyms: ['sales'],
        fields: [
          { name: 'order_id', expression: 'orders.order_id' },
          { name: 'amount', expression: 'orders.amount', description: 'Order amount' },
        ] },
      { name: 'customers',
        dataSource: { project: 'p', dataset: 'd', table: 'customers' },
        keys: ['customer_id'], fields: [] },
    ],
    relationships: [
      { name: 'orders_customers',
        source: { entity: 'orders', joinKeys: { relationshipColumns: ['order_id'], entityColumns: ['order_id'] } },
        destination: { entity: 'customers', joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] } } },
    ],
    metrics: [
      { name: 'order_count', expression: 'COUNT(orders.order_id)', entities: ['orders'] },
    ],
  };

  const doc = modelDocument(model) as any;
  const m = doc.semantic_model[0];

  test('declares the supported version and a single model', () => {
    expect(doc.version).toBe('0.2.0.dev0');
    expect(doc.semantic_model).toHaveLength(1);
    expect(m.name).toBe('sales');
    expect(m.description).toBe('Sales model');
  });

  test('renders a dataset source as the dotted project.dataset.table shorthand', () => {
    const orders = m.datasets.find((d: any) => d.name === 'orders');
    expect(orders.source).toBe('p.d.orders');
    expect(orders.primary_key).toEqual(['order_id']);
  });

  test('carries entity synonyms via ai_context', () => {
    const orders = m.datasets.find((d: any) => d.name === 'orders');
    expect(orders.ai_context).toEqual({ synonyms: ['sales'] });
  });

  test('renders a field expression as a single-dialect object', () => {
    const orders = m.datasets.find((d: any) => d.name === 'orders');
    const amount = orders.fields.find((f: any) => f.name === 'amount');
    expect(amount.expression).toEqual({ dialects: [{ dialect: 'ANSI_SQL', expression: 'orders.amount' }] });
  });

  test('inverts a relationship to from/to + from_columns/to_columns', () => {
    const rel = m.relationships[0];
    expect(rel.from).toBe('orders');
    expect(rel.to).toBe('customers');
    expect(rel.from_columns).toEqual(['customer_id']);
    expect(rel.to_columns).toEqual(['customer_id']);
  });

  test('omits a metric entities list (the loader recomputes it)', () => {
    expect(m.metrics[0]).not.toHaveProperty('entities');
    expect(m.metrics[0].expression).toEqual({ dialects: [{ dialect: 'ANSI_SQL', expression: 'COUNT(orders.order_id)' }] });
  });

  test('preserves a vendor expressionDialect as the emitted dialect', () => {
    const vendor: SemanticModel = {
      name: 'v', entities: [], relationships: [],
      metrics: [{ name: 'm', expression: 'ZEROIFNULL(x)', entities: [], expressionDialect: 'SNOWFLAKE' }],
    };
    const vdoc = modelDocument(vendor) as any;
    expect(vdoc.semantic_model[0].metrics[0].expression)
      .toEqual({ dialects: [{ dialect: 'SNOWFLAKE', expression: 'ZEROIFNULL(x)' }] });
  });

  test('emits a verbatim-query source without a project/dataset prefix', () => {
    // A whitespace-bearing dataSource.table is a query the loader kept verbatim
    // (and still defaulted project/dataset onto). Serializing must not glue the
    // prefix into the query with dots, or the reload corrupts the table.
    const queryModel: SemanticModel = {
      name: 'q',
      entities: [{
        name: 'recent', keys: ['id'], fields: [],
        dataSource: { project: 'p', dataset: 'd', table: 'SELECT * FROM p.d.raw WHERE ts > 0' },
      }],
      relationships: [], metrics: [],
    };
    const qdoc = modelDocument(queryModel) as any;
    expect(qdoc.semantic_model[0].datasets[0].source).toBe('SELECT * FROM p.d.raw WHERE ts > 0');

    const reloaded = loadModels(serializeModel(queryModel), LOAD).models[0];
    expect(reloaded.entities[0].dataSource.table).toBe('SELECT * FROM p.d.raw WHERE ts > 0');
  });
});
