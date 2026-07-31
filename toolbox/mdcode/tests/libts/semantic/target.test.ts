// Behavior specification for the semantic push target selection: the `--target`
// parser and the Knowledge Catalog coordinate resolution (src/tool/commands.ts),
// plus the KC deploy seam's dry-run behavior (src/libts/semantic/kc.ts). All
// hermetic: no network. The full deploy path (provisioning + entry creation
// against a fake service) is covered in kc.push.test.ts.

import { describe, test, expect } from 'bun:test';
import { resolveTargets, resolveKcCoords, unusedFlagWarnings, PushOptions } from '../../../src/tool/commands';
import { SemanticModelSource } from '../../../src/libts/sources/semantic-model';
import { deployKnowledgeCatalog } from '../../../src/libts/semantic/kc';
import { SemanticModel } from '../../../src/libts/semantic/ir';
import { CatalogClientMock } from '../mocks';

function scope(): SemanticModelSource {
  return new SemanticModelSource('semantic-model', 'scope-proj.us.scope_eg');
}

function models(...names: string[]): SemanticModel[] {
  return names.map(name => ({ name, entities: [], relationships: [], metrics: [] }));
}

describe('resolveTargets', () => {
  test('defaults to BigQuery when unset', () => {
    expect(resolveTargets(undefined)).toEqual(['bigquery']);
  });

  test('accepts the bq short form and the bigquery alias', () => {
    expect(resolveTargets('bq')).toEqual(['bigquery']);
    expect(resolveTargets('bigquery')).toEqual(['bigquery']);
  });

  test('resolves kc', () => {
    expect(resolveTargets('kc')).toEqual(['kc']);
  });

  test('resolves both in BigQuery-first order (encodes fail-fast)', () => {
    expect(resolveTargets('both')).toEqual(['bigquery', 'kc']);
  });

  test('throws on an unknown target', () => {
    expect(() => resolveTargets('catalog')).toThrow(/--target must be one of: bq, kc, both/);
  });
});

describe('resolveKcCoords', () => {
  test('falls back to the catalog.yaml scope triple when no flags given', () => {
    expect(resolveKcCoords(scope(), {})).toEqual({
      project: 'scope-proj', location: 'us', entryGroup: 'scope_eg',
    });
  });

  test('--project overrides just the project (shared flag)', () => {
    const o: PushOptions = { project: 'flag-proj' };
    expect(resolveKcCoords(scope(), o)).toEqual({
      project: 'flag-proj', location: 'us', entryGroup: 'scope_eg',
    });
  });

  test('--location and --entry-group each override their segment', () => {
    const o: PushOptions = { location: 'eu', entryGroup: 'eg2' };
    expect(resolveKcCoords(scope(), o)).toEqual({
      project: 'scope-proj', location: 'eu', entryGroup: 'eg2',
    });
  });

  test('a mix of flag + scope resolves per-segment', () => {
    const o: PushOptions = { project: 'flag-proj', entryGroup: 'eg2' };
    expect(resolveKcCoords(scope(), o)).toEqual({
      project: 'flag-proj', location: 'us', entryGroup: 'eg2',
    });
  });
});

describe('unusedFlagWarnings', () => {
  test('no warnings when no coordinate flags are set', () => {
    expect(unusedFlagWarnings(['bigquery'], {})).toEqual([]);
    expect(unusedFlagWarnings(['kc'], {})).toEqual([]);
  });

  test('bigquery-only flags warn on a kc-only target', () => {
    expect(unusedFlagWarnings(['kc'], { dataset: 'ds', transpile: true })).toEqual([
      '--dataset is ignored for the kc target',
      '--transpile is ignored for the kc target',
    ]);
  });

  test('kc-only flags warn on a bigquery-only target', () => {
    expect(unusedFlagWarnings(['bigquery'], { location: 'eu', entryGroup: 'eg' })).toEqual([
      '--location is ignored for the bigquery target',
      '--entry-group is ignored for the bigquery target',
    ]);
  });

  test('both target warns for nothing — every flag applies somewhere', () => {
    expect(unusedFlagWarnings(['bigquery', 'kc'],
      { dataset: 'ds', transpile: true, location: 'eu', entryGroup: 'eg' })).toEqual([]);
  });

  test('--project is shared and never warned', () => {
    expect(unusedFlagWarnings(['bigquery'], { project: 'p' })).toEqual([]);
    expect(unusedFlagWarnings(['kc'], { project: 'p' })).toEqual([]);
  });
});

describe('deployKnowledgeCatalog (dry run)', () => {
  test('succeeds, writes nothing, and reports a plan per model', async () => {
    const client = new CatalogClientMock();
    const res = await deployKnowledgeCatalog(client, models('sales'),
      { project: 'p', location: 'us', entryGroup: 'eg', dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(1);
    expect(res.results[0].model).toBe('sales');
    expect(res.results[0].executed).toBe(false);
    expect(res.results[0].error).toBeUndefined();
    // The plan names the destination and the (default) custom-type coordinates.
    expect(res.results[0].ddl).toContain('p.us.eg');
    expect(res.results[0].ddl).toContain('custom types in p.global');
    // A dry run touches nothing.
    expect(client.mockEntries).toHaveLength(0);
  });

  test('--type-project/--type-location surface in the plan', async () => {
    const client = new CatalogClientMock();
    const res = await deployKnowledgeCatalog(client, models('sales'), {
      project: 'p', location: 'us', entryGroup: 'eg', dryRun: true,
      typeProject: 'types-proj', typeLocation: 'us-central1',
    });
    expect(res.results[0].ddl).toContain('custom types in types-proj.us-central1');
  });

  test('reports one result per model', async () => {
    const client = new CatalogClientMock();
    const res = await deployKnowledgeCatalog(client, models('a', 'b'),
      { project: 'p', location: 'us', entryGroup: 'eg', dryRun: true });
    expect(res.results.map(r => r.model)).toEqual(['a', 'b']);
  });
});
