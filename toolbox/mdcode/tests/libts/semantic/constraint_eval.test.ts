// Behavior specification for lowering a constraint to a SQL probe.
//
// A constraint is written against the ontology; the probe runs against a store.
// These tests fix what the lowering may change on the way -- logical names for
// bound columns, an action argument for a bound parameter, an aggregate for a
// correlated subquery, and the invariant for its negation -- and what it must
// leave alone, which is every other piece of SQL the author wrote.
//
// The model is built here rather than loaded from a fixture, so each test shows
// the binding it depends on.

import {describe, expect, test} from 'bun:test';

import {lowerConstraint, LowerOptions} from '../../../src/libts/semantic/constraint_eval';
import {Constraint, Entity, Relationship, SemanticModel} from '../../../src/libts/semantic/ir';


function entity(
    name: string, table: string, keys: string[],
    columns: Record<string, string|undefined>): Entity {
  return {
    name,
    dataSource: table,
    keys,
    fields: Object.entries(columns).map(([field, expression]) => ({
      name: field,
      ...(expression === undefined ? {} : {expression}),
    })),
  };
}


const ORDER = entity('Order', 'Orders', ['orderId'], {
  orderId: 'order_id',
  customerId: 'customer_id',
  total: 'total',
  totalTax: 'total_tax',
  status: 'status',
});

const LINE_ITEM = entity('LineItem', 'LineItem', ['lineItemId'], {
  lineItemId: 'line_item_id',
  orderId: 'order_id',
  amount: 'amount',
});

const HAS_LINE_ITEMS: Relationship = {
  name: 'OrderHasLineItems',
  source: {entity: 'LineItem', columns: ['order_id']},
  destination: {entity: 'Order', columns: ['order_id']},
};


function model(overrides: Partial<SemanticModel> = {}): SemanticModel {
  return {
    name: 'Commerce',
    entities: [ORDER, LINE_ITEM],
    relationships: [HAS_LINE_ITEMS],
    metrics: [],
    ...overrides,
  };
}


function constraint(expression: string): Constraint {
  return {name: 'Rule', expression};
}


// The predicate inside the probe, which is what the substitutions produce. The
// SELECT and the LIMIT around it are the same for every constraint.
function predicateOf(sql: string): string {
  const m = sql.match(/NOT COALESCE\((.*), FALSE\)/);
  if (!m) throw new Error(`no predicate in: ${sql}`);
  const inner = m[1];
  // The lowering parenthesizes what it wraps; the author's own parentheses stay.
  return inner.startsWith('(') && inner.endsWith(')') ? inner.slice(1, -1) :
                                                        inner;
}


function lower(
    expression: string, opts: LowerOptions = {},
    over: SemanticModel = model()) {
  return lowerConstraint(over, constraint(expression), opts);
}


function lowered(expression: string, opts: LowerOptions = {},
                 over: SemanticModel = model()) {
  const result = lower(expression, opts, over);
  if (!result.ok) throw new Error(result.reason);
  return result.probe;
}


function refusal(expression: string, opts: LowerOptions = {},
                 over: SemanticModel = model()): string {
  const result = lower(expression, opts, over);
  if (result.ok) throw new Error(`expected a refusal, got: ${result.probe.sql}`);
  return result.reason;
}


describe('what the probe asks', () => {
  test('it selects the rows that break the invariant, not the ones that keep it',
       () => {
         const probe = lowered('Order.total >= 0');
         expect(probe.sql).toBe(
             'SELECT order_id FROM Orders ' +
             'WHERE NOT COALESCE((total >= 0), FALSE) LIMIT 5');
       });

  test('a NULL counts as a violation rather than slipping through the negation',
       () => {
         // A plain NOT would leave `NULL >= 0` unknown, and an unknown row would
         // not come back, so the gate would pass a row it never checked.
         expect(lowered('Order.total >= 0').sql)
             .toContain('NOT COALESCE((total >= 0), FALSE)');
       });

  test('it names the entity and the table it resolved to', () => {
    const probe = lowered('Order.total >= 0');
    expect(probe.entity).toBe('Order');
    expect(probe.table).toBe('Orders');
    expect(probe.keyColumns).toEqual(['order_id']);
  });

  test('it caps the rows it returns, because a gate only has to explain itself',
       () => {
         expect(lowered('Order.total >= 0', {limit: 1}).sql)
             .toEndWith('LIMIT 1');
       });
});


describe('logical names become bound columns', () => {
  test('a field resolves to the column the binding profile gave it', () => {
    const renamed = model({
      entities: [
        entity('Order', 'orders_v2', ['orderId'],
               {orderId: 'id', total: 'order_total_usd'}),
        LINE_ITEM,
      ],
    });
    expect(lowered('Order.total >= 0', {}, renamed).sql)
        .toBe('SELECT id FROM orders_v2 ' +
              'WHERE NOT COALESCE((order_total_usd >= 0), FALSE) LIMIT 5');
  });

  test('one field name is not rewritten by another it starts with', () => {
    // `Order.total` must not match inside `Order.totalTax`.
    expect(predicateOf(lowered('Order.totalTax <= Order.total').sql))
        .toBe('total_tax <= total');
  });

  test('an expression-bound field is inlined in parentheses', () => {
    const computed = model({
      entities: [
        entity('Order', 'Orders', ['orderId'],
               {orderId: 'order_id', total: 'price * quantity'}),
        LINE_ITEM,
      ],
    });
    expect(predicateOf(lowered('Order.total >= 0', {}, computed).sql))
        .toBe('(price * quantity) >= 0');
  });

  test('a qualifier inside a string literal is data, not a reference', () => {
    expect(predicateOf(lowered("Order.status != 'Order.total'").sql))
        .toBe("status != 'Order.total'");
  });
});


describe('action arguments become bound parameters', () => {
  const OPTS = {parameters: ['amount'], parameterPrefix: 'p_'};

  test('an argument is bound, never pasted into the SQL', () => {
    const probe = lowered('amount <= Order.total', OPTS);
    expect(predicateOf(probe.sql)).toBe('@p_amount <= total');
    expect(probe.parameters).toEqual(['amount']);
    expect(probe.readsParameter).toBe(true);
  });

  test('a constraint reading no argument is an invariant, not a guard', () => {
    expect(lowered('Order.total >= 0', OPTS).readsParameter).toBe(false);
  });

  test('an argument may share a name with a column without colliding', () => {
    // `total` is both the action's argument and the Order column. The column is
    // substituted first and parked, so binding the argument cannot rewrite it.
    const probe = lowered(
        'total <= Order.total', {parameters: ['total'], parameterPrefix: 'p_'});
    expect(predicateOf(probe.sql)).toBe('@p_total <= total');
  });

  test('an argument the expression does not read is not bound', () => {
    expect(lowered('Order.total >= 0', {parameters: ['amount']}).parameters)
        .toEqual([]);
  });

  test('a constraint over arguments alone needs no table', () => {
    const probe = lowered('amount <= 25', OPTS);
    expect(probe.sql).toBe(
        'SELECT 1 AS violated FROM UNNEST([1]) ' +
        'WHERE NOT COALESCE((@p_amount <= 25), FALSE) LIMIT 1');
    expect(probe.entity).toBe('');
    expect(probe.keyColumns).toEqual([]);
  });
});


describe('an aggregate reaches across a declared relationship', () => {
  test('it becomes a subquery correlated on the relationship join columns',
       () => {
         expect(predicateOf(lowered('Order.total == SUM(LineItem.amount)').sql))
             .toBe('total = COALESCE((SELECT SUM(amount) FROM LineItem ' +
                   'WHERE LineItem.order_id = Orders.order_id), 0)');
       });

  test('SUM over no rows is zero, so an empty order is not a violation', () => {
    expect(predicateOf(lowered('Order.total == SUM(LineItem.amount)').sql))
        .toContain('COALESCE((SELECT SUM');
  });

  test('MIN has no identity over no rows, so it stays NULL and fails closed',
       () => {
         expect(predicateOf(lowered('Order.total >= MIN(LineItem.amount)').sql))
             .toBe('total >= (SELECT MIN(amount) FROM LineItem ' +
                   'WHERE LineItem.order_id = Orders.order_id)');
       });

  test('the aggregated entity is not the entity the probe walks', () => {
    expect(lowered('Order.total == SUM(LineItem.amount)').entity).toBe('Order');
  });

  test('a call that is not an aggregate is left for the store', () => {
    expect(predicateOf(lowered("LOWER(Order.status) = 'shipped'").sql))
        .toBe("LOWER(status) = 'shipped'");
  });
});


describe('SQL the author wrote is passed through', () => {
  // The store decides what SQL it accepts. Each of these was outside the
  // grammar the evaluator used to parse, and each now reaches the store intact.
  const CASES: Array<[string, string]> = [
    ['Order.total BETWEEN 0 AND 100', 'total BETWEEN 0 AND 100'],
    [`Order.status IN ('open', 'shipped')`, `status IN ('open', 'shipped')`],
    ['Order.total - Order.totalTax >= 0', 'total - total_tax >= 0'],
    [
      '(Order.total > 0 OR Order.totalTax > 0) AND Order.total >= 0',
      '(total > 0 OR total_tax > 0) AND total >= 0',
    ],
    [
      `CASE WHEN Order.status = 'open' THEN Order.total ELSE 0 END >= 0`,
      `CASE WHEN status = 'open' THEN total ELSE 0 END >= 0`,
    ],
    [`Order.status LIKE 'ship%'`, `status LIKE 'ship%'`],
  ];

  for (const [expression, expected] of CASES) {
    test(expression, () => {
      expect(predicateOf(lowered(expression).sql)).toBe(expected);
    });
  }
});


describe('spellings an author reaches for', () => {
  test('== is folded to the SQL =', () => {
    expect(predicateOf(lowered('Order.total == 0').sql)).toBe('total = 0');
  });

  test('= NULL is read as a null test, because SQL rejects it as a comparison',
       () => {
         expect(predicateOf(lowered('Order.status != NULL').sql))
             .toBe('status IS NOT NULL');
         expect(predicateOf(lowered('Order.status = NULL').sql))
             .toBe('status IS NULL');
       });

  test('>= is not mistaken for a null test', () => {
    expect(predicateOf(lowered('Order.total >= 0').sql)).toBe('total >= 0');
  });
});


describe('scoping to the rows an action touched', () => {
  test('a single-key entity is probed only over the touched keys', () => {
    const probe = lowered('Order.total >= 0', {touchedKeysParam: 'touched'});
    expect(probe.scoped).toBe(true);
    expect(probe.sql).toContain(
        'CAST(order_id AS STRING) IN UNNEST(@touched)');
    expect(probe.unscopedSql).not.toContain('UNNEST(@touched)');
  });

  test('a composite key is probed unscoped, since the comparison is not emitted',
       () => {
         const composite = model({
           entities: [
             entity('Order', 'Orders', ['tenantId', 'orderId'],
                    {tenantId: 'tenant_id', orderId: 'order_id', total: 'total'}),
             LINE_ITEM,
           ],
         });
         const probe = lowered(
             'Order.total >= 0', {touchedKeysParam: 'touched'}, composite);
         expect(probe.scoped).toBe(false);
         expect(probe.sql).toBe(probe.unscopedSql);
       });

  test('the unscoped form is always emitted, so a caller can fall back to it',
       () => {
         const probe = lowered('Order.total >= 0', {touchedKeysParam: 'touched'});
         expect(probe.unscopedSql).toBe(
             'SELECT order_id FROM Orders ' +
             'WHERE NOT COALESCE((total >= 0), FALSE) LIMIT 5');
       });
});


describe('what it refuses, because no store could phrase it', () => {
  test('an undeclared field', () => {
    expect(refusal('Order.discount >= 0'))
        .toContain(`entity 'Order' declares no field 'discount'`);
  });

  test('a field the binding profile left unbound', () => {
    const unbound = model({
      entities: [
        entity('Order', 'Orders', ['orderId'],
               {orderId: 'order_id', total: undefined}),
        LINE_ITEM,
      ],
    });
    expect(refusal('Order.total >= 0', {}, unbound)).toContain('is unbound');
  });

  test('two entities read side by side, since the probe walks one table', () => {
    expect(refusal('Order.total >= LineItem.amount'))
        .toContain('reads fields of more than one entity');
  });

  test('an aggregate over an entity with no relationship to the row', () => {
    const unrelated = model({relationships: []});
    expect(refusal('Order.total == SUM(LineItem.amount)', {}, unrelated))
        .toContain('no relationship connects');
  });

  test('an aggregate over an ambiguous pair of relationships', () => {
    const ambiguous = model({
      relationships: [
        HAS_LINE_ITEMS,
        {
          name: 'OrderHasCredits',
          source: {entity: 'LineItem', columns: ['order_id']},
          destination: {entity: 'Order', columns: ['order_id']},
        },
      ],
    });
    expect(refusal('Order.total == SUM(LineItem.amount)', {}, ambiguous))
        .toContain('is ambiguous about which one it means');
  });

  test('an aggregate with no row to correlate to', () => {
    expect(refusal('SUM(LineItem.amount) >= 0'))
        .toContain('needs a row to correlate to');
  });

  test('an entity with no key, since a violation could not be attributed', () => {
    const keyless = model({
      entities: [entity('Order', 'Orders', [], {total: 'total'}), LINE_ITEM],
    });
    expect(refusal('Order.total >= 0', {}, keyless)).toContain('declares no key');
  });

  test('an abstract entity, which has no table', () => {
    const abstract = model({
      entities: [{...ORDER, abstract: true}, LINE_ITEM],
    });
    expect(refusal('Order.total >= 0', {}, abstract)).toContain('is abstract');
  });

  test('an expression that ranges over nothing at all', () => {
    expect(refusal('1 >= 0')).toContain('nothing for it to range over');
  });

  test('an empty expression', () => {
    expect(refusal('   ')).toContain('the expression is empty');
  });

  test('every refusal names the constraint, so the runtime can report which',
       () => {
         expect(refusal('Order.discount >= 0')).toStartWith(`constraint 'Rule'`);
       });
});
