// Serializes the Semantic Model IR (./ir) back to the AI-first semantics format
// (YAML). This is the inverse of `loader.ts`: `loader` reads authored YAML into
// the IR; this module writes the IR out as a YAML document a `loader` can read
// back. It is the local-workspace sink for `pull` (Knowledge Catalog -> IR ->
// YAML), the counterpart to how `push` compiles YAML -> IR -> a destination.
//
// Fidelity is at the IR level, not byte-for-byte with a hand-authored file. The
// loader flattens several authoring conveniences into the IR at load time, so
// they are already gone before serialization and cannot be reproduced here:
//   * per-dialect `expression.dialects[]` variants collapse to one string (the
//     picked dialect); only that one expression is re-emitted.
//   * `ai_context.instructions` and `examples`, a field `label`, and a
//     `dimension.is_time` marker are folded into the composed `description` at
//     load; they are re-emitted as part of `description`, not as their original
//     structured keys.
//   * comments and key ordering are not preserved.
// What IS preserved round-trips exactly: names, descriptions (as composed),
// entity/field/relationship/metric `synonyms`, keys, data sources, field
// expressions, and relationship join columns. See serialize.test.ts.

import * as yaml from 'yaml';
import { SemanticModel, Entity, Field, Relationship, Metric, DataSource } from './ir';

// The schema version the loader was written against; re-emitted verbatim so a
// serialized document loads without a version-mismatch warning.
const SERIALIZED_VERSION = '0.2.0.dev0';

// The dialect label used for an expression the IR did not mark with a vendor
// `expressionDialect`. The loader only sets `expressionDialect` for a vendor
// fallback; a target- or canonical-sourced expression is left unmarked, and the
// IR cannot tell those two apart. ANSI_SQL is the format's portable default
// (accepted by every target, BigQuery included), so emitting it is lossless at
// the IR level: reloading picks it as the canonical fallback and, like the
// original, leaves `expressionDialect` unset.
const DEFAULT_DIALECT = 'ANSI_SQL';

/**
 * Serializes a single semantic model to a YAML document string in the AI-first
 * semantics format. The document contains exactly this one model; `pull` writes
 * one file per model (catalog/<entryGroup>/<model>.yaml).
 */
export function serializeModel(model: SemanticModel): string {
  return yaml.stringify(modelDocument(model));
}

// Builds the plain document object (version + one model) that yaml.stringify
// renders. Kept separate so tests can assert the structure without parsing YAML.
export function modelDocument(model: SemanticModel): Record<string, any> {
  return {
    version: SERIALIZED_VERSION,
    semantic_model: [modelDoc(model)],
  };
}

function modelDoc(model: SemanticModel): Record<string, any> {
  return compact({
    name: model.name,
    description: model.description,
    datasets: (model.entities ?? []).map(datasetDoc),
    relationships: nonEmpty((model.relationships ?? []).map(relationshipDoc)),
    metrics: nonEmpty((model.metrics ?? []).map(metricDoc)),
  });
}

function datasetDoc(entity: Entity): Record<string, any> {
  return compact({
    name: entity.name,
    source: sourceString(entity.dataSource),
    primary_key: nonEmpty(entity.keys),
    description: entity.description,
    ai_context: aiContext(entity.synonyms),
    fields: nonEmpty((entity.fields ?? []).map(fieldDoc)),
  });
}

function fieldDoc(field: Field): Record<string, any> {
  return compact({
    name: field.name,
    expression: expressionDoc(field.expression, field.expressionDialect),
    description: field.description,
    ai_context: aiContext(field.synonyms),
  });
}

function metricDoc(metric: Metric): Record<string, any> {
  // `entities` is derived by the loader from the expression's entity qualifiers,
  // so it is intentionally not emitted: the loader recomputes it on reload.
  return compact({
    name: metric.name,
    expression: expressionDoc(metric.expression, metric.expressionDialect),
    description: metric.description,
    ai_context: aiContext(metric.synonyms),
  });
}

// Inverts loader.convertRelationship: the authored `from`/`to` are the endpoint
// entities, and `from_columns`/`to_columns` are the destination end's
// relationship/entity columns (the source end only mirrors the from-entity key
// and carries no independent authored information).
function relationshipDoc(rel: Relationship): Record<string, any> {
  return compact({
    name: rel.name,
    from: rel.source.entity,
    to: rel.destination.entity,
    from_columns: rel.destination.joinKeys.relationshipColumns,
    to_columns: rel.destination.joinKeys.entityColumns,
    description: rel.description,
    ai_context: aiContext(rel.synonyms),
  });
}

// Renders a single-dialect expression object matching the loader's schema.
function expressionDoc(expression: string, dialect: string | undefined): Record<string, any> {
  return { dialects: [{ dialect: dialect ?? DEFAULT_DIALECT, expression }] };
}

// Composes the dotted `source` shorthand from the structured DataSource,
// inverting loader.parseSource. Omits absent project/dataset parts.
function sourceString(ds: DataSource): string {
  return [ds.project, ds.dataset, ds.table]
    .filter((p): p is string => p !== undefined && p !== '')
    .join('.');
}

// Emits synonyms via the structured `ai_context` object (the only authoring path
// the loader reads synonyms from). Returns undefined when there are none, so
// `compact` drops the key entirely.
function aiContext(synonyms: string[] | undefined): Record<string, any> | undefined {
  return synonyms && synonyms.length ? { synonyms } : undefined;
}

// Drops undefined-valued keys so the emitted YAML only shows fields the model
// actually set (matching the emitters' `compact` convention).
function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// Returns the array, or undefined when empty, so an empty list is omitted rather
// than rendered as `[]`.
function nonEmpty<T>(items: T[]): T[] | undefined {
  return items.length ? items : undefined;
}
