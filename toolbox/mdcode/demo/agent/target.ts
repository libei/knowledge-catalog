// Prints where this model is deployed: project, instance and database,
// separated by spaces.
//
// setup.sh and cleanup.sh read it from here rather than from their own
// environment variables. Two sources would let a reader seed one database and
// have the demo talk to another -- and it is the profile that decides which one
// the demo talks to, so the profile decides for the scripts too. To run this
// somewhere else, change `deployment_target` in commerce.profiles/spanner.yaml
// and nothing else.

import {googleDeploymentTargets} from '../../src/libts/semantic/deployment_target';

import {loadModel, profileName} from './model';

const [target] = googleDeploymentTargets(loadModel()).spanner;
if (!target) {
  console.error(
      `profile '${profileName}' names no Spanner deployment target, so ` +
      `there is no database to create`);
  process.exit(1);
}
console.log(`${target.project} ${target.instance} ${target.database}`);
