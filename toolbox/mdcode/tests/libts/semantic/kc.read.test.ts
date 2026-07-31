// Tests for the Knowledge Catalog reader (modelsFromCatalogResources in
// src/libts/semantic/catalog.ts), the inverse of the emitter. The core property
// is a round trip: emitting a model to catalog resources and reading them back
// reconstructs the same IR. Combined with the loader corpus, this proves the full
// YAML -> IR -> KC-resources -> IR path is lossless at the IR level.

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { loadModels, LoadOptions } from '../../../src/libts/semantic/loader';
import {
  generateCatalogResources, modelsFromCatalogResources, KcGenerateOptions,
} from '../../../src/libts/semantic/catalog';
import { SemanticModel } from '../../../src/libts/semantic/ir';

const FIXTURES = path.join(__dirname, 'fixtures');
const LOAD: LoadOptions = { defaultProject: 'sqlgen-testing', defaultDataset: 'demo' };
const OPTS: KcGenerateOptions = {
  project: 'sqlgen-testing', location: 'us-central1', entryGroup: 'semantic',
};

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

describe('modelsFromCatalogResources round-trips the emitter', () => {
  for (const fixture of CORPUS) {
    test(`${fixture}: IR -> resources -> IR is stable`, () => {
      const model = loadFixtureModels(fixture)[0];
      const { entries } = generateCatalogResources(model, OPTS);
      const { models } = modelsFromCatalogResources(entries);
      expect(models).toHaveLength(1);
      expect(models[0]).toEqual(model);
    });
  }
});

describe('modelsFromCatalogResources behavior', () => {
  const SALES: SemanticModel = {
    name: 'sales',
    description: 'Sales model',
    entities: [
      { name: 'customers', dataSource: { project: 'p', dataset: 'd', table: 'customers' }, keys: ['customer_id'],
        synonyms: ['accounts'],
        fields: [{ name: 'region', expression: 'customers.region', description: 'Sales region' }] },
      { name: 'orders', dataSource: { project: 'p', dataset: 'd', table: 'orders' }, keys: ['order_id'], fields: [] },
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

  test('reconstructs the full IR from emitted resources', () => {
    const { entries } = generateCatalogResources(SALES, OPTS);
    const { models } = modelsFromCatalogResources(entries);
    expect(models[0]).toEqual(SALES);
  });

  test('re-derives a measure entities list from its expression, not the aspect', () => {
    const { entries } = generateCatalogResources(SALES, OPTS);
    const { models } = modelsFromCatalogResources(entries);
    expect(models[0].metrics[0].entities).toEqual(['orders']);
  });

  test('reads entity names from the display name, not the slugged entry id', () => {
    const spaced: SemanticModel = {
      name: 'm', entities: [
        { name: 'Order Items', dataSource: { table: 't' }, keys: ['id'], fields: [] },
      ], relationships: [], metrics: [],
    };
    const { entries } = generateCatalogResources(spaced, OPTS);
    const { models } = modelsFromCatalogResources(entries);
    expect(models[0].entities[0].name).toBe('Order Items');
  });

  test('warns and returns nothing when no model anchor is present', () => {
    const { models, warnings } = modelsFromCatalogResources([]);
    expect(models).toHaveLength(0);
    expect(warnings.join('\n')).toContain('no semantic-model entry');
  });

  test('groups children under multiple model anchors by parentEntry', () => {
    const a = generateCatalogResources({ ...SALES, name: 'a' }, OPTS).entries;
    const b = generateCatalogResources({ ...SALES, name: 'b' }, OPTS).entries;
    const { models } = modelsFromCatalogResources([...a, ...b]);
    const byName = Object.fromEntries(models.map(m => [m.name, m]));
    expect(models).toHaveLength(2);
    expect(byName['a'].entities.map(e => e.name).sort()).toEqual(['customers', 'orders']);
    expect(byName['b'].metrics.map(m => m.name)).toEqual(['order_count']);
  });
});
