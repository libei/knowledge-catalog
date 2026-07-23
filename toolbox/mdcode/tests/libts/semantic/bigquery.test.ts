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
import { SemanticModel } from '../../../src/libts/semantic/ir';

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


describe('entities become node tables', () => {
  const { ddl } = generatePropertyGraph(SALES, OPTS);

  test('each entity is a node table keyed by its grain (the KEY measures lock to)', () => {
    expect(ddl).toContain('`sqlgen-testing.bei_semantic_ir_verify.customers` AS customers');
    expect(ddl).toContain('KEY(customer_id)');
    expect(ddl).toContain('`sqlgen-testing.bei_semantic_ir_verify.order_items` AS order_items');
    expect(ddl).toContain('KEY(order_item_id)');
  });

  test('a plain-column field emits a bare property (no redundant "col AS col")', () => {
    // order_items.amount -> just `amount`, since the expression is only the column.
    expect(ddl).toContain('\n      amount');
    expect(ddl).not.toContain('amount AS amount');
  });

  test('a field description is preserved as OPTIONS(description=...)', () => {
    expect(ddl).toContain('region OPTIONS(description="Sales region")');
  });
});


describe('model-level metrics become inline measures', () => {
  const { ddl, warnings } = generatePropertyGraph(SALES, OPTS);

  test('a single-entity metric becomes a table-local MEASURE (entity qualifier stripped)', () => {
    // SUM(order_items.amount) -> MEASURE(SUM(amount)); the measure body must
    // reference columns local to the table it is attached to.
    expect(ddl).toContain('MEASURE(SUM(amount)) AS total_revenue');
    expect(ddl).toContain('MEASURE(COUNT(order_item_id)) AS item_count');
  });

  test('a measure is attached to its owning entity, keeping it locked to that KEY', () => {
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


describe('relationships become edge tables', () => {
  test('every edge table declares an explicit element KEY (base-table PKs are not assumed)', () => {
    // BigQuery rejects an edge table without a key unless the base table declares
    // a PRIMARY KEY; semantic models over arbitrary tables cannot rely on that,
    // so the generator always emits KEY(...). This was caught by live testing.
    const { ddl } = generatePropertyGraph(SALES, OPTS);
    expect(ddl).toContain('AS orders_customers\n    KEY(order_id)');
    expect(ddl).toContain('AS orderitems_orders\n    KEY(order_item_id)');
  });

  test('a direct-FK edge is backed by the source entity table; REFERENCES target each endpoint KEY', () => {
    const { ddl } = generatePropertyGraph(SALES, OPTS);
    expect(ddl).toContain('`sqlgen-testing.bei_semantic_ir_verify.orders` AS orders_customers');
    expect(ddl).toContain('SOURCE KEY(order_id) REFERENCES orders(order_id)');
    expect(ddl).toContain('DESTINATION KEY(customer_id) REFERENCES customers(customer_id)');
  });

  test('an association edge is backed by its own table, keyed by rel.keys, and carries edge properties', () => {
    const { ddl } = generatePropertyGraph(SCHOOL, OPTS);
    expect(ddl).toContain('`sqlgen-testing.bei_semantic_ir_verify.enrollment` AS enrollment');
    expect(ddl).toContain('AS enrollment\n    KEY(enrollment_id)');
    expect(ddl).toContain('SOURCE KEY(student_id) REFERENCES students(student_id)');
    expect(ddl).toContain('DESTINATION KEY(course_id) REFERENCES courses(course_id)');
    expect(ddl).toContain('grade OPTIONS(description="Letter grade")');
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
    // literal text must survive qualifier stripping unchanged.
    const model: SemanticModel = {
      ...SALES,
      metrics: [{ name: 'flagged',
        expression: "SUM(IF(order_items.amount > 0, order_items.amount, 0)) /* 'orders.note' */",
        entities: ['order_items'] }],
    };
    const { ddl, warnings } = generatePropertyGraph(model, OPTS);
    expect(ddl).toContain("MEASURE(SUM(IF(amount > 0, amount, 0)) /* 'orders.note' */) AS flagged");
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
