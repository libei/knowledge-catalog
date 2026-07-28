// End-to-end tests for the Knowledge Catalog destination: real-shaped fixtures
// run the full file -> IR -> catalog-resources path.
//
// The primary check is a GOLDEN test: for every fixture under `fixtures/`, the
// complete generated resource set (entries, entry links, and the combined load +
// generate warnings) is compared against a committed `<fixture>.kc.golden.json`.
// The golden is destination-scoped, so it sits next to the same fixture's
// `<fixture>.bigquery.golden.sql`: open the `.yaml` and both goldens to see one
// input mapped to each output target.
//
//   Regenerate goldens after an intentional generator change:
//     UPDATE_GOLDENS=1 npx bun test ./tests/libts/semantic/kc.e2e.test.ts
//   then read the diff before committing.
//
// Unit-level tests for the same emitter (inline IR) live in `kc.test.ts`.

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { loadModels, LoadOptions } from '../../../src/libts/semantic/loader';
import { generateCatalogResources, KcGenerateOptions } from '../../../src/libts/semantic/catalog';

const FIXTURES = path.join(__dirname, 'fixtures');

// The same corpus the BigQuery e2e test uses, so every fixture has a golden per
// destination. New fixtures are added here (and in bigquery.e2e.test.ts).
const CORPUS = [
  'star_orders_customer.yaml',
  'lineitem_databricks_ext.yaml',
  'tpcds_retail.yaml',
  'tpcds_date_edge.yaml',
  'sales_fanout.yaml',
  'vendor_dialects.yaml',
];

// Fixed destination so the generated resource names are reproducible byte-for-byte.
const KC_OPTS: KcGenerateOptions = {
  project: 'sqlgen-testing', location: 'us-central1', entryGroup: 'semantic',
};

function build(fixture: string, load: LoadOptions = {}) {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  const opts = { defaultProject: 'sqlgen-testing', defaultDataset: 'demo', ...load };
  const { models, warnings: loadWarnings } = loadModels(text, opts);
  const { entries, entryLinks, warnings: genWarnings } =
    generateCatalogResources(models[0], KC_OPTS);
  return { models, entries, entryLinks, loadWarnings, genWarnings };
}

// The artifact a golden captures: the full resource set plus every warning (load
// + generate), so a reviewer sees dropped/flagged elements alongside the output.
function render(fixture: string): string {
  const { entries, entryLinks, loadWarnings, genWarnings } = build(fixture);
  const warnings = [...loadWarnings, ...genWarnings];
  return JSON.stringify({ entries, entryLinks, warnings }, null, 2) + '\n';
}

// Goldens are destination-scoped: `<fixture>.kc.golden.json`.
const goldenPath = (fixture: string) =>
  path.join(FIXTURES, fixture.replace(/\.yaml$/, '.kc.golden.json'));


describe('golden resources: each corpus fixture generates its exact expected catalog resources', () => {
  for (const fixture of CORPUS) {
    test(fixture, () => {
      const actual = render(fixture);
      const golden = goldenPath(fixture);
      if (process.env.UPDATE_GOLDENS) {
        fs.writeFileSync(golden, actual);
        return;
      }
      if (!fs.existsSync(golden)) {
        throw new Error(
          `missing golden ${path.basename(golden)} — run UPDATE_GOLDENS=1 to create it`);
      }
      expect(actual).toBe(fs.readFileSync(golden, 'utf8'));
    });
  }
});


describe('structure holds across the corpus (what a golden alone does not assert)', () => {
  test('every fixture emits exactly one semantic-model anchor entry', () => {
    for (const fixture of CORPUS) {
      const { entries } = build(fixture);
      const anchors = entries.filter(e => e.entryType.endsWith('/entryTypes/semantic-model'));
      expect(anchors).toHaveLength(1);
    }
  });

  test('entity and measure entries are parented to the model anchor', () => {
    for (const fixture of CORPUS) {
      const { entries } = build(fixture);
      const anchor = entries.find(e => e.entryType.endsWith('/entryTypes/semantic-model'))!;
      const nonAnchor = entries.filter(e => e !== anchor);
      expect(nonAnchor.every(e => e.parentEntry === anchor.name)).toBe(true);
    }
  });

  test('every entry link endpoint resolves to an emitted entity entry', () => {
    for (const fixture of CORPUS) {
      const { entries, entryLinks } = build(fixture);
      const names = new Set(entries.map(e => e.name));
      for (const link of entryLinks) {
        for (const ref of link.entryReferences) {
          expect(names.has(ref.name)).toBe(true);
        }
      }
    }
  });
});
