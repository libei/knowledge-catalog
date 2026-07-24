// Deploys Semantic Model IR to BigQuery.
//
// This is the destination-specific orchestration layer for the BigQuery target:
// it drives the pure `generatePropertyGraph` emitter and then runs the resulting
// `CREATE OR REPLACE PROPERTY GRAPH` DDL against BigQuery. Keeping this out of
// `bigquery.ts` preserves that emitter as a pure IR->string function (no GCP
// dependency), per the shared-front-end / per-destination-emitter design.

import * as bq from '../gcp/bigquery';
import { SemanticModel } from './ir';
import { generatePropertyGraph, GenerateOptions } from './bigquery';

export interface DeployOptions extends GenerateOptions {
  dryRun?: boolean;   // compile + report only; do not execute against BigQuery
}

export interface ModelDeployResult {
  model: string;
  ddl: string;
  warnings: string[];
  executed: boolean;
  error?: string;
}

export interface DeployResult {
  ok: boolean;
  results: ModelDeployResult[];
}

// Compiles each model to a property-graph DDL and (unless dryRun) executes it via
// the BigQuery client. The job is billed to the first resolvable of: the explicit
// `opts.project`, the project on the model's entity tables, or the client's
// context project. Compilation warnings never fail the deploy; an execution error
// does (and stops further models, matching the sync path's fail-fast behavior).
export async function deployBigQuery(client: bq.BigQueryClient,
                                     models: SemanticModel[],
                                     opts: DeployOptions = {}): Promise<DeployResult> {
  const { dryRun, ...generateOpts } = opts;
  const results: ModelDeployResult[] = [];

  for (const model of models) {
    const { ddl, warnings } = generatePropertyGraph(model, generateOpts);
    const result: ModelDeployResult = { model: model.name, ddl, warnings, executed: false };
    results.push(result);

    if (dryRun) {
      continue;
    }

    const runProject = resolveRunProject(model, client, generateOpts);
    if (!runProject) {
      result.error = `cannot resolve a BigQuery project to run the graph DDL for '${model.name}'`;
      return { ok: false, results };
    }

    const res = await client.query(runProject, ddl);
    const queryErrors = res.result?.errors;
    if (res.status !== 200 || (queryErrors && queryErrors.length)) {
      const detail = queryErrors?.map(e => e.message).filter(Boolean).join('; ')
        || res.message || `HTTP ${res.status}`;
      result.error = detail;
      return { ok: false, results };
    }

    result.executed = true;
  }

  return { ok: true, results };
}

// Resolves the project that runs (and is billed for) the DDL job.
function resolveRunProject(model: SemanticModel, client: bq.BigQueryClient,
                           opts: GenerateOptions): string | undefined {
  return opts.project
    ?? (model.entities ?? []).map(e => e.dataSource?.project).find((p): p is string => !!p)
    ?? client.context.project;
}
