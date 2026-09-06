// Drops the database the demo created. Nothing else in the instance is touched.
//

import * as cp from 'child_process';

import {database, instance, project} from './config';

cp.execSync(
    `gcloud spanner databases delete ${database} --instance=${instance} ` +
        `--project=${project} --quiet`,
    {stdio: 'inherit'});
console.log(`Deleted Spanner database ${database}.`);
