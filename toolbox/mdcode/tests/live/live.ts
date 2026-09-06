// Shared configuration for the LIVE suite: the tests that run against real
// services instead of a fake.
//
// Every other test in this repository is hermetic, and should stay that way --
// a unit test that needs credentials and a network is a unit test that stops
// being run. But a hermetic test can only prove that the code does what its
// author expected the service to want. It cannot prove the service agrees.
// Three things in the constraints work are exactly of that kind:
//
//   * the SQL a constraint lowers to is asserted as a STRING, so a probe that
//     is subtly invalid GoogleSQL passes the unit test and fails in production;
//   * the Spanner request shapes are asserted against a spy, which by
//     construction accepts whatever the client sends (the `seqno` bug was
//     invisible to a spy and obvious on the first real two-statement
//     transaction);
//   * the runtime's central guarantee -- a constraint probe observes the
//     action's own uncommitted writes, and a violation leaves nothing behind --
//     is a property of the DATABASE's transaction semantics, not of our code.
//
// So this suite exists alongside the hermetic one, not instead of it. It is
// skipped unless KCMD_LIVE is set, so `npm test` is unchanged; `npm run
// test:live` opts in.
//
// Everything is overridable by environment variable. The defaults are the
// project the suite was developed against; the Spanner database defaults to one
// of its own (`kcmd_live_test`) rather than any existing database, because
// these tests write, and a test that can disturb someone's data is a test
// nobody will run.
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';

import * as context from '../../src/libts/gcp/context';
import * as spanner from '../../src/libts/gcp/spanner';


// The master switch. Unset means every live describe() block is skipped, which
// is what happens on a plain `npm test` and in CI.
export const LIVE = !!process.env.KCMD_LIVE;

// The catalog leg is opt-in separately: it needs a catalog surface on which
// this project may USE the published `semantic-*` system entry types, which a
// project generally cannot do on the production endpoint. Point DATAPLEX_ENDPOINT
// and KC_TYPE_PROJECT at a surface where it can, then set KCMD_LIVE_KC.
export const LIVE_KC = LIVE && !!process.env.KCMD_LIVE_KC;

export const project = process.env.KCMD_LIVE_PROJECT ?? 'sqlgen-testing';
export const instance =
    process.env.KCMD_LIVE_SPANNER_INSTANCE ?? 'graph-unified-solution-demo';
export const database =
    process.env.KCMD_LIVE_SPANNER_DATABASE ?? 'kcmd_live_test';

export const kcLocation = process.env.KCMD_LIVE_KC_LOCATION ?? 'global';
export const kcEntryGroup =
    process.env.KCMD_LIVE_KC_ENTRY_GROUP ?? 'kcmd_live_test';

export const databaseName =
    `projects/${project}/instances/${instance}/databases/${database}`;

// The suite runs the model the action demo ships, so a change that breaks the
// demo breaks a test rather than a reader.
export const modelPath =
    path.join(__dirname, '..', '..', 'demo', 'action', 'payments.yaml');

export function readModelYaml(): string {
  return fs.readFileSync(modelPath, 'utf8');
}


// ApiContext.default() also reads `compute/region` from gcloud and throws when
// it is unset, which has nothing to do with Spanner; this builds the context
// directly so the suite runs on a machine that never set one. The token is
// fetched once per process -- ApiContext.refresh() re-fetches it on a 401.
let ctx: context.ApiContext|undefined;

export function apiContext(): context.ApiContext {
  if (!ctx) {
    const token =
        cp.execSync('gcloud -q auth application-default print-access-token')
            .toString()
            .trim();
    if (!token) {
      throw new Error(
          'No application-default credentials; run `gcloud auth ' +
          'application-default login`.');
    }
    ctx = new context.ApiContext(project, kcLocation, token);
  }
  return ctx;
}

export function dataClient(): spanner.SpannerDataClient {
  return new spanner.SpannerDataClient(
      apiContext(), project, instance, database);
}

export function adminClient(): spanner.SpannerClient {
  return new spanner.SpannerClient(apiContext());
}


// The physical schema the payments model binds to. Deliberately a copy of the
// demo's rather than an import: the demo owns its own database and its own
// seed, and the two must be able to drift without one breaking the other.
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS Person (
     person_id INT64 NOT NULL,
     name STRING(128),
     city STRING(128),
   ) PRIMARY KEY (person_id)`,
  `CREATE TABLE IF NOT EXISTS Account (
     account_id INT64 NOT NULL,
     owner_id INT64,
     name STRING(128),
     balance FLOAT64,
     minimum_balance FLOAT64,
     status STRING(16),
   ) PRIMARY KEY (account_id)`,
  `CREATE TABLE IF NOT EXISTS Transfer (
     transfer_id INT64 NOT NULL,
     source_account_id INT64,
     target_account_id INT64,
     amount FLOAT64,
   ) PRIMARY KEY (transfer_id)`,
];


// The state every live test starts from. Accounts 1-4 are the demo's, so a
// reader recognizes them; 5 and 6 exist only here, to give the runtime's
// "ambiguous object reference" path two real rows to be ambiguous between.
//
//   1 Alice Checking   2500, floor  100, OPEN
//   2 Alice Savings   18000, floor 5000, OPEN
//   3 Bob Checking      400, floor    0, OPEN
//   4 Carol Savings     900, floor    0, FROZEN
//   5 Shared Name       100, floor    0, OPEN
//   6 Shared Name       100, floor    0, OPEN
export const SEED: string[] = [
  'DELETE FROM Transfer WHERE TRUE',
  'DELETE FROM Account WHERE TRUE',
  'DELETE FROM Person WHERE TRUE',
  `INSERT INTO Person (person_id, name, city) VALUES
     (1, 'Alice', 'Seattle'), (2, 'Bob', 'Austin'), (3, 'Carol', 'Denver')`,
  `INSERT INTO Account
     (account_id, owner_id, name, balance, minimum_balance, status) VALUES
     (1, 1, 'Alice Checking', 2500.0,  100.0, 'OPEN'),
     (2, 1, 'Alice Savings', 18000.0, 5000.0, 'OPEN'),
     (3, 2, 'Bob Checking',    400.0,    0.0, 'OPEN'),
     (4, 3, 'Carol Savings',   900.0,    0.0, 'FROZEN'),
     (5, 2, 'Shared Name',     100.0,    0.0, 'OPEN'),
     (6, 2, 'Shared Name',     100.0,    0.0, 'OPEN')`,
];


// Fails with the response body attached. A live test that fails on an
// unexpected status is nearly always debugged from the server's own message, so
// losing it costs a whole re-run.
export function expectOk<T>(res: {status: number; message?: string; result?: T},
                            what: string): T {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${what} failed with ${res.status}: ${res.message ?? ''}`);
  }
  return res.result as T;
}


// Runs `statements` in one read-write transaction and commits.
export async function commitAll(statements: spanner.Statement[]):
    Promise<void> {
  const client = dataClient();
  await client.withSession(async session => {
    const txn = expectOk(await client.beginReadWrite(session), 'beginTransaction');
    for (const stmt of statements) {
      const res = await client.executeSql(session, txn.id!, stmt);
      if (res.status < 200 || res.status >= 300) {
        await client.rollback(session, txn.id!);
        throw new Error(`"${stmt.sql}" failed: ${res.message}`);
      }
    }
    expectOk(await client.commit(session, txn.id!), 'commit');
  });
}


// Restores the seed state. Called before each test that writes, so no test
// depends on the order it ran in.
export async function reseed(): Promise<void> {
  await commitAll(SEED.map(sql => ({sql})));
}


// A committed read, outside any test transaction: what the database actually
// holds now. This is how a live test proves a rollback really discarded
// something -- reading inside the transaction would prove nothing.
export async function readCommitted(
    sql: string, params?: Record<string, any>,
    paramTypes?: spanner.ParamTypes): Promise<string[][]> {
  const client = dataClient();
  return await client.withSession(async session => {
    const txn =
        expectOk(await client.beginReadWrite(session), 'beginTransaction');
    const res =
        await client.executeSql(session, txn.id!, {sql, params, paramTypes});
    await client.rollback(session, txn.id!);
    return expectOk(res, `query "${sql}"`).rows ?? [];
  });
}


// The balances, keyed by account id, as the database currently holds them.
export async function balances(): Promise<Record<string, string>> {
  const rows = await readCommitted(
      'SELECT CAST(account_id AS STRING), CAST(balance AS STRING) FROM Account');
  return Object.fromEntries(rows.map(r => [r[0], r[1]]));
}
