// Creates the ecommerce database the credit demo runs against.
//
// A NEW database, not one of the existing demo databases: the demo writes and
// rolls back real transactions, and it should not be able to disturb anything
// that was already there. Re-running this is safe -- the schema statements are
// IF NOT EXISTS and the seed replaces the rows it owns.
//
// Everything here goes through the Spanner REST surface on application-default
// credentials, so the demo needs no gcloud CLI beyond having logged in once.

import * as gcp from '../../src/libts/gcp/context';
import {Operation, SpannerClient} from '../../src/libts/gcp/spanner';

import {database, dataClient, instance, project} from './config';


// Money is NUMERIC rather than FLOAT64, because rule 3 is an equality between
// two sums of money and binary floating point does not answer that question
// reliably: 0.1 + 0.2 is not 0.3 in FLOAT64, and an order whose lines add up
// would be reported as violating the invariant.
//
// `Orders`, not `Order`: ORDER is a reserved word in GoogleSQL. The model calls
// the entity `Order` and binds it to this table, which is what a logical name
// is for.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS Customer (
     customer_id INT64 NOT NULL,
     name STRING(128),
     email STRING(256),
   ) PRIMARY KEY (customer_id)`,
  `CREATE TABLE IF NOT EXISTS Orders (
     order_id INT64 NOT NULL,
     customer_id INT64,
     total NUMERIC,
     status STRING(16),
   ) PRIMARY KEY (order_id)`,
  `CREATE TABLE IF NOT EXISTS LineItem (
     line_item_id STRING(64) NOT NULL,
     order_id INT64,
     type STRING(16),
     amount NUMERIC,
     memo STRING(MAX),
   ) PRIMARY KEY (line_item_id)`,
];

// Three orders, chosen so each rule has a case that trips it and a case that
// does not:
//
//   #12345  $147.85  Andy Brook  -- a $30 credit is within the order but over
//                                   the $25 ceiling: rule 2 alone escalates
//   #12346   $18.00  Andy Brook  -- a $30 credit exceeds the order as well:
//                                   rules 1 and 2 both escalate
//   #12347  $200.00  Dana Reyes  -- a $10 credit trips neither and commits
const SEED = [
  `DELETE FROM LineItem WHERE TRUE`,
  `DELETE FROM Orders WHERE TRUE`,
  `DELETE FROM Customer WHERE TRUE`,
  `INSERT INTO Customer (customer_id, name, email) VALUES
     (1, 'Andy Brook', 'andybrook@gmail.com'),
     (2, 'Dana Reyes', 'dana.reyes@example.com')`,
  `INSERT INTO Orders (order_id, customer_id, total, status) VALUES
     (12345, 1, NUMERIC '147.85', 'OPEN'),
     (12346, 1, NUMERIC  '18.00', 'OPEN'),
     (12347, 2, NUMERIC '200.00', 'OPEN')`,
  `INSERT INTO LineItem (line_item_id, order_id, type, amount, memo) VALUES
     ('li-12345-1', 12345, 'item',     NUMERIC  '89.99', 'Cast iron skillet'),
     ('li-12345-2', 12345, 'item',     NUMERIC  '34.50', 'Enamel saucepan'),
     ('li-12345-3', 12345, 'shipping', NUMERIC  '12.00', 'Labor Day sale shipping'),
     ('li-12345-4', 12345, 'tax',      NUMERIC  '11.36', 'Sales tax'),
     ('li-12346-1', 12346, 'item',     NUMERIC  '18.00', 'Silicone spatula set'),
     ('li-12347-1', 12347, 'item',     NUMERIC '200.00', 'Stand mixer')`,
];


const admin = new SpannerClient(gcp.ApiContext.default());


// Both createDatabase and updateDatabaseDdl return a long-running operation.
// Nothing that follows is meaningful until it finishes, so wait rather than
// racing the next step against it.
async function finish(
    label: string,
    started: {status: number; message?: string; result?: Operation}):
    Promise<void> {
  if (started.status < 200 || started.status >= 300) {
    throw new Error(`${label} failed: ${started.message ?? started.status}`);
  }
  let op = started.result;
  const name = op?.name;
  for (let polls = 0; !op?.done && name && polls < 120; polls++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const res = await admin.getOperation(name);
    if (res.status !== 200) {
      throw new Error(`${label} failed while polling: ${res.message}`);
    }
    op = res.result;
  }
  if (!op?.done) throw new Error(`${label} did not complete`);
  if (op.error) {
    throw new Error(`${label} failed: ${op.error.message ?? op.error.code}`);
  }
}


const existing = await admin.getDatabase(project, instance, database);
if (existing.status === 404) {
  console.log(`Creating Spanner database ${database} ...`);
  await finish(
      'createDatabase',
      await admin.createDatabase(project, instance, database));
} else if (existing.status !== 200) {
  throw new Error(`Cannot reach ${database}: ${existing.message}`);
} else {
  console.log(`Spanner database ${database} already exists.`);
}

console.log('Applying the schema ...');
await finish(
    'updateDatabaseDdl',
    await admin.updateDatabaseDdl(project, instance, database, SCHEMA));

console.log('Seeding orders ...');
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
console.log('Next: bun credit.ts --list');
