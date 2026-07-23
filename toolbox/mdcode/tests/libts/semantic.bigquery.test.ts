// Tests for the BigQuery property-graph generator (src/libts/semantic/bigquery.ts).
//

import { describe, test, expect } from 'bun:test';
import { generatePropertyGraph } from '../../src/libts/semantic/bigquery';
import { SemanticModel } from '../../src/libts/semantic/ir';

// A small sales model: customers -(place)- orders, plus an order_items fact
// table joined to orders. Metrics exercise single-entity placement and the
// cross-table skip path.
const MODEL: SemanticModel = {
  name: 'sales',
  entities: [
    {
      name: 'customers',
      dataSource: { project: 'proj', dataset: 'sales', table: 'customers' },
      keys: ['customer_id'],
      fields: [
        { name: 'customer_id', expression: 'customers.customer_id' },
        { name: 'region', expression: 'customers.region', description: 'Sales region' },
      ],
    },
    {
      name: 'orders',
      dataSource: { project: 'proj', dataset: 'sales', table: 'orders' },
      keys: ['order_id'],
      fields: [
        { name: 'order_id', expression: 'orders.order_id' },
        { name: 'status', expression: 'orders.status' },
      ],
    },
    {
      name: 'order_items',
      dataSource: { project: 'proj', dataset: 'sales', table: 'order_items' },
      keys: ['order_item_id'],
      fields: [
        { name: 'order_item_id', expression: 'order_items.order_item_id' },
        { name: 'amount', expression: 'order_items.amount' },
      ],
    },
  ],
  relationships: [
    {
      name: 'customer_orders',
      source: {
        entity: 'orders',
        joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] },
      },
      destination: {
        entity: 'customers',
        joinKeys: { relationshipColumns: ['customer_id'], entityColumns: ['customer_id'] },
      },
    },
  ],
  metrics: [
    { name: 'total_revenue', expression: 'SUM(order_items.amount)', entities: ['order_items'] },
    { name: 'order_count', expression: 'COUNT(orders.order_id)', entities: ['orders'] },
    // Genuinely cross-table: references two entities' columns in one aggregate.
    { name: 'weird', expression: 'SUM(order_items.amount * customers.customer_id)',
      entities: ['order_items', 'customers'] },
  ],
};

describe('generatePropertyGraph', () => {
  const { ddl, warnings } = generatePropertyGraph(MODEL);

  test('emits a single CREATE OR REPLACE PROPERTY GRAPH', () => {
    expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH `proj.sales.sales`');
    expect(ddl).toContain('NODE TABLES (');
    expect(ddl).toContain('EDGE TABLES (');
    expect(ddl.trim().endsWith(';')).toBe(true);
  });

  test('renders node tables with keys and properties', () => {
    expect(ddl).toContain('`proj.sales.customers` AS customers');
    expect(ddl).toContain('KEY(customer_id)');
    // Bare column when expression is just the column.
    expect(ddl).toContain('customer_id');
    // Description carried into OPTIONS.
    expect(ddl).toContain('region OPTIONS(description="Sales region")');
  });

  test('renders the edge table referencing node labels', () => {
    expect(ddl).toContain('`proj.sales.orders` AS customer_orders');
    expect(ddl).toContain('SOURCE KEY(customer_id) REFERENCES orders(customer_id)');
    expect(ddl).toContain('DESTINATION KEY(customer_id) REFERENCES customers(customer_id)');
  });

  test('places single-entity metrics as inline MEASUREs (qualifier stripped)', () => {
    expect(ddl).toContain('MEASURE(SUM(amount)) AS total_revenue');
    expect(ddl).toContain('MEASURE(COUNT(order_id)) AS order_count');
  });

  test('skips a genuinely cross-table metric and warns', () => {
    expect(ddl).not.toContain('weird');
    expect(warnings.some(w => w.includes("metric 'weird'") && w.includes('multiple tables')))
      .toBe(true);
  });

  test('no warnings for the placeable metrics', () => {
    expect(warnings.some(w => w.includes("'total_revenue'"))).toBe(false);
    expect(warnings.some(w => w.includes("'order_count'"))).toBe(false);
  });
});

describe('generatePropertyGraph options and edge cases', () => {
  test('falls back to opts for project/dataset and graph name', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'e',
        dataSource: { table: 't' },
        keys: ['id'],
        fields: [{ name: 'id', expression: 'e.id' }],
      }],
      relationships: [],
      metrics: [],
    };
    const { ddl } = generatePropertyGraph(model, { project: 'p', dataset: 'd', graphName: 'g' });
    expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH `p.d.g`');
    expect(ddl).toContain('`p.d.t` AS e');
    // No relationships => no EDGE TABLES block.
    expect(ddl).not.toContain('EDGE TABLES');
  });

  test('warns when a table has no resolvable project/dataset', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [{ name: 'e', dataSource: { table: 't' }, keys: ['id'], fields: [] }],
      relationships: [],
      metrics: [],
    };
    const { warnings } = generatePropertyGraph(model);
    expect(warnings.some(w => w.includes('missing a project and/or dataset'))).toBe(true);
  });
});
