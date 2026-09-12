// Loads the demo model under its Spanner binding profile, and opens the store
// the profile points at.
//
// The database is read out of the profile's deployment target rather than
// configured here. That is what the profile is for: one place says where this
// model lives, and both the agent's read tools and its write tools go there.
// Pointing the demo at another store is selecting another profile, not passing
// a flag.

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'yaml';

import * as gcp from '../../src/libts/gcp/context';
import * as spanner from '../../src/libts/gcp/spanner';
import {googleDeploymentTargets} from '../../src/libts/semantic/deployment_target';
import {SemanticModel} from '../../src/libts/semantic/ir';
import {fromDocument} from '../../src/libts/semantic/loader';
import {mergeProfile} from '../../src/libts/semantic/resolve_profiles';

const HERE = import.meta.dir;

// The model lives where `kcmd` looks for one: a catalog workspace, under the
// entry group catalog.yaml scopes to. So `kcmd action list` and the tools
// derived below are reading the same two files, not two copies that can drift.
export const modelPath = process.env.DEMO_MODEL_PATH ??
    path.join(HERE, 'catalog/EntryGroups/commerce_demo/commerce.yaml');
export const profileName = process.env.DEMO_PROFILE ?? 'spanner';


/**
 * The logical model with the named profile merged onto it -- the same merge
 * `kcmd --profile` performs, so what runs here is what the CLI would run.
 */
export function loadModel(): SemanticModel {
  const profilePath = path.join(
      path.dirname(modelPath),
      `${path.basename(modelPath, '.yaml')}.profiles`, `${profileName}.yaml`);

  const logical = yaml.parse(fs.readFileSync(modelPath, 'utf8'));
  const profile = yaml.parse(fs.readFileSync(profilePath, 'utf8'));
  const merged = mergeProfile(logical, profile, profileName);
  if (merged.error) {
    throw new Error(`profile '${profileName}': ${merged.error}`);
  }
  for (const warning of merged.warnings) console.error(`Warning: ${warning}`);

  const loaded = fromDocument(merged.doc);
  for (const warning of loaded.warnings) console.error(`Warning: ${warning}`);
  if (!loaded.models.length) throw new Error(`${modelPath} declares no model`);
  return loaded.models[0];
}


/** The Spanner database this model's deployment target names. */
export function openStore(model: SemanticModel):
    {client: spanner.SpannerDataClient; database: string} {
  const [target] = googleDeploymentTargets(model).spanner;
  if (!target) {
    throw new Error(
        `model '${model.name}' under profile '${profileName}' declares no ` +
        `Spanner deployment target, so there is no store to run against`);
  }
  return {
    client: new spanner.SpannerDataClient(
        gcp.ApiContext.default(), target.project, target.instance,
        target.database),
    database: `${target.project}/${target.instance}/${target.database}`,
  };
}
