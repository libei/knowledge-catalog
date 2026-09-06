// Running an action against a store, gated by the model's constraints.
//
// The store is faked here rather than mocked at the HTTP layer: the fake
// records the statements it is given, answers queries from a programmable
// table, and tracks whether the transaction ended in a commit or a rollback.
// That is exactly the surface the runtime's guarantees are stated in -- "a
// violation rolls back", "an unevaluable constraint never opens a transaction"
// -- so the assertions can be about those guarantees rather than about wire
// format.
//

import {describe, expect, test} from 'bun:test';

import * as spanner from '../../../src/libts/gcp/spanner';
import {Action, SemanticModel} from '../../../src/libts/semantic/ir';
import {ActionPlan, runAction} from '../../../src/libts/semantic/runtime';


// A query the fake knows how to answer: rows returned when `match` is found in
// the statement's SQL.
interface Answer {
  match: string;
  rows: string[][];
}


class FakeSpanner {
  readonly database = 'projects/p/instances/i/databases/d';
  readonly statements: spanner.Statement[] = [];
  committed = false;
  rolledBack = false;
  sessionsOpen = 0;
  beginFails = false;
  commitFails = false;
  // Statements whose SQL contains one of these fragments fail, so a store-level
  // error can be provoked at a chosen point.
  failOn: string[] = [];

  constructor(private readonly answers: Answer[] = []) {}

  async withSession<T>(fn: (s: string) => Promise<T>): Promise<T> {
    this.sessionsOpen++;
    try {
      return await fn('sessions/1');
    } finally {
      this.sessionsOpen--;
    }
  }

  async beginReadWrite() {
    return this.beginFails ? {status: 400, message: 'nope'} :
                             {status: 200, result: {id: 'txn-1'}};
  }

  async executeSql(_s: string, _t: string, stmt: spanner.Statement) {
    this.statements.push(stmt);
    if (this.failOn.some(f => stmt.sql.includes(f))) {
      return {status: 400, message: 'statement rejected'};
    }
    const answer = this.answers.find(a => stmt.sql.includes(a.match));
    return {status: 200, result: {rows: answer?.rows ?? []}};
  }

  async commit() {
    if (this.commitFails) return {status: 500, message: 'commit failed'};
    this.committed = true;
    return {status: 200, result: {commitTimestamp: '2026-09-06T00:00:00Z'}};
  }

  async rollback() {
    this.rolledBack = true;
    return {status: 200, result: {}};
  }

  get client(): spanner.SpannerDataClient {
    return this as unknown as spanner.SpannerDataClient;
  }

  // The SQL of every statement run, for asserting what did and did not happen.
  get sql(): string[] {
    return this.statements.map(s => s.sql);
  }
}


const transfer: Action = {
  name: 'Transfer',
  description: 'Move funds between two accounts.',
  executor: {kind: 'mcp', mcp: {server: '//example/servers/payments', tool: 'transfer'}},
  parameters: [
    {name: 'source', type: 'Account', isEntityRef: true},
    {name: 'target', type: 'Account', isEntityRef: true},
    {name: 'amount', type: 'Float', isEntityRef: false},
  ],
};

function model(overrides: Partial<SemanticModel> = {}): SemanticModel {
  return {
    name: 'payments',
    entities: [
      {
        name: 'Account',
        dataSource: 'demo.payments.Account',
        keys: ['accountId'],
        fields: [
          {name: 'accountId', expression: 'account_id'},
          {name: 'balance', expression: 'balance'},
          {name: 'name', expression: 'name', type: 'String'},
        ],
      },
    ],
    relationships: [],
    metrics: [],
    actions: [transfer],
    constraints: [{
      name: 'NonNegativeBalance',
      expression: 'Account.balance >= 0',
      description: 'An account cannot go negative. Transfer less, or choose an account with more funds.',
    }],
    ...overrides,
  };
}


// A handler that debits and credits, and reports both accounts as touched.
const debitAndCredit = async (ctx: {refs: Record<string, {keys: string[]}>}):
    Promise<ActionPlan> => ({
  statements: [{sql: 'UPDATE Account SET balance = balance - 100 WHERE account_id = 1'}],
  touched: {
    Account: [ctx.refs.source.keys[0], ctx.refs.target.keys[0]],
  },
});

// Answers that resolve 'A1' to account 1 and 'A2' to account 2, and report the
// constraint as satisfied.
function resolvingFake(extra: Answer[] = []) {
  return new FakeSpanner([
    {match: 'FROM Account WHERE CAST(account_id AS STRING) = @ref', rows: [['1']]},
    ...extra,
  ]);
}

function run(fake: FakeSpanner, over: Partial<Parameters<typeof runAction>[0]> = {}) {
  return runAction({
    model: model(),
    actionName: 'Transfer',
    args: {source: 'A1', target: 'A2', amount: 100},
    client: fake.client,
    handler: debitAndCredit as never,
    ...over,
  });
}


describe('a write that satisfies every constraint', () => {
  test('commits', async () => {
    const fake = resolvingFake();
    const outcome = await run(fake);
    expect(outcome.status).toBe('committed');
    expect(fake.committed).toBe(true);
    expect(fake.rolledBack).toBe(false);
  });

  test('reports which constraints it checked', async () => {
    const outcome = await run(resolvingFake());
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    expect(outcome.checked).toEqual(['NonNegativeBalance']);
    expect(outcome.commitTimestamp).toBe('2026-09-06T00:00:00Z');
  });

  test('checks the constraint AFTER applying the write, in the same transaction',
       () => {
         // Read-your-writes is the whole mechanism: a probe run before the
         // update would see the pre-state and pass on a write that breaks the
         // invariant.
         const fake = resolvingFake();
         return run(fake).then(() => {
           const update = fake.sql.findIndex(s => s.startsWith('UPDATE'));
           const probe = fake.sql.findIndex(s => s.includes('NOT COALESCE'));
           expect(update).toBeGreaterThanOrEqual(0);
           expect(probe).toBeGreaterThan(update);
         });
       });

  test('scopes the probe to the rows the action touched', async () => {
    const fake = resolvingFake();
    await run(fake);
    const probe = fake.statements.find(s => s.sql.includes('NOT COALESCE'));
    expect(probe?.sql).toContain('IN UNNEST(@touchedKeys)');
    expect(probe?.params?.touchedKeys).toEqual(['1', '1']);
  });

  test('closes the session even on the happy path', async () => {
    const fake = resolvingFake();
    await run(fake);
    expect(fake.sessionsOpen).toBe(0);
  });
});


describe('a write that would break a constraint', () => {
  const violating = () => resolvingFake(
    [{match: 'NOT COALESCE', rows: [['1']]}]);

  test('is rolled back, not committed', async () => {
    const fake = violating();
    const outcome = await run(fake);
    expect(outcome.status).toBe('rejected');
    expect(fake.rolledBack).toBe(true);
    expect(fake.committed).toBe(false);
  });

  test("returns the model author's description, so the caller can correct itself",
       async () => {
         const outcome = await run(violating());
         if (outcome.status !== 'rejected') throw new Error('expected a rejection');
         expect(outcome.message)
           .toContain('An account cannot go negative. Transfer less');
       });

  test('names the constraint and the offending row', async () => {
    const outcome = await run(violating());
    if (outcome.status !== 'rejected') throw new Error('expected a rejection');
    expect(outcome.violations).toHaveLength(1);
    expect(outcome.violations[0].constraint).toBe('NonNegativeBalance');
    expect(outcome.violations[0].entity).toBe('Account');
    expect(outcome.violations[0].violatingKeys).toEqual([['1']]);
  });
});


describe('a constraint the evaluator cannot lower', () => {
  const unlowerable = model({
    constraints: [{name: 'Aggregate', expression: 'SUM(Account.balance) > 0'}],
  });

  test('aborts the action rather than running it unchecked', async () => {
    const fake = resolvingFake();
    const outcome = await run(fake, {model: unlowerable});
    expect(outcome.status).toBe('error');
    expect(fake.committed).toBe(false);
  });

  test('does not even open a transaction', async () => {
    // Failing closed means failing early: nothing should reach the store.
    const fake = resolvingFake();
    await run(fake, {model: unlowerable});
    expect(fake.statements).toHaveLength(0);
  });

  test('explains that an unchecked write is why it refused', async () => {
    const outcome = await run(resolvingFake(), {model: unlowerable});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('cannot all be evaluated');
    expect(outcome.message).toContain("constraint 'Aggregate'");
  });
});


describe('resolving an entity-typed argument', () => {
  test('matches on the key', async () => {
    const fake = resolvingFake();
    const outcome = await run(fake);
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    expect(outcome.refs.source).toEqual(
      {entity: 'Account', keys: ['1'], input: 'A1'});
  });

  test('also matches on an identifying name column', async () => {
    // An agent saying "Alice" should reach the same row as one saying "7".
    const fake = resolvingFake();
    await run(fake);
    const lookup = fake.statements[0];
    expect(lookup.sql).toContain('CAST(account_id AS STRING) = @ref');
    expect(lookup.sql).toContain('CAST(name AS STRING) = @ref');
  });

  test('rejects a reference that matches nothing', async () => {
    const fake = new FakeSpanner([]);
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toBe("No Account matches 'A1'.");
    expect(fake.rolledBack).toBe(true);
  });

  test('rejects an ambiguous reference and lists the candidates', async () => {
    const fake = new FakeSpanner(
      [{match: 'FROM Account WHERE CAST', rows: [['1'], ['2']]}]);
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('matches more than one Account (1, 2)');
  });

  test('rejects a missing required reference', async () => {
    const outcome = await run(
      resolvingFake(), {args: {target: 'A2', amount: 100}});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain("requires 'source', a reference to a Account");
  });

  test('leaves scalar arguments alone', async () => {
    const outcome = await run(resolvingFake());
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    expect(Object.keys(outcome.refs)).toEqual(['source', 'target']);
  });
});


describe('when the handler reports no touched rows', () => {
  const wholeTable = async (): Promise<ActionPlan> =>
    ({statements: [{sql: 'UPDATE Account SET balance = 0 WHERE TRUE'}]});

  test('the constraint is checked over the whole table', async () => {
    // The alternative -- passing an empty key array to the scoped probe --
    // would match nothing and the constraint would pass vacuously.
    const fake = resolvingFake();
    await run(fake, {handler: wholeTable});
    const probe = fake.statements.find(s => s.sql.includes('NOT COALESCE'));
    expect(probe?.sql).not.toContain('UNNEST');
    expect(probe?.params).toBeUndefined();
  });

  test('and a violation is still caught', async () => {
    const fake = resolvingFake([{match: 'NOT COALESCE', rows: [['1']]}]);
    const outcome = await run(fake, {handler: wholeTable});
    expect(outcome.status).toBe('rejected');
    expect(fake.rolledBack).toBe(true);
  });
});


describe('failures that are not constraint violations', () => {
  test('an unknown action is refused before any store call', async () => {
    const fake = resolvingFake();
    const outcome = await run(fake, {actionName: 'Refund'});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain("declares no action 'Refund'");
    expect(fake.statements).toHaveLength(0);
  });

  test('a transaction that will not begin is reported, not retried', async () => {
    const fake = resolvingFake();
    fake.beginFails = true;
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('Could not begin a transaction');
  });

  test('a rejected statement rolls the transaction back', async () => {
    const fake = resolvingFake();
    fake.failOn = ['UPDATE Account'];
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('statement rejected');
    expect(fake.rolledBack).toBe(true);
    expect(fake.committed).toBe(false);
  });

  test('a handler that throws rolls the transaction back', async () => {
    const fake = resolvingFake();
    const outcome = await run(fake, {
      handler: async () => {
        throw new Error('handler blew up');
      },
    });
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('handler blew up');
    expect(fake.rolledBack).toBe(true);
  });

  test('a commit that fails is reported as such, not as a violation', async () => {
    const fake = resolvingFake();
    fake.commitFails = true;
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('passed every constraint but the commit');
  });

  test('the session is closed even when the action fails', async () => {
    const fake = resolvingFake();
    fake.failOn = ['UPDATE Account'];
    await run(fake);
    expect(fake.sessionsOpen).toBe(0);
  });
});
