// Provisions the database the live Spanner suite runs against.
//
//   KCMD_LIVE=1 npx bun tests/live/setup.ts
//
// Safe to re-run: the database is created only if it is missing, the schema
// statements are IF NOT EXISTS, and the seed replaces the rows it owns. Run it
// once before `npm run test:live`; the tests themselves only write rows, never
// schema, so the suite stays fast and a failed run leaves nothing to repair.
//

import {
  adminClient,
  database,
  databaseName,
  expectOk,
  instance,
  project,
  reseed,
  SCHEMA,
} from './live';

import {Operation} from '../../src/libts/gcp/spanner';


// Database create and get are not on SpannerClient -- it exists to push DDL,
// and provisioning a database is not something the tool does. Calling the REST
// surface through the client's own request methods keeps auth, retry and
// logging identical to every other call the suite makes, which is worth more
// here than a tidier signature.
const admin = adminClient();
const databases = `projects/${project}/instances/${instance}/databases`;


async function awaitOperation(op: Operation, what: string): Promise<void> {
  if (!op.name) return;
  for (let i = 0; i < 120; i++) {
    const polled = expectOk(await admin.getOperation(op.name), `${what} poll`);
    if (polled.done) {
      if (polled.error) {
        throw new Error(`${what} failed: ${JSON.stringify(polled.error)}`);
      }
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`${what} did not finish in four minutes.`);
}


async function main(): Promise<void> {
  const existing = await admin._get<{name?: string}>(databaseName);
  if (existing.status === 404) {
    console.log(`Creating Spanner database ${database} ...`);
    const created = expectOk(
        await admin._post<Operation>(
            databases, {createStatement: `CREATE DATABASE \`${database}\``}),
        'databases.create');
    await awaitOperation(created, 'databases.create');
  } else {
    expectOk(existing, 'databases.get');
    console.log(`Spanner database ${database} already exists.`);
  }

  console.log('Applying the schema ...');
  const ddl = expectOk(
      await admin.updateDatabaseDdl(project, instance, database, SCHEMA),
      'updateDatabaseDdl');
  await awaitOperation(ddl, 'updateDatabaseDdl');

  console.log('Seeding ...');
  await reseed();

  console.log();
  console.log(`Ready: ${databaseName}`);
  console.log('Next: KCMD_LIVE=1 npm run test:live');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
