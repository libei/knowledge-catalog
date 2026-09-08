// How a model's MANY-TO-MANY relationships are encoded in Knowledge Catalog.
//
// A one-to-many relationship publishes as a built-in `schema-join` entry link
// between the two entity entries. A many-to-many one cannot: schema-join holds
// a single source/target column pair, and a junction is two joins through a
// third table. A custom entry LINK type is not an option either -- Dataplex
// accepts only its own link types. So a many-to-many edge publishes as an ENTRY
// instead, one per relationship, parented to the model anchor beside the
// entities and metrics, carrying an aspect that holds both joins and the
// junction table. The type is the custom `semantic-association` pair DECLARED
// IN kc_custom_types.ts and created there by `kcmd init --semantic-model`. That
// file is the list of what is custom; this one is only the encoding that fills
// the aspect.
//
// The custom pair is what makes a many-to-many edge explicit in the catalog. A
// search can tell one apart from anything else by its entry type, and the
// aspect's fields are typed and queryable rather than prose a reader has to
// interpret.
//
// WHEN A BUILT-IN MANY-TO-MANY TYPE SHIPS, follow the instructions at the top
// of kc_custom_types.ts. Nothing in this file changes: the readers below match
// a type by its id suffix, so they do not care which project it lives in. If
// what ships instead is a schema-join that can model a junction, this file goes
// away and `relationshipLink` in knowledge_catalog.ts stops skipping M:N.
//
// The call sites are `knowledge_catalog.ts` (emit the entries),
// `kc_converter.ts` (read them back), and `pull_kc.ts` (hydrate the aspect).
//
// `instructions` and the edge's own `fields` ride the association's aspect
// rather than the built-in `guidelines` and `schema` aspects an entity uses. A
// pull derives which aspect types to hydrate from the project the ENTRY type
// lives in, so an association entry, whose type is custom and therefore in the
// destination project, would ask for aspect types that exist only under
// `dataplex-types`. Keeping both on the association's own aspect keeps the
// whole encoding inside the one type kc_custom_types.ts provisions.
//
// The helpers at the bottom duplicate a few lines from the modules above on
// purpose. This module imports only the IR, the entry shape and the type
// registry, so it can be swapped or deleted as a unit.

import {Entry} from '../gcp/dataplex';

import {AiContext, Association, DATA_TYPES, DataType, Field, Relationship, SemanticModel} from './ir';
import {ASSOCIATION_TYPE_ID, customAspectKey, customAspectTypeName, customEntryTypeName} from './kc_custom_types';

// Full resource name of the association entry type for a destination.
export function associationEntryTypeName(dest: {project: string}): string {
  return customEntryTypeName(ASSOCIATION_TYPE_ID, dest);
}

// Full resource name of the association aspect type for a destination.
export function associationAspectTypeName(dest: {project: string}): string {
  return customAspectTypeName(ASSOCIATION_TYPE_ID, dest);
}

// Aspect-map key: the `project.location.type` reference form the client keys an
// entry's aspects by.
export function associationAspectKey(dest: {project: string}): string {
  return customAspectKey(ASSOCIATION_TYPE_ID, dest);
}


// ---------------------------------------------------------------------------
// Write side: the IR -> one entry per many-to-many relationship.
// ---------------------------------------------------------------------------

// What the emitter supplies so this file need not rebuild entry names or repeat
// the id-collision bookkeeping it already does for entities and metrics.
export interface AssociationEmitContext {
  // The destination project, which is where the custom types live.
  project: string;
  // Full entry resource name for an entry id (Namer.entry).
  entry(entryId: string): string;
  // Full entry resource name of the model anchor, the parent of every
  // association.
  anchor: string;
  // Reserves an entry id, returning false when it collides with one already
  // emitted (knowledge_catalog.claim).
  claim(entryId: string, label: string): boolean;
  // Names of the entities this push actually publishes an entry for. An
  // abstract entity, or one a binding profile pruned, is absent, so an edge
  // ending on it would name an entity the catalog has no entry for.
  publishedEntities: Set<string>;
  // Renders a table into the linked-resource form the catalog stores
  // (knowledge_catalog.resourcePath), so the junction is addressed the same way
  // an entity's backing table is.
  resource(dataSource: string): string;
}

// The entry id of one association: `<model>.associations.<name>`, alongside
// `<model>.entities.<name>` and `<model>.metrics.<name>`.
export function associationEntryId(modelId: string, relName: string): string {
  return `${modelId}.associations.${slug(relName)}`;
}

// The entry-id prefix a model's associations occupy, so delete reconciliation
// removes the entry of a relationship dropped from the model.
export function associationOwnedPrefix(modelId: string): string {
  return `${modelId}.associations.`;
}

/**
 * One entry per many-to-many relationship, to append to the model's entries.
 *
 * Empty when the model declares none, so a model of only foreign-key edges is
 * unchanged from before this type existed. An edge whose endpoint entity this
 * push does not publish is skipped with a warning, the same way
 * `relationshipLink` skips a foreign-key edge in that situation.
 */
export function associationEntries(
    model: SemanticModel, modelId: string, ctx: AssociationEmitContext,
    warnings: string[]): Entry[] {
  const entries: Entry[] = [];
  for (const rel of model.relationships ?? []) {
    const assoc = rel.association;
    if (!assoc) continue;

    const missing = !ctx.publishedEntities.has(rel.source.entity) ?
        rel.source.entity :
        !ctx.publishedEntities.has(rel.destination.entity) ?
        rel.destination.entity :
        undefined;
    if (missing !== undefined) {
      warnings.push(
          `relationship '${rel.name}': endpoint entity '${missing}' is not a ` +
          `published entity; the many-to-many relationship is skipped.`);
      continue;
    }

    const id = associationEntryId(modelId, rel.name);
    if (!ctx.claim(id, `many-to-many relationship '${rel.name}'`)) continue;
    entries.push({
      name: ctx.entry(id),
      entryType: associationEntryTypeName(ctx),
      parentEntry: ctx.anchor,
      entrySource: compact({
                     displayName: rel.name,
                     description: rel.description,
                   }) as Entry['entrySource'],
      aspects: {
        [associationAspectKey(ctx)]: {
          aspectType: associationAspectTypeName(ctx),
          data: associationAspectData(rel, assoc, ctx),
        },
      },
    });
  }
  return entries;
}

// The aspect payload for one many-to-many relationship: its two endpoints, the
// junction table and the columns on it that reach each endpoint, the edge's own
// properties, and any AI instructions.
function associationAspectData(
    rel: Relationship, assoc: Association,
    ctx: AssociationEmitContext): Record<string, any> {
  return compact({
    fromEntity: rel.source.entity,
    toEntity: rel.destination.entity,
    // A model with no physical binding has no junction table to name; the
    // template leaves the field optional, so omit it rather than store ''.
    junction: ctx.resource(assoc.dataSource) || undefined,
    keys: nonEmpty(assoc.keys),
    fromColumns: nonEmpty(assoc.sourceColumns),
    toColumns: nonEmpty(assoc.destinationColumns),
    fields: nonEmpty(
        (assoc.fields ??
         []).map(f => compact({
                   name: f.name,
                   // An untyped field is published as Opaque, the explicit
                   // "type unknown" marker, so a pull recovers it as Opaque
                   // rather than dropping the type
                   // -- what the built-in schema aspect does for an entity's
                   // fields.
                   dataType: f.type ?? 'Opaque',
                   description: f.description,
                   expression: f.expression,
                 }))),
    instructions: rel.aiContext?.instructions || undefined,
  });
}


// ---------------------------------------------------------------------------
// Read side: an association entry -> the IR.
// ---------------------------------------------------------------------------

// True when an entry is one of a model's many-to-many relationships, matched by
// the entry type's id suffix so the project the type lives in need not be known
// -- which is what lets a pull keep working when the custom type is replaced by
// a built-in one.
export function isAssociationEntry(entry: Entry): boolean {
  return entry.entryType?.endsWith(`/entryTypes/${ASSOCIATION_TYPE_ID}`) ??
      false;
}

// The aspect type resource names to hydrate for an association entry. Named
// through the entry type's own project so the pull follows the type wherever it
// lives.
export function associationAspectTypes(entryTypeBase: string): string[] {
  return [`${entryTypeBase}/aspectTypes/${ASSOCIATION_TYPE_ID}`];
}

/**
 * Recovers one many-to-many relationship from its entry, the inverse of
 * associationEntries.
 *
 * Returns undefined, with a warning, for an entry naming an endpoint that is
 * not one of the model's entities, or missing a junction column list: an edge
 * that cannot say what it joins is not a usable relationship, and one bad entry
 * degrades itself rather than the pull.
 */
export function readAssociation(
    entry: Entry, entityNames: string[], warnings: string[]): Relationship|
    undefined {
  const name = entry.entrySource?.displayName || idOf(entry.name);
  const data = associationAspectDataOf(entry);
  const known = new Set(entityNames);

  const from = str(data.fromEntity);
  const to = str(data.toEntity);
  for (const [side, end] of [['fromEntity', from], ['toEntity', to]] as const) {
    if (!known.has(end)) {
      warnings.push(
          `many-to-many relationship '${name}': ${side} '${end}' is not one ` +
          `of the model's entities; the relationship is skipped`);
      return undefined;
    }
  }

  const fromColumns = stringList(data.fromColumns);
  const toColumns = stringList(data.toColumns);
  if (!fromColumns.length || !toColumns.length) {
    const side = !fromColumns.length ? 'from' : 'to';
    warnings.push(
        `many-to-many relationship '${name}': the ${ASSOCIATION_TYPE_ID} ` +
        `aspect names no junction column on the ${side} end; the ` +
        `relationship is skipped`);
    return undefined;
  }

  const association: Association = {
    dataSource: dataSourceFromResource(str(data.junction)),
    keys: stringList(data.keys),
    sourceColumns: fromColumns,
    destinationColumns: toColumns,
  };
  const fields = asArray(data.fields)
                     .map(f => readField(f))
                     .filter((f): f is Field => f !== undefined);
  if (fields.length) association.fields = fields;

  // A many-to-many edge carries no columns on either ENDPOINT table: the
  // columns that bind it are the junction's, above. Empty lists here are what
  // the loader produces for an authored `association`, so the two agree.
  const relationship: Relationship = {
    name,
    source: {entity: from, columns: []},
    destination: {entity: to, columns: []},
    association,
  };
  const description = entry.entrySource?.description;
  if (description !== undefined && description !== '') {
    relationship.description = description;
  }
  const instructions = str(data.instructions);
  if (instructions) relationship.aiContext = {instructions} as AiContext;
  return relationship;
}

// One edge property from its aspect record. A record with no name is dropped: a
// nameless field cannot be referenced and would not survive a reload.
function readField(f: any): Field|undefined {
  const name = str(f?.name);
  if (!name) return undefined;
  const field: Field = {name};
  const expression = str(f?.expression);
  if (expression) field.expression = expression;
  const dataType = str(f?.dataType);
  if ((DATA_TYPES as readonly string[]).includes(dataType)) {
    field.type = dataType as DataType;
  }
  const description = str(f?.description);
  if (description) field.description = description;
  return field;
}


// ---------------------------------------------------------------------------
// Local helpers (see the file header on why they are not shared).
// ---------------------------------------------------------------------------

// The association aspect's `data` from an entry, matched by the aspect key's
// `.semantic-association` suffix or the aspectType's
// `/aspectTypes/semantic-association` suffix, so it is found whichever project
// the type was provisioned in.
function associationAspectDataOf(entry: Entry): Record<string, any> {
  for (const [key, aspect] of Object.entries(entry.aspects ?? {})) {
    if (key.endsWith(`.${ASSOCIATION_TYPE_ID}`) ||
        aspect.aspectType?.endsWith(`/aspectTypes/${ASSOCIATION_TYPE_ID}`)) {
      return aspect.data ?? {};
    }
  }
  return {};
}

// The dotted `project.dataset.table` form of a stored linked resource, the
// inverse of knowledge_catalog.resourcePath. Anything that is not a BigQuery
// table URI comes back as it was stored.
function dataSourceFromResource(resource: string): string {
  const value = resource.trim();
  const m = value.match(
      /^\/\/bigquery\.googleapis\.com\/projects\/([^/]+)\/datasets\/([^/]+)\/tables\/([^/]+)$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : value;
}

// Entry ids allow letters, numbers, underscores, hyphens, and periods.
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// The id segment of a full entry resource name.
function idOf(name: string): string {
  return name.split('/').pop() ?? name;
}

// Drops undefined-valued keys so the emitted aspect (and its golden) only shows
// fields the model actually set.
function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

// The non-empty strings of an array value, dropping non-string and empty
// members so a degenerate '' does not round-trip.
function stringList(value: any): string[] {
  return asArray(value).filter(
      (s): s is string => typeof s === 'string' && s !== '');
}

function str(value: any): string {
  return typeof value === 'string' ? value : '';
}

function nonEmpty<T>(list: T[]): T[]|undefined {
  return list.length ? list : undefined;
}
