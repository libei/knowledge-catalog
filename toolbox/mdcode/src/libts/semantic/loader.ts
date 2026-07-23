// Loads an open, vendor-neutral AI-first semantics format (YAML/JSON) into the
// Semantic Model IR (./ir).
//
// The format describes a semantic model as datasets (entities), foreign-key
// relationships, and model-level metrics, with entity-qualified SQL expressions
// (`Entity.column`) supplied per SQL dialect. This module reads the subset of
// that logical layer needed to normalize a model into the IR, so the rest of the
// toolbox (e.g. the BigQuery property-graph generator) can consume models
// authored in it. Fields outside the supported subset are accepted and ignored.
//

import * as yaml from 'yaml';
import * as z from 'zod';
import { SemanticModel, Entity, Field, Relationship, Metric, DataSource } from './ir';
import { referencedEntityNames, dedupe } from './expr';

export interface LoadOptions {
  dialect?: string;         // preferred expression dialect; default 'BIGQUERY'
  defaultProject?: string;  // fallback when a dataset `source` omits the project
  defaultDataset?: string;  // fallback when a dataset `source` omits the dataset
}

export interface LoadResult {
  models: SemanticModel[];
  warnings: string[];
}

const DEFAULT_DIALECT = 'BIGQUERY';
const FALLBACK_DIALECT = 'ANSI_SQL';
// The logical-layer schema version this loader was written against; a document
// declaring a different version is loaded anyway, with a warning.
const SUPPORTED_VERSION = '0.2.0.dev0';


// An expression is supplied as one or more per-dialect variants; we collapse it
// to a single string by picking a dialect. Unknown sibling keys are ignored.
const expressionSchema = z.object({
  dialects: z.array(z.object({
    dialect: z.string(),
    expression: z.string(),
  })).min(1),
});

const fieldSchema = z.object({
  name: z.string(),
  expression: expressionSchema,
});

const datasetSchema = z.object({
  name: z.string(),
  source: z.string(),
  primary_key: z.array(z.string()).optional(),
  fields: z.array(fieldSchema).optional(),
});

const relationshipSchema = z.object({
  name: z.string(),
  from: z.string(),
  to: z.string(),
  from_columns: z.array(z.string()).min(1),
  to_columns: z.array(z.string()).min(1),
});

const metricSchema = z.object({
  name: z.string(),
  expression: expressionSchema,
  description: z.string().optional(),
});

const modelSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  datasets: z.array(datasetSchema).min(1),
  relationships: z.array(relationshipSchema).optional(),
  metrics: z.array(metricSchema).optional(),
});

const documentSchema = z.object({
  version: z.string().optional(),
  semantic_model: z.array(modelSchema).min(1),
});

type ExpressionDoc = z.infer<typeof expressionSchema>;
type DatasetDoc = z.infer<typeof datasetSchema>;
type FieldDoc = z.infer<typeof fieldSchema>;
type RelationshipDoc = z.infer<typeof relationshipSchema>;
type MetricDoc = z.infer<typeof metricSchema>;
type ModelDoc = z.infer<typeof modelSchema>;


/**
 * Loads YAML or JSON text (a document in the AI-first semantics format) into the
 * Semantic Model IR. `yaml.parse` accepts JSON too, so both are supported.
 */
export function loadModels(text: string, opts: LoadOptions = {}): LoadResult {
  let doc: unknown;
  try {
    doc = yaml.parse(text);
  } catch (err: any) {
    throw new Error(`Semantic model load error: could not parse input: ${err?.message ?? err}`);
  }
  return fromDocument(doc, opts);
}

/**
 * Converts an already-parsed document object into the Semantic Model IR. Throws
 * on a structurally invalid document; softer, lossy conversions are reported in
 * `warnings` rather than thrown.
 */
export function fromDocument(doc: unknown, opts: LoadOptions = {}): LoadResult {
  const result = documentSchema.safeParse(doc);
  if (!result.success) {
    throw new Error(`Semantic model load error: ${result.error.message}`);
  }

  const warnings: string[] = [];
  const parsed = result.data;

  if (parsed.version && parsed.version !== SUPPORTED_VERSION) {
    warnings.push(
      `document version '${parsed.version}' differs from the supported '${SUPPORTED_VERSION}'; ` +
      `loading anyway`);
  }

  const models = parsed.semantic_model.map(m => convertModel(m, opts, warnings));
  return { models, warnings: dedupe(warnings) };
}


function convertModel(m: ModelDoc, opts: LoadOptions, warnings: string[]): SemanticModel {
  const dialect = opts.dialect ?? DEFAULT_DIALECT;

  const entities = m.datasets.map(ds => convertDataset(ds, opts, warnings, dialect));

  const seenNames = new Set<string>();
  for (const e of entities) {
    if (seenNames.has(e.name)) {
      warnings.push(
        `model '${m.name}': duplicate dataset name '${e.name}'; ` +
        `only one node table can carry that label (the graph will be invalid)`);
    }
    seenNames.add(e.name);
  }

  const keysByEntity = new Map(entities.map(e => [e.name, e.keys]));

  const relationships = (m.relationships ?? []).map(
    r => convertRelationship(r, keysByEntity, warnings));

  const entityNames = entities.map(e => e.name);
  const metrics = (m.metrics ?? []).map(
    mt => convertMetric(mt, entityNames, warnings, dialect));

  const model: SemanticModel = { name: m.name, entities, relationships, metrics };
  if (m.description) model.description = m.description;
  return model;
}

function convertDataset(ds: DatasetDoc, opts: LoadOptions,
                        warnings: string[], dialect: string): Entity {
  const ctx = `dataset '${ds.name}'`;
  const dataSource = parseSource(ds.source, opts, warnings, ctx);
  const keys = ds.primary_key ?? [];
  if (!keys.length) {
    warnings.push(`${ctx}: no primary_key; the entity's KEY will be empty (invalid for graph generation)`);
  }
  const fields = (ds.fields ?? []).map(f => convertField(f, ds.name, warnings, dialect));
  return { name: ds.name, dataSource, keys, fields };
}

function convertField(f: FieldDoc, entityName: string, warnings: string[], dialect: string): Field {
  const expression = pickDialect(f.expression, dialect, `field '${entityName}.${f.name}'`, warnings);
  return { name: f.name, expression };
}

// Maps a foreign-key relationship onto the IR's direct-FK edge convention: the
// source end carries the `from` dataset's own primary key (it identifies the
// edge-backing table), while the destination end carries the FK columns
// (`from_columns`) referencing the target's key columns (`to_columns`).
function convertRelationship(r: RelationshipDoc, keysByEntity: Map<string, string[]>,
                            warnings: string[]): Relationship {
  const ctx = `relationship '${r.name}'`;
  const fromKeys = keysByEntity.get(r.from);
  if (fromKeys === undefined) {
    warnings.push(`${ctx}: 'from' dataset '${r.from}' is not defined in the model`);
  }
  if (!keysByEntity.has(r.to)) {
    warnings.push(`${ctx}: 'to' dataset '${r.to}' is not defined in the model`);
  }
  if (r.from_columns.length !== r.to_columns.length) {
    warnings.push(
      `${ctx}: from_columns (${r.from_columns.length}) and to_columns ` +
      `(${r.to_columns.length}) have different lengths; the join keys will be mismatched`);
  }

  // Fall back to the FK columns when the from dataset declares no primary key.
  const sourceKey = fromKeys && fromKeys.length ? fromKeys : r.from_columns;

  return {
    name: r.name,
    source: {
      entity: r.from,
      joinKeys: { relationshipColumns: sourceKey, entityColumns: sourceKey },
    },
    destination: {
      entity: r.to,
      joinKeys: { relationshipColumns: r.from_columns, entityColumns: r.to_columns },
    },
  };
}

function convertMetric(mt: MetricDoc, entityNames: string[],
                       warnings: string[], dialect: string): Metric {
  const ctx = `metric '${mt.name}'`;
  const expression = pickDialect(mt.expression, dialect, ctx, warnings);
  const entities = referencedEntityNames(expression, entityNames);
  if (!entities.length) {
    warnings.push(`${ctx}: expression references no known entity; it may not be placeable downstream`);
  }
  const metric: Metric = { name: mt.name, expression, entities };
  if (mt.description) metric.description = mt.description;
  return metric;
}


// Picks a single expression string from the per-dialect variants: the requested
// dialect, else the portable ANSI_SQL fallback, else the first listed (warning on
// either fallback). Dialect names are compared case-insensitively.
function pickDialect(expr: ExpressionDoc, preferred: string,
                     ctx: string, warnings: string[]): string {
  const byName = (name: string) =>
    expr.dialects.find(d => d.dialect.toUpperCase() === name.toUpperCase());

  const exact = byName(preferred);
  if (exact) return exact.expression;

  const fallback = byName(FALLBACK_DIALECT);
  if (fallback) {
    warnings.push(`${ctx}: no '${preferred}' dialect; using '${FALLBACK_DIALECT}' expression`);
    return fallback.expression;
  }

  const first = expr.dialects[0];
  warnings.push(`${ctx}: no '${preferred}' or '${FALLBACK_DIALECT}' dialect; using '${first.dialect}' expression`);
  return first.expression;
}

// Parses a dotted `source` string into a structured table reference. Handles
// `project.dataset.table`, `dataset.table`, and bare `table`, filling a missing
// project/dataset from options. A source that looks like a query (contains
// whitespace) cannot be structured, so it is kept verbatim as the table name.
function parseSource(source: string, opts: LoadOptions,
                     warnings: string[], ctx: string): DataSource {
  const trimmed = source.trim();

  if (/\s/.test(trimmed)) {
    warnings.push(`${ctx}: source looks like a query, not a table reference; keeping it verbatim`);
    return withDefaults({ table: trimmed }, opts);
  }

  const parts = trimmed.split('.').map(unquote);
  let project: string | undefined;
  let dataset: string | undefined;
  let table: string;

  if (parts.length === 1) {
    table = parts[0];
  } else if (parts.length === 2) {
    [dataset, table] = parts;
  } else if (parts.length === 3) {
    [project, dataset, table] = parts;
  } else {
    warnings.push(
      `${ctx}: source '${trimmed}' has ${parts.length} dotted parts; ` +
      `treating the first two as project/dataset and the rest as the table`);
    project = parts[0];
    dataset = parts[1];
    table = parts.slice(2).join('.');
  }

  const ds: DataSource = { table };
  if (project) ds.project = project;
  if (dataset) ds.dataset = dataset;
  return withDefaults(ds, opts);
}

function withDefaults(ds: DataSource, opts: LoadOptions): DataSource {
  if (!ds.project && opts.defaultProject) ds.project = opts.defaultProject;
  if (!ds.dataset && opts.defaultDataset) ds.dataset = opts.defaultDataset;
  return ds;
}

function unquote(part: string): string {
  return part.replace(/^[`"]/, '').replace(/[`"]$/, '');
}
