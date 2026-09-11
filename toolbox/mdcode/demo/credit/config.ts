// Where the demo runs, and how its pieces find each other.
//
// Everything is overridable by environment variable so the demo can be pointed
// at a project the reader owns; the defaults are the instance it was developed
// against.

import * as path from 'node:path';

import * as gcp from '../../src/libts/gcp/context';
import * as spanner from '../../src/libts/gcp/spanner';

export const project = process.env.DEMO_CLOUD_PROJECT ?? 'sqlgen-testing';
export const instance =
    process.env.DEMO_SPANNER_INSTANCE ?? 'graph-unified-solution-demo';
export const database =
    process.env.DEMO_SPANNER_DATABASE ?? 'semantic_credit_demo';

export const modelPath = path.join(import.meta.dir, 'ecommerce.yaml');


export function dataClient(): spanner.SpannerDataClient {
  return new spanner.SpannerDataClient(
      gcp.ApiContext.default(), project, instance, database);
}
