// Tests for the Knowledge Catalog push path: deployKnowledgeCatalog in
// src/libts/semantic/kc.ts, driven against the fake catalog client. Hermetic: no
// network, no gcloud. `settleMs: 0` skips the real post-provisioning settle.
//
// The round-trip test closes the full loop — push a model through the deployer,
// then pull it back with pullKnowledgeCatalog — proving the publish sequence
// writes exactly what the reader reconstructs.

import { describe, test, expect } from 'bun:test';

import { deployKnowledgeCatalog, pullKnowledgeCatalog } from '../../../src/libts/semantic/kc';
import { SemanticModel } from '../../../src/libts/semantic/ir';
import { SEMANTIC_TYPE_IDS } from '../../../src/libts/semantic/catalog';
import { CatalogClientMock } from '../mocks';
import * as gcp from '../../../src/libts/gcp';

const OPTS = {
  project: 'sqlgen-testing', location: 'us-central1', entryGroup: 'semantic',
  settleMs: 0,
};

function salesModel(name = 'sales'): SemanticModel {
  return {
    name,
    description: 'Sales model',
    entities: [
      { name: 'customers', dataSource: { project: 'p', dataset: 'd', table: 'customers' }, keys: ['customer_id'],
        fields: [{ name: 'region', expression: 'customers.region', description: 'Sales region' }] },
      { name: 'orders', dataSource: { project: 'p', dataset: 'd', table: 'orders' }, keys: ['order_id'], fields: [] },
    ],
    relationships: [
      { name: 'orders_customers',
        source: { entity: 'orders', joinKeys: { relationshipColumns: ['order_id'], entityColumns: ['order_id'] } },
        destination: { entity: 'customers', joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] } } },
    ],
    metrics: [{ name: 'order_count', expression: 'COUNT(orders.order_id)', entities: ['orders'] }],
  };
}

// The bare type id of an entry's entryType.
const typeOf = (e: gcp.Entry) => e.entryType.split('/').pop()!;

describe('deployKnowledgeCatalog (fake service)', () => {
  test('provisions custom types + entry group, then writes entries anchor-first', async () => {
    const client = new CatalogClientMock();
    const res = await deployKnowledgeCatalog(client, [salesModel()], OPTS);

    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(1);
    expect(res.results[0].executed).toBe(true);
    expect(res.results[0].error).toBeUndefined();

    // Entry group + all three aspect types + all three entry types provisioned.
    expect(client.createdEntryGroups).toEqual(['semantic']);
    expect(client.createdAspectTypes.sort()).toEqual([...SEMANTIC_TYPE_IDS].sort());
    expect(client.createdEntryTypes.sort()).toEqual([...SEMANTIC_TYPE_IDS].sort());

    // One model anchor + two entities + one measure, anchor first.
    expect(typeOf(client.mockEntries[0])).toBe('semantic-model');
    const created = client.mockEntries.map(typeOf);
    expect(created.filter(t => t === 'semantic-entity')).toHaveLength(2);
    expect(created.filter(t => t === 'semantic-measure')).toHaveLength(1);
  });

  test('defaults the custom types to the destination project, location global', async () => {
    const client = new CatalogClientMock();
    await deployKnowledgeCatalog(client, [salesModel()], OPTS);
    // Aspect types were created in the destination project / global.
    const names = [...client.mockAspectTypes.keys()];
    expect(names.every(n => n.startsWith('projects/sqlgen-testing/locations/global/aspectTypes/'))).toBe(true);
  });

  test('honors --type-project/--type-location for the custom types', async () => {
    const client = new CatalogClientMock();
    await deployKnowledgeCatalog(client, [salesModel()],
      { ...OPTS, typeProject: 'types-proj', typeLocation: 'us' });
    const aspectNames = [...client.mockAspectTypes.keys()];
    const entryTypeNames = [...client.mockEntryTypes.keys()];
    expect(aspectNames.every(n => n.startsWith('projects/types-proj/locations/us/aspectTypes/'))).toBe(true);
    expect(entryTypeNames.every(n => n.startsWith('projects/types-proj/locations/us/entryTypes/'))).toBe(true);
  });

  test('defers relationship edges with a warning and creates no entry links', async () => {
    const client = new CatalogClientMock();
    const res = await deployKnowledgeCatalog(client, [salesModel()], OPTS);
    expect(client.mockEntryLinks).toHaveLength(0);
    expect(res.results[0].warnings.join('\n')).toContain('1 relationship edge not published');
  });

  test('publishes multiple models, provisioning shared setup once', async () => {
    const client = new CatalogClientMock();
    const res = await deployKnowledgeCatalog(client, [salesModel('a'), salesModel('b')], OPTS);
    expect(res.ok).toBe(true);
    expect(res.results.map(r => r.model)).toEqual(['a', 'b']);
    expect(res.results.every(r => r.executed)).toBe(true);
    // Setup is provisioned once, not per model.
    expect(client.createdEntryGroups).toEqual(['semantic']);
    expect(client.createdAspectTypes.sort()).toEqual([...SEMANTIC_TYPE_IDS].sort());
    // Two model anchors written.
    expect(client.mockEntries.filter(e => typeOf(e) === 'semantic-model')).toHaveLength(2);
  });

  test('reuses existing types (already-exists is not an error)', async () => {
    const client = new CatalogClientMock();
    // Pre-seed the entry group and all types, as a prior push would have left them.
    client.addMockEntryGroup({ name: 'projects/sqlgen-testing/locations/us-central1/entryGroups/semantic' });
    for (const id of SEMANTIC_TYPE_IDS) {
      client.addMockAspectType({ name: `projects/sqlgen-testing/locations/global/aspectTypes/${id}` });
      client.addMockEntryType({ name: `projects/sqlgen-testing/locations/global/entryTypes/${id}`, requiredAspects: [] });
    }
    const res = await deployKnowledgeCatalog(client, [salesModel()], OPTS);
    expect(res.ok).toBe(true);
    expect(res.results[0].executed).toBe(true);
    // Nothing new provisioned.
    expect(client.createdEntryGroups).toEqual([]);
    expect(client.createdAspectTypes).toEqual([]);
  });

  test('a provisioning failure fails the whole push', async () => {
    class FailingAspectTypes extends CatalogClientMock {
      async createAspectType(): Promise<gcp.ApiResult<gcp.AspectType>> {
        return { status: 500, message: 'boom' };
      }
    }
    const client = new FailingAspectTypes();
    const res = await deployKnowledgeCatalog(client, [salesModel()], OPTS);
    expect(res.ok).toBe(false);
    expect(res.results[0].executed).toBe(false);
    expect(res.results[0].error).toContain('aspect type');
    expect(res.results[0].error).toContain('boom');
    // No entries written when provisioning failed.
    expect(client.mockEntries).toHaveLength(0);
  });

  test('an entry write failure fails that model', async () => {
    class FailingEntry extends CatalogClientMock {
      async createEntry(): Promise<gcp.ApiResult<gcp.Entry>> {
        return { status: 403, message: 'permission denied' };
      }
    }
    const client = new FailingEntry();
    const res = await deployKnowledgeCatalog(client, [salesModel()], OPTS);
    expect(res.ok).toBe(false);
    expect(res.results[0].executed).toBe(false);
    expect(res.results[0].error).toContain('permission denied');
  });
});


describe('push -> pull round trip (fake service)', () => {
  test('a pushed model pulls back to the same IR', async () => {
    const client = new CatalogClientMock();
    const model = salesModel();

    const push = await deployKnowledgeCatalog(client, [model], OPTS);
    expect(push.ok).toBe(true);

    const { models, warnings } = await pullKnowledgeCatalog(client, {
      project: OPTS.project, location: OPTS.location, entryGroup: OPTS.entryGroup,
    });
    expect(warnings).toEqual([]);
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(model);
  });
});
