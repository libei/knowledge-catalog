// Constraint lowering, checked by running the SQL it produces.
//
// The hermetic tests (tests/libts/semantic/constraint_eval.test.ts) compare the
// lowered SQL to an expected string. That pins the shape, but a string is not a
// query: a probe can be exactly the text we intended and still be invalid
// GoogleSQL, or valid and mean something other than "the rows that violate
// this". Two of the lowering decisions are semantic claims about the engine
// rather than about our code, and only the engine can settle them:
//
//   * `NOT COALESCE(expr, FALSE)` treats a NULL column as a violation. The
//     reason it is written that way is that `NOT (NULL >= 0)` is UNKNOWN, not
//     TRUE, so the obvious spelling silently lets NULLs through. That is a
//     claim about three-valued logic in Spanner, and there is a test below that
//     runs both spellings side by side.
//   * a scoped probe restricts to the touched rows with
//     `CAST(key AS STRING) IN UNNEST(@touchedKeys)`, bound as an ARRAY<STRING>.
//     Whether the server accepts that binding is not something a string
//     comparison can know.
//
// Every test here runs inside a transaction that is rolled back, so the
// database is untouched and the tests do not depend on each other's order.
//

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';

import * as spanner from '../../src/libts/gcp/spanner';
import {
  ConstraintProbe,
  lowerConstraint,
  lowerConstraints,
  violationMessage,
} from '../../src/libts/semantic/constraint_eval';
import {SemanticModel} from '../../src/libts/semantic/ir';
import {loadModels} from '../../src/libts/semantic/loader';

import {
  dataClient,
  expectOk,
  LIVE,
  readModelYaml,
  reseed,
} from './live';


const TOUCHED = 'touchedKeys';

let model: SemanticModel;

function lower(expression: string, opts: {limit?: number} = {}):
    ConstraintProbe {
  const res = lowerConstraint(
      model, {name: 'UnderTest', expression},
      {touchedKeysParam: TOUCHED, limit: opts.limit});
  if (!res.ok) throw new Error(`could not lower "${expression}": ${res.reason}`);
  return res.probe;
}

function byName(name: string): ConstraintProbe {
  const {probes} =
      lowerConstraints(model, {touchedKeysParam: TOUCHED});
  const probe = probes.find(p => p.constraint.name === name);
  if (!probe) throw new Error(`no probe for constraint '${name}'`);
  return probe;
}

// Applies `setup`, then runs each query, then rolls back. The probes therefore
// see the uncommitted state -- the same way the runtime's gate sees an action's
// write -- and nothing survives the test.
async function inRolledBackTransaction(
    setup: spanner.Statement[],
    queries: spanner.Statement[]): Promise<string[][][]> {
  const client = dataClient();
  return await client.withSession(async session => {
    const txn =
        expectOk(await client.beginReadWrite(session), 'beginTransaction');
    try {
      for (const stmt of setup) {
        expectOk(
            await client.executeSql(session, txn.id!, stmt),
            `setup "${stmt.sql}"`);
      }
      const out: string[][][] = [];
      for (const stmt of queries) {
        out.push(
            expectOk(
                await client.executeSql(session, txn.id!, stmt),
                `probe "${stmt.sql}"`)
                .rows ??
            []);
      }
      return out;
    } finally {
      await client.rollback(session, txn.id!);
    }
  });
}

// Runs one probe unscoped (over the whole table).
async function runUnscoped(
    probe: ConstraintProbe, setup: spanner.Statement[] = []):
    Promise<string[][]> {
  return (await inRolledBackTransaction(setup, [{sql: probe.unscopedSql}]))[0];
}

// Runs one probe restricted to the given keys, exactly as the runtime binds it.
async function runScoped(
    probe: ConstraintProbe, keys: string[],
    setup: spanner.Statement[] = []): Promise<string[][]> {
  return (await inRolledBackTransaction(setup, [{
           sql: probe.sql,
           params: {[TOUCHED]: keys},
           paramTypes:
               {[TOUCHED]: {code: 'ARRAY', arrayElementType: {code: 'STRING'}}},
         }]))[0];
}

function setBalance(accountId: number, value: string): spanner.Statement {
  return {sql: `UPDATE Account SET balance = ${value} WHERE account_id = ${
              accountId}`};
}


describe.skipIf(!LIVE)('constraint probes on real Spanner', () => {
  beforeAll(async () => {
    model = loadModels(readModelYaml(), {dialect: 'ANSI_SQL'}).models[0];
    await reseed();
  });

  afterAll(async () => {
    await reseed();
  });

  describe('the shipped model', () => {
    test('every constraint lowers', () => {
      const {probes, errors} = lowerConstraints(model, {touchedKeysParam: TOUCHED});
      expect(errors).toEqual([]);
      expect(probes.map(p => p.constraint.name)).toEqual([
        'NonNegativeBalance',
        'AboveMinimumBalance',
        'PositiveAmount',
        'OpenAccountsOnly',
      ]);
    });

    test('and every lowered probe is SQL the server accepts', async () => {
      // The single most valuable thing this file does: a probe that does not
      // parse fails the action it was supposed to guard, and no amount of
      // string comparison would have caught it.
      const {probes} = lowerConstraints(model, {touchedKeysParam: TOUCHED});
      for (const probe of probes) {
        await runUnscoped(probe);
        await runScoped(probe, ['1']);
      }
    });

    test('the seeded state satisfies the three balance and amount rules',
         async () => {
           for (const name
                    of ['NonNegativeBalance', 'AboveMinimumBalance',
                        'PositiveAmount']) {
             expect(await runUnscoped(byName(name))).toEqual([]);
           }
         });

    test('and violates OpenAccountsOnly, which is why scoping matters',
         async () => {
           // Account 4 is frozen in the seed. Whole-table, that is a violation;
           // scoped to rows an action did not touch, it is none of that
           // action's business. This is the enforcement contract -- an action
           // must not INTRODUCE a violation among the rows it changes -- and it
           // is only observable against data.
           const probe = byName('OpenAccountsOnly');
           expect(await runUnscoped(probe)).toEqual([['4']]);
           expect(await runScoped(probe, ['1', '3'])).toEqual([]);
           expect(await runScoped(probe, ['3', '4'])).toEqual([['4']]);
         });
  });

  describe('what the probe selects', () => {
    test('the rows that violate, named by key', async () => {
      const rows = await runUnscoped(
          byName('NonNegativeBalance'), [setBalance(1, '-5.0')]);
      expect(rows).toEqual([['1']]);
    });

    test('nothing when the constraint holds', async () => {
      expect(await runUnscoped(
                 byName('NonNegativeBalance'), [setBalance(1, '0.0')]))
          .toEqual([]);
    });

    test('a field-to-field comparison reads both columns', async () => {
      // Account 2 keeps a floor of 5000; dropping it to 4000 breaks the rule
      // without going anywhere near zero, so only the field-to-field form
      // catches it.
      const rows = await runUnscoped(
          byName('AboveMinimumBalance'), [setBalance(2, '4000.0')]);
      expect(rows).toEqual([['2']]);
      expect(await runUnscoped(byName('NonNegativeBalance'),
                               [setBalance(2, '4000.0')]))
          .toEqual([]);
    });

    test('a rule on another entity probes that entity\'s table', async () => {
      const rows = await runUnscoped(byName('PositiveAmount'), [{
        sql: 'INSERT INTO Transfer (transfer_id, source_account_id, ' +
            'target_account_id, amount) VALUES (7001, 1, 3, -5.0)',
      }]);
      expect(rows).toEqual([['7001']]);
    });

    test('the violation cap is honoured by the server, not just emitted',
         async () => {
           const setup = [
             setBalance(1, '-1.0'), setBalance(2, '-1.0'), setBalance(3, '-1.0')
           ];
           const capped = lower('Account.balance >= 0', {limit: 2});
           expect(await runUnscoped(capped, setup)).toHaveLength(2);
           const uncapped = lower('Account.balance >= 0', {limit: 10});
           expect(await runUnscoped(uncapped, setup)).toHaveLength(3);
         });
  });

  describe('a NULL column', () => {
    test('counts as a violation', async () => {
      const rows = await runUnscoped(
          byName('NonNegativeBalance'), [setBalance(1, 'NULL')]);
      expect(rows).toEqual([['1']]);
    });

    test('and would NOT have, written the obvious way', async () => {
      // The reason lowering emits `NOT COALESCE(expr, FALSE)`. `NULL >= 0` is
      // UNKNOWN; `NOT UNKNOWN` is UNKNOWN; a WHERE clause keeps only TRUE. So
      // the natural spelling lets exactly the rows we are least sure about
      // through the gate. Run both against the same state and the difference is
      // not an argument, it is two result sets.
      const naive = {
        sql: 'SELECT CAST(account_id AS STRING) FROM Account ' +
            'WHERE NOT (balance >= 0) LIMIT 5',
      };
      const guarded = {sql: byName('NonNegativeBalance').unscopedSql};
      const [naiveRows, guardedRows] =
          await inRolledBackTransaction([setBalance(1, 'NULL')], [naive, guarded]);
      expect(naiveRows).toEqual([]);
      expect(guardedRows).toEqual([['1']]);
    });
  });

  describe('scoping to the rows an action touched', () => {
    test('binds the key array the runtime sends', async () => {
      const probe = byName('NonNegativeBalance');
      expect(probe.scoped).toBe(true);
      const rows = await runScoped(
          probe, ['1', '3'], [setBalance(1, '-1.0'), setBalance(2, '-1.0')]);
      // Account 2 is broken too, but the action did not touch it.
      expect(rows).toEqual([['1']]);
    });

    test('an empty key set matches nothing, which is why the runtime never ' +
             'sends one',
         async () => {
           // Documents the trap the runtime avoids by falling back to
           // unscopedSql: a scoped probe with no keys passes vacuously, and a
           // gate that always passes is worse than no gate.
           const probe = byName('NonNegativeBalance');
           expect(await runScoped(probe, [], [setBalance(1, '-1.0')]))
               .toEqual([]);
           expect(await runUnscoped(probe, [setBalance(1, '-1.0')]))
               .toEqual([['1']]);
         });
  });

  describe('the expression forms the evaluator accepts', () => {
    // Each of these has a hermetic test asserting the SQL text. Here the only
    // assertion is that the server runs it: a lowering that produces valid text
    // for an operator Spanner spells differently would pass there and fail
    // here.
    const forms = [
      'Account.balance > 0',
      'Account.balance >= 0',
      'Account.balance < 1000000',
      'Account.balance <= 1000000',
      'Account.status = \'OPEN\'',
      'Account.status != \'FROZEN\'',
      'Account.status <> \'FROZEN\'',
      'Account.balance >= -100.5',
      'Account.balance >= Account.minimumBalance',
      'Account.balance >= 0 AND Account.status != \'FROZEN\'',
      'Account.balance >= 0 OR Account.status = \'FROZEN\'',
      'Account.balance >= 0 and Account.status != \'FROZEN\'',
      'Account.ownerId != NULL',
      'Account.ownerId = NULL',
      'Account.balance >= 0 AND Account.balance <= 1000000',
    ];

    for (const expression of forms) {
      test(`${expression}`, async () => {
        const probe = lower(expression);
        await runUnscoped(probe);
        await runScoped(probe, ['1', '4']);
      });
    }

    test('a NULL comparison has to become a null test to run at all', async () => {
      // The live suite found this one. `NOT COALESCE((owner_id != NULL), FALSE)`
      // is the obvious lowering and GoogleSQL refuses to compile it -- "Operands
      // of != cannot be literal NULL" -- so the probe was not merely wrong about
      // NULLs, it could not run. Lowering emits IS NOT NULL instead, and this
      // asserts against the server that the result is both accepted and correct.
      const probe = lower('Account.ownerId != NULL');
      expect(probe.unscopedSql).toContain('IS NOT NULL');
      expect(await runUnscoped(probe)).toEqual([]);
      expect(await runUnscoped(probe, [{
        sql: 'UPDATE Account SET owner_id = NULL WHERE account_id = 3',
      }])).toEqual([['3']]);
    });

    test('<> is emitted as != and still means the same thing to the server',
         async () => {
           const ne = lower('Account.status != \'FROZEN\'');
           const angle = lower('Account.status <> \'FROZEN\'');
           expect(angle.unscopedSql).toBe(ne.unscopedSql);
           expect(await runUnscoped(angle)).toEqual([['4']]);
         });
  });

  test('the message a violation returns names the row the server found',
       async () => {
         const probe = byName('NonNegativeBalance');
         const rows = await runUnscoped(probe, [setBalance(1, '-5.0')]);
         const message = violationMessage(probe, rows);
         expect(message).toContain('An account cannot be overdrawn');
         expect(message).toContain('NonNegativeBalance');
         expect(message).toContain('1');
       });
});
