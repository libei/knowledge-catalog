// Running an action against a store.
//
// The store is faked here rather than mocked at the HTTP layer: the fake
// records the statements it is given, answers queries from a programmable
// table, and tracks whether the transaction ended in a commit or a rollback.
// That is exactly the surface the runtime's guarantees are stated in -- "a
// failed statement rolls back", "a refused action never opens a transaction"
// -- so the assertions can be about those guarantees rather than about wire
// format.
//

import {describe, expect, test} from 'bun:test';

import * as spanner from '../../../src/libts/gcp/spanner';
import {Action, Constraint, SemanticModel} from '../../../src/libts/semantic/ir';
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
  sessionsOpened = 0;
  beginFails = false;
  commitFails = false;
  // A commit that REJECTS rather than returning a status, and a session that
  // cannot be created: the two failures that reach the runtime as a thrown
  // error rather than as a response, which is what makes them interesting.
  commitThrows = false;
  sessionFails = false;
  // Statements whose SQL contains one of these fragments fail, so a store-level
  // error can be provoked at a chosen point.
  failOn: string[] = [];

  constructor(private readonly answers: Answer[] = []) {}

  async withSession<T>(fn: (s: string) => Promise<T>): Promise<T> {
    if (this.sessionFails) {
      throw new Error('Spanner: could not create a session on d (503).');
    }
    this.sessionsOpen++;
    this.sessionsOpened++;
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
    // What a socket hang-up, a DNS failure or an abort looks like from here.
    if (this.commitThrows) throw new TypeError('fetch failed');
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
  executor: {
    kind: 'mcp',
    mcp: {server: '//example/servers/payments', tool: 'transfer'},
  },
  parameters: [
    {name: 'source', type: 'Account', isEntityRef: true},
    {name: 'target', type: 'Account', isEntityRef: true},
    {name: 'amount', type: 'Float', isEntityRef: false},
  ],
};

// The base model states no constraint, so every action in it is safe to run
// unchecked and the tests below are about the write itself. The refusal rules
// get their own model further down.
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
    ...overrides,
  };
}


const debitAndCredit = async (): Promise<ActionPlan> => ({
  statements: [{
    sql: 'UPDATE Account SET balance = balance - 100 WHERE account_id = 1',
  }],
});

// Answers that resolve 'A1' and 'A2' to account 1.
function resolvingFake(extra: Answer[] = []) {
  return new FakeSpanner([
    {
      match: 'FROM Account WHERE account_id = @ref0',
      rows: [['1']],
    },
    ...extra,
  ]);
}

function run(
    fake: FakeSpanner, over: Partial<Parameters<typeof runAction>[0]> = {}) {
  return runAction({
    model: model(),
    actionName: 'Transfer',
    args: {source: 'A1', target: 'A2', amount: 100},
    client: fake.client,
    handler: debitAndCredit,
    ...over,
  });
}


describe('resolving an entity-typed argument', () => {
  test('matches on the key', async () => {
    const fake = resolvingFake();
    const outcome = await run(fake);
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    expect(outcome.refs.source).toEqual({
      entity: 'Account',
      keys: ['1'],
      input: 'A1',
    });
  });

  test('also matches on an identifying name column', async () => {
    // An agent saying "Alice" should reach the same row as one saying "7".
    const fake = resolvingFake();
    await run(fake);
    const lookup = fake.statements[0];
    expect(lookup.sql).toContain('account_id = @ref0');
    expect(lookup.sql).toContain('name = @ref');
  });

  test('compares each column as itself, so an index can answer the lookup',
       async () => {
         // This SELECT runs inside the action's read-write transaction. Casting
         // the columns to STRING would make one predicate shape fit every key
         // type, at the price of a scan holding read locks over the whole table
         // for the length of the write.
         const fake = resolvingFake();
         await run(fake);
         expect(fake.statements[0].sql).not.toContain('CAST');
       });

  test('drops a key predicate the input cannot possibly match', async () => {
    // 'A1' is not an Integer, so no INT64 key equals it. Comparing anyway
    // would mean casting the column, which is the scan this avoids.
    const fake = new FakeSpanner([{match: 'FROM Account', rows: [['1']]}]);
    await run(fake, {
      model: model({
        entities: [{
          name: 'Account',
          dataSource: 'demo.payments.Account',
          keys: ['accountId'],
          fields: [
            {name: 'accountId', expression: 'account_id', type: 'Integer'},
            {name: 'name', expression: 'name', type: 'String'},
          ],
        }],
      }),
    });
    // The key column is still SELECTed -- it is what a match returns -- but
    // nothing compares it.
    expect(fake.statements[0].sql).toContain('WHERE name = @ref LIMIT');
    expect(fake.statements[0].sql).not.toContain('account_id =');
  });

  test('does not query at all when nothing could match the input', async () => {
    // An Integer key, no identifying text field, and a reference that is not a
    // number: there is no row this could denote, and no predicate left to ask.
    const fake = new FakeSpanner([]);
    const outcome = await run(fake, {
      model: model({
        entities: [{
          name: 'Account',
          dataSource: 'demo.payments.Account',
          keys: ['accountId'],
          fields: [
            {name: 'accountId', expression: 'account_id', type: 'Integer'},
          ],
        }],
      }),
    });
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toBe("No Account matches 'A1'.");
    expect(fake.statements).toHaveLength(0);
  });

  test('rejects a reference that matches nothing', async () => {
    const fake = new FakeSpanner([]);
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toBe("No Account matches 'A1'.");
    expect(fake.rolledBack).toBe(true);
  });

  test('rejects an ambiguous reference and lists the candidates', async () => {
    const fake =
        new FakeSpanner([{match: 'FROM Account WHERE', rows: [['1'], ['2']]}]);
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('matches more than one Account (1, 2)');
  });

  test('rejects a missing required reference', async () => {
    const outcome =
        await run(resolvingFake(), {args: {target: 'A2', amount: 100}});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message)
        .toContain("requires 'source', a reference to a Account");
  });

  test('leaves scalar arguments alone', async () => {
    const outcome = await run(resolvingFake());
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    expect(Object.keys(outcome.refs)).toEqual(['source', 'target']);
  });
});


describe('failures that stop the write', () => {
  test('an unknown action is refused before any store call', async () => {
    const fake = resolvingFake();
    const outcome = await run(fake, {actionName: 'Refund'});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain("declares no action 'Refund'");
    expect(fake.statements).toHaveLength(0);
  });

  test('a transaction that will not begin is reported, not retried',
       async () => {
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

  test('a commit that fails is reported as a commit failure', async () => {
    const fake = resolvingFake();
    fake.commitFails = true;
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('committing it failed');
    expect(fake.committed).toBe(false);
  });

  test('a commit that fails is reported as an UNKNOWN outcome, not a rollback',
       async () => {
         // The one failure this runtime cannot call: Spanner returns a deadline
         // or a 5xx on commit for a commit that landed as readily as for one
         // that did not, and nothing can undo it from here. Saying "rolled
         // back" would be a guess, and a caller acting on it would apply the
         // write twice.
         const fake = resolvingFake();
         fake.commitFails = true;
         const outcome = await run(fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.indeterminate).toBe(true);
         expect(outcome.message).toContain('Whether the write landed is unknown');
         expect(fake.rolledBack).toBe(false);
       });

  test('a rollback that fails does not replace the reason the action stopped',
       async () => {
         // The reason is what the caller acts on. An abandoned transaction is
         // aborted by the server on its own.
         const fake = new FakeSpanner([]);
         fake.rollback = async () => {
           throw new Error('rollback unreachable');
         };
         const outcome = await run(fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toBe("No Account matches 'A1'.");
       });

  test('a rollback that fails after a thrown statement keeps the store error',
       async () => {
         const fake = resolvingFake();
         fake.failOn = ['UPDATE Account'];
         fake.rollback = async () => {
           throw new Error('rollback unreachable');
         };
         const outcome = await run(fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain('statement rejected');
       });

  test('the session is closed even when the action fails', async () => {
    const fake = resolvingFake();
    fake.failOn = ['UPDATE Account'];
    await run(fake);
    expect(fake.sessionsOpen).toBe(0);
  });

  test('the session is closed on the happy path too', async () => {
    const fake = resolvingFake();
    await run(fake);
    expect(fake.sessionsOpen).toBe(0);
    expect(fake.sessionsOpened).toBe(1);
  });
});


describe('an executor the runtime cannot roll back', () => {
  test('is refused when the caller supplies no handler', async () => {
    // An MCP tool commits inside a system this transaction does not control,
    // so a rollback here would leave the two out of step.
    const fake = resolvingFake();
    const outcome = await run(fake, {handler: undefined});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('could not be rolled back');
    expect(fake.statements).toHaveLength(0);
  });
});


// A second model, for the half of the runtime the payments model cannot reach:
// an action whose write is declared in the model rather than performed by a
// handler.
const credit: Action = {
  name: 'Credit',
  description: 'Credit an account and record the entry.',
  executor: {
    kind: 'sql',
    sql: {
      statements: [
        'INSERT INTO Entry (entry_id, account_id, amount) ' +
            'VALUES (@newEntryKey, @account, @amount)',
        'UPDATE Account SET balance = balance - @amount ' +
            'WHERE account_id = @account',
      ],
    },
  },
  parameters: [
    {name: 'account', type: 'Account', isEntityRef: true},
    {name: 'amount', type: 'Float', isEntityRef: false},
  ],
  affects: [
    {concept: 'Entry', operation: 'create', fields: ['amount']},
    {concept: 'Account', operation: 'modify', fields: ['balance']},
  ],
};

function creditModel(overrides: Partial<SemanticModel> = {}): SemanticModel {
  const base = model();
  return {
    ...base,
    entities: [
      ...base.entities,
      {
        name: 'Entry',
        dataSource: 'demo.payments.Entry',
        keys: ['entryId'],
        fields: [
          {name: 'entryId', expression: 'entry_id'},
          {name: 'amount', expression: 'amount'},
        ],
      },
    ],
    actions: [credit],
    ...overrides,
  };
}

function runCredit(
    fake: FakeSpanner, over: Partial<Parameters<typeof runAction>[0]> = {}) {
  return runAction({
    model: creditModel(),
    actionName: 'Credit',
    args: {account: 'A1', amount: 100},
    client: fake.client,
    ...over,
  });
}


describe('an action whose write is declared in the model', () => {
  test('runs the executor statements in order, with no handler involved',
       async () => {
         const fake = resolvingFake();
         const outcome = await runCredit(fake);
         if (outcome.status !== 'committed') throw new Error(outcome.message);
         expect(fake.sql.filter(s => s.startsWith('INSERT'))).toHaveLength(1);
         expect(fake.sql.filter(s => s.startsWith('UPDATE'))).toHaveLength(1);
         expect(fake.sql.indexOf('INSERT INTO Entry (entry_id, account_id, ' +
                                 'amount) VALUES (@newEntryKey, @account, ' +
                                 '@amount)'))
             .toBeLessThan(fake.sql.findIndex(s => s.startsWith('UPDATE')));
       });

  test('binds every caller value as a parameter, interpolating nothing',
       async () => {
         const fake = resolvingFake();
         await runCredit(fake);
         const insert = fake.statements.find(s => s.sql.startsWith('INSERT'))!;
         expect(insert.sql).not.toContain('100');
         expect(insert.params?.amount).toBe(100);
         expect(insert.paramTypes?.amount).toEqual({code: 'FLOAT64'});
       });

  test('binds only the parameters a given statement mentions', async () => {
    // The UPDATE names both; a statement naming one would carry one.
    const fake = resolvingFake();
    await runCredit(fake);
    const update = fake.statements.find(s => s.sql.startsWith('UPDATE'))!;
    expect(Object.keys(update.params ?? {}).sort()).toEqual([
      'account',
      'amount',
    ]);
    expect(update.params?.newEntryKey).toBeUndefined();
  });

  test('generates the key of a created row rather than taking the caller\'s',
       async () => {
         // An agent that picks its own primary key can overwrite a row that
         // already has that key.
         const fake = resolvingFake();
         await runCredit(fake);
         const insert = fake.statements.find(s => s.sql.startsWith('INSERT'))!;
         expect(typeof insert.params?.newEntryKey).toBe('string');
         expect(insert.params?.newEntryKey as string).not.toBe('');
       });

  test('resolves an entity-typed argument to its key before binding it',
       async () => {
         const fake = resolvingFake();
         await runCredit(fake);
         const update = fake.statements.find(s => s.sql.startsWith('UPDATE'))!;
         expect(update.params?.account).toBe('1');
       });

  test('commits once every statement has run', async () => {
    const fake = resolvingFake();
    await runCredit(fake);
    expect(fake.committed).toBe(true);
    expect(fake.rolledBack).toBe(false);
  });
});


// Nothing evaluates a constraint yet. The runtime therefore has to tell an
// action a constraint might decide from one no constraint touches, and refuse
// the first rather than apply a write the model says must be checked.
describe('an action a constraint may decide is refused, not run unchecked', () => {
  const balance: Constraint = {
    name: 'NonNegativeBalance',
    expression: 'Account.balance >= 0',
    description: 'An account cannot go negative.',
  };

  const runWith = (over: Partial<SemanticModel>, fake = resolvingFake()) =>
      runAction({
        model: creditModel(over),
        actionName: 'Credit',
        args: {account: 'A1', amount: 100},
        client: fake.client,
      });

  test('an action that names a guard is refused', async () => {
    const outcome = await runWith({
      actions: [{...credit, guards: ['NonNegativeBalance']}],
      constraints: [balance],
    });
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain("guarded by 'NonNegativeBalance'");
    expect(outcome.message).toContain('does not evaluate constraints yet');
  });

  test('a refused action never opens a transaction', async () => {
    // The point of deciding before the store is touched: there is nothing to
    // roll back, and no session to leak.
    const fake = resolvingFake();
    await runWith(
        {
          actions: [{...credit, guards: ['NonNegativeBalance']}],
          constraints: [balance],
        },
        fake);
    expect(fake.statements).toHaveLength(0);
    expect(fake.sessionsOpened).toBe(0);
    expect(fake.rolledBack).toBe(false);
  });

  test('an action writing data a constraint reads is refused, and says which',
       async () => {
         // Credit affects Account; NonNegativeBalance reads Account.balance.
         // Nothing links them in the model -- an invariant holds for every
         // write -- so the overlap is the only signal there is.
         const outcome = await runWith({constraints: [balance]});
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message)
             .toContain("'NonNegativeBalance' could constrain");
       });

  test('an action writing data no constraint reads runs', async () => {
    // The same constraint, over an entity Credit does not touch. This is what
    // makes the runtime useful before the evaluator exists.
    const outcome = await runWith({
      constraints: [{
        name: 'NamedAccount',
        expression: 'Ledger.name IS NOT NULL',
        description: 'Every ledger is named.',
      }],
      entities: [
        ...creditModel().entities,
        {
          name: 'Ledger',
          dataSource: 'demo.payments.Ledger',
          keys: ['ledgerId'],
          fields: [
            {name: 'ledgerId', expression: 'ledger_id'},
            {name: 'name', expression: 'name', type: 'String'},
          ],
        },
      ],
    });
    expect(outcome.status).toBe('committed');
  });

  test('an action that declares no affects is refused when the model has ' +
           'constraints',
       async () => {
         // Silence is not a statement that nothing is constrained, and reading
         // it as one is the single guess here that fails open.
         const outcome = await runWith({
           actions: [{...credit, affects: undefined}],
           constraints: [balance],
         });
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain("declares no 'affects'");
       });

  test('an action that declares no affects runs when the model has no ' +
           'constraints',
       async () => {
         // Nothing to be unsure about, so there is nothing to refuse. The DML
         // is the UPDATE alone: dropping `affects` drops the `create` that
         // generates `@newEntryKey`, so an INSERT binding it would fail for an
         // unrelated reason and prove nothing about the refusal rules.
         const outcome = await runWith({
           actions: [{
             ...credit,
             affects: undefined,
             executor: {
               kind: 'sql',
               sql: {
                 statements: [
                   'UPDATE Account SET balance = balance - @amount ' +
                       'WHERE account_id = @account',
                 ],
               },
             },
           }],
         });
         expect(outcome.status).toBe('committed');
       });

  test('a guard is refused even when the model states no such constraint',
       async () => {
         // An unresolved guard fails the push, so this model should not exist.
         // If one reaches the runtime anyway, the action still claims to be
         // checked, and running it would still be running it unchecked.
         const outcome = await runWith({
           actions: [{...credit, guards: ['NoSuchRule']}],
           constraints: [],
         });
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain("guarded by 'NoSuchRule'");
       });

  test('several bearing constraints are all named, in a stable order',
       async () => {
         const outcome = await runWith({
           constraints: [
             {name: 'ZBalance', expression: 'Account.balance >= 0'},
             {name: 'AEntry', expression: 'Entry.amount > 0'},
           ],
         });
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain("'AEntry' and 'ZBalance'");
       });
});


// The overlap test is the one place the refusal rule could fail open: it is
// what decides that no constraint bears on a write, and it decides it by
// reading expressions this module does not parse. So it is wrong on purpose,
// in the direction that refuses.
describe('constraints the overlap test cannot rule out', () => {
  const runWith = (over: Partial<SemanticModel>) => runAction({
    model: creditModel(over),
    actionName: 'Credit',
    args: {account: 'A1', amount: 100},
    client: resolvingFake().client,
  });

  test('a constraint qualified by a RELATIONSHIP the action affects is found',
       async () => {
         // `affects` names an entity OR a relationship, and validation
         // deliberately permits a relationship-qualified expression. Scanning
         // entity names alone would find no overlap, and -- because `affects`
         // is non-empty -- the "declares no affects" rule would not catch it
         // either, so the write would run unchecked.
         const outcome = await runWith({
           actions: [{
             ...credit,
             affects: [{concept: 'PostedTo', operation: 'create'}],
           }],
           relationships: [{
             name: 'PostedTo',
             source: {entity: 'Entry', columns: ['entry_id']},
             destination: {entity: 'Account', columns: ['account_id']},
           }],
           constraints: [
             {name: 'OnePosting', expression: 'PostedTo.postings <= 1'},
           ],
         });
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain("'OnePosting' could constrain");
       });

  test('a constraint that names no known concept bears on every action',
       async () => {
         // `amount > 0` is about whatever the author had in mind. Nothing here
         // can tell which concept that is, and reading "it mentions no entity"
         // as "it constrains none" is the guess that runs an unchecked write.
         const outcome = await runWith({
           constraints: [{name: 'PositiveAmount', expression: 'amount > 0'}],
         });
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain("'PositiveAmount' could constrain");
       });
});


describe('an action whose write comes from a handler', () => {
  test('is not held to a binding pass its plan never uses', async () => {
    // The bindings exist to fill the model's OWN statements. A handler is
    // handed the resolved refs whole, so a two-part key it can write perfectly
    // well must not be refused on the way in.
    //
    // The entity carries an identifying column because that is the only way a
    // composite-keyed row can be named by one value at all -- see the
    // resolution tests below.
    const fake = new FakeSpanner([{match: 'FROM Account', rows: [['eu', '1']]}]);
    const outcome = await run(fake, {
      model: model({
        entities: [{
          name: 'Account',
          dataSource: 'demo.payments.Account',
          keys: ['region', 'accountId'],
          fields: [
            {name: 'region', expression: 'region', type: 'String'},
            {name: 'accountId', expression: 'account_id', type: 'String'},
            {name: 'name', expression: 'name', type: 'String'},
          ],
        }],
      }),
    });
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    expect(outcome.refs.source.keys).toEqual(['eu', '1']);
  });

  test('a composite key is still refused when the MODEL supplies the write',
       async () => {
         // Here the key has to become one statement parameter, and one value
         // cannot carry two columns.
         const fake =
             new FakeSpanner([{match: 'FROM Account', rows: [['eu', '1']]}]);
         const outcome = await runCredit(fake, {
           model: creditModel({
             entities: [
               {
                 name: 'Account',
                 dataSource: 'demo.payments.Account',
                 keys: ['region', 'accountId'],
                 fields: [
                   {name: 'region', expression: 'region', type: 'String'},
                   {name: 'accountId', expression: 'account_id', type: 'String'},
                   {name: 'name', expression: 'name', type: 'String'},
                 ],
               },
               {
                 name: 'Entry',
                 dataSource: 'demo.payments.Entry',
                 keys: ['entryId'],
                 fields: [{name: 'entryId', expression: 'entry_id'}],
               },
             ],
           }),
         });
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain('a composite key cannot be passed');
       });
});


describe('the key generated for a created row', () => {
  // Every model here keys Entry by something a UUID is not.
  function entryKeyed(type: 'Integer'|'String', statements: string[]) {
    return creditModel({
      actions: [{...credit, executor: {kind: 'sql', sql: {statements}}}],
      entities: [
        ...model().entities,
        {
          name: 'Entry',
          dataSource: 'demo.payments.Entry',
          keys: ['entryId'],
          fields: [
            {name: 'entryId', expression: 'entry_id', type},
            {name: 'amount', expression: 'amount'},
          ],
        },
      ],
    });
  }

  test('is refused by name when the entity is not keyed by a String',
       async () => {
         // The store would reject the INSERT too, but as "statement rejected"
         // -- naming neither the entity, nor the key, nor the reason.
         const fake = resolvingFake();
         const outcome = await runCredit(fake, {
           model: entryKeyed(
               'Integer',
               [
                 'INSERT INTO Entry (entry_id, amount) ' +
                     'VALUES (@newEntryKey, @amount)',
               ]),
         });
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain("Entry's key 'entryId' has type Integer");
         expect(fake.sql.some(s => s.startsWith('INSERT'))).toBe(false);
       });

  test('does not refuse an entity whose statement supplies its own key',
       async () => {
         // An INT64 key is nobody's problem as long as the DML never asks the
         // runtime for one. Refusing over a value the action does not bind
         // would be a false alarm on a model that works.
         const fake = resolvingFake();
         const outcome = await runCredit(fake, {
           model: entryKeyed(
               'Integer',
               [
                 'INSERT INTO Entry (entry_id, amount) ' +
                     'SELECT MAX(entry_id) + 1, @amount FROM Entry',
               ]),
         });
         if (outcome.status !== 'committed') throw new Error(outcome.message);
       });

  test('fills a String key, which is what a UUID is', async () => {
    const fake = resolvingFake();
    const outcome = await runCredit(fake, {
      model: entryKeyed(
          'String',
          [
            'INSERT INTO Entry (entry_id, amount) ' +
                'VALUES (@newEntryKey, @amount)',
          ]),
    });
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    const insert = fake.statements.find(s => s.sql.startsWith('INSERT'));
    expect(insert?.paramTypes?.newEntryKey).toEqual({code: 'STRING'});
  });
});


// A commit is the one step whose failure cannot be undone from here, so what
// the runtime SAYS about it is the whole of what a caller has to go on.
describe('a commit whose outcome the runtime cannot know', () => {
  test('a commit that rejects is indeterminate, not a rollback', async () => {
    // The request throws rather than returning a status -- a socket hang-up, a
    // DNS failure, an abort. That is exactly the shape a commit deadline takes
    // from the client, and the case where the write is likeliest to have
    // landed anyway. Reporting a rollback would invite the retry that applies
    // it twice.
    const fake = resolvingFake();
    fake.commitThrows = true;
    const outcome = await runCredit(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.indeterminate).toBe(true);
    expect(outcome.message).toContain('Whether the write landed is unknown');
    expect(outcome.message).not.toContain('rolled back');
    expect(fake.rolledBack).toBe(false);
  });
});


describe('a failure before any transaction exists', () => {
  test('is not reported as a rollback', async () => {
    // Nothing was opened, so nothing was rolled back. Saying otherwise tells
    // the caller a transaction was undone that never began.
    const fake = resolvingFake();
    fake.sessionFails = true;
    const outcome = await runCredit(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('could not start');
    expect(outcome.message).not.toContain('rolled back');
  });
});


// `onViolation` says what a violation DOES. A rule that only reports one can
// never refuse a write, so it cannot be the reason a write is refused.
describe('a constraint that only warns', () => {
  const advisory: Constraint = {
    name: 'BalanceIsLow',
    expression: 'Account.balance >= 0',
    description: 'Flag an account that has gone negative.',
    onViolation: 'warn',
  };

  test(
      'does not gate the action, because it could never refuse it',
      async () => {
        // Gating on it would leave a model that states advisory rules
        // permanently unrunnable, with nothing the author could change short
        // of deleting the rule.
        const outcome = await runAction({
          model: creditModel({constraints: [advisory]}),
          actionName: 'Credit',
          args: {account: 'A1', amount: 100},
          client: resolvingFake().client,
        });
        if (outcome.status !== 'committed') throw new Error(outcome.message);
      });

  test('does not gate it as a guard either', async () => {
    const outcome = await runAction({
      model: creditModel({
        actions: [{...credit, guards: ['BalanceIsLow']}],
        constraints: [advisory],
      }),
      actionName: 'Credit',
      args: {account: 'A1', amount: 100},
      client: resolvingFake().client,
    });
    if (outcome.status !== 'committed') throw new Error(outcome.message);
  });

  test(
      'but a guard naming nothing the model declares still refuses',
      async () => {
        // Validation makes that a hard error and `kcmd action run` now runs
        // validation -- but a library caller reaching runAction directly gets
        // no such pass, and a guard this cannot account for is not something
        // to wave through on the grounds that it was not found.
        const outcome = await runAction({
          model: creditModel({
            actions: [{...credit, guards: ['NoSuchRule']}],
            constraints: [advisory],
          }),
          actionName: 'Credit',
          args: {account: 'A1', amount: 100},
          client: resolvingFake().client,
        });
        if (outcome.status !== 'error') throw new Error('expected an error');
        expect(outcome.message).toContain('\'NoSuchRule\'');
      });
});


// For a `sql` executor the write is in the model, so what it touches is a fact
// to be read rather than a claim to be believed.
describe('the blast radius read off the statements', () => {
  const nonNegative: Constraint = {
    name: 'NonNegativeBalance',
    expression: 'Account.balance >= 0',
    description: 'An account cannot go negative.',
  };

  test(
      'an action that writes more than it declares is still caught',
      async () => {
        // This `affects` omits Account, whose balance the second statement
        // changes, and the constraint reads exactly that. Trusting the
        // declaration would run the write with the rule unevaluated -- and an
        // author who under-declares is the likeliest one to have missed it.
        const outcome = await runAction({
          model: creditModel({
            actions: [{
              ...credit,
              affects: [{concept: 'Entry', operation: 'create'}],
            }],
            constraints: [nonNegative],
          }),
          actionName: 'Credit',
          args: {account: 'A1', amount: 100},
          client: resolvingFake().client,
        });
        if (outcome.status !== 'error') throw new Error('expected an error');
        expect(outcome.message)
            .toContain('\'NonNegativeBalance\' could constrain');
      });

  test(
      'a statement writing a table no concept binds is not vouched for',
      async () => {
        // An audit table is not something a constraint can be stated over,
        // but it is also not something this can attribute to a concept -- and
        // what it would be vouching for is running the write unchecked.
        const outcome = await runAction({
          model: creditModel({
            actions: [{
              ...credit,
              executor: {
                kind: 'sql',
                sql: {
                  statements: ['INSERT INTO audit_log (note) VALUES (@amount)'],
                },
              },
              affects: [{concept: 'Entry', operation: 'create'}],
            }],
            constraints: [nonNegative],
          }),
          actionName: 'Credit',
          args: {account: 'A1', amount: 100},
          client: resolvingFake().client,
        });
        if (outcome.status !== 'error') throw new Error('expected an error');
        expect(outcome.message).toContain('could constrain');
      });

  test(
      'an action whose statements stay inside what it declares runs',
      async () => {
        // The point of reading the statements is to catch the one that
        // reaches further, not to refuse everything.
        const fake = resolvingFake();
        const outcome = await runAction({
          model: creditModel({
            constraints: [{
              name: 'EntryHasAmount',
              expression: 'Entry.amount >= 0',
              description: 'A ledger entry records an amount.',
            }],
            actions: [{
              ...credit,
              executor: {
                kind: 'sql',
                sql: {
                  statements: [
                    'UPDATE Account SET balance = balance - @amount ' +
                        'WHERE account_id = @account',
                  ],
                },
              },
              affects: [{
                concept: 'Account',
                operation: 'modify',
                fields: ['balance'],
              }],
            }],
          }),
          actionName: 'Credit',
          args: {account: 'A1', amount: 100},
          client: fake.client,
        });
        if (outcome.status !== 'committed') throw new Error(outcome.message);
      });
});


describe('an entity whose key has more than one column', () => {
  test('is not resolved by matching one part of the key', async () => {
    // `region = @ref OR account_id = @ref` accepts a row matching one PART of
    // the key as though it were the row meant, and can match several rows that
    // agree on that part and differ in the rest. One value cannot name a
    // two-column key, and guessing which column it names is not resolution.
    const fake =
        new FakeSpanner([{match: 'FROM Account', rows: [['eu', '1']]}]);
    const outcome = await run(fake, {
      model: model({
        entities: [{
          name: 'Account',
          dataSource: 'demo.payments.Account',
          keys: ['region', 'accountId'],
          fields: [
            {name: 'region', expression: 'region', type: 'String'},
            {name: 'accountId', expression: 'account_id', type: 'String'},
          ],
        }],
      }),
    });
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('its key has 2 columns');
    // Nothing was asked of the store: there was no question to ask.
    expect(fake.statements).toEqual([]);
  });
});


describe('an argument given as empty text', () => {
  test('is a value for a String parameter', async () => {
    // `--arg memo=` says the memo is blank, which is a different statement
    // from not passing one.
    const fake = resolvingFake();
    const outcome = await runAction({
      model: creditModel({
        actions: [{
          ...credit,
          executor: {
            kind: 'sql',
            sql: {
              statements: [
                'UPDATE Account SET memo = @memo WHERE account_id = @account',
              ],
            },
          },
          parameters: [
            {name: 'account', type: 'Account', isEntityRef: true},
            {name: 'memo', type: 'String', isEntityRef: false},
          ],
          affects: [{
            concept: 'Account',
            operation: 'modify',
            fields: ['balance'],
          }],
        }],
      }),
      actionName: 'Credit',
      args: {account: 'A1', memo: ''},
      client: fake.client,
    });
    if (outcome.status !== 'committed') throw new Error(outcome.message);
  });

  test('is still not a value for a numeric one', async () => {
    // There is no Float that empty text could be.
    const outcome =
        await runCredit(resolvingFake(), {args: {account: 'A1', amount: ''}});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('was not given a value');
  });
});
