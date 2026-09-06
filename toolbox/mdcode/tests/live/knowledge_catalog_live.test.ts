// Constraints through a real Knowledge Catalog: push, then pull.
//
// Constraints have no built-in system type, so each publishes as its own entry
// under the custom `semantic-constraint` type that `kcmd init` provisions, the
// way an action publishes under `semantic-action`. The hermetic test
// (tests/libts/semantic/constraints.test.ts) asserts that the emitter writes
// that shape and the reader recovers it -- but it hands the emitter's output
// straight back to the reader, so the catalog itself is never in the loop.
//
// Everything that could go wrong lives in the part it skips. A custom type has
// to be created before an entry can reference it, Dataplex enforces the aspect
// template it was created with, and a template this code wrote is a claim about
// Dataplex until a server accepts it. This asks that question.
//
// Gated separately from the rest of the live suite (KCMD_LIVE_KC): pushing a
// semantic model needs a catalog surface on which this project may USE the
// published `semantic-*` entry types, which is not generally true on the
// production endpoint. Point DATAPLEX_ENDPOINT and KC_TYPE_PROJECT at a surface
// where it is, then set KCMD_LIVE_KC=1.
//

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {CatalogClient} from '../../src/libts/gcp/dataplex';
import {SemanticModel} from '../../src/libts/semantic/ir';
import {deployKnowledgeCatalog} from '../../src/libts/semantic/deploy_knowledge_catalog';
import {CONSTRAINT_TYPE_ID, provisionCustomTypes} from '../../src/libts/semantic/kc_custom_types';
import {LoadedModel, loadModels} from '../../src/libts/semantic/loader';
import {pullKnowledgeCatalog} from '../../src/libts/semantic/pull_kc';

import {apiContext, kcEntryGroup, kcLocation, LIVE_KC, project} from './live';


// A catalog round trip is several sequential REST calls; the default 5s is not
// a useful budget for one.
const TIMEOUT = 180000;

const FIXTURE = path.join(
    __dirname, '..', 'libts', 'semantic', 'fixtures',
    'actions_place_order.yaml');

const deployOptions = {
  project,
  location: kcLocation,
  entryGroup: kcEntryGroup,
  systemTypeProject: process.env.KC_TYPE_PROJECT,
};

let cat: CatalogClient;
let authored: SemanticModel;

function loaded(model: SemanticModel): LoadedModel[] {
  return [{document: 'actions_place_order.yaml', model}];
}


// Removes everything this suite may have written. Entry LINKS go first: a link
// whose endpoint entries are deleted first is orphaned, and an orphaned link
// cannot be addressed by name afterwards -- it survives even the entry group's
// deletion and collides with the next run.
async function purge(): Promise<void> {
  // Only the entries a push owns. Creating a group also creates an `entrygroup`
  // entry describing the group itself, which is not ours to delete.
  const entries: string[] = [];
  for await (const entry of cat.listEntries(project, kcLocation, kcEntryGroup)) {
    if (entry.name && entry.entryType?.includes('/entryTypes/semantic-')) {
      entries.push(entry.name);
    }
  }

  const links = new Set<string>();
  for (const entry of entries) {
    const found = await cat.lookupEntryLinks(project, kcLocation, {entry});
    for (const link of found.result ?? []) {
      if (link.name) links.add(link.name.split('/entryLinks/')[1]);
    }
  }
  for (const link of links) {
    await cat.deleteEntryLink(project, kcLocation, kcEntryGroup, link);
  }
  for (const entry of entries) {
    await cat._delete(entry);
  }
}


// Polls until the group's entries collection answers. Getting the entry group
// itself is not enough: it returns 200 while a list of its entries still 404s,
// so waiting on the wrong call makes the first real request fail.
async function waitForEntryGroup(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      for await (const _ of cat.listEntries(project, kcLocation, kcEntryGroup)) {
        break;
      }
      return;
    } catch (err) {
      if (!`${err}`.includes('404') && !`${err}`.includes('does not exist')) {
        throw err;
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`entry group ${kcEntryGroup} never became addressable`);
}


// The constraint entries as the SERVER holds them, fetched fresh rather than
// taken from anything the emitter produced. Each is returned as its display
// name, its description, and its aspect data.
async function serverConstraints():
    Promise<{name: string; description: string; data: Record<string, any>}[]> {
  const found = [];
  for await (const entry of cat.listEntries(project, kcLocation, kcEntryGroup)) {
    if (!entry.entryType?.endsWith(`/entryTypes/${CONSTRAINT_TYPE_ID}`)) continue;
    // The aspect filter takes full aspect-type RESOURCE names, not the dotted
    // key the aspect map is written under, and the type lives beside the entry
    // type -- so derive it from the entry's own entryType rather than naming a
    // project, which differs per surface.
    const aspectType = `${entry.entryType!.split('/entryTypes/')[0]}/aspectTypes/${
        CONSTRAINT_TYPE_ID}`;
    const fetched = await cat.getEntry(
        project, kcLocation, kcEntryGroup, entry.name!.split('/entries/')[1],
        [aspectType]);
    if (fetched.status !== 200) {
      throw new Error(`getEntry failed with ${fetched.status}: ${fetched.message}`);
    }
    const aspects = fetched.result?.aspects ?? {};
    // Read-back keys the aspect map by project NUMBER, not id, so match on the
    // suffix rather than the key we wrote.
    const key = Object.keys(aspects).find(k => k.endsWith(`.${CONSTRAINT_TYPE_ID}`));
    if (!key) {
      throw new Error(`constraint entry ${entry.name} came back with no ${
          CONSTRAINT_TYPE_ID} aspect`);
    }
    found.push({
      name: fetched.result?.entrySource?.displayName ?? '',
      description: fetched.result?.entrySource?.description ?? '',
      data: (aspects[key].data ?? {}) as Record<string, any>,
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}


describe.skipIf(!LIVE_KC)('constraints through a real Knowledge Catalog', () => {
  beforeAll(async () => {
    cat = new CatalogClient(apiContext());
    authored =
        loadModels(fs.readFileSync(FIXTURE, 'utf8')).models[0];

    const created =
        await cat.createEntryGroup(project, kcLocation, kcEntryGroup);
    if (created.status !== 200 && created.status !== 409) {
      throw new Error(
          `could not create entry group ${kcEntryGroup}: ${created.status} ${
              created.message ?? ''}`);
    }
    // Creating an entry group is a long-running operation: the call returns
    // before the group is addressable, and the next request 404s. Wait for it
    // rather than sleep a guessed interval.
    await waitForEntryGroup();
    // What `kcmd init --semantic-model` does: an entry cannot reference a
    // custom type that does not exist yet.
    const provisioned = await provisionCustomTypes(cat, {project});
    if (provisioned.error || provisioned.denied) {
      throw new Error(
          `could not provision the custom types: ${
              provisioned.error ?? provisioned.denied}`);
    }
    // Start from empty so a previous interrupted run cannot make this one pass
    // or fail for the wrong reason.
    await purge();
  }, TIMEOUT);

  afterAll(async () => {
    await purge();
    await cat._delete(
        `projects/${project}/locations/${kcLocation}/entryGroups/${
            kcEntryGroup}`);
  }, TIMEOUT);

  test('a push writes the model, constraints and all', async () => {
    const result =
        await deployKnowledgeCatalog(loaded(authored), apiContext(), deployOptions);
    expect(result.details ?? '').toBe('');
    expect(result.success).toBe(true);
    expect(result.created).toBeGreaterThan(0);
    // The author is told constraints are catalog-only -- carried, not enforced
    // by the catalog.
    expect(result.warnings.some(w => w.includes('constraint'))).toBe(true);
  }, TIMEOUT);

  test('and Dataplex really stored one entry per constraint', async () => {
    // The question the hermetic test cannot ask: whether a server accepts an
    // entry of a type this code created, holding an aspect shaped by a template
    // this code wrote.
    const stored = await serverConstraints();
    expect(stored.map(c => c.name)).toEqual([
      'NonNegativeOrderTotal',
      'PositiveQuantity',
    ]);
    expect(stored[0].data.expression).toBe('orders.o_totalprice >= 0');
    expect(stored[0].description).toContain('cannot be negative');
  }, TIMEOUT);

  test('a pull recovers the constraints byte for byte', async () => {
    const pulled =
        await pullKnowledgeCatalog(cat, {project, location: kcLocation, entryGroup: kcEntryGroup});
    expect(pulled.models).toHaveLength(1);
    expect(pulled.models[0].constraints).toEqual(authored.constraints);
  }, TIMEOUT);

  test('together with the actions published beside them', async () => {
    const pulled =
        await pullKnowledgeCatalog(cat, {project, location: kcLocation, entryGroup: kcEntryGroup});
    expect(pulled.models[0].actions).toEqual(authored.actions);
  }, TIMEOUT);

  test('an edited constraint is updated in place, not duplicated', async () => {
    // Re-push is the common case -- a model is edited far more often than it is
    // first published -- and it takes a different path through the catalog
    // (update, not create) that the hermetic test never exercises.
    const edited: SemanticModel = {
      ...authored,
      constraints: authored.constraints!.map(
          c => c.name === 'PositiveQuantity' ?
              {...c, description: 'An order line must be for a positive number of units.'} :
              c),
    };
    const result =
        await deployKnowledgeCatalog(loaded(edited), apiContext(), deployOptions);
    expect(result.details ?? '').toBe('');
    expect(result.success).toBe(true);
    expect(result.created).toBe(0);
    expect(result.updated).toBeGreaterThan(0);

    const pulled =
        await pullKnowledgeCatalog(cat, {project, location: kcLocation, entryGroup: kcEntryGroup});
    expect(pulled.models[0].constraints).toEqual(edited.constraints);
    expect(pulled.models[0].constraints).toHaveLength(
        authored.constraints!.length);
  }, TIMEOUT);
});
