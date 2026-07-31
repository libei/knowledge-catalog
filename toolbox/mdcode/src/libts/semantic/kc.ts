// Deploys Semantic Model IR to Knowledge Catalog (Dataplex).
//
// This is the destination-specific orchestration layer for the Knowledge Catalog
// target, the counterpart to `deploy.ts` (BigQuery). The eventual publisher will
// map the pure IR to `semantic-model`/`semantic-entity`/`semantic-measure`
// Entries, `semantic-*` Aspects, and `semantic-relationship` EntryLinks and write
// them via the Dataplex catalog client — mirroring the shared-front-end /
// per-destination-emitter design used for BigQuery.
//
// For now this is a STUB: the CLI `--target kc|both` surface, its coordinate
// flags, and this dispatch seam are wired end to end, but no entries are written.
// The seam reports the resolved destination so the plumbing is observable and
// testable; the actual publish path (and its server-side system types) lands
// later. See the plan's Follow-ups.
//
// What a live run against real Dataplex confirmed the publisher will need (see
// catalog.ts and the KC-emitter validation notes):
//   * The `semantic-*` entry/aspect types must be provisioned first; aspect types
//     validate a CLOSED schema, so their metadataTemplate must match the emitter's
//     aspect-data field names exactly.
//   * Entries write via entries.create in array order (model anchor before its
//     children); a freshly created entry type can lag a few seconds before
//     entries.create sees it (retry the "may not exist" window).
//   * Relationship edges need the `semantic-relationship` entry link type, which
//     is not user-creatable and not yet provisioned — no predefined link type is
//     both directed and valid over `semantic-entity` endpoints, so the edges wait
//     on that system type. entries.create is synchronous; type creates are LROs.

import type { CatalogClient, Entry } from '../gcp/dataplex';
import { SemanticModel } from './ir';
import { DeployResult, ModelDeployResult } from './deploy';
import { modelsFromCatalogResources } from './catalog';

export interface KcDeployOptions {
  // The resolved Knowledge Catalog destination (flag overrides applied over the
  // catalog.yaml scope defaults).
  project: string;
  location: string;
  entryGroup: string;
  dryRun?: boolean;   // compile + report only; never writes
}

// Compiles each model for the Knowledge Catalog target. Until the publisher is
// implemented this always reports "not yet available" (echoing the resolved
// destination), so a `kc`/`both` push prints a clear message and exits non-zero
// without touching Dataplex. Kept async and DeployResult-shaped so the real
// implementation is a drop-in replacement.
export async function deployKnowledgeCatalog(
    models: SemanticModel[],
    opts: KcDeployOptions): Promise<DeployResult> {
  const destination = `${opts.project}.${opts.location}.${opts.entryGroup}`;

  const results: ModelDeployResult[] = models.map(model => ({
    model: model.name,
    ddl: '',
    warnings: [],
    executed: false,
    error: opts.dryRun
      ? `Knowledge Catalog target is not yet available (dry run: would deploy '${model.name}' to ${destination})`
      : `Knowledge Catalog target is not yet available (would deploy '${model.name}' to ${destination})`,
  }));

  return { ok: false, results };
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
