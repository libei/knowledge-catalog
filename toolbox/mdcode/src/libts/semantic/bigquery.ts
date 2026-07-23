// Generates BigQuery property-graph DDL (with inline measures) from the
// Semantic Model IR.
//
// The IR (./ir) is pure semantics. This module is its first consumer: it emits
// a single `CREATE OR REPLACE PROPERTY GRAPH` statement over the entities'
// existing base tables, with model-level metrics rendered as inline
// `MEASURE(...)` properties.
//
// BigQuery graph measures bind an aggregate to exactly one table's KEY; the
// cross-entity rollup happens at query time via GRAPH_EXPAND(...) + AGG(...).
// A metric therefore lands on whichever single table its aggregate columns
// reference; a metric whose aggregate genuinely spans multiple tables cannot be
// expressed as one MEASURE and is skipped (reported in `warnings`).
//
// See: https://docs.cloud.google.com/bigquery/docs/graph-measures
//

import { SemanticModel, Entity, Field, Relationship, RelationshipEnd, Metric, DataSource } from './ir';
import { referencedEntityNames, stripQualifier, dedupe } from './expr';

export interface GenerateOptions {
  project?: string;    // default project for the graph + unqualified table refs
  dataset?: string;    // dataset the graph is created in (else inferred from entities)
  graphName?: string;  // default: model.name
}

export interface GenerateResult {
  ddl: string;         // CREATE OR REPLACE PROPERTY GRAPH ...
  warnings: string[];  // skipped metrics, unresolved table refs, etc.
}

// Aggregate functions BigQuery accepts inside MEASURE(...).
const SUPPORTED_AGGREGATES = ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'];

/**
 * Generates the BigQuery property-graph DDL for a semantic model.
 *
 * The generated statement references the entities' existing base tables; it does
 * not create them. Returns the DDL plus any warnings collected while mapping the
 * IR (e.g. metrics that could not be placed on a single table).
 */
export function generatePropertyGraph(model: SemanticModel, opts: GenerateOptions = {}): GenerateResult {
  const warnings: string[] = [];

  // The IR requires entities/relationships/metrics, but be defensive against a
  // hand-built or partially-deserialized model rather than throwing on `.map`.
  const entities = model.entities ?? [];
  const relationships = model.relationships ?? [];
  const metrics = model.metrics ?? [];

  if (!entities.length) {
    warnings.push('model has no entities; the generated NODE TABLES block will be empty and invalid');
  }

  // Metrics are model-level; place each on the single entity its aggregate
  // references. metricsByEntity: entity name -> measure property lines.
  const metricsByEntity = new Map<string, string[]>();
  for (const metric of metrics) {
    placeMetric(metric, model, metricsByEntity, warnings);
  }

  const nodeTables = entities.map(
    entity => renderNodeTable(entity, metricsByEntity.get(entity.name) ?? [], opts, warnings));

  const entitiesByName = new Map(entities.map(e => [e.name, e]));
  const edgeTables = relationships.map(
    rel => renderEdgeTable(rel, entitiesByName, opts, warnings));

  const graphName = qualifyGraph(model, opts);

  const blocks: string[] = [
    `CREATE OR REPLACE PROPERTY GRAPH ${graphName}`,
    `NODE TABLES (\n${nodeTables.join(',\n')}\n)`,
  ];
  if (edgeTables.length) {
    blocks.push(`EDGE TABLES (\n${edgeTables.join(',\n')}\n)`);
  }

  return { ddl: blocks.join('\n') + ';\n', warnings: dedupe(warnings) };
}


// Assigns a metric to the node table of the single entity its aggregate
// references, recording a warning if it references zero or multiple entities.
function placeMetric(metric: Metric, model: SemanticModel,
                     metricsByEntity: Map<string, string[]>, warnings: string[]): void {
  const referenced = referencedEntities(metric.expression, model);

  // The IR also declares metric.entities. Placement is driven by the qualifiers
  // actually present in the expression (that is what we strip and attach), but a
  // disagreement with the declared list signals an inconsistent model, so
  // surface it rather than resolving silently.
  if (metric.entities && !sameSet(metric.entities, referenced)) {
    warnings.push(
      `metric '${metric.name}' declares entities [${metric.entities.join(', ')}] but its ` +
      `expression references [${referenced.join(', ') || 'none'}]; placing per the expression`);
  }

  if (referenced.length !== 1) {
    const detail = referenced.length === 0
      ? 'references no known entity'
      : `spans multiple tables (${referenced.join(', ')})`;
    warnings.push(`metric '${metric.name}' ${detail}; skipped (cannot be a single MEASURE)`);
    return;
  }

  const entity = referenced[0];
  const body = stripQualifier(metric.expression, entity);
  if (!startsWithSupportedAggregate(body)) {
    warnings.push(
      `metric '${metric.name}' expression '${body}' does not begin with a supported ` +
      `aggregate (${SUPPORTED_AGGREGATES.join(', ')}); emitting anyway`);
  }

  const lines = metricsByEntity.get(entity) ?? [];
  lines.push(`MEASURE(${body}) AS ${metric.name}`);
  metricsByEntity.set(entity, lines);
}

// Returns the model entity names whose `<name>.` qualifier appears in an
// expression. String literals are ignored so a value like 'orders.x' is not
// mistaken for a reference to the `orders` entity.
function referencedEntities(expression: string, model: SemanticModel): string[] {
  return referencedEntityNames(expression, (model.entities ?? []).map(e => e.name));
}

function startsWithSupportedAggregate(body: string): boolean {
  const fn = body.trimStart().match(/^([A-Za-z_]+)\s*\(/);
  return !!fn && SUPPORTED_AGGREGATES.includes(fn[1].toUpperCase());
}


function renderNodeTable(entity: Entity, measures: string[],
                         opts: GenerateOptions, warnings: string[]): string {
  const table = qualifyTable(entity.dataSource, opts, warnings, `entity '${entity.name}'`);
  const properties = [
    ...entity.fields.map(f => renderFieldProperty(f, entity.name)),
    ...measures,
  ];

  return [
    line(1, `${table} AS ${entity.name}`),
    line(2, `KEY(${entity.keys.join(', ')})`),
    propertiesBlock(properties),
  ].join('\n');
}

// Renders a field as a graph property: a bare column when the expression is just
// the column, else `<expr> AS <name>`. Attaches a description when present.
function renderFieldProperty(field: Field, entity: string): string {
  const local = stripQualifier(field.expression, entity);
  let prop = local === field.name ? field.name : `${local} AS ${field.name}`;
  if (field.description) {
    prop += ` OPTIONS(description=${quote(field.description)})`;
  }
  return prop;
}


function renderEdgeTable(rel: Relationship, entitiesByName: Map<string, Entity>,
                        opts: GenerateOptions, warnings: string[]): string {
  // Backed by the association/junction table when present (the M:N shape),
  // otherwise by the source entity's base table (direct foreign-key relationship,
  // where the source table holds the join columns).
  let backing: string;
  const sourceEntity = entitiesByName.get(rel.source.entity);
  if (rel.dataSource) {
    backing = qualifyTable(rel.dataSource, opts, warnings, `relationship '${rel.name}'`);
  } else if (!sourceEntity) {
    warnings.push(`relationship '${rel.name}': unknown source entity '${rel.source.entity}'`);
    backing = `\`${rel.source.entity}\``;
  } else {
    backing = qualifyTable(sourceEntity.dataSource, opts, warnings, `relationship '${rel.name}'`);
  }

  const src = keys(rel.source);
  const dst = keys(rel.destination);
  const lines = [
    line(1, `${backing} AS ${rel.name}`),
    line(2, `KEY(${edgeKey(rel, sourceEntity).join(', ')})`),
    line(2, `SOURCE KEY(${src.rel}) REFERENCES ${rel.source.entity}(${src.entity})`),
    line(2, `DESTINATION KEY(${dst.rel}) REFERENCES ${rel.destination.entity}(${dst.entity})`),
  ];

  if (rel.fields && rel.fields.length) {
    const properties = rel.fields.map(f => renderFieldProperty(f, rel.name));
    lines.push(propertiesBlock(properties));
  }

  return lines.join('\n');
}

// The edge element key: the columns that uniquely identify an edge row. Graph
// element tables must declare a key explicitly (base-table PRIMARY KEYs are not
// assumed). Prefers the relationship's own `keys`; for a direct FK backed by the
// source entity's table, uses that entity's keys; otherwise falls back to the
// composite of both ends' join columns on the backing table.
function edgeKey(rel: Relationship, sourceEntity: Entity | undefined): string[] {
  if (rel.keys && rel.keys.length) {
    return rel.keys;
  }
  if (!rel.dataSource && sourceEntity) {
    return sourceEntity.keys;
  }
  return dedupe([
    ...rel.source.joinKeys.relationshipColumns,
    ...rel.destination.joinKeys.relationshipColumns,
  ]);
}

function keys(end: RelationshipEnd): { rel: string; entity: string } {
  return {
    rel: end.joinKeys.relationshipColumns.join(', '),
    entity: end.joinKeys.entityColumns.join(', '),
  };
}


// Builds a backtick-quoted `project.dataset.table` reference, falling back to
// opts for a missing project/dataset. Warns when neither yields a project or
// dataset (the ref will be unqualified and likely invalid).
function qualifyTable(ds: DataSource, opts: GenerateOptions,
                      warnings: string[], context: string): string {
  const project = ds.project ?? opts.project;
  const dataset = ds.dataset ?? opts.dataset;
  const parts = [project, dataset, ds.table].filter((p): p is string => !!p);
  if (!project || !dataset) {
    warnings.push(`${context}: table '${ds.table}' is missing a project and/or dataset`);
  }
  return `\`${parts.join('.')}\``;
}

// Builds the dataset-qualified graph name.
function qualifyGraph(model: SemanticModel, opts: GenerateOptions): string {
  const name = opts.graphName ?? model.name;
  const first = (model.entities ?? [])[0];
  const dataset = opts.dataset ?? first?.dataSource.dataset;
  const project = opts.project ?? first?.dataSource.project;
  const parts = [project, dataset, name].filter((p): p is string => !!p);
  return `\`${parts.join('.')}\``;
}


// All generated indentation flows through this single mechanism: one nesting
// level == one INDENT. `line` indents one line to a depth; `list` indents a set
// of lines and joins them comma-separated; `propertiesBlock` is the shared
// `PROPERTIES( ... )` shape used by both node and edge tables. Keeping every
// indent derived from `depth` (rather than hardcoded spaces) makes the output
// indentation consistent by construction.
const INDENT = '  ';
const pad = (depth: number): string => INDENT.repeat(depth);
const line = (depth: number, text: string): string => `${pad(depth)}${text}`;
const list = (depth: number, lines: string[]): string =>
  lines.map(l => line(depth, l)).join(',\n');

function propertiesBlock(properties: string[]): string {
  return `${line(2, 'PROPERTIES(')}\n${list(3, properties)}\n${line(2, ')')}`;
}

// Renders a value as a BigQuery double-quoted string literal. Backslash and the
// quote are escaped, and control characters that cannot appear raw inside a
// quoted literal (newline, carriage return, tab) are escaped too, so a
// multi-line description does not produce a broken literal.
function quote(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every(x => sa.has(x));
}
