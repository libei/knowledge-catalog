// Behavior specification for the BigQuery property-graph generator
// (src/libts/semantic/bigquery.ts).
//
// Each test names and documents one behavior of `generatePropertyGraph`. The two
// fixtures below (a direct-FK chain and an M:N association) were executed against
// a live BigQuery instance (project `sqlgen-testing`): the chain's node measures
// were validated with GRAPH_EXPAND + AGG against a plain-SQL control, and the
// association graph was traversed with a GQL MATCH. The "matches verified DDL"
// tests pin the generator output to the exact text BigQuery accepted, so this
// suite guards the behavior without needing a live instance.
//

import { describe, test, expect } from 'bun:test';
import { generatePropertyGraph, GenerateOptions } from '../../../src/libts/semantic/bigquery';
import { SemanticModel, Metric } from '../../../src/libts/semantic/ir';

// Target used for the live verification; kept so the golden DDL below is
// reproducible byte-for-byte.
const OPTS: GenerateOptions = { project: 'sqlgen-testing', dataset: 'bei_semantic_ir_verify' };

// Direct-FK chain: order_items (root) -> orders -> customers, with node-level
// measures. Verified live via GRAPH_EXPAND + AGG.
const SALES: SemanticModel = {
  name: 'sales_graph',
  entities: [
    { name: 'customers', dataSource: { table: 'customers' }, keys: ['customer_id'],
      fields: [
        { name: 'customer_id', expression: 'customers.customer_id' },
        { name: 'region', expression: 'customers.region', description: 'Sales region' },
      ] },
    { name: 'orders', dataSource: { table: 'orders' }, keys: ['order_id'],
      fields: [
        { name: 'order_id', expression: 'orders.order_id' },
        { name: 'customer_id', expression: 'orders.customer_id' },
        { name: 'status', expression: 'orders.status' },
      ] },
    { name: 'order_items', dataSource: { table: 'order_items' }, keys: ['order_item_id'],
      fields: [
        { name: 'order_item_id', expression: 'order_items.order_item_id' },
        { name: 'order_id', expression: 'order_items.order_id' },
        { name: 'amount', expression: 'order_items.amount' },
      ] },
  ],
  relationships: [
    { name: 'orders_customers',
      source:      { entity: 'orders',    joinKeys: { relationshipColumns: ['order_id'],    entityColumns: ['order_id'] } },
      destination: { entity: 'customers', joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] } } },
    { name: 'orderitems_orders',
      source:      { entity: 'order_items', joinKeys: { relationshipColumns: ['order_item_id'], entityColumns: ['order_item_id'] } },
      destination: { entity: 'orders',      joinKeys: { relationshipColumns: ['order_id'],      entityColumns: ['order_id'] } } },
  ],
  metrics: [
    { name: 'total_revenue', expression: 'SUM(order_items.amount)',          entities: ['order_items'] },
    { name: 'item_count',    expression: 'COUNT(order_items.order_item_id)', entities: ['order_items'] },
    { name: 'order_count',   expression: 'COUNT(orders.order_id)',           entities: ['orders'] },
  ],
};

// M:N via an association table with its own key and an edge property. Verified
// live via a GQL MATCH traversal.
const SCHOOL: SemanticModel = {
  name: 'school_graph',
  entities: [
    { name: 'students', dataSource: { table: 'students' }, keys: ['student_id'],
      fields: [ { name: 'student_id', expression: 'students.student_id' },
                { name: 'name', expression: 'students.name' } ] },
    { name: 'courses', dataSource: { table: 'courses' }, keys: ['course_id'],
      fields: [ { name: 'course_id', expression: 'courses.course_id' },
                { name: 'title', expression: 'courses.title' } ] },
  ],
  relationships: [
    { name: 'enrollment',
      dataSource: { table: 'enrollment' },
      keys: ['enrollment_id'],
      source:      { entity: 'students', joinKeys: { relationshipColumns: ['student_id'], entityColumns: ['student_id'] } },
      destination: { entity: 'courses',  joinKeys: { relationshipColumns: ['course_id'],  entityColumns: ['course_id'] } },
      fields: [ { name: 'grade', expression: 'enrollment.grade', description: 'Letter grade' } ] },
  ],
  metrics: [],
};


describe('model-level metrics become inline measures', () => {
  const { warnings } = generatePropertyGraph(SALES, OPTS);

  test('a measure is attached to its owning entity, keeping it locked to that KEY', () => {
    const { ddl } = generatePropertyGraph(SALES, OPTS);
    // order_count counts orders, so it must live on the `orders` node (locked to
    // order_id) — not on the fan-out `order_items` table. Live verification
    // confirmed this yields 3 orders for the "west" region, not 4 (the item
    // count), proving joins do not inflate the measure.
    const ordersBlock = ddl.slice(ddl.indexOf('AS orders\n'), ddl.indexOf('AS order_items'));
    expect(ordersBlock).toContain('MEASURE(COUNT(order_id)) AS order_count');
  });

  test('a metric whose aggregate spans multiple tables is skipped and reported', () => {
    // A BigQuery measure binds to a single table's KEY, so a genuinely
    // cross-table aggregate cannot become one MEASURE.
    const model: SemanticModel = {
      ...SALES,
      metrics: [{ name: 'weird', expression: 'SUM(order_items.amount * customers.customer_id)',
                  entities: ['order_items', 'customers'] }],
    };
    const res = generatePropertyGraph(model, OPTS);
    expect(res.ddl).not.toContain('weird');
    expect(res.warnings.some(w => w.includes("metric 'weird'") && w.includes('multiple tables')))
      .toBe(true);
  });

  test('placeable metrics produce no warnings', () => {
    expect(warnings).toEqual([]);
  });
});


describe('graph naming and options', () => {
  test('graph name and unqualified table refs fall back to options', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [{ name: 'e', dataSource: { table: 't' }, keys: ['id'],
                   fields: [{ name: 'id', expression: 'e.id' }] }],
      relationships: [],
      metrics: [],
    };
    const { ddl } = generatePropertyGraph(model, { project: 'p', dataset: 'd', graphName: 'g' });
    expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH `p.d.g`');
    expect(ddl).toContain('`p.d.t` AS e');
  });

  test('a model with no relationships omits the EDGE TABLES block', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [{ name: 'e', dataSource: { table: 't' }, keys: ['id'], fields: [] }],
      relationships: [],
      metrics: [],
    };
    const { ddl } = generatePropertyGraph(model, OPTS);
    expect(ddl).not.toContain('EDGE TABLES');
  });

  test('a table with no resolvable project/dataset yields a warning', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [{ name: 'e', dataSource: { table: 't' }, keys: ['id'], fields: [] }],
      relationships: [],
      metrics: [],
    };
    const { warnings } = generatePropertyGraph(model);  // no opts to fall back to
    expect(warnings.some(w => w.includes('missing a project and/or dataset'))).toBe(true);
  });
});


describe('robust handling of messy inputs (from code review)', () => {
  test('a description with newlines/tabs/quotes escapes into a single valid string literal', () => {
    // Raw newlines cannot appear inside a BigQuery double-quoted literal; they
    // (and \t, ", \) must be escaped or the OPTIONS(description=...) is invalid.
    const model: SemanticModel = {
      name: 'm', relationships: [], metrics: [],
      entities: [{ name: 'e', dataSource: { table: 't' }, keys: ['id'],
        fields: [{ name: 'id', expression: 'e.id', description: 'line1\nline2\t"q"' }] }],
    };
    const { ddl } = generatePropertyGraph(model, OPTS);
    expect(ddl).toContain('OPTIONS(description="line1\\nline2\\t\\"q\\"")');
    expect(ddl).not.toContain('line1\nline2');  // no raw newline inside the literal
  });

  test('an entity qualifier inside a string literal is neither stripped nor counted as a reference', () => {
    // Only order_items is genuinely referenced; 'orders.note' is data. The metric
    // must place on order_items (not be flagged as spanning orders too), and the
    // literal text must survive qualifier stripping unchanged. The aggregate's
    // operand is an expression, so it is exposed as a derived property and the
    // MEASURE aggregates that property (a MEASURE cannot wrap a raw expression).
    const model: SemanticModel = {
      ...SALES,
      metrics: [{ name: 'flagged',
        expression: "SUM(IF(CAST(order_items.amount AS STRING) = 'orders.note', 0, order_items.amount))",
        entities: ['order_items'] }],
    };
    const { ddl, warnings } = generatePropertyGraph(model, OPTS);
    // The operand is lowered to a derived property, with the qualifier stripped
    // from real columns but the 'orders.note' literal preserved verbatim.
    expect(ddl).toContain("IF(CAST(amount AS STRING) = 'orders.note', 0, amount) AS flagged_input");
    expect(ddl).toContain('MEASURE(SUM(flagged_input)) AS flagged');
    expect(warnings.some(w => w.includes('flagged') && w.includes('multiple'))).toBe(false);
  });

  test("a metric whose declared entities disagree with its expression is reported", () => {
    // The IR declares entities: ['orders'] but the expression aggregates
    // order_items; the generator places per the expression and surfaces the
    // discrepancy instead of resolving it silently.
    const model: SemanticModel = {
      ...SALES,
      metrics: [{ name: 'mislabeled', expression: 'SUM(order_items.amount)', entities: ['orders'] }],
    };
    const { warnings } = generatePropertyGraph(model, OPTS);
    expect(warnings.some(w => w.includes("metric 'mislabeled'") && w.includes('declares entities')))
      .toBe(true);
  });

  test('a model with no entities is reported rather than silently emitting an invalid graph', () => {
    const model: SemanticModel = { name: 'm', entities: [], relationships: [], metrics: [] };
    const { warnings } = generatePropertyGraph(model, OPTS);
    expect(warnings.some(w => w.includes('no entities'))).toBe(true);
  });

  test('an entity with an empty KEY is skipped, and edges referencing it are omitted', () => {
    // A graph node requires a KEY; a keyless entity (e.g. a dimension declared
    // with no primary_key, only custom_extensions) cannot form a valid node, so
    // it and any edge pointing at it are dropped rather than emitted as invalid
    // `KEY()` and a dangling edge REFERENCE. Surfaced by the corpus golden for
    // the date_dim fixture.
    const model: SemanticModel = {
      name: 'm',
      entities: [
        { name: 'facts', dataSource: { table: 'facts' }, keys: ['id'],
          fields: [{ name: 'id', expression: 'facts.id' }] },
        { name: 'nokey', dataSource: { table: 'nokey' }, keys: [], fields: [] },
      ],
      relationships: [
        { name: 'facts_to_nokey',
          source:      { entity: 'facts', joinKeys: { relationshipColumns: ['id'],       entityColumns: ['id'] } },
          destination: { entity: 'nokey', joinKeys: { relationshipColumns: ['nokey_id'], entityColumns: ['nokey_id'] } } },
      ],
      metrics: [],
    };
    const { ddl, warnings } = generatePropertyGraph(model, OPTS);
    expect(ddl).not.toContain('nokey');       // node skipped
    expect(ddl).not.toContain('KEY()');       // never emit an empty key
    expect(ddl).not.toContain('EDGE TABLES'); // the only edge referenced the skipped node
    expect(warnings.some(w => w.includes("entity 'nokey'") && w.includes('empty KEY'))).toBe(true);
    expect(warnings.some(w => w.includes("relationship 'facts_to_nokey'") && w.includes('skipped entity')))
      .toBe(true);
  });
});


describe('measure operand lowering (a MEASURE can only aggregate an exposed property)', () => {
  // Minimal one-entity model; each test supplies its own metrics. Since every
  // metric here homes on the sole `orders` entity, `entities` defaults to it
  // (a metric may still override) so the cases read as just name + expression.
  const base = (metrics: Array<Omit<Metric, 'entities'> & { entities?: string[] }>): SemanticModel => ({
    name: 'm', relationships: [],
    metrics: metrics.map(m => ({ entities: ['orders'], ...m })),
    entities: [{ name: 'orders', dataSource: { table: 'orders' }, keys: ['o_orderkey'],
      fields: [
        { name: 'o_orderkey', expression: 'orders.o_orderkey' },
        { name: 'status', expression: 'orders.status' },
      ] }],
  });

  test('an aggregate over an expression exposes a derived property and measures it', () => {
    const { ddl } = generatePropertyGraph(
      base([{ name: 'fulfilled', expression: "SUM(IF(orders.status = 'F', orders.amount, 0))" }]), OPTS);
    expect(ddl).toContain("IF(status = 'F', amount, 0) AS fulfilled_input");
    expect(ddl).toContain('MEASURE(SUM(fulfilled_input)) AS fulfilled');
    // Never a raw expression inside the MEASURE (the shape BigQuery rejects).
    expect(ddl).not.toContain('MEASURE(SUM(IF(');
  });

  test('an aggregate over a column that is not a field exposes it under its own name', () => {
    const { ddl } = generatePropertyGraph(
      base([{ name: 'total', expression: 'SUM(orders.amount)' }]), OPTS);
    // `amount` is not a declared field, so it is added as a bare property.
    expect(ddl).toContain('MEASURE(SUM(amount)) AS total');
    expect(ddl).toMatch(/\n\s*amount,/);  // exposed as a bare property line
  });

  test('an aggregate over an existing field reuses that field (no duplicate property)', () => {
    const { ddl } = generatePropertyGraph(
      base([{ name: 'n_status', expression: 'COUNT(orders.status)' }]), OPTS);
    expect(ddl).toContain('MEASURE(COUNT(status)) AS n_status');
    // `status` is declared once (the field) and not re-added as an operand property.
    const bareStatus = ddl.split('\n').filter(l => l.trim().replace(/,$/, '') === 'status').length;
    expect(bareStatus).toBe(1);
  });

  test('COUNT(*) is lowered to COUNT over the key property', () => {
    // COUNT(*) names no column, so it relies on the metric's declared home.
    const { ddl } = generatePropertyGraph(
      base([{ name: 'order_count', expression: 'COUNT(*)', entities: ['orders'] }]), OPTS);
    expect(ddl).toContain('MEASURE(COUNT(o_orderkey)) AS order_count');
  });

  test('two metrics sharing an operand expression expose it once', () => {
    const { ddl } = generatePropertyGraph(base([
      { name: 'sum_pos', expression: 'SUM(IF(orders.amount > 0, orders.amount, 0))' },
      { name: 'avg_pos', expression: 'AVG(IF(orders.amount > 0, orders.amount, 0))' },
    ]), OPTS);
    // The identical operand yields a single derived property, reused by both.
    expect(ddl.match(/AS sum_pos_input/g)?.length).toBe(1);
    expect(ddl).not.toContain('avg_pos_input');
    expect(ddl).toContain('MEASURE(SUM(sum_pos_input)) AS sum_pos');
    expect(ddl).toContain('MEASURE(AVG(sum_pos_input)) AS avg_pos');
  });

  test('a compound-of-aggregates (ratio) cannot be one MEASURE and is skipped + flagged', () => {
    const { ddl, warnings } = generatePropertyGraph(
      base([{ name: 'aov', expression: 'SUM(orders.amount) / COUNT(orders.o_orderkey)' }]), OPTS);
    expect(ddl).not.toContain('aov');
    expect(warnings.some(w => w.includes("metric 'aov'") && w.includes('single MEASURE'))).toBe(true);
  });
});


// The BigQuery restrictions recorded at
// go/x20 -> bei/bigquery-property-graph-limits.html (section A): a graph MEASURE
// may only aggregate a SINGLE EXPOSED PROPERTY of its node — never a raw column
// (A1), an inline expression (A2), or `*` (A3). Rather than enumerate inputs one
// by one, this guard parses the emitted DDL and asserts the invariant BigQuery
// itself enforces, so ANY future emitter change that reintroduces a rejected
// shape fails here — even for inputs no explicit test covers.
describe('emitter never produces a MEASURE shape BigQuery rejects (x20 record §A)', () => {
  // For each NODE block: the names it exposes as (non-measure) properties, and
  // the aggregate operand of each MEASURE it declares.
  function parseNodeMeasures(ddl: string): Record<string, { exposed: Set<string>; operands: string[] }> {
    const nodes: Record<string, { exposed: Set<string>; operands: string[] }> = {};
    let inNodeSection = false, inProps = false;
    let cur: string | null = null;
    for (const raw of ddl.split('\n')) {
      const t = raw.trim();
      if (t.startsWith('NODE TABLES')) { inNodeSection = true; continue; }
      if (t.startsWith('EDGE TABLES')) { inNodeSection = false; continue; }
      if (!inNodeSection) continue;
      const alias = t.match(/^`[^`]+`\s+AS\s+(\w+)$/);
      if (alias) { cur = alias[1]; nodes[cur] = { exposed: new Set(), operands: [] }; inProps = false; continue; }
      if (t.endsWith('PROPERTIES(')) { inProps = true; continue; }
      if (inProps && (t === ')' || t === '),')) { inProps = false; continue; }
      if (!inProps || !cur) continue;
      const meas = t.match(/^MEASURE\(\s*\w+\(\s*(?:DISTINCT\s+)?(.*?)\)\s*\)\s+AS\s+\w+,?$/);
      if (meas) { nodes[cur].operands.push(meas[1].trim()); continue; }
      // A non-measure property line: record the name it exposes (after AS, or the
      // bare identifier), ignoring any trailing comma or OPTIONS(...) suffix.
      const noOpts = t.replace(/,\s*$/, '').replace(/\s+OPTIONS\(.*\)$/, '');
      const asIdx = noOpts.lastIndexOf(' AS ');
      nodes[cur].exposed.add((asIdx >= 0 ? noOpts.slice(asIdx + 4) : noOpts).trim());
    }
    return nodes;
  }

  function assertLegalMeasures(ddl: string): void {
    expect(ddl).not.toContain('MEASURE(COUNT(*))');  // §A3 star must never survive
    for (const { exposed, operands } of Object.values(parseNodeMeasures(ddl))) {
      for (const op of operands) {
        // §A1/§A2: a bare identifier only — no parentheses, operators, or `*`.
        expect(op).toMatch(/^[A-Za-z_]\w*$/);
        // ...and it must be an exposed property of the very same node.
        expect(exposed.has(op)).toBe(true);
      }
    }
  }

  test('the live-verified chain graph satisfies the invariant', () => {
    assertLegalMeasures(generatePropertyGraph(SALES, OPTS).ddl);
  });

  test('every rejected input shape is lowered to a legal MEASURE', () => {
    // Metrics written deliberately in each shape BigQuery rejects: a raw column
    // (§A1), an inline expression (§A2), a shared inline expression, COUNT(*)
    // (§A3), and a DISTINCT count. The invariant must hold whatever the input.
    const model: SemanticModel = {
      name: 'kitchen_sink', relationships: [],
      entities: [{ name: 'orders', dataSource: { table: 'orders' }, keys: ['o_orderkey'],
        fields: [
          { name: 'o_orderkey', expression: 'orders.o_orderkey' },
          { name: 'status', expression: 'orders.status' },
        ] }],
      metrics: [
        { name: 'revenue',   expression: 'SUM(orders.amount)',                             entities: ['orders'] }, // §A1
        { name: 'fulfilled', expression: "SUM(IF(orders.status = 'F', orders.amount, 0))", entities: ['orders'] }, // §A2
        { name: 'avg_pos',   expression: "AVG(IF(orders.status = 'F', orders.amount, 0))", entities: ['orders'] }, // §A2 shared
        { name: 'n_orders',  expression: 'COUNT(*)',                                        entities: ['orders'] }, // §A3
        { name: 'n_status',  expression: 'COUNT(DISTINCT orders.status)',                   entities: ['orders'] }, // DISTINCT
      ],
    };
    const { ddl } = generatePropertyGraph(model, OPTS);
    assertLegalMeasures(ddl);
    // Spot-check the lowerings the invariant stands in for.
    expect(ddl).toContain('MEASURE(COUNT(o_orderkey)) AS n_orders');       // star -> key property
    expect(ddl).toContain('MEASURE(COUNT(DISTINCT status)) AS n_status');
    expect(ddl).not.toContain('MEASURE(SUM(IF(');                          // no inline expr in a MEASURE
  });
});


describe('emits DDL that BigQuery accepts (live-verified regression guard)', () => {
  // The exact strings below were run against BigQuery and produced correct
  // results. Any change to generator formatting must be re-verified before these
  // goldens are updated.

  test('direct-FK chain graph with node measures matches the verified DDL', () => {
    const { ddl } = generatePropertyGraph(SALES, OPTS);
    expect(ddl).toBe(VERIFIED_SALES_DDL);
  });

  test('M:N association graph with edge properties matches the verified DDL', () => {
    const { ddl } = generatePropertyGraph(SCHOOL, OPTS);
    expect(ddl).toBe(VERIFIED_SCHOOL_DDL);
  });
});


const VERIFIED_SALES_DDL =
`CREATE OR REPLACE PROPERTY GRAPH \`sqlgen-testing.bei_semantic_ir_verify.sales_graph\`
NODE TABLES (
  \`sqlgen-testing.bei_semantic_ir_verify.customers\` AS customers
    KEY(customer_id)
    PROPERTIES(
      customer_id,
      region OPTIONS(description="Sales region")
    ),
  \`sqlgen-testing.bei_semantic_ir_verify.orders\` AS orders
    KEY(order_id)
    PROPERTIES(
      order_id,
      customer_id,
      status,
      MEASURE(COUNT(order_id)) AS order_count
    ),
  \`sqlgen-testing.bei_semantic_ir_verify.order_items\` AS order_items
    KEY(order_item_id)
    PROPERTIES(
      order_item_id,
      order_id,
      amount,
      MEASURE(SUM(amount)) AS total_revenue,
      MEASURE(COUNT(order_item_id)) AS item_count
    )
)
EDGE TABLES (
  \`sqlgen-testing.bei_semantic_ir_verify.orders\` AS orders_customers
    KEY(order_id)
    SOURCE KEY(order_id) REFERENCES orders(order_id)
    DESTINATION KEY(customer_id) REFERENCES customers(customer_id),
  \`sqlgen-testing.bei_semantic_ir_verify.order_items\` AS orderitems_orders
    KEY(order_item_id)
    SOURCE KEY(order_item_id) REFERENCES order_items(order_item_id)
    DESTINATION KEY(order_id) REFERENCES orders(order_id)
);
`;

const VERIFIED_SCHOOL_DDL =
`CREATE OR REPLACE PROPERTY GRAPH \`sqlgen-testing.bei_semantic_ir_verify.school_graph\`
NODE TABLES (
  \`sqlgen-testing.bei_semantic_ir_verify.students\` AS students
    KEY(student_id)
    PROPERTIES(
      student_id,
      name
    ),
  \`sqlgen-testing.bei_semantic_ir_verify.courses\` AS courses
    KEY(course_id)
    PROPERTIES(
      course_id,
      title
    )
)
EDGE TABLES (
  \`sqlgen-testing.bei_semantic_ir_verify.enrollment\` AS enrollment
    KEY(enrollment_id)
    SOURCE KEY(student_id) REFERENCES students(student_id)
    DESTINATION KEY(course_id) REFERENCES courses(course_id)
    PROPERTIES(
      grade OPTIONS(description="Letter grade")
    )
);
`;
