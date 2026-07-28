// Behavior specification for the Knowledge Catalog emitter
// (src/libts/semantic/catalog.ts).
//
// Each test names one behavior of `generateCatalogResources`. The e2e goldens
// (kc.e2e.test.ts) capture the full resource JSON for real-shaped fixtures; the
// focused tests here pin the structural invariants a golden cannot make
// self-evident: which entry types and aspect keys are emitted, where a
// relationship's join keys land, and the warnings for unknown/empty references.

import { describe, test, expect } from 'bun:test';
import { generateCatalogResources, KcGenerateOptions } from '../../../src/libts/semantic/catalog';
import { SemanticModel } from '../../../src/libts/semantic/ir';

const OPTS: KcGenerateOptions = {
  project: 'sqlgen-testing', location: 'us-central1', entryGroup: 'semantic',
};

// A direct-FK chain: orders -> customers, with one edge and two measures. Small
// enough to assert over exhaustively.
const SALES: SemanticModel = {
  name: 'sales',
  description: 'Sales model',
  entities: [
    { name: 'customers', dataSource: { project: 'p', dataset: 'd', table: 'customers' }, keys: ['customer_id'],
      fields: [
        { name: 'customer_id', expression: 'customers.customer_id' },
        { name: 'region', expression: 'customers.region', description: 'Sales region' },
      ] },
    { name: 'orders', dataSource: { project: 'p', dataset: 'd', table: 'orders' }, keys: ['order_id'],
      fields: [
        { name: 'order_id', expression: 'orders.order_id' },
        { name: 'customer_id', expression: 'orders.customer_id' },
      ] },
  ],
  relationships: [
    { name: 'orders_customers',
      source:      { entity: 'orders',    joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] } },
      destination: { entity: 'customers', joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] } } },
  ],
  metrics: [
    { name: 'order_count', expression: 'COUNT(orders.order_id)', entities: ['orders'] },
  ],
};

const TYPE_PREFIX = 'projects/dataplex-types/locations/global';
const ENTRY_PREFIX = 'projects/sqlgen-testing/locations/us-central1/entryGroups/semantic';


describe('entries: one per model, entity, and measure', () => {
  const { entries } = generateCatalogResources(SALES, OPTS);

  test('the model entry is the semantic-model anchor', () => {
    const model = entries.find(e => e.entryType.endsWith('/semantic-model'));
    expect(model?.name).toBe(`${ENTRY_PREFIX}/entries/sales`);
    expect(model?.entryType).toBe(`${TYPE_PREFIX}/entryTypes/semantic-model`);
  });

  test('entity and measure entries are children of the model entry', () => {
    const model = `${ENTRY_PREFIX}/entries/sales`;
    const children = entries.filter(e => e.parentEntry);
    expect(children).toHaveLength(3);                 // 2 entities + 1 measure
    expect(children.every(e => e.parentEntry === model)).toBe(true);
  });

  test('each entity is a semantic-entity entry with a stable id', () => {
    const orders = entries.find(e => e.name.endsWith('/entries/sales.entities.orders'));
    expect(orders?.entryType).toBe(`${TYPE_PREFIX}/entryTypes/semantic-entity`);
  });

  test('each measure is a semantic-measure entry', () => {
    const m = entries.find(e => e.name.endsWith('/entries/sales.measures.order_count'));
    expect(m?.entryType).toBe(`${TYPE_PREFIX}/entryTypes/semantic-measure`);
  });
});


describe('aspects: keyed by the project.location.type reference form', () => {
  const { entries } = generateCatalogResources(SALES, OPTS);
  const orders = entries.find(e => e.name.endsWith('/entries/sales.entities.orders'))!;

  test('the aspect map key is the ref form, the aspectType is the full name', () => {
    const key = 'dataplex-types.global.semantic-entity';
    expect(orders.aspects?.[key]).toBeDefined();
    expect(orders.aspects?.[key].aspectType).toBe(`${TYPE_PREFIX}/aspectTypes/semantic-entity`);
  });

  test('entity fields travel as a list inside the semantic-entity aspect', () => {
    const data = orders.aspects?.['dataplex-types.global.semantic-entity'].data;
    expect(data?.keys).toEqual(['order_id']);
    expect(data?.source).toEqual({ project: 'p', dataset: 'd', table: 'orders' });
    expect(data?.fields.map((f: any) => f.name)).toEqual(['order_id', 'customer_id']);
  });

  test('a measure aspect carries its expression and entity references', () => {
    const m = entries.find(e => e.name.endsWith('/entries/sales.measures.order_count'))!;
    const data = m.aspects?.['dataplex-types.global.semantic-measure'].data;
    expect(data?.expression).toBe('COUNT(orders.order_id)');
    expect(data?.entities).toEqual([`${ENTRY_PREFIX}/entries/sales.entities.orders`]);
  });
});


describe('relationships: an EntryLink edge plus join keys in the model aspect', () => {
  const { entries, entryLinks } = generateCatalogResources(SALES, OPTS);

  test('one EntryLink per relationship, with SOURCE and TARGET endpoints', () => {
    expect(entryLinks).toHaveLength(1);
    const link = entryLinks[0];
    expect(link.name).toBe(`${ENTRY_PREFIX}/entryLinks/sales.relationships.orders_customers`);
    expect(link.entryLinkType).toBe(`${TYPE_PREFIX}/entryLinkTypes/semantic-relationship`);
    expect(link.entryReferences).toEqual([
      { name: `${ENTRY_PREFIX}/entries/sales.entities.orders`, type: 'SOURCE' },
      { name: `${ENTRY_PREFIX}/entries/sales.entities.customers`, type: 'TARGET' },
    ]);
  });

  test("join keys are preserved in the model aspect (an EntryLink can't hold them)", () => {
    const model = entries.find(e => e.entryType.endsWith('/semantic-model'))!;
    const rels = model.aspects?.['dataplex-types.global.semantic-model'].data?.relationships;
    expect(rels).toHaveLength(1);
    expect(rels[0].source.joinKeys).toEqual({ relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] });
  });
});


describe('undefined-valued fields are omitted, set ones are kept', () => {
  const { entries } = generateCatalogResources(SALES, OPTS);
  const customers = entries.find(e => e.name.endsWith('/entries/sales.entities.customers'))!;

  test('a field with no metadata has only name + expression', () => {
    const fields = customers.aspects?.['dataplex-types.global.semantic-entity'].data?.fields;
    expect(fields[0]).toEqual({ name: 'customer_id', expression: 'customers.customer_id' });
  });

  test('a field description is retained when present', () => {
    const fields = customers.aspects?.['dataplex-types.global.semantic-entity'].data?.fields;
    expect(fields[1]).toEqual({ name: 'region', expression: 'customers.region', description: 'Sales region' });
  });
});


describe('dangling and empty references are warned, not silently dropped', () => {
  test('a relationship to an unknown entity is dropped from both the links and the model aspect', () => {
    const model: SemanticModel = {
      ...SALES,
      relationships: [
        { name: 'bad',
          source:      { entity: 'orders',  joinKeys: { relationshipColumns: ['x'], entityColumns: ['x'] } },
          destination: { entity: 'unknown', joinKeys: { relationshipColumns: ['y'], entityColumns: ['y'] } } },
      ],
    };
    const { entries, entryLinks, warnings } = generateCatalogResources(model, OPTS);
    expect(entryLinks).toHaveLength(0);
    // The model aspect must not advertise an edge whose endpoint has no entry.
    const anchor = entries.find(e => e.entryType.endsWith('/semantic-model'))!;
    expect(anchor.aspects?.['dataplex-types.global.semantic-model'].data?.relationships).toBeUndefined();
    expect(warnings).toContain(
      "relationship 'bad': references unknown entity 'unknown'; relationship omitted (no entry link, absent from model aspect)");
  });

  test('a measure referencing an unknown entity is still emitted, with a warning', () => {
    const model: SemanticModel = {
      ...SALES,
      metrics: [{ name: 'bogus', expression: 'SUM(ghost.x)', entities: ['ghost'] }],
    };
    const { entries, warnings } = generateCatalogResources(model, OPTS);
    expect(entries.find(e => e.name.endsWith('/entries/sales.measures.bogus'))).toBeDefined();
    expect(warnings).toContain(
      "metric 'bogus': references unknown entity 'ghost'; still emitted (reference may not resolve)");
  });

  test('an entity with no keys is warned about', () => {
    const model: SemanticModel = {
      name: 'm', entities: [{ name: 'e', dataSource: { table: 't' }, keys: [], fields: [] }],
      relationships: [], metrics: [],
    };
    const { warnings } = generateCatalogResources(model, OPTS);
    expect(warnings).toContain(
      "entity 'e': no keys; the semantic-entity aspect will have an empty key list");
  });
});


describe('colliding entry/link ids are skipped, not silently overwritten', () => {
  test('two entities whose names normalize to the same id emit only one entry, with a warning', () => {
    // 'order items' and 'order_items' both slug to 'order_items' -> the same
    // entry id. Emitting both would have the second overwrite the first on write.
    const model: SemanticModel = {
      name: 'm',
      entities: [
        { name: 'order items', dataSource: { table: 'a' }, keys: ['k'], fields: [] },
        { name: 'order_items', dataSource: { table: 'b' }, keys: ['k'], fields: [] },
      ],
      relationships: [], metrics: [],
    };
    const { entries, warnings } = generateCatalogResources(model, OPTS);
    const collided = entries.filter(e => e.name.endsWith('/entries/m.entities.order_items'));
    expect(collided).toHaveLength(1);
    expect(warnings).toContain(
      "entity 'order_items': generated entry id 'm.entities.order_items' duplicates an earlier one; " +
      "skipped (rename to avoid overwriting it on publish)");
  });

  test('two relationships whose names normalize to the same id emit only one link, with a warning', () => {
    const model: SemanticModel = {
      ...SALES,
      relationships: [
        { name: 'orders customers',
          source:      { entity: 'orders',    joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] } },
          destination: { entity: 'customers', joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] } } },
        { name: 'orders_customers',
          source:      { entity: 'orders',    joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] } },
          destination: { entity: 'customers', joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] } } },
      ],
    };
    const { entries, entryLinks, warnings } = generateCatalogResources(model, OPTS);
    expect(entryLinks).toHaveLength(1);
    // The model aspect stays consistent with the emitted links: only one accepted.
    const anchor = entries.find(e => e.entryType.endsWith('/semantic-model'))!;
    expect(anchor.aspects?.['dataplex-types.global.semantic-model'].data?.relationships).toHaveLength(1);
    expect(warnings).toContain(
      "relationship 'orders_customers': generated entry link id 'sales.relationships.orders_customers' " +
      "duplicates an earlier one; skipped (rename to avoid overwriting it on publish)");
  });
});


describe('system type location is overridable', () => {
  test('a staging type project/location flows into every type name and aspect key', () => {
    const { entries } = generateCatalogResources(SALES, {
      ...OPTS, systemTypeProject: 'staging', systemTypeLocation: 'us',
    });
    const model = entries.find(e => e.entryType.includes('/semantic-model'))!;
    expect(model.entryType).toBe('projects/staging/locations/us/entryTypes/semantic-model');
    expect(model.aspects?.['staging.us.semantic-model']).toBeDefined();
  });
});
