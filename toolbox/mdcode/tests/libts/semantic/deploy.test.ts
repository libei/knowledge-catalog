// Unit tests for the BigQuery deployer (semantic model -> property-graph DDL ->
// jobs.query) and the semantic-model manifest scope wiring.
//
// These exercise the orchestration around the pure emitter (already golden-tested
// in bigquery.e2e.test.ts): that the DDL is executed exactly once per model, that
// --dry-run compiles without executing, and that an execution error fails fast.

import { describe, test, expect, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import { loadModels } from '../../../src/libts/semantic/loader';
import { generatePropertyGraph, deployBigQuery } from '../../../src/libts/semantic';
import {
  SqlTranspiler, TranspileRequest, TranspileResponse,
} from '../../../src/libts/semantic/transpile';
import * as bq from '../../../src/libts/gcp/bigquery';
import * as gcp from '../../../src/libts/gcp';
import { CatalogManifest } from '../../../src/libts/manifest';
import { SemanticModelSource } from '../../../src/libts/sources/semantic-model';
import { createLayout, Layouts } from '../../../src/libts/layout';

const FIXTURES = path.join(__dirname, 'fixtures');
const CTX = new gcp.ApiContext('ctx-project', 'us', 'token');

// A BigQuery client whose query() records calls instead of hitting the service.
class FakeBigQuery extends bq.BigQueryClient {
  public calls: { project: string; sql: string }[] = [];
  public status = 200;
  public response: bq.QueryResponse = {};

  constructor() {
    super(CTX);
  }

  async query(project: string, sql: string): Promise<gcp.ApiResult<bq.QueryResponse>> {
    this.calls.push({ project, sql });
    return { status: this.status, result: this.response };
  }
}

function loadFixture(fixture: string) {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  return loadModels(text, { defaultProject: 'sqlgen-testing', defaultDataset: 'demo' });
}


describe('deployBigQuery executes the generated DDL', () => {
  test('runs the property-graph DDL once, billed to the resolved project', async () => {
    const { models } = loadFixture('sales_fanout.yaml');
    const client = new FakeBigQuery();

    const result = await deployBigQuery(client, models, { project: 'sqlgen-testing', dataset: 'demo' });

    expect(result.ok).toBe(true);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].project).toBe('sqlgen-testing');
    expect(client.calls[0].sql).toContain('CREATE OR REPLACE PROPERTY GRAPH');

    // The executed DDL is exactly what the pure emitter produces.
    const expected = generatePropertyGraph(models[0], { project: 'sqlgen-testing', dataset: 'demo' }).ddl;
    expect(client.calls[0].sql).toBe(expected);
    expect(result.results[0].executed).toBe(true);
    expect(result.results[0].error).toBeUndefined();
  });

  test('dry run compiles the DDL but never calls the service', async () => {
    const { models } = loadFixture('sales_fanout.yaml');
    const client = new FakeBigQuery();

    const result = await deployBigQuery(client, models, {
      project: 'sqlgen-testing', dataset: 'demo', dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(client.calls).toHaveLength(0);
    expect(result.results[0].executed).toBe(false);
    expect(result.results[0].ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH');
  });

  test('a query-level error fails fast and reports the reason', async () => {
    const { models } = loadFixture('sales_fanout.yaml');
    const client = new FakeBigQuery();
    client.response = { errors: [{ message: 'Not found: Table foo' }] };

    const result = await deployBigQuery(client, models, { project: 'sqlgen-testing', dataset: 'demo' });

    expect(result.ok).toBe(false);
    expect(result.results[0].executed).toBe(false);
    expect(result.results[0].error).toContain('Not found: Table foo');
  });

  test('an incomplete job (jobComplete=false) is reported as a failure, not success', async () => {
    const { models } = loadFixture('sales_fanout.yaml');
    const client = new FakeBigQuery();
    client.response = { jobComplete: false };

    const result = await deployBigQuery(client, models, { project: 'sqlgen-testing', dataset: 'demo' });

    expect(result.ok).toBe(false);
    expect(result.results[0].executed).toBe(false);
    expect(result.results[0].error).toContain('jobComplete=false');
  });

  test('a shared graphName across multiple models is rejected (would clobber)', async () => {
    const { models } = loadFixture('sales_fanout.yaml');
    const client = new FakeBigQuery();
    const two = [models[0], models[0]];

    await expect(deployBigQuery(client, two, { graphName: 'shared' })).rejects.toThrow(/more than one model/);
    expect(client.calls).toHaveLength(0);
  });

  test('with no --project override, the job is billed to the entity table project', async () => {
    // sales_fanout tables carry no project in their source; the loader fills the
    // default project, which then becomes the run project when no override is set.
    const { models } = loadFixture('sales_fanout.yaml');
    const client = new FakeBigQuery();

    await deployBigQuery(client, models, {});

    expect(client.calls[0].project).toBe('sqlgen-testing');
  });
});


describe('semantic-model manifest scope', () => {
  test('initWithSemanticModel builds the scope WITHOUT any Dataplex/KC lookup', async () => {
    // The semantic-model path must not touch the Knowledge Catalog: init resolves
    // the scope purely from its name, with no getEntryGroup call.
    const spy = spyOn(gcp.CatalogClient.prototype, 'getEntryGroup');

    const manifest = await CatalogManifest.initWithSemanticModel('my-proj.us-central1.sales-group', CTX);

    expect(spy).not.toHaveBeenCalled();
    expect(manifest.source).toBeInstanceOf(SemanticModelSource);
    expect(manifest.source.type).toBe('semantic-model');
    // What save() serializes into catalog.yaml: `${type}.${name}`.
    expect(`${manifest.source.type}.${manifest.source.name}`)
      .toBe('semantic-model.my-proj.us-central1.sales-group');
    expect((manifest.source as SemanticModelSource).entryGroupId).toBe('sales-group');

    spy.mockRestore();
  });

  test('the entry-sync members are unsupported (KC push deferred)', () => {
    const source = new SemanticModelSource('semantic-model', 'p.us.eg');
    expect(() => source.localName({} as gcp.Entry)).toThrow(/does not support entry sync/);
    expect(() => source.serviceName('x')).toThrow(/does not support entry sync/);
  });

  test('the semantic-model layout is not yet constructible (multi-file deferred)', () => {
    expect(() => createLayout(Layouts.SEMANTIC_MODEL, '/tmp/catalog'))
      .toThrow(/multi-file layout deferred/);
  });
});


// A fake transpiler driven by a fixed expression->GoogleSQL map, so this stays
// hermetic (no Python/sqlglot; that mechanism has its own tests). Records the
// batches it was called with.
function fakeTranspiler(map: Record<string, string>): SqlTranspiler & { calls: TranspileRequest[][] } {
  const fn = ((requests: TranspileRequest[], _target: string): Promise<TranspileResponse[]> => {
    fn.calls.push(requests);
    return Promise.resolve(requests.map(r =>
      r.expression in map
        ? { id: r.id, sql: map[r.expression] }
        : { id: r.id, error: 'no mapping' }));
  }) as SqlTranspiler & { calls: TranspileRequest[][] };
  fn.calls = [];
  return fn;
}

// A model authored in Snowflake: one vendor field label and one vendor metric,
// which the loader marks with `expressionDialect` for the transpile pass.
const VENDOR_YAML = `
version: "0.2.0.dev0"
semantic_model:
  - name: vendor_demo
    datasets:
      - name: orders
        source: orders
        primary_key: [o_orderkey]
        fields:
          - name: o_orderkey
            expression:
              dialects: [{dialect: ANSI_SQL, expression: o_orderkey}]
          - name: status_label
            expression:
              dialects: [{dialect: SNOWFLAKE, expression: "IFF(orders.o_orderstatus = 'F', 'done', 'open')"}]
    metrics:
      - name: fulfilled_revenue
        expression:
          dialects: [{dialect: SNOWFLAKE, expression: "SUM(IFF(orders.o_orderstatus = 'F', orders.o_totalprice, 0))"}]
`;

describe('deployBigQuery --transpile rewrites vendor-dialect expressions', () => {
  const GOOGLE_SQL = {
    "IFF(orders.o_orderstatus = 'F', 'done', 'open')":
      "IF(orders.o_orderstatus = 'F', 'done', 'open')",
    "SUM(IFF(orders.o_orderstatus = 'F', orders.o_totalprice, 0))":
      "SUM(IF(orders.o_orderstatus = 'F', orders.o_totalprice, 0))",
  };

  test('with transpile on, the emitted DDL contains GoogleSQL, not the vendor SQL', async () => {
    const { models } = loadModels(VENDOR_YAML, { defaultProject: 'sqlgen-testing', defaultDataset: 'demo' });
    const client = new FakeBigQuery();
    const transpiler = fakeTranspiler(GOOGLE_SQL);

    const result = await deployBigQuery(client, models, {
      project: 'sqlgen-testing', dataset: 'demo', dryRun: true, transpile: true, transpiler,
    });

    expect(result.ok).toBe(true);
    // The transpiler saw both vendor expressions in a single batch.
    expect(transpiler.calls).toHaveLength(1);
    expect(transpiler.calls[0]).toHaveLength(2);

    // The emitter strips the `orders.` qualifier inside PROPERTIES, so the
    // transpiled GoogleSQL appears unqualified in the DDL.
    const ddl = result.results[0].ddl;
    expect(ddl).toContain("IF(o_orderstatus = 'F', 'done', 'open')");
    // The metric's inline IF() is lowered to a derived property; BigQuery rejects
    // an expression directly inside MEASURE (x20 record §A2).
    expect(ddl).toContain("IF(o_orderstatus = 'F', o_totalprice, 0) AS fulfilled_revenue_input");
    expect(ddl).toContain('MEASURE(SUM(fulfilled_revenue_input)) AS fulfilled_revenue');
    // The vendor form must be gone, and no inline expression survives in a MEASURE.
    expect(ddl).not.toContain('IFF(');
    expect(ddl).not.toContain('MEASURE(SUM(IF(');

    // Transpile provenance surfaces as warnings, before any compile warnings.
    expect(result.results[0].warnings.some(w => /transpiled 'SNOWFLAKE' -> 'BIGQUERY'/.test(w))).toBe(true);
  });

  test('with transpile off (default), the vendor SQL is left verbatim and no transpiler runs', async () => {
    const { models } = loadModels(VENDOR_YAML, { defaultProject: 'sqlgen-testing', defaultDataset: 'demo' });
    const client = new FakeBigQuery();
    const transpiler = fakeTranspiler(GOOGLE_SQL);

    const result = await deployBigQuery(client, models, {
      project: 'sqlgen-testing', dataset: 'demo', dryRun: true, transpiler,  // transpile omitted
    });

    expect(result.ok).toBe(true);
    expect(transpiler.calls).toHaveLength(0);
    expect(result.results[0].ddl).toContain('IFF(');
  });
});
