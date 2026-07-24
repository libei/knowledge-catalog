// Behavior specification for the transpile pass (src/libts/semantic/transpile.ts),
// using an INJECTED fake transpiler so these tests are hermetic (no Python, no
// sqlglot). The real sqlglot mechanism is covered by transpile.sqlglot.test.ts;
// the end-to-end golden by transpile.e2e.test.ts.

import { describe, test, expect } from 'bun:test';
import {
  transpileModel, SqlTranspiler, TranspileRequest, TranspileResponse,
} from '../../../src/libts/semantic/transpile';
import { SemanticModel } from '../../../src/libts/semantic/ir';

// A model with one vendor field and one vendor metric on `orders`, plus a
// canonical (already-target) field that carries no provenance.
function model(): SemanticModel {
  return {
    name: 'm',
    entities: [{
      name: 'orders',
      dataSource: { table: 'orders' },
      keys: ['o_orderkey'],
      fields: [
        { name: 'o_orderkey', expression: 'o_orderkey' },
        {
          name: 'status_label',
          expression: "IFF(orders.o_orderstatus = 'F', 'done', 'open')",
          expressionDialect: 'SNOWFLAKE',
        },
      ],
    }],
    relationships: [],
    metrics: [{
      name: 'fulfilled_revenue',
      expression: "SUM(IFF(orders.o_orderstatus = 'F', orders.o_totalprice, 0))",
      entities: ['orders'],
      expressionDialect: 'SNOWFLAKE',
    }],
  };
}

// A fake transpiler driven by a fixed input->output map; anything unmapped comes
// back as an error. Records the requests it saw.
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


describe('a vendor expression is transpiled and its provenance cleared', () => {
  const transpiler = fakeTranspiler({
    "IFF(orders.o_orderstatus = 'F', 'done', 'open')":
      "IF(orders.o_orderstatus = 'F', 'done', 'open')",
    "SUM(IFF(orders.o_orderstatus = 'F', orders.o_totalprice, 0))":
      "SUM(IF(orders.o_orderstatus = 'F', orders.o_totalprice, 0))",
  });
  const input = model();
  let out: Awaited<ReturnType<typeof transpileModel>>;

  test('field and metric expressions are rewritten', async () => {
    out = await transpileModel(input, { target: 'BIGQUERY', transpiler });
    const field = out.model.entities[0].fields[1];
    const metric = out.model.metrics[0];
    expect(field.expression).toBe("IF(orders.o_orderstatus = 'F', 'done', 'open')");
    expect(metric.expression).toBe("SUM(IF(orders.o_orderstatus = 'F', orders.o_totalprice, 0))");
  });

  test('the expressionDialect provenance is cleared after transpiling', () => {
    expect(out.model.entities[0].fields[1].expressionDialect).toBeUndefined();
    expect(out.model.metrics[0].expressionDialect).toBeUndefined();
  });

  test('a per-expression success note names both dialects', () => {
    expect(out.warnings).toContain("field 'orders.status_label': transpiled 'SNOWFLAKE' -> 'BIGQUERY'");
    expect(out.warnings).toContain("metric 'fulfilled_revenue': transpiled 'SNOWFLAKE' -> 'BIGQUERY'");
  });

  test('the input model is not mutated (a clone is returned)', () => {
    expect(input.entities[0].fields[1].expression)
      .toBe("IFF(orders.o_orderstatus = 'F', 'done', 'open')");
    expect(input.entities[0].fields[1].expressionDialect).toBe('SNOWFLAKE');
    expect(out.model).not.toBe(input);
  });
});


describe('an untranspilable expression is left verbatim with a warning', () => {
  test('an error response keeps the expression and its provenance', async () => {
    const transpiler = fakeTranspiler({}); // nothing maps => all errors
    const input = model();
    const { model: out, warnings } = await transpileModel(input, { transpiler });
    const field = out.entities[0].fields[1];
    expect(field.expression).toBe("IFF(orders.o_orderstatus = 'F', 'done', 'open')");
    expect(field.expressionDialect).toBe('SNOWFLAKE');
    expect(warnings).toContain(
      "field 'orders.status_label': could not transpile 'SNOWFLAKE' -> 'BIGQUERY' (no mapping); left verbatim");
  });
});


describe('the qualifier-preservation guard rejects entity-altering rewrites', () => {
  test('a rewrite that changes the referenced entity set is kept verbatim', async () => {
    // The fake re-cases the `orders.` qualifier to `Orders.`; referencedEntityNames
    // matches case-sensitively, so the entity set would change from {orders} to {}
    // and the downstream measure would silently drop. The guard must reject it.
    const transpiler = fakeTranspiler({
      "IFF(orders.o_orderstatus = 'F', 'done', 'open')":
        "IF(Orders.o_orderstatus = 'F', 'done', 'open')",
      "SUM(IFF(orders.o_orderstatus = 'F', orders.o_totalprice, 0))":
        "SUM(IF(orders.o_orderstatus = 'F', orders.o_totalprice, 0))",
    });
    const { model: out, warnings } = await transpileModel(model(), { transpiler });
    const field = out.entities[0].fields[1];
    expect(field.expression).toBe("IFF(orders.o_orderstatus = 'F', 'done', 'open')");
    expect(field.expressionDialect).toBe('SNOWFLAKE');
    expect(warnings.some(w =>
      w.startsWith("field 'orders.status_label':") && w.includes('altered the referenced entities')
      && w.includes('kept verbatim'))).toBe(true);
    // The metric, whose qualifiers survive, is still transpiled.
    expect(out.metrics[0].expression).toBe("SUM(IF(orders.o_orderstatus = 'F', orders.o_totalprice, 0))");
  });
});


describe('a model with no vendor provenance is a no-op', () => {
  test('the transpiler is never invoked and the model is returned unchanged', async () => {
    const clean: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'orders', dataSource: { table: 'orders' }, keys: ['id'],
        fields: [{ name: 'id', expression: 'id' }],
      }],
      relationships: [],
      metrics: [{ name: 'total', expression: 'SUM(orders.amount)', entities: ['orders'] }],
    };
    const transpiler = fakeTranspiler({});
    const { model: out, warnings } = await transpileModel(clean, { transpiler });
    expect(transpiler.calls).toHaveLength(0);
    expect(warnings).toEqual([]);
    expect(out).toEqual(clean);
  });
});


describe('multiple source dialects are transpiled independently', () => {
  test('each request carries its own source dialect', async () => {
    const input: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'orders', dataSource: { table: 'orders' }, keys: ['id'],
        fields: [
          { name: 'a', expression: 'orders.a::text', expressionDialect: 'POSTGRES' },
          { name: 'b', expression: 'orders.b::double', expressionDialect: 'DATABRICKS' },
        ],
      }],
      relationships: [],
      metrics: [],
    };
    let seen: TranspileRequest[] = [];
    const transpiler: SqlTranspiler = (requests) => {
      seen = requests;
      return Promise.resolve(requests.map(r => ({ id: r.id, sql: `CAST(${r.expression})` })));
    };
    await transpileModel(input, { transpiler });
    expect(seen.map(r => r.dialect).sort()).toEqual(['DATABRICKS', 'POSTGRES']);
  });
});
