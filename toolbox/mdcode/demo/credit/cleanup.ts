// Drops the database the credit demo created. Nothing else in the instance is
// touched, because the demo never wrote anywhere else.

import * as gcp from '../../src/libts/gcp/context';
import {SpannerClient} from '../../src/libts/gcp/spanner';

import {database, instance, project} from './config';

const admin = new SpannerClient(gcp.ApiContext.default());

console.log(`Dropping Spanner database ${database} ...`);
const res = await admin.dropDatabase(project, instance, database);
if (res.status === 404) {
  console.log('It was not there.');
} else if (res.status < 200 || res.status >= 300) {
  throw new Error(`Drop failed: ${res.message ?? res.status}`);
} else {
  console.log('Done.');
}
