// Defines the Semantic Model intermediate representation (IR).
//
// The IR is the in-memory contract for a semantic model. It represents
// semantics only: a graph of entities (nodes) connected by relationships
// (edges), plus model-level metrics.
//

/**
 * A semantic model: a graph of entities (nodes) connected by relationships
 * (edges), with model-level metrics defined over them.
 *
 * The IR is pure semantics. Deployment/target configuration lives in the
 * project manifest (`catalog.yaml`), NOT here.
 */
export interface SemanticModel {
  name: string;
  description?: string;
  entities: Entity[];
  relationships: Relationship[];
  metrics: Metric[];
}

/**
 * A structured reference to a physical table backing an entity or an
 * association (edge) table.
 *
 * Kept lean for now (BigQuery-shaped); additional platforms/fields can be added
 * later. The YAML layer may accept a shorthand string (e.g. "proj.dataset.table")
 * and normalize it into this structured form.
 */
export interface DataSource {
  project?: string;
  dataset?: string;
  table: string;
}

/**
 * An entity: a node in the semantic graph. Backed by a physical table
 * (`dataSource`), identified by `keys`, and carrying its dimension `fields`.
 */
export interface Entity {
  name: string;
  dataSource: DataSource;
  keys: string[];        // grain / primary key
  description?: string;
  synonyms?: string[];
  fields: Field[];       // dimensions / attributes
}

/**
 * A field: a dimension / attribute of an entity or relationship.
 *
 * Fields describe the data; aggregates are expressed as model-level `Metric`s,
 * not fields.
 */
export interface Field {
  name: string;
  expression: string;              // column reference or scalar SQL expression
  type?: string;                   // logical type; often inferable from source schema
  description?: string;
  synonyms?: string[];
  // Set only when `expression` was taken verbatim from a non-target, non-canonical
  // vendor dialect (e.g. 'SNOWFLAKE'): the dialect it was authored in. It marks
  // the expression as a candidate for transpilation to the target dialect (see
  // ./transpile), which clears this once the rewrite is applied.
  expressionDialect?: string;
}

/**
 * A relationship: a directed edge in the semantic graph, from `source` to
 * `destination`. May be backed by its own association (edge) table
 * (`dataSource`); when absent, it is a direct foreign-key join. Carries its own
 * `fields` (edge properties).
 */
export interface Relationship {
  name: string;
  source: RelationshipEnd;
  destination: RelationshipEnd;
  dataSource?: DataSource;  // association/edge table; absent => direct FK join
  keys?: string[];          // edge key (when backed by an association table)
  description?: string;
  synonyms?: string[];
  fields?: Field[];         // edge properties
}

/**
 * One endpoint of a relationship.
 *
 * `joinKeys.relationshipColumns` are the columns on the edge/source table;
 * `joinKeys.entityColumns` are the referenced columns on the endpoint entity
 * (defaulting to that entity's `keys`).
 */
export interface RelationshipEnd {
  entity: string;        // name-reference into SemanticModel.entities
  joinKeys: JoinKeys;
}

export interface JoinKeys {
  relationshipColumns: string[];
  entityColumns: string[];
}

/**
 * A metric: a model-level, named aggregate.
 *
 * Because it lives on the model rather than a single entity, a metric may span
 * multiple entities — its `expression` can reference fields across the graph,
 * joined via relationships. `entities` lists the entities the metric references
 * (one for an entity-scoped metric, several for a cross-entity metric); the
 * join path between them is resolved by consumers via the model's relationships.
 */
export interface Metric {
  name: string;
  expression: string;    // aggregate expression, may reference entity-qualified fields
  entities: string[];    // entities referenced by the metric (>= 1)
  description?: string;
  synonyms?: string[];
  // As on `Field`: set only when `expression` was taken verbatim from a
  // non-target, non-canonical vendor dialect. Marks it as a candidate for
  // transpilation (see ./transpile), which clears this once applied.
  expressionDialect?: string;
}
