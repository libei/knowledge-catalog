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
import { transpileModel, SqlTranspiler } from './transpile';

export interface DeployOptions extends GenerateOptions {
  dryRun?: boolean;   // compile + report only; do not execute against BigQuery
  // When set, vendor-dialect expressions (those the loader marked with a source
  // dialect) are rewritten to GoogleSQL via the transpile pass before the DDL is
  // generated. Default off, so a model authored entirely in GoogleSQL/ANSI is
  // unaffected. See ./transpile.
  transpile?: boolean;
  transpiler?: SqlTranspiler;  // override the transpile mechanism (tests); default sqlglot
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
  const { dryRun, transpile, transpiler, ...generateOpts } = opts;

  // A single graphName applied to every model would make each CREATE OR REPLACE
  // clobber the previous one, leaving only the last model deployed.
  if (generateOpts.graphName && models.length > 1) {
    throw new Error('graphName cannot be set when deploying more than one model; it would overwrite all but the last graph');
  }

  const results: ModelDeployResult[] = [];

  for (const model of models) {
    // Rewrite vendor-dialect expressions to GoogleSQL first (opt-in). Transpile
    // warnings precede compile warnings since they explain what the emitter saw.
    let source = model;
    const transpileWarnings: string[] = [];
    if (transpile) {
      const t = await transpileModel(model, { target: 'BIGQUERY', transpiler });
      source = t.model;
      transpileWarnings.push(...t.warnings);
    }

    const { ddl, warnings } = generatePropertyGraph(source, generateOpts);
    const result: ModelDeployResult = {
      model: model.name, ddl, warnings: [...transpileWarnings, ...warnings], executed: false,
    };
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

    // jobs.query returns jobComplete=false when the statement did not finish
    // within the synchronous timeout; don't report success for an unconfirmed run.
    if (res.result?.jobComplete === false) {
      result.error = `BigQuery did not complete the graph DDL for '${model.name}' synchronously (jobComplete=false)`;
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
