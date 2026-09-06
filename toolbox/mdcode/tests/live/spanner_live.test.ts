// SpannerDataClient against real Cloud Spanner.
//
// The hermetic version of this file (tests/libts/gcp/spanner.test.ts) asserts
// the request bodies the client builds. That is worth having -- it pins the
// shapes cheaply -- but a spy accepts anything, so it can only prove the client
// sends what we decided it should, never that Spanner wants that. The `seqno`
// requirement is the standing proof: the client was correct against its spy and
// failed on the first real transaction that ran two statements.
//
// So these tests re-prove the same facts by making the server the oracle, and
// add the ones a spy cannot express at all -- that a rollback really discards,
// and that a statement can see its own transaction's uncommitted writes.
//

import {afterAll, beforeEach, describe, expect, test} from 'bun:test';

import * as spanner from '../../src/libts/gcp/spanner';

import {
  apiContext,
  dataClient,
  expectOk,
  instance,
  LIVE,
  project,
  readCommitted,
  reseed,
} from './live';


// A Transfer row is the cheapest thing to write: it has no foreign-key
// constraints in the schema, so a test can insert one, look at it, and roll
// back without arranging anything else.
function insertTransfer(id: number, amount = 1.0): spanner.Statement {
  return {
    sql: 'INSERT INTO Transfer ' +
        '(transfer_id, source_account_id, target_account_id, amount) ' +
        'VALUES (@id, 1, 3, @amount)',
    params: {id: `${id}`, amount},
    paramTypes: {id: {code: 'INT64'}, amount: {code: 'FLOAT64'}},
  };
}

function countTransfers(): spanner.Statement {
  return {sql: 'SELECT CAST(COUNT(*) AS STRING) FROM Transfer'};
}


describe.skipIf(!LIVE)('SpannerDataClient on real Spanner', () => {
  beforeEach(async () => {
    await reseed();
  });

  afterAll(async () => {
    await reseed();
  });

  describe('sessions', () => {
    test('creates a session that belongs to the configured database',
         async () => {
           const client = dataClient();
           const session =
               expectOk(await client.createSession(), 'createSession');
           expect(session.name).toContain(`${client.database}/sessions/`);
           expectOk(await client.deleteSession(session.name!), 'deleteSession');
         });

    test('deleting a session really removes it, not just locally', async () => {
      const client = dataClient();
      const session = expectOk(await client.createSession(), 'createSession');
      expectOk(await client.deleteSession(session.name!), 'deleteSession');
      // The spy version could only observe that a DELETE was sent. The server
      // is the only thing that can say the session is gone.
      const after = await client._get(session.name!);
      expect(after.status).toBe(404);
    });

    test('withSession deletes the session even when the body throws',
         async () => {
           const client = dataClient();
           let leaked = '';
           await expect(client.withSession(async session => {
             leaked = session;
             throw new Error('deliberate');
           })).rejects.toThrow('deliberate');
           expect(leaked).not.toBe('');
           expect((await client._get(leaked)).status).toBe(404);
         });

    test('a session that cannot be created is reported, naming the database',
         async () => {
           const missing = new spanner.SpannerDataClient(
               apiContext(), project, instance, 'no_such_database_here');
           await expect(missing.withSession(async () => 'unreachable'))
               .rejects.toThrow('no_such_database_here');
         });
  });

  describe('the per-transaction statement sequence number', () => {
    test('lets several statements run in one transaction', async () => {
      // The regression. Without the counter the SECOND statement fails, so a
      // single-statement smoke test would still pass.
      const client = dataClient();
      await client.withSession(async session => {
        const txn = expectOk(
            await client.beginReadWrite(session), 'beginTransaction');
        for (const id of [9001, 9002, 9003]) {
          expectOk(
              await client.executeSql(session, txn.id!, insertTransfer(id)),
              `insert ${id}`);
        }
        expectOk(await client.rollback(session, txn.id!), 'rollback');
      });
    });

    test('is genuinely required -- reusing one is rejected by the server',
         async () => {
           // Pins the REASON the counter exists. If Spanner ever stopped
           // enforcing this, the counter would become dead code and this test
           // is what would say so.
           const client = dataClient();
           await client.withSession(async session => {
             const txn = expectOk(
                 await client.beginReadWrite(session), 'beginTransaction');
             const raw = (sql: string) => client._post<spanner.ResultSet>(
                 `${session}:executeSql`,
                 {transaction: {id: txn.id}, sql, seqno: '1'});
             expectOk(await raw('INSERT INTO Transfer ' +
                                '(transfer_id, source_account_id, ' +
                                'target_account_id, amount) ' +
                                'VALUES (9101, 1, 3, 1.0)'),
                      'first statement');
             const second = await raw('INSERT INTO Transfer ' +
                                      '(transfer_id, source_account_id, ' +
                                      'target_account_id, amount) ' +
                                      'VALUES (9102, 1, 3, 1.0)');
             expect(second.status).toBe(400);
             expect(second.message).toContain('seqno');
             await client.rollback(session, txn.id!);
           });
         });

    test('is tracked per transaction, so two open at once do not collide',
         async () => {
           // Two sessions, not two transactions in one: Spanner allows a single
           // session at most one active read-write transaction and invalidates
           // the earlier one ("This transaction has been invalidated by a later
           // transaction in the same session"), which is exactly the kind of
           // rule a spy cannot tell you. The counter is keyed by transaction id
           // regardless, and interleaving the two statements is what would
           // expose a shared one.
           const a = dataClient();
           const b = dataClient();
           await a.withSession(async sessionA => {
             await b.withSession(async sessionB => {
               const txnA = expectOk(
                   await a.beginReadWrite(sessionA), 'begin a');
               const txnB = expectOk(
                   await b.beginReadWrite(sessionB), 'begin b');
               expectOk(
                   await a.executeSql(sessionA, txnA.id!, insertTransfer(9201)),
                   'a1');
               expectOk(
                   await b.executeSql(sessionB, txnB.id!, insertTransfer(9301)),
                   'b1');
               expectOk(
                   await a.executeSql(sessionA, txnA.id!, insertTransfer(9202)),
                   'a2');
               expectOk(
                   await b.executeSql(sessionB, txnB.id!, insertTransfer(9302)),
                   'b2');
               await a.rollback(sessionA, txnA.id!);
               await b.rollback(sessionB, txnB.id!);
             });
           });
         });

    test('restarts after a commit, so a reused session keeps working',
         async () => {
           const client = dataClient();
           await client.withSession(async session => {
             const first = expectOk(
                 await client.beginReadWrite(session), 'begin first');
             expectOk(
                 await client.executeSql(
                     session, first.id!, insertTransfer(9401)),
                 'first insert');
             expectOk(await client.commit(session, first.id!), 'commit');

             const second = expectOk(
                 await client.beginReadWrite(session), 'begin second');
             expectOk(
                 await client.executeSql(
                     session, second.id!, insertTransfer(9402)),
                 'second insert');
             expectOk(
                 await client.executeSql(
                     session, second.id!, insertTransfer(9403)),
                 'third insert');
             await client.rollback(session, second.id!);
           });
         });

    test('restarts after a rollback too', async () => {
      const client = dataClient();
      await client.withSession(async session => {
        const first =
            expectOk(await client.beginReadWrite(session), 'begin first');
        expectOk(
            await client.executeSql(session, first.id!, insertTransfer(9501)),
            'first insert');
        expectOk(await client.rollback(session, first.id!), 'rollback');

        const second =
            expectOk(await client.beginReadWrite(session), 'begin second');
        expectOk(
            await client.executeSql(session, second.id!, insertTransfer(9502)),
            'second insert');
        expectOk(
            await client.executeSql(session, second.id!, insertTransfer(9503)),
            'third insert');
        await client.rollback(session, second.id!);
      });
    });
  });

  describe('executeSql', () => {
    test('binds named parameters and returns the columns it was asked for',
         async () => {
           const rows = await readCommitted(
               'SELECT name, CAST(balance AS STRING) FROM Account ' +
                   'WHERE CAST(account_id AS STRING) = @id',
               {id: '1'}, {id: {code: 'STRING'}});
           expect(rows).toEqual([['Alice Checking', '2500']]);
         });

    test('declares an array parameter Spanner could not otherwise infer',
         async () => {
           // The constraint probes bind exactly this shape; if the paramTypes
           // spelling were wrong, every scoped probe would fail at runtime.
           const rows = await readCommitted(
               'SELECT CAST(account_id AS STRING) FROM Account ' +
                   'WHERE CAST(account_id AS STRING) IN UNNEST(@ids) ' +
                   'ORDER BY account_id',
               {ids: ['1', '3']},
               {ids: {code: 'ARRAY', arrayElementType: {code: 'STRING'}}});
           expect(rows).toEqual([['1'], ['3']]);
         });

    test('names the result columns in the response metadata', async () => {
      const client = dataClient();
      await client.withSession(async session => {
        const txn =
            expectOk(await client.beginReadWrite(session), 'beginTransaction');
        const res = expectOk(
            await client.executeSql(
                session, txn.id!,
                {sql: 'SELECT account_id, balance FROM Account LIMIT 1'}),
            'select');
        expect(res.metadata?.rowType?.fields?.map(f => f.name)).toEqual([
          'account_id', 'balance'
        ]);
        await client.rollback(session, txn.id!);
      });
    });
  });

  describe('transaction semantics the runtime depends on', () => {
    test('a statement sees its own transaction\'s uncommitted writes',
         async () => {
           // Read-your-writes is what makes the constraint gate meaningful: the
           // probe has to observe the action's write before anyone commits it.
           const client = dataClient();
           await client.withSession(async session => {
             const txn = expectOk(
                 await client.beginReadWrite(session), 'beginTransaction');
             const before = expectOk(
                 await client.executeSql(session, txn.id!, countTransfers()),
                 'count before');
             expect(before.rows).toEqual([['0']]);

             expectOk(
                 await client.executeSql(
                     session, txn.id!, insertTransfer(9601)),
                 'insert');

             const after = expectOk(
                 await client.executeSql(session, txn.id!, countTransfers()),
                 'count after');
             expect(after.rows).toEqual([['1']]);
             await client.rollback(session, txn.id!);
           });
         });

    test('a rollback discards the write, and nothing outside ever saw it',
         async () => {
           const client = dataClient();
           await client.withSession(async session => {
             const txn = expectOk(
                 await client.beginReadWrite(session), 'beginTransaction');
             expectOk(
                 await client.executeSql(
                     session, txn.id!, insertTransfer(9701)),
                 'insert');
             expectOk(await client.rollback(session, txn.id!), 'rollback');
           });
           expect(await readCommitted(
                      'SELECT CAST(COUNT(*) AS STRING) FROM Transfer'))
               .toEqual([['0']]);
         });

    test('a commit makes the write visible to a later reader', async () => {
      const client = dataClient();
      const stamp = await client.withSession(async session => {
        const txn =
            expectOk(await client.beginReadWrite(session), 'beginTransaction');
        expectOk(
            await client.executeSql(session, txn.id!, insertTransfer(9801, 7.5)),
            'insert');
        return expectOk(await client.commit(session, txn.id!), 'commit')
            .commitTimestamp;
      });
      expect(stamp).toBeTruthy();
      expect(await readCommitted(
                 'SELECT CAST(amount AS STRING) FROM Transfer ' +
                 'WHERE transfer_id = 9801'))
          .toEqual([['7.5']]);
    });
  });
});
