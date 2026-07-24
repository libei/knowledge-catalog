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
  // Semantic-model (BigQuery) push options:
  semanticModel?: string;  // limit to a single model by name (default: all)
  dryRun?: boolean;    // compile + print the DDL without executing
  project?: string;    // override the BigQuery project for the graph + table refs
  dataset?: string;    // override the BigQuery dataset for the graph + table refs
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


export async function pull(): Promise<number> {
  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);

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


// Compiles the local semantic model YAML files to BigQuery property-graph DDL and
// (unless --dry-run/--validate-only) deploys them. Models are read from
// catalog/<entryGroupId>/.
async function pushSemanticModel(source: SemanticModelSource, options: PushOptions,
                                 ctx: context.ApiContext): Promise<number> {
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

  const client = new kcmd.bigquery.BigQueryClient(ctx);
  console.log(dryRun
    ? 'Compiling semantic model(s) (dry run)...'
    : 'Pushing semantic model(s) to BigQuery...');

  const deployResult = await kcmd.semantic.deployBigQuery(client, models, {
    project: options.project,
    dataset: options.dataset,
    dryRun,
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

  if (!deployResult.ok) {
    return 1;
  }
  if (dryRun) {
    console.log('\nDry run complete; no changes were applied.');
  }
  return 0;
}
