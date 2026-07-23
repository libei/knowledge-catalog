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

  // Metrics are model-level; place each on the single entity its aggregate
  // references. metricsByEntity: entity name -> measure property lines.
  const metricsByEntity = new Map<string, string[]>();
  for (const metric of model.metrics ?? []) {
    placeMetric(metric, model, metricsByEntity, warnings);
  }

  const nodeTables = model.entities.map(
    entity => renderNodeTable(entity, metricsByEntity.get(entity.name) ?? [], opts, warnings));

  const entitiesByName = new Map(model.entities.map(e => [e.name, e]));
  const edgeTables = model.relationships.map(
    rel => renderEdgeTable(rel, entitiesByName, opts, warnings));

  const graphName = qualifyGraph(model, opts);

  const blocks: string[] = [
    `CREATE OR REPLACE PROPERTY GRAPH ${graphName}`,
    `NODE TABLES (\n${nodeTables.join(',\n')}\n)`,
  ];
  if (edgeTables.length) {
    blocks.push(`EDGE TABLES (\n${edgeTables.join(',\n')}\n)`);
  }

  return { ddl: blocks.join('\n') + ';\n', warnings };
}


// Assigns a metric to the node table of the single entity its aggregate
// references, recording a warning if it references zero or multiple entities.
function placeMetric(metric: Metric, model: SemanticModel,
                     metricsByEntity: Map<string, string[]>, warnings: string[]): void {
  const referenced = referencedEntities(metric.expression, model);

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

// Returns the model entity names whose `<name>.` qualifier appears in an expression.
function referencedEntities(expression: string, model: SemanticModel): string[] {
  return model.entities
    .map(e => e.name)
    .filter(name => new RegExp(`\\b${escapeRegExp(name)}\\.`).test(expression));
}

// Removes the `<entity>.` qualifier so the expression references table-local columns.
function stripQualifier(expression: string, entity: string): string {
  return expression.replace(new RegExp(`\\b${escapeRegExp(entity)}\\.`, 'g'), '');
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
    `  ${table} AS ${entity.name}`,
    `    KEY(${entity.keys.join(', ')})`,
    `    PROPERTIES(\n${indentList(properties, 6)}\n    )`,
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
  if (rel.dataSource) {
    backing = qualifyTable(rel.dataSource, opts, warnings, `relationship '${rel.name}'`);
  } else {
    const sourceEntity = entitiesByName.get(rel.source.entity);
    if (!sourceEntity) {
      warnings.push(`relationship '${rel.name}': unknown source entity '${rel.source.entity}'`);
      backing = `\`${rel.source.entity}\``;
    } else {
      backing = qualifyTable(sourceEntity.dataSource, opts, warnings, `relationship '${rel.name}'`);
    }
  }

  const lines = [
    `  ${backing} AS ${rel.name}`,
    `    SOURCE KEY(${keys(rel.source).rel}) REFERENCES ${rel.source.entity}(${keys(rel.source).entity})`,
    `    DESTINATION KEY(${keys(rel.destination).rel}) REFERENCES ${rel.destination.entity}(${keys(rel.destination).entity})`,
  ];

  if (rel.fields && rel.fields.length) {
    const properties = rel.fields.map(f => renderFieldProperty(f, rel.name));
    lines.push(`    PROPERTIES(\n${indentList(properties, 6)}\n    )`);
  }

  return lines.join('\n');
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
  const dataset = opts.dataset ?? model.entities[0]?.dataSource.dataset;
  const project = opts.project ?? model.entities[0]?.dataSource.project;
  const parts = [project, dataset, name].filter((p): p is string => !!p);
  return `\`${parts.join('.')}\``;
}


function indentList(lines: string[], spaces: number): string {
  const pad = ' '.repeat(spaces);
  return lines.map(l => `${pad}${l}`).join(',\n');
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
