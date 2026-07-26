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

import { SemanticModel } from './ir';
import { DeployResult, ModelDeployResult } from './deploy';

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
