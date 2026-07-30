// CLI command handlers
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as glob from 'glob';

import * as kcmd from '../libts';
import * as dataplex from '../libts/gcp/dataplex';
import * as context from '../libts/gcp/context';
import { SemanticModelSource } from '../libts/sources/semantic-model';


export interface InitOptions {
  entryGroup?: string;
  bigqueryDataset?: string | string[];
  kb?: string;
  semanticModel?: string;
  pull?: boolean;
}


export interface PushOptions {
  force?: boolean;
  validateOnly?: boolean;
  // Semantic-model push options:
  semanticModel?: string;  // limit to a single model by name (default: all)
  target?: string;     // deploy destination: bq | kc | both (default: bq)
  dryRun?: boolean;    // compile + report without executing
  project?: string;    // shared: override the destination project (bq + kc)
  dataset?: string;    // BigQuery only: override the dataset for the graph + table refs
  location?: string;   // KC only: override the Knowledge Catalog location
  entryGroup?: string; // KC only: override the Knowledge Catalog entry group
  transpile?: boolean; // rewrite vendor-dialect expressions to GoogleSQL first
}


export interface PullOptions {
  // Semantic-model (Knowledge Catalog) pull options:
  semanticModel?: string;  // limit to a single model by name (default: all)
  dryRun?: boolean;    // read + print the serialized YAML without writing files
  project?: string;    // override the Knowledge Catalog project
  location?: string;   // override the Knowledge Catalog location
  entryGroup?: string; // override the Knowledge Catalog entry group
}


// A concrete, single deploy destination. `--target both` expands to both, in
// BigQuery-first order.
export type DeployTarget = 'bigquery' | 'kc';

// Parses the `--target` flag into the ordered list of destinations to deploy to.
// Accepts `bq`/`bigquery`, `kc`, and `both`; defaults to BigQuery when unset. The
// `both` order (BigQuery first) encodes the fail-fast rule: if BigQuery fails, KC
// is never attempted.
export function resolveTargets(raw?: string): DeployTarget[] {
  switch (raw) {
    case undefined:
    case 'bq':
    case 'bigquery':
      return ['bigquery'];
    case 'kc':
      return ['kc'];
    case 'both':
      return ['bigquery', 'kc'];
    default:
      throw new Error(`--target must be one of: bq, kc, both (got '${raw}')`);
  }
}


export interface KcCoords {
  project: string;
  location: string;
  entryGroup: string;
}

// The subset of push/pull flags that override a Knowledge Catalog coordinate.
export interface KcCoordOverrides {
  project?: string;
  location?: string;
  entryGroup?: string;
}

// Resolves the Knowledge Catalog destination for a push/pull: each segment is the
// command-time flag if given, else the corresponding part of the catalog.yaml
// scope triple (the default). The scope is a default, not a lock.
export function resolveKcCoords(source: SemanticModelSource, o: KcCoordOverrides): KcCoords {
  return {
    project: o.project ?? source.projectId,
    location: o.location ?? source.locationId,
    entryGroup: o.entryGroup ?? source.entryGroupId,
  };
}


// Returns the messages for flags that don't apply to any selected target, so the
// user learns a flag had no effect. `--project` is shared by both targets, so it
// is never warned; `--dataset`/`--transpile` are BigQuery-only and `--location`/
// `--entry-group` are Knowledge Catalog-only.
export function unusedFlagWarnings(targets: DeployTarget[], o: PushOptions): string[] {
  const set = new Set(targets);
  const warnings: string[] = [];
  if (!set.has('bigquery')) {
    if (o.dataset !== undefined) warnings.push('--dataset is ignored for the kc target');
    if (o.transpile) warnings.push('--transpile is ignored for the kc target');
  }
  if (!set.has('kc')) {
    if (o.location !== undefined) warnings.push('--location is ignored for the bigquery target');
    if (o.entryGroup !== undefined) warnings.push('--entry-group is ignored for the bigquery target');
  }
  return warnings;
}


export async function init(options: InitOptions): Promise<number> {
  const ctx = context.ApiContext.default();

  let manifest: kcmd.CatalogManifest;
  if (options.entryGroup) {
    manifest = await kcmd.CatalogManifest.initWithEntryGroup(options.entryGroup, ctx);
  }
  else if (options.kb) {
    manifest = await kcmd.CatalogManifest.initWithKnowledgeBase(options.kb, ctx);
  }
  else if (options.bigqueryDataset) {
    let datasets = '';
    if (Array.isArray(options.bigqueryDataset)) {
      datasets = options.bigqueryDataset.join(',');
    }
    else {
      datasets = options.bigqueryDataset!;
    }
    manifest = await kcmd.CatalogManifest.initWithBigQuery(datasets, ctx);
  }
  else if (options.semanticModel) {
    manifest = await kcmd.CatalogManifest.initWithSemanticModel(options.semanticModel, ctx);
  }
  else {
    console.error('Error: Must provide either --entry-group or --bigquery-dataset or --kb or --semantic-model');
    return 1;
  }

  manifest.save('catalog.yaml');
  console.log(fs.readFileSync('catalog.yaml', 'utf8'));

  // For a semantic-model workspace, create the (empty) entry-group directory that
  // will hold the model YAML files.
  if (manifest.source instanceof SemanticModelSource) {
    fs.mkdirSync(path.join('catalog', manifest.source.entryGroupId), { recursive: true });
  }

  if (options.pull) {
    return await pull();
  }

  return 0;
}


export async function pull(options: PullOptions = {}): Promise<number> {
  const ctx = context.ApiContext.default();

  const manifest = await kcmd.CatalogManifest.load('catalog.yaml', ctx);
  if (manifest.source instanceof SemanticModelSource) {
    return await pullSemanticModel(manifest.source, options, ctx);
  }

  // Reuse the manifest already loaded above rather than re-loading catalog.yaml.
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx, manifest);

  const catalog = new dataplex.CatalogClient(ctx);
  const sync = new kcmd.CatalogSync(catalog, snapshot);

  console.log('Pulling catalog entries...');
  const result = await sync.pull();

  if (result.success) {
    console.log('Successfully updated local snapshot.');
    return 0;
  }
  else {
    console.error('Error pulling catalog entries:', result.details);
    return 1;
  }
}


// Reads the semantic model(s) back from Knowledge Catalog and writes each as a
// YAML file in catalog/<entryGroupId>/ (the workspace layout `push` reads from).
// The destination is the catalog.yaml scope triple with any
// `--project`/`--location`/`--entry-group` overrides applied.
//
// Overwrite policy mirrors the core `pull`: each model file is regenerated from
// the service (last-write-wins). Locally-authored formatting the loader does not
// carry into the IR (per-dialect variants, ai_context structure, comments) is not
// reproduced; `--dry-run` prints the YAML so the overwrite can be previewed
// before it is applied.
async function pullSemanticModel(source: SemanticModelSource, options: PullOptions,
                                 ctx: context.ApiContext): Promise<number> {
  const coords = resolveKcCoords(source, options);
  const destination = `${coords.project}.${coords.location}.${coords.entryGroup}`;
  const dir = path.join('catalog', source.entryGroupId);
  const dryRun = !!options.dryRun;

  const client = new dataplex.CatalogClient(ctx);
  console.log(dryRun
    ? `Reading semantic model(s) from Knowledge Catalog (dry run) [${destination}]...`
    : `Pulling semantic model(s) from Knowledge Catalog [${destination}]...`);

  const { models, warnings } = await kcmd.semantic.pullKnowledgeCatalog(client, {
    project: coords.project,
    location: coords.location,
    entryGroup: coords.entryGroup,
    model: options.semanticModel,
  });
  for (const w of warnings) {
    console.warn(`warning: ${w}`);
  }

  if (!models.length) {
    console.error(`Error: no semantic models found in ${destination}.`);
    return 1;
  }

  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const model of models) {
    const file = path.join(dir, `${modelFileName(model.name)}.yaml`);
    const yamlText = kcmd.semantic.serializeModel(model);
    if (dryRun) {
      console.log(`\n# ${file}\n${yamlText}`);
    }
    else {
      fs.writeFileSync(file, yamlText);
      console.log(`Wrote ${file}`);
    }
  }

  if (dryRun) {
    console.log('\nDry run complete; no files were written.');
  }
  return 0;
}


// Maps a model name to a safe file stem, matching the emitter's entry-id slug so
// a pulled workspace mirrors the published resource names.
function modelFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}


export async function push(options: PushOptions): Promise<number> {
  const ctx = context.ApiContext.default();

  const manifest = await kcmd.CatalogManifest.load('catalog.yaml', ctx);
  if (manifest.source instanceof SemanticModelSource) {
    return await pushSemanticModel(manifest.source, options, ctx);
  }

  // Reuse the manifest already loaded above rather than re-loading catalog.yaml.
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx, manifest);

  const catalog = new dataplex.CatalogClient(ctx);
  const sync = new kcmd.CatalogSync(catalog, snapshot);

  console.log('Pushing catalog entries...');
  const result = await sync.push(options);

  if (result.success) {
    console.log('Successfully pushed catalog entries.');
    return 0;
  }
  else {
    console.error('Error pushing catalog entries:', result.details);
    return 1;
  }
}


// Loads the local semantic model YAML files and deploys each model to the
// selected target(s) (`--target bq|kc|both`, default bq). Models are read from
// catalog/<entryGroupId>/. Targets run in BigQuery-first order; a target failure
// stops the push before the next target (so a BigQuery failure skips KC).
async function pushSemanticModel(source: SemanticModelSource, options: PushOptions,
                                 ctx: context.ApiContext): Promise<number> {
  // Validate the target selection first, so a bad `--target` fails fast.
  const targets = resolveTargets(options.target);

  const dir = path.join('catalog', source.entryGroupId);
  if (!fs.existsSync(dir)) {
    console.error(`Error: semantic model directory '${dir}' does not exist. Run 'kcmd init --semantic-model' first.`);
    return 1;
  }

  const files = glob.globSync('*.yaml', { cwd: dir, absolute: true, nodir: true }).sort();
  if (!files.length) {
    console.error(`Error: no semantic model YAML files found in '${dir}'.`);
    return 1;
  }

  // --validate-only ("validate without applying") and --dry-run are equivalent
  // here: both compile and report but never execute the DDL.
  const dryRun = !!(options.dryRun || options.validateOnly);

  const loadOpts = { defaultProject: options.project, defaultDataset: options.dataset };
  let models: kcmd.semantic.SemanticModel[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const { models: fileModels, warnings } = kcmd.semantic.loadModels(text, loadOpts);
    for (const w of warnings) {
      // When transpiling, the loader's per-expression "using ... verbatim (not
      // transpiled to ...)" notes are superseded by the transpile pass's own
      // outcome lines; printing both is contradictory, so drop them here.
      if (options.transpile && w.includes('(not transpiled to')) continue;
      console.warn(`warning [${path.basename(file)}]: ${w}`);
    }
    for (const m of fileModels) {
      if (seen.has(m.name)) {
        console.error(`Error: duplicate semantic model name '${m.name}' found in '${dir}'; model names must be unique across files.`);
        return 1;
      }
      seen.add(m.name);
    }
    models.push(...fileModels);
  }

  if (options.semanticModel) {
    models = models.filter(m => m.name === options.semanticModel);
    if (!models.length) {
      console.error(`Error: no semantic model named '${options.semanticModel}' found in '${dir}'.`);
      return 1;
    }
  }
  if (!models.length) {
    console.error(`Error: no semantic models found in '${dir}'.`);
    return 1;
  }

  // Warn about flags that don't apply to the selected target(s).
  for (const w of unusedFlagWarnings(targets, options)) {
    console.warn(`warning: ${w}`);
  }

  for (const target of targets) {
    const ok = target === 'bigquery'
      ? await pushToBigQuery(models, options, ctx, dryRun)
      : await pushToKnowledgeCatalog(source, models, options, dryRun);
    // Fail-fast: because targets run BigQuery-first, a BigQuery failure stops the
    // push before Knowledge Catalog is attempted.
    if (!ok) {
      return 1;
    }
  }

  if (dryRun) {
    console.log('\nDry run complete; no changes were applied.');
  }
  return 0;
}


// Deploys the models to BigQuery and reports per-model results. Returns whether
// the whole target succeeded.
async function pushToBigQuery(models: kcmd.semantic.SemanticModel[], options: PushOptions,
                              ctx: context.ApiContext, dryRun: boolean): Promise<boolean> {
  const client = new kcmd.bigquery.BigQueryClient(ctx);
  console.log(dryRun
    ? 'Compiling semantic model(s) for BigQuery (dry run)...'
    : 'Pushing semantic model(s) to BigQuery...');

  const deployResult = await kcmd.semantic.deployBigQuery(client, models, {
    project: options.project,
    dataset: options.dataset,
    dryRun,
    transpile: options.transpile,
  });

  for (const r of deployResult.results) {
    for (const w of r.warnings) {
      console.warn(`warning [${r.model}]: ${w}`);
    }
    if (dryRun) {
      console.log(`\n-- model: ${r.model}\n${r.ddl}`);
    }
    else if (r.executed) {
      console.log(`Deployed property graph for model '${r.model}'.`);
    }
    else if (r.error) {
      console.error(`Failed to deploy model '${r.model}': ${r.error}`);
    }
  }

  return deployResult.ok;
}


// Deploys the models to Knowledge Catalog and reports per-model results. Returns
// whether the whole target succeeded. The destination is the catalog.yaml scope
// triple with any `--project`/`--location`/`--entry-group` overrides applied.
async function pushToKnowledgeCatalog(source: SemanticModelSource,
                                      models: kcmd.semantic.SemanticModel[],
                                      options: PushOptions, dryRun: boolean): Promise<boolean> {
  const coords = resolveKcCoords(source, options);
  console.log(dryRun
    ? 'Compiling semantic model(s) for Knowledge Catalog (dry run)...'
    : 'Pushing semantic model(s) to Knowledge Catalog...');

  const deployResult = await kcmd.semantic.deployKnowledgeCatalog(models, { ...coords, dryRun });

  for (const r of deployResult.results) {
    for (const w of r.warnings) {
      console.warn(`warning [${r.model}]: ${w}`);
    }
    if (r.error) {
      console.error(`Failed to deploy model '${r.model}' to Knowledge Catalog: ${r.error}`);
    }
  }

  return deployResult.ok;
}
