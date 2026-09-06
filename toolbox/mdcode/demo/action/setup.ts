// Creates the payments database the action demo runs against.
//
// A NEW database, not one of the existing demo databases: the demo writes and
// rolls back real transactions, and it should not be able to disturb anything
// that was already there. Re-running this is safe -- the schema statements are
// IF NOT EXISTS and the seed replaces the rows it owns.
//

import * as cp from 'child_process';

import {database, dataClient, instance, project} from './config';


// Tables plus the property graph over them. The graph makes the same model
// queryable with GQL after the runtime has written through it (see the
// runbook's last step), which is the point of putting an action and a graph on
// one model.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS Person (
  person_id INT64 NOT NULL,
  name STRING(128),
  city STRING(128),
) PRIMARY KEY (person_id);

CREATE TABLE IF NOT EXISTS Account (
  account_id INT64 NOT NULL,
  owner_id INT64,
  name STRING(128),
  balance FLOAT64,
  minimum_balance FLOAT64,
  status STRING(16),
) PRIMARY KEY (account_id);

CREATE TABLE IF NOT EXISTS Transfer (
  transfer_id INT64 NOT NULL,
  source_account_id INT64,
  target_account_id INT64,
  amount FLOAT64,
) PRIMARY KEY (transfer_id);

CREATE OR REPLACE PROPERTY GRAPH payments
  NODE TABLES (
    Account KEY (account_id) LABEL Account
  )
  EDGE TABLES (
    Transfer
      KEY (transfer_id)
      SOURCE KEY (source_account_id) REFERENCES Account (account_id)
      DESTINATION KEY (target_account_id) REFERENCES Account (account_id)
      LABEL Transfers
  );
`;

// Four accounts across three people, chosen so each constraint has a case that
// trips it and a case that does not:
//
//   Alice Checking  2500, floor    100  -- a small transfer out is fine, a big
//                                          one overdraws it
//   Alice Savings  18000, floor   5000  -- has money, but not 14000 of headroom
//   Bob Checking     400, floor      0  -- the ordinary destination
//   Carol Savings    900, FROZEN       -- cannot be touched at all
const SEED = [
  `DELETE FROM Transfer WHERE TRUE`,
  `DELETE FROM Account WHERE TRUE`,
  `DELETE FROM Person WHERE TRUE`,
  `INSERT INTO Person (person_id, name, city) VALUES
     (1, 'Alice', 'Seattle'), (2, 'Bob', 'Austin'), (3, 'Carol', 'Denver')`,
  `INSERT INTO Account
     (account_id, owner_id, name, balance, minimum_balance, status) VALUES
     (1, 1, 'Alice Checking', 2500.0,  100.0, 'OPEN'),
     (2, 1, 'Alice Savings', 18000.0, 5000.0, 'OPEN'),
     (3, 2, 'Bob Checking',    400.0,    0.0, 'OPEN'),
     (4, 3, 'Carol Savings',   900.0,    0.0, 'FROZEN')`,
];


function databaseExists(): boolean {
  const listed = cp.execSync(
      `gcloud spanner databases list --instance=${instance} ` +
          `--project=${project} --format='value(name)'`,
      {encoding: 'utf8'});
  // gcloud prints the bare database id here, but has printed the full resource
  // path in other versions, so accept either rather than silently deciding the
  // database is missing and failing on a create that cannot succeed.
  return listed.split('\n').some(line => {
    const name = line.trim();
    return name === database || name.endsWith(`/${database}`);
  });
}


if (!databaseExists()) {
  console.log(`Creating Spanner database ${database} ...`);
  cp.execSync(
      `gcloud spanner databases create ${database} --instance=${instance} ` +
          `--project=${project} --database-dialect=GOOGLE_STANDARD_SQL`,
      {stdio: 'inherit'});
} else {
  console.log(`Spanner database ${database} already exists.`);
}

console.log('Applying the schema and the property graph ...');
cp.execSync(
    `gcloud spanner databases ddl update ${database} --instance=${instance} ` +
        `--project=${project} --ddl-file=/dev/stdin`,
    {input: SCHEMA, stdio: ['pipe', 'inherit', 'inherit']});

console.log('Seeding accounts ...');
const client = dataClient();
await client.withSession(async sessionName => {
  const begun = await client.beginReadWrite(sessionName);
  const transactionId = begun.result?.id;
  if (!transactionId) {
    throw new Error(`Could not begin a transaction: ${begun.message}`);
  }
  for (const sql of SEED) {
    const res = await client.executeSql(sessionName, transactionId, {sql});
    if (res.status < 200 || res.status >= 300) {
      await client.rollback(sessionName, transactionId);
      throw new Error(`Seed failed on "${sql}": ${res.message}`);
    }
  }
  const committed = await client.commit(sessionName, transactionId);
  if (committed.status < 200 || committed.status >= 300) {
    throw new Error(`Seed commit failed: ${committed.message}`);
  }
});

console.log();
console.log(`Ready: projects/${project}/instances/${instance}/databases/${
    database}`);
console.log('Next: bun transfer.ts --list');
