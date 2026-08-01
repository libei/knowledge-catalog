// Deploys Semantic Model IR to Knowledge Catalog (Dataplex).
//
// This is the destination-specific orchestration layer for the Knowledge Catalog
// target, the counterpart to `deploy.ts` (BigQuery). It maps the pure IR to
// `semantic-model`/`semantic-entity`/`semantic-measure` Entries carrying
// `semantic-*` Aspects (via the pure emitter in catalog.ts) and writes them
// through the Dataplex catalog client — mirroring the shared-front-end /
// per-destination-emitter design used for BigQuery.
//
// Types: the `semantic-*` entry/aspect types are not yet available as built-in
// system types in `dataplex-types/global`, so push provisions and references
// CUSTOM types in the destination project (typeLocation defaults to `global`).
// When the built-in types land, callers point typeProject/typeLocation at them
// and the emitter output is unchanged. A live run against real Dataplex confirmed
// the publish sequence this implements:
//   * The `semantic-*` aspect/entry types are provisioned first; aspect types
//     validate a CLOSED schema, so their metadataTemplate (aspectTypeTemplates in
//     catalog.ts) must match the emitted aspect-data field names exactly. Type
//     creates are LROs; entries.create is synchronous.
//   * A freshly created entry type can lag a few seconds before entries.create
//     sees it, so we settle briefly after creating new types and retry the
//     "may not exist" propagation window per entry.
//   * Entries are created in array order (model anchor before its children).
//   * Relationship edges need the `semantic-relationship` entry link type, which
//     is not user-creatable and not yet provisioned — no predefined link type is
//     both directed and valid over `semantic-entity` endpoints — so those edges
//     are deferred with a warning. Nothing is lost: each relationship's join keys
//     and edge properties travel in the `semantic-model` aspect regardless.

import type { CatalogClient, Entry } from '../gcp/dataplex';
import { SemanticModel } from './ir';
import { DeployResult, ModelDeployResult } from './deploy';
import {
  generateCatalogResources, modelsFromCatalogResources,
  aspectTypeTemplates, SEMANTIC_TYPE_IDS, KcResources,
} from './catalog';

export interface KcDeployOptions {
  // The resolved Knowledge Catalog destination (flag overrides applied over the
  // catalog.yaml scope defaults).
  project: string;
  location: string;
  entryGroup: string;
  // Where the custom `semantic-*` entry/aspect types are created and referenced.
  // Default: the destination project, location `global`. Point these at
  // `dataplex-types`/`global` once the built-in system types are available.
  typeProject?: string;
  typeLocation?: string;
  dryRun?: boolean;   // compile + report only; never writes
  // Milliseconds to wait after provisioning newly-created types before creating
  // entries (a new entry type can lag before entries.create sees it). Skipped
  // when nothing new was created; tests set 0 to stay fast.
  settleMs?: number;
}

const DEFAULT_TYPE_LOCATION = 'global';
const DEFAULT_SETTLE_MS = 4000;
// Entry-create propagation retry: a just-created entry type can briefly 404.
const ENTRY_CREATE_TRIES = 5;
const ENTRY_CREATE_RETRY_MS = 3000;

// Publishes each model to Knowledge Catalog and reports per-model results. The
// shared setup (entry group + custom types) is provisioned once; then each
// model's entries are created in anchor-first order. Relationship edges are
// deferred with a warning (see the file header). On `dryRun` nothing is written:
// each model reports the resources it would create. A provisioning failure fails
// the whole push (every model errors) since no entry could validate without its
// aspect type.
export async function deployKnowledgeCatalog(
    client: CatalogClient,
    models: SemanticModel[],
    opts: KcDeployOptions): Promise<DeployResult> {
  const typeProject = opts.typeProject ?? opts.project;
  const typeLocation = opts.typeLocation ?? DEFAULT_TYPE_LOCATION;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;

  // Emit every model up front (pure): dry-run and warnings need no network, and a
  // generation warning surfaces even if a later write fails.
  const emitted = models.map(model => ({
    model,
    resources: generateCatalogResources(model, {
      project: opts.project, location: opts.location, entryGroup: opts.entryGroup,
      systemTypeProject: typeProject, systemTypeLocation: typeLocation,
    }),
  }));

  if (opts.dryRun) {
    return {
      ok: true,
      results: emitted.map(({ model, resources }) => ({
        model: model.name,
        ddl: planSummary(resources, opts, typeProject, typeLocation),
        warnings: [...resources.warnings, ...linkDeferralWarnings(resources)],
        executed: false,
      })),
    };
  }

  // Provision shared setup once. A failure here dooms every model, so report it
  // on each result and stop before touching entries.
  const setup = await provision(client, opts, typeProject, typeLocation);
  if (setup.error) {
    return {
      ok: false,
      results: emitted.map(({ model, resources }) => ({
        model: model.name, ddl: '', warnings: resources.warnings, executed: false,
        error: setup.error,
      })),
    };
  }
  // A newly created entry type can lag before entries.create sees it.
  if (setup.created && settleMs > 0) {
    await sleep(settleMs);
  }

  const results: ModelDeployResult[] = [];
  let ok = true;
  for (const { model, resources } of emitted) {
    const warnings = [...resources.warnings, ...linkDeferralWarnings(resources)];
    const error = await createEntries(client, opts, resources.entries);
    results.push({ model: model.name, ddl: '', warnings, executed: !error, error });
    if (error) ok = false;
  }

  return { ok, results };
}


interface ProvisionResult {
  created: boolean;   // whether any type/group was newly created (vs already existed)
  error?: string;     // first fatal provisioning error, if any
}

// Ensures the destination entry group and the custom `semantic-*` aspect/entry
// types exist. Idempotent: an "already exists" is success. Aspect types carry the
// closed-schema metadataTemplate the emitted aspect data validates against.
async function provision(client: CatalogClient, opts: KcDeployOptions,
                         typeProject: string, typeLocation: string): Promise<ProvisionResult> {
  const templates = aspectTypeTemplates();

  // Every create here is independent (entry types carry no required aspects), so
  // run them concurrently and fold the results rather than serializing 7 LROs.
  const creates: Array<{ label: string; run: () => Promise<{ status: number; message?: string }> }> = [
    { label: `entry group '${opts.entryGroup}'`,
      run: () => client.createEntryGroup(opts.project, opts.location, opts.entryGroup, {} as any) },
    ...SEMANTIC_TYPE_IDS.map(id => ({
      label: `aspect type '${id}'`,
      run: () => client.createAspectType(typeProject, typeLocation, id, { metadataTemplate: templates[id] }),
    })),
    ...SEMANTIC_TYPE_IDS.map(id => ({
      label: `entry type '${id}'`,
      run: () => client.createEntryType(typeProject, typeLocation, id, {}),
    })),
  ];

  const outcomes = await Promise.all(creates.map(async c => ({ label: c.label, res: await c.run() })));

  let created = false;
  let error: string | undefined;
  for (const { label, res } of outcomes) {
    if (isOk(res)) created = true;
    else if (!isExists(res) && !error) error = `${label}: ${errText(res)}`;
  }
  return { created, error };
}

// Creates a model's entries. The anchor (entries[0]) is the parent of every
// child, so it is written first; the remaining entries are independent and are
// written concurrently. An entry that already exists is updated in place
// (idempotent re-push). Returns the first error message, or undefined on success.
async function createEntries(client: CatalogClient, opts: KcDeployOptions,
                             entries: Entry[]): Promise<string | undefined> {
  if (!entries.length) return undefined;
  const [anchor, ...children] = entries;
  const anchorErr = await writeEntry(client, opts, anchor);
  if (anchorErr) return anchorErr;
  const childErrs = await Promise.all(children.map(e => writeEntry(client, opts, e)));
  return childErrs.find(e => e !== undefined);
}

// Writes one entry: create, retrying the type-propagation window, then fall back
// to update-in-place if it already exists. Returns an error message or undefined.
async function writeEntry(client: CatalogClient, opts: KcDeployOptions,
                          entry: Entry): Promise<string | undefined> {
  const entryId = idOf(entry.name);
  let res = await createEntryWithRetry(client, opts, entryId, entry);
  if (isExists(res)) {
    // Idempotent re-push: refresh the existing entry's source + aspects.
    res = await client.updateEntry(entry, ['entry_source', 'aspects'],
                                   Object.keys(entry.aspects ?? {}));
  }
  if (!isOk(res)) return `entry '${entryId}': ${errText(res)}`;
  return undefined;
}

// entries.create can briefly 404 on a just-created entry type; retry that window.
async function createEntryWithRetry(client: CatalogClient, opts: KcDeployOptions,
                                    entryId: string, entry: Entry) {
  let res = await client.createEntry(opts.project, opts.location, opts.entryGroup, entryId, entry);
  for (let attempt = 1; attempt < ENTRY_CREATE_TRIES; attempt++) {
    if (isOk(res) || isExists(res) || !isPropagating(res)) break;
    await sleep(ENTRY_CREATE_RETRY_MS);
    res = await client.createEntry(opts.project, opts.location, opts.entryGroup, entryId, entry);
  }
  return res;
}

// A per-model warning for relationship edges that cannot be published yet (the
// `semantic-relationship` entry link type is not user-creatable). The edges'
// structure is preserved in the semantic-model aspect regardless.
function linkDeferralWarnings(resources: KcResources): string[] {
  const n = resources.entryLinks.length;
  if (!n) return [];
  return [
    `${n} relationship edge${n === 1 ? '' : 's'} not published: the ` +
    `'semantic-relationship' entry link type is not yet available; ` +
    `join keys are preserved in the semantic-model aspect.`,
  ];
}

// A human-readable summary of what a (dry-run) push would create.
function planSummary(resources: KcResources, opts: KcDeployOptions,
                     typeProject: string, typeLocation: string): string {
  const dest = `${opts.project}.${opts.location}.${opts.entryGroup}`;
  const types = `${typeProject}.${typeLocation}`;
  const lines = [
    `Knowledge Catalog plan (destination ${dest}, custom types in ${types}):`,
    `  ${resources.entries.length} entr${resources.entries.length === 1 ? 'y' : 'ies'}:`,
    ...resources.entries.map(e => `    - ${idOf(e.name)} (${idOf(e.entryType)})`),
  ];
  if (resources.entryLinks.length) {
    lines.push(`  ${resources.entryLinks.length} relationship edge(s) deferred (see warnings)`);
  }
  return lines.join('\n');
}


// The id segment of a full entry/entryLink resource name (after the last '/').
function idOf(name: string): string {
  return name.split('/').pop() ?? name;
}

function isOk(res: { status: number }): boolean {
  return res.status === 200;
}

// A create that failed because the resource already exists — treated as success
// for idempotent provisioning and re-push.
function isExists(res: { status: number; message?: string }): boolean {
  return res.status === 409 || /already exists|alreadyexists/i.test(res.message ?? '');
}

// A transient "entry type not visible yet" error worth retrying. Matches the
// propagation phrasing specifically, not a bare "not found" (which also covers a
// genuinely missing entry group or aspect type — a real, non-transient failure).
function isPropagating(res: { message?: string }): boolean {
  const msg = res.message ?? '';
  return /may not exist/i.test(msg) || /entry type .*(not found|does not exist)/i.test(msg);
}

function errText(res: { status: number; message?: string }): string {
  return res.message?.trim() || `HTTP ${res.status}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}


// ---------------------------------------------------------------------------
// Pull: Knowledge Catalog -> Semantic Model IR
//
// The read counterpart of the (still-stubbed) publisher above and the inverse of
// `push`. Unlike the deploy stub this path is live: reading the `semantic-*`
// entries back needs no server-side type provisioning, only that the entries
// exist. It enumerates the destination entry group, hydrates each semantic
// entry's aspect (a BASIC list omits aspect data, so each entry is re-fetched
// with its aspect type, mirroring CatalogSync.pull), and hands the hydrated
// entries to the pure reader (catalog.modelsFromCatalogResources).
// ---------------------------------------------------------------------------

export interface KcPullOptions {
  project: string;
  location: string;
  entryGroup: string;
  model?: string;   // limit to a single model by name (default: all)
}

export interface KcPullResult {
  models: SemanticModel[];
  warnings: string[];
}

// Upper bound on in-flight aspect-hydration fetches during a pull.
const HYDRATE_CONCURRENCY = 8;

export async function pullKnowledgeCatalog(
    client: CatalogClient,
    opts: KcPullOptions): Promise<KcPullResult> {
  const destination = `${opts.project}.${opts.location}.${opts.entryGroup}`;
  const warnings: string[] = [];

  // Enumerate the group (paging is inherently sequential) and pick the semantic
  // entries, then hydrate their aspects concurrently: a BASIC list omits aspect
  // data, so each entry needs its own lookupEntry, and those fetches are
  // independent. The pool preserves input order so warnings stay deterministic.
  const targets: { entry: Entry; aspectType: string }[] = [];
  for await (const entry of client.listEntries(opts.project, opts.location, opts.entryGroup)) {
    const aspectType = semanticAspectType(entry.entryType);
    if (aspectType) targets.push({ entry, aspectType });   // else: not part of a semantic model
  }

  const fetched = await mapConcurrent(targets, HYDRATE_CONCURRENCY, async ({ entry, aspectType }) => {
    const res = await client.lookupEntry(opts.project, opts.location, entry.name, [aspectType]);
    if (res.status !== 200 || !res.result) {
      return { warning: `failed to fetch entry '${entry.name}' (status ${res.status}); skipped` };
    }
    return { entry: res.result };
  });

  const hydrated: Entry[] = [];
  for (const r of fetched) {
    if (r.entry) hydrated.push(r.entry);
    else if (r.warning) warnings.push(r.warning);
  }

  const read = modelsFromCatalogResources(hydrated);
  warnings.push(...read.warnings);

  let models = read.models;
  if (opts.model) {
    models = models.filter(m => m.name === opts.model);
    if (!models.length) {
      warnings.push(`no semantic model named '${opts.model}' found in ${destination}`);
    }
  }

  return { models, warnings };
}

// Maps `items` through `fn` with at most `limit` calls in flight, returning
// results in input order (so downstream ordering stays deterministic).
async function mapConcurrent<T, R>(items: T[], limit: number,
    fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// The `semantic-*` aspect type name for a semantic entry, derived from its entry
// type (the aspect type is the parallel resource in the same project/location).
// Returns undefined for entries that are not part of a semantic model.
function semanticAspectType(entryType: string): string | undefined {
  for (const t of ['semantic-model', 'semantic-entity', 'semantic-measure']) {
    if (entryType?.endsWith(`/entryTypes/${t}`)) {
      return entryType.replace('/entryTypes/', '/aspectTypes/');
    }
  }
  return undefined;
}
