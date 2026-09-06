// Lowering constraints to SQL probes: what the evaluator accepts, what it
// refuses, and the exact SQL it emits.
//
// The refusals get as much attention as the successes here. The gate fails
// closed -- an un-lowerable constraint aborts the action -- so a change that
// quietly widened or narrowed what lowers would change which writes are allowed
// through, and that should never happen unnoticed.
//

import {describe, expect, test} from 'bun:test';

import {
  lowerConstraint,
  lowerConstraints,
  violationMessage,
} from '../../../src/libts/semantic/constraint_eval';
import {Constraint, Entity, SemanticModel} from '../../../src/libts/semantic/ir';


function field(name: string, expression?: string, extra: object = {}) {
  return {name, expression: expression ?? name, ...extra};
}

const account: Entity = {
  name: 'Account',
  dataSource: 'demo.payments.Account',
  keys: ['accountId'],
  fields: [
    field('accountId', 'account_id'),
    field('balance'),
    field('overdraftLimit', 'overdraft_limit'),
    field('status', undefined, {type: 'String'}),
    field('brand', undefined, {type: 'String'}),
    field('projected', undefined, {expression: undefined}),
    field('headroom', 'balance - overdraft_limit'),
  ],
};

const ledgerEntry: Entity = {
  name: 'LedgerEntry',
  dataSource: 'demo.payments.LedgerEntry',
  keys: ['accountId', 'seq'],
  fields: [field('accountId', 'account_id'), field('seq'), field('amount')],
};

const party: Entity = {
  name: 'Party',
  dataSource: 'demo.payments.Party',
  keys: ['partyId'],
  abstract: true,
  fields: [field('partyId', 'party_id'), field('score')],
};

const keyless: Entity = {
  name: 'Event',
  dataSource: 'demo.payments.Event',
  keys: [],
  fields: [field('amount')],
};

function modelWith(...constraints: Constraint[]): SemanticModel {
  return {
    name: 'payments',
    entities: [account, ledgerEntry, party, keyless],
    relationships: [],
    metrics: [],
    constraints,
  };
}

function lower(expression: string, opts = {touchedKeysParam: 'touchedKeys'}) {
  const constraint: Constraint = {name: 'C', expression};
  return lowerConstraint(modelWith(constraint), constraint, opts);
}

// The reason text of a lowering that was expected to fail.
function reason(expression: string): string {
  const result = lower(expression);
  if (result.ok) throw new Error(`expected '${expression}' to be refused`);
  return result.reason;
}


describe('lowering an expression the evaluator understands', () => {
  test('a field-to-literal comparison becomes a scoped violation probe', () => {
    const result = lower('Account.balance >= 0');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.sql).toBe(
      'SELECT account_id FROM Account WHERE NOT COALESCE((balance >= 0), FALSE)' +
      ' AND CAST(account_id AS STRING) IN UNNEST(@touchedKeys) LIMIT 5');
    expect(result.probe.scoped).toBe(true);
    expect(result.probe.entity).toBe('Account');
    expect(result.probe.table).toBe('Account');
    expect(result.probe.keyColumns).toEqual(['account_id']);
  });

  test('the probe selects rows that VIOLATE the constraint, not ones that hold',
       () => {
         const result = lower('Account.balance >= 0');
         if (!result.ok) throw new Error(result.reason);
         // NOT wraps the invariant: an empty result set is the passing case.
         expect(result.probe.sql).toContain('NOT COALESCE((balance >= 0)');
       });

  test('a NULL column counts as a violation, not as a pass', () => {
    // Plain SQL negation would let a NULL through: `NULL >= 0` is unknown and
    // `NOT unknown` is unknown, so the row would not be returned. COALESCE to
    // FALSE makes the unknown case a violation -- the fail-closed reading.
    const result = lower('Account.balance >= 0');
    if (!result.ok) throw new Error(result.reason);
    expect(result.probe.sql).toContain('COALESCE(');
    expect(result.probe.sql).toContain(', FALSE)');
  });

  test('both a scoped and a whole-table form are emitted', () => {
    const result = lower('Account.balance >= 0');
    if (!result.ok) throw new Error(result.reason);
    expect(result.probe.unscopedSql).toBe(
      'SELECT account_id FROM Account WHERE NOT COALESCE((balance >= 0), FALSE)' +
      ' LIMIT 5');
    expect(result.probe.unscopedSql).not.toContain('UNNEST');
  });

  test('without a touched-keys parameter the probe covers the whole table',
       () => {
         const result = lower('Account.balance >= 0', {} as never);
         if (!result.ok) throw new Error(result.reason);
         expect(result.probe.scoped).toBe(false);
         expect(result.probe.sql).toBe(result.probe.unscopedSql);
       });

  test('a composite-key entity is probed unscoped', () => {
    // Scoping a composite key needs a struct-array comparison the evaluator
    // does not emit, so it falls back to the whole table -- slower, still
    // correct. Silently scoping on one of the two key columns would be wrong.
    const constraint: Constraint = {name: 'C', expression: 'LedgerEntry.amount != 0'};
    const result = lowerConstraint(
      modelWith(constraint), constraint, {touchedKeysParam: 'touchedKeys'});
    if (!result.ok) throw new Error(result.reason);
    expect(result.probe.scoped).toBe(false);
    expect(result.probe.keyColumns).toEqual(['account_id', 'seq']);
    expect(result.probe.sql).toContain('SELECT account_id, seq FROM LedgerEntry');
  });

  test('comparisons join with AND and OR, each parenthesized', () => {
    const result = lower(
      "Account.balance >= 0 AND Account.status != 'CLOSED' OR Account.balance > 100");
    if (!result.ok) throw new Error(result.reason);
    expect(result.probe.sql).toContain(
      "(balance >= 0) AND (status != 'CLOSED') OR (balance > 100)");
  });

  test('a lowercase and/or joins the same way', () => {
    const result = lower('Account.balance >= 0 and Account.balance < 1000000');
    if (!result.ok) throw new Error(result.reason);
    expect(result.probe.sql).toContain('(balance >= 0) AND (balance < 1000000)');
  });

  test('a field whose name contains "and" is not split on it', () => {
    const result = lower('Account.brand != Account.status');
    if (!result.ok) throw new Error(result.reason);
    expect(result.probe.sql).toContain('(brand != status)');
  });

  test('two fields of the same entity can be compared', () => {
    const result = lower('Account.balance >= Account.overdraftLimit');
    if (!result.ok) throw new Error(result.reason);
    expect(result.probe.sql).toContain('(balance >= overdraft_limit)');
  });

  test('logical field names lower to their physical columns', () => {
    const result = lower('Account.overdraftLimit <= 0');
    if (!result.ok) throw new Error(result.reason);
    expect(result.probe.sql).toContain('overdraft_limit <= 0');
    expect(result.probe.sql).not.toContain('overdraftLimit');
  });

  test('a two-character operator is not read as a one-character one', () => {
    const ge = lower('Account.balance >= 0');
    const le = lower('Account.balance <= 0');
    const ne = lower('Account.balance != 0');
    if (!ge.ok || !le.ok || !ne.ok) throw new Error('expected all three to lower');
    expect(ge.probe.sql).toContain('(balance >= 0)');
    expect(le.probe.sql).toContain('(balance <= 0)');
    expect(ne.probe.sql).toContain('(balance != 0)');
  });

  test('<> is emitted as != so the probe uses one spelling', () => {
    const result = lower('Account.balance <> 0');
    if (!result.ok) throw new Error(result.reason);
    expect(result.probe.sql).toContain('(balance != 0)');
  });

  test('a negative and a decimal literal are both accepted', () => {
    const result = lower('Account.balance >= -0.5');
    if (!result.ok) throw new Error(result.reason);
    expect(result.probe.sql).toContain('(balance >= -0.5)');
  });

  test('TRUE, FALSE and NULL are literals', () => {
    for (const literal of ['TRUE', 'FALSE', 'NULL']) {
      const result = lower(`Account.balance != ${literal}`);
      expect(result.ok).toBe(true);
    }
  });

  test('the violation-row cap is configurable', () => {
    const constraint: Constraint = {name: 'C', expression: 'Account.balance >= 0'};
    const result =
      lowerConstraint(modelWith(constraint), constraint, {limit: 1});
    if (!result.ok) throw new Error(result.reason);
    expect(result.probe.sql.endsWith('LIMIT 1')).toBe(true);
  });
});


describe('refusing an expression the evaluator cannot check', () => {
  test('an empty expression', () => {
    expect(reason('   ')).toContain('the expression is empty');
  });

  test('a parenthesized or function-call expression', () => {
    expect(reason('ABS(Account.balance) > 0')).toContain('parentheses');
  });

  test('an expression with no comparison operator', () => {
    expect(reason('Account.balance')).toContain('is not a comparison');
  });

  test('a left side that is not an <Entity>.<field> reference', () => {
    expect(reason('0 <= Account.balance'))
      .toContain('is not an <Entity>.<field> reference');
  });

  test('a right side that is neither a literal nor a field', () => {
    expect(reason('Account.balance >= someLimit'))
      .toContain('neither a literal nor an');
  });

  test('a string literal containing a quote or backslash', () => {
    // Rejected rather than escaped: a surprising escape in generated SQL is
    // harder to spot than a refusal.
    expect(reason("Account.status != 'it\\'s'")).toContain('neither a literal');
  });

  test('an expression spanning two entities', () => {
    expect(reason('Account.balance >= 0 AND LedgerEntry.amount > 0'))
      .toContain('spans more than one entity');
  });

  test('a comparison between two entities', () => {
    expect(reason('Account.balance >= LedgerEntry.amount'))
      .toContain('compares fields of two entities');
  });

  test('an entity the model does not declare', () => {
    expect(reason('Ghost.balance >= 0')).toContain("'Ghost' is not declared");
  });

  test('a field the entity does not declare', () => {
    expect(reason('Account.nope >= 0')).toContain("declares no field 'nope'");
  });

  test('a field that is unbound under the current binding', () => {
    expect(reason('Account.projected >= 0')).toContain('is unbound');
  });

  test('a field bound to an expression rather than a bare column', () => {
    expect(reason('Account.headroom >= 0')).toContain('rather than a bare column');
  });

  test('an abstract entity, which has no table', () => {
    expect(reason('Party.score > 0')).toContain('is abstract');
  });

  test('an entity with no key, so a violation could not be attributed', () => {
    expect(reason('Event.amount > 0')).toContain('declares no key');
  });

  test('the refusal always names the constraint', () => {
    expect(reason('Account.nope >= 0')).toStartWith("constraint 'C' cannot be evaluated");
  });
});


describe('lowering every constraint on a model', () => {
  test('probes and refusals come back separately', () => {
    const model = modelWith(
      {name: 'NonNegativeBalance', expression: 'Account.balance >= 0'},
      {name: 'Unlowerable', expression: 'SUM(Account.balance) > 0'},
    );
    const {probes, errors} = lowerConstraints(model, {touchedKeysParam: 'k'});
    expect(probes.map(p => p.constraint.name)).toEqual(['NonNegativeBalance']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("constraint 'Unlowerable'");
  });

  test('a model with no constraints yields neither probes nor errors', () => {
    const model: SemanticModel =
      {name: 'payments', entities: [account], relationships: [], metrics: []};
    expect(lowerConstraints(model)).toEqual({probes: [], errors: []});
  });
});


describe('the message a violation returns', () => {
  const probe = (() => {
    const result = lowerConstraint(
      modelWith({
        name: 'NonNegativeBalance',
        expression: 'Account.balance >= 0',
        description: 'An account cannot go negative. Transfer less, or pick an account with more funds.',
      }),
      {
        name: 'NonNegativeBalance',
        expression: 'Account.balance >= 0',
        description: 'An account cannot go negative. Transfer less, or pick an account with more funds.',
      },
      {touchedKeysParam: 'k'});
    if (!result.ok) throw new Error(result.reason);
    return result.probe;
  })();

  test("the author's description leads, because it is the actionable part",
       () => {
         const message = violationMessage(probe, [['7']]);
         expect(message).toStartWith('An account cannot go negative.');
       });

  test('the constraint and its expression are cited', () => {
    const message = violationMessage(probe, [['7']]);
    expect(message).toContain("constraint 'NonNegativeBalance'");
    expect(message).toContain('Account.balance >= 0');
  });

  test('the offending rows are named', () => {
    expect(violationMessage(probe, [['7'], ['9']]))
      .toContain('Violating Account: 7, 9.');
  });

  test('a constraint with no description still says which one failed', () => {
    const bare = {...probe, constraint: {...probe.constraint, description: undefined}};
    expect(violationMessage(bare, []))
      .toStartWith("Constraint 'NonNegativeBalance' does not hold.");
  });
});
