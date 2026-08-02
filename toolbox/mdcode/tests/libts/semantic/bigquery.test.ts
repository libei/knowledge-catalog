// Behavior specification for the BigQuery property-graph generator
// (src/libts/semantic/bigquery.ts).
//
// The readable "big picture" tests live in `bigquery.e2e.test.ts`: a corpus of
// `<fixture>.yaml` inputs, each with a committed
// `<fixture>.bigquery.golden.sql` showing the exact generated DDL and warnings.
// Open a `.yaml` next to its golden to see a full translation. Prefer adding a
// fixture + golden there.
//
// This file holds only what a loader fixture CANNOT express, because the open
// AI-first format the loader reads is a subset of the IR:
//   - an M:N association edge (its own backing table, key, and edge properties)
//   —
//     the format has no association-table syntax, so its IR is hand-built here
//     and checked against a committed golden file.
//   - IR-contract cases the loader never produces: a COUNT(*) metric with a
//     declared home entity, and a metric whose declared entities disagree with
//     its expression (the loader always derives entities FROM the expression).
//   - degenerate inputs the format forbids (a model with no datasets) and pure
//     GenerateOptions behavior (graph naming / qualification fallback).
// Plus a structural invariant guard that parses generated DDL and asserts the
// shape BigQuery enforces for measures, run over the loaded fixtures.
//

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {GenerateOptions, generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';

const FIXTURES = path.join(__dirname, 'fixtures');

// Loads a corpus fixture to its IR (same defaults the e2e golden suite uses),
// so the invariant guard below can run over the exact models the goldens
// capture.
function loadFixture(fixture: string): SemanticModel {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  const {models} = loadModels(
      text, {defaultProject: 'sqlgen-testing', defaultDataset: 'demo'});
  return models[0];
}
const GEN_OPTS: GenerateOptions = {
  project: 'sqlgen-testing',
  dataset: 'demo'
};


describe(
    'M:N association edge (no association-table syntax in the open format yet)',
    () => {
      // Hand-built because the loader's relationship schema is direct-FK only
      // (from/to/columns) — it cannot express an edge backed by its own
      // association table with its own KEY and edge properties. The expected
      // DDL is a committed golden file
      // (`school_manytomany.bigquery.golden.sql`) so the output stays
      // reviewable as text; these exact strings were run against a live
      // BigQuery instance and traversed with a GQL MATCH.
      const SCHOOL: SemanticModel = {
        name: 'school_graph',
        entities: [
          {
            name: 'students',
            dataSource: 'students',
            keys: ['student_id'],
            fields: [
              {name: 'student_id', expression: 'students.student_id'},
              {name: 'name', expression: 'students.name'}
            ]
          },
          {
            name: 'courses',
            dataSource: 'courses',
            keys: ['course_id'],
            fields: [
              {name: 'course_id', expression: 'courses.course_id'},
              {name: 'title', expression: 'courses.title'}
            ]
          },
        ],
        relationships: [
          {
            name: 'enrollment',
            dataSource: 'enrollment',
            keys: ['enrollment_id'],
            source: {
              entity: 'students',
              joinKeys: {
                relationshipColumns: ['student_id'],
                entityColumns: ['student_id']
              }
            },
            destination: {
              entity: 'courses',
              joinKeys: {
                relationshipColumns: ['course_id'],
                entityColumns: ['course_id']
              }
            },
            fields: [{
              name: 'grade',
              expression: 'enrollment.grade',
              description: 'Letter grade'
            }]
          },
        ],
        metrics: [],
      };
      const SCHOOL_OPTS: GenerateOptions = {
        project: 'sqlgen-testing',
        dataset: 'bei_semantic_ir_verify'
      };

      test('the association graph matches its committed golden DDL', () => {
        const {ddl} = generatePropertyGraph(SCHOOL, SCHOOL_OPTS);
        const golden = fs.readFileSync(
            path.join(FIXTURES, 'school_manytomany.bigquery.golden.sql'),
            'utf8');
        expect(ddl).toBe(golden);
      });
    });


describe('IR-contract metric cases the loader cannot produce', () => {
  // A minimal one-entity model shared by the cases below. Metrics are supplied
  // per test with an explicit `entities`, which is exactly what the loader
  // never does independently of the expression.
  const orders = (): SemanticModel => ({
    name: 'm',
    relationships: [],
    metrics: [],
    entities: [{
      name: 'orders',
      dataSource: 'orders',
      keys: ['o_orderkey'],
      fields: [{name: 'o_orderkey', expression: 'orders.o_orderkey'}]
    }],
  });

  test(
      'COUNT(*) with a declared home entity lowers to COUNT over the key property',
      () => {
        // COUNT(*) names no column, so it relies on the metric's declared home.
        // The loader always derives entities from the expression, so a
        // qualifier-free COUNT(*) gets entities:[] there and is skipped; a
        // producer that declares the home (or hand-built IR) reaches this
        // lowering.
        const model = orders();
        model.metrics = [
          {name: 'order_count', expression: 'COUNT(*)', entities: ['orders']}
        ];
        const {ddl} = generatePropertyGraph(model, GEN_OPTS);
        expect(ddl).toContain('MEASURE(COUNT(o_orderkey)) AS order_count');
      });

  test(
      'a metric whose declared entities disagree with its expression is reported',
      () => {
        // Declared entities:['orders'] but the expression aggregates a
        // different known entity (order_items); the generator places per the
        // expression and surfaces the discrepancy rather than resolving it
        // silently. The loader cannot create this state (it sets entities FROM
        // the expression).
        const model = orders();
        model.entities.push({
          name: 'order_items',
          dataSource: 'order_items',
          keys: ['order_item_id'],
          fields: [
            {name: 'order_item_id', expression: 'order_items.order_item_id'}
          ],
        });
        model.metrics = [{
          name: 'mislabeled',
          expression: 'SUM(order_items.amount)',
          entities: ['orders']
        }];
        const {warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(
                   w => w.includes('metric \'mislabeled\'') &&
                       w.includes('declares entities')))
            .toBe(true);
      });
});


describe('degenerate inputs and GenerateOptions behavior', () => {
  test(
      'a model with no entities is reported, not silently emitted as an invalid graph',
      () => {
        // The open format requires datasets.min(1), so this state is only
        // reachable as hand-built IR.
        const {warnings} = generatePropertyGraph(
            {name: 'm', entities: [], relationships: [], metrics: []},
            GEN_OPTS);
        expect(warnings.some(w => w.includes('no entities'))).toBe(true);
      });

  test('graph name and unqualified table refs fall back to options', () => {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [{
        name: 'e',
        dataSource: 't',
        keys: ['id'],
        fields: [{name: 'id', expression: 'e.id'}]
      }],
    };
    const {ddl} = generatePropertyGraph(
        model, {project: 'p', dataset: 'd', graphName: 'g'});
    expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH `p.d.g`');
    expect(ddl).toContain('`p.d.t` AS e');
  });

  test('a table with no resolvable project/dataset yields a warning', () => {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [{name: 'e', dataSource: 't', keys: ['id'], fields: []}],
    };
    const {warnings} = generatePropertyGraph(model);  // no opts to fall back to
    expect(warnings.some(w => w.includes('missing a project and/or dataset')))
        .toBe(true);
  });
});


// The BigQuery restrictions recorded at
// go/x20 -> bei/bigquery-property-graph-limits.html (section A): a graph
// MEASURE may only aggregate a SINGLE EXPOSED PROPERTY of its node — never a
// raw column (A1), an inline expression (A2), or `*` (A3). Rather than
// enumerate inputs one by one, this guard parses the emitted DDL and asserts
// the invariant BigQuery itself enforces, so ANY future emitter change that
// reintroduces a rejected shape fails here — even for inputs no explicit test
// covers.
describe(
    'emitter never produces a MEASURE shape BigQuery rejects (x20 record §A)',
    () => {
      // For each NODE block: the names it exposes as (non-measure) properties,
      // and the aggregate operand of each MEASURE it declares.
      function parseNodeMeasures(ddl: string): Record < string, {
        exposed: Set<string>;
        operands: string[]
      }
      > {
        const nodes: Record < string, {
          exposed: Set<string>;
          operands: string[]
        }
        > = {};
        let inNodeSection = false, inProps = false;
        let cur: string|null = null;
        for (const raw of ddl.split('\n')) {
          const t = raw.trim();
          if (t.startsWith('NODE TABLES')) {
            inNodeSection = true;
            continue;
          }
          if (t.startsWith('EDGE TABLES')) {
            inNodeSection = false;
            continue;
          }
          if (!inNodeSection) continue;
          const alias = t.match(/^`[^`]+`\s+AS\s+(\w+)$/);
          if (alias) {
            cur = alias[1];
            nodes[cur] = {exposed: new Set(), operands: []};
            inProps = false;
            continue;
          }
          if (t.endsWith('PROPERTIES(')) {
            inProps = true;
            continue;
          }
          if (inProps && (t === ')' || t === '),')) {
            inProps = false;
            continue;
          }
          if (!inProps || !cur) continue;
          const meas = t.match(
              /^MEASURE\(\s*\w+\(\s*(?:DISTINCT\s+)?(.*?)\)\s*\)\s+AS\s+\w+,?$/);
          if (meas) {
            nodes[cur].operands.push(meas[1].trim());
            continue;
          }
          // A non-measure property line: record the name it exposes (after AS,
          // or the bare identifier), ignoring any trailing comma or
          // OPTIONS(...) suffix.
          const noOpts =
              t.replace(/,\s*$/, '').replace(/\s+OPTIONS\(.*\)$/, '');
          const asIdx = noOpts.lastIndexOf(' AS ');
          nodes[cur].exposed.add(
              (asIdx >= 0 ? noOpts.slice(asIdx + 4) : noOpts).trim());
        }
        return nodes;
      }

      function assertLegalMeasures(ddl: string): void {
        expect(ddl).not.toContain(
            'MEASURE(COUNT(*))');  // §A3 star must never survive
        for (const {exposed, operands} of Object.values(
                 parseNodeMeasures(ddl))) {
          for (const op of operands) {
            // §A1/§A2: a bare identifier only — no parentheses, operators, or
            // `*`.
            expect(op).toMatch(/^[A-Za-z_]\w*$/);
            // ...and it must be an exposed property of the very same node.
            expect(exposed.has(op)).toBe(true);
          }
        }
      }

      // The fixtures whose goldens carry measures — the invariant must hold for
      // each.
      test('the live-verified fan-out chain satisfies the invariant', () => {
        assertLegalMeasures(
            generatePropertyGraph(loadFixture('sales_fanout.yaml'), GEN_OPTS)
                .ddl);
      });

      test('every lowered operand shape stays a legal MEASURE', () => {
        assertLegalMeasures(generatePropertyGraph(
                                loadFixture('measure_lowering.yaml'), GEN_OPTS)
                                .ddl);
      });

      test('a COUNT(*) lowering (star -> key property) stays legal', () => {
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          entities: [{
            name: 'orders',
            dataSource: 'orders',
            keys: ['o_orderkey'],
            fields: [{name: 'o_orderkey', expression: 'orders.o_orderkey'}]
          }],
          metrics: [
            {name: 'n_orders', expression: 'COUNT(*)', entities: ['orders']}
          ],
        };
        const {ddl} = generatePropertyGraph(model, GEN_OPTS);
        assertLegalMeasures(ddl);
        expect(ddl).toContain('MEASURE(COUNT(o_orderkey)) AS n_orders');
        expect(ddl).not.toContain('MEASURE(COUNT(*))');
      });
    });
