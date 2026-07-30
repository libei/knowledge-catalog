// Tests for the Knowledge Catalog pull path: the IO orchestration
// (pullKnowledgeCatalog in src/libts/semantic/kc.ts) against a fake catalog
// client, and the CLI command (commands.pull) end to end against a temp
// workspace. Both are hermetic: no network, no gcloud.
//
// The orchestration test closes the full loop — emit resources, seed them into a
// fake service, pull them back — proving push and pull are symmetric.

import { describe, test, expect, afterEach, mock, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { generateCatalogResources, KcGenerateOptions } from '../../../src/libts/semantic/catalog';
import { pullKnowledgeCatalog } from '../../../src/libts/semantic/kc';
import { loadModels } from '../../../src/libts/semantic/loader';
import { SemanticModel } from '../../../src/libts/semantic/ir';
import { CatalogClientMock } from '../mocks';
import * as commands from '../../../src/tool/commands';
import * as context from '../../../src/libts/gcp/context';
import * as dataplex from '../../../src/libts/gcp/dataplex';

const OPTS: KcGenerateOptions = {
  project: 'sqlgen-testing', location: 'us-central1', entryGroup: 'semantic',
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

// Emits the given models and seeds them into a fresh fake catalog client, as if a
// prior push had published them.
function seed(...models: SemanticModel[]): CatalogClientMock {
  const client = new CatalogClientMock();
  const entries = models.flatMap(m => generateCatalogResources(m, OPTS).entries);
  client.setMockEntries(entries);
  return client;
}

describe('pullKnowledgeCatalog (fake service)', () => {
  test('reconstructs a published model end to end', async () => {
    const model = salesModel();
    const { models, warnings } = await pullKnowledgeCatalog(seed(model), OPTS);
    expect(warnings).toEqual([]);
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(model);
  });

  test('returns every model in the entry group', async () => {
    const client = seed(salesModel('a'), salesModel('b'));
    const { models } = await pullKnowledgeCatalog(client, OPTS);
    expect(models.map(m => m.name).sort()).toEqual(['a', 'b']);
  });

  test('--model filters to a single named model', async () => {
    const client = seed(salesModel('a'), salesModel('b'));
    const { models } = await pullKnowledgeCatalog(client, { ...OPTS, model: 'b' });
    expect(models.map(m => m.name)).toEqual(['b']);
  });

  test('warns when the requested model is absent', async () => {
    const { models, warnings } = await pullKnowledgeCatalog(seed(salesModel('a')), { ...OPTS, model: 'zzz' });
    expect(models).toHaveLength(0);
    expect(warnings.join('\n')).toContain("no semantic model named 'zzz'");
  });
});


describe('commands.pull for a semantic-model scope', () => {
  const origCwd = process.cwd();

  afterEach(() => {
    process.chdir(origCwd);
    mock.restore();
  });

  // Sets up a temp workspace with a semantic-model catalog.yaml, and stubs the
  // API context + catalog client so pull reads the seeded entries.
  function workspace(entries: dataplex.Entry[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-pull-'));
    fs.writeFileSync(path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.sqlgen-testing.us-central1.semantic\n');
    process.chdir(dir);

    spyOn(context.ApiContext, 'default').mockReturnValue(
      new context.ApiContext('sqlgen-testing', 'us-central1', 'token'));
    spyOn(dataplex.CatalogClient.prototype, 'listEntries').mockImplementation(
      async function* () { for (const e of entries) yield e; });
    spyOn(dataplex.CatalogClient.prototype, 'lookupEntry').mockImplementation(
      async (_p: string, _l: string, name: string) => {
        const e = entries.find(x => x.name === name);
        return e ? { status: 200, result: e } : { status: 404, message: 'Not found' };
      });
    return dir;
  }

  test('writes catalog/<entryGroup>/<model>.yaml that reloads to the same IR', async () => {
    const model = salesModel();
    const dir = workspace(generateCatalogResources(model, OPTS).entries);

    const code = await commands.pull({});
    expect(code).toBe(0);

    const file = path.join(dir, 'catalog', 'semantic', 'sales.yaml');
    expect(fs.existsSync(file)).toBe(true);
    const reloaded = loadModels(fs.readFileSync(file, 'utf8'),
      { defaultProject: 'sqlgen-testing', defaultDataset: 'demo' }).models;
    expect(reloaded[0]).toEqual(model);
  });

  test('--dry-run writes no file', async () => {
    const model = salesModel();
    const dir = workspace(generateCatalogResources(model, OPTS).entries);

    const code = await commands.pull({ dryRun: true });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'catalog', 'semantic', 'sales.yaml'))).toBe(false);
  });

  test('overwrites an existing model file (last-write-wins)', async () => {
    const model = salesModel();
    const dir = workspace(generateCatalogResources(model, OPTS).entries);
    const file = path.join(dir, 'catalog', 'semantic', 'sales.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# stale hand-authored content\n');

    const code = await commands.pull({});
    expect(code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('stale hand-authored');
  });

  test('exits non-zero when the entry group has no semantic models', async () => {
    workspace([]);
    const code = await commands.pull({});
    expect(code).toBe(1);
  });
});
