// Generates Knowledge Catalog (Dataplex) resources from the Semantic Model IR.
//
// The IR (./ir) is pure semantics. This module is its Knowledge Catalog emitter,
// the counterpart to `bigquery.ts`: it maps the model to catalog resources —
// `semantic-model` / `semantic-entity` / `semantic-measure` Entries (each
// carrying the matching `semantic-*` Aspect) plus `semantic-relationship`
// EntryLinks for the graph edges. Like `bigquery.ts` it is a PURE function of the
// IR: no GCP calls, no I/O. The orchestration layer (`kc.ts`, the counterpart to
// `deploy.ts`) drives this emitter and writes the resulting resources via the
// Dataplex catalog client.
//
// Scope of this first cut (the "solid" subset — see the KC-publisher design):
//   * Model, entities, and measures become Entries + Aspects; relationships
//     become EntryLinks. All of these are representable with resource shapes that
//     already exist on the client (Entry/Aspect) or are trivially serializable
//     (EntryLink), so the output is golden-testable today.
//   * Entity fields are carried as a list inside the `semantic-entity` aspect.
//     Attaching them instead as column-level `semantic-field` aspects (keyed
//     `<aspectRef>@<path>`) is the planned evolution; it depends on a schema-aspect
//     path model and a client fix (the dotted `@path` aspect-key handling), so it
//     is deliberately out of this first cut.
//   * An EntryLink carries only its endpoints; a relationship's join keys and edge
//     properties therefore travel in the `semantic-model` aspect's `relationships`
//     list (the model-level structure sink) so nothing is dropped.
//   * EntryLink ids are more restricted than entry ids (lowercase letters, digits,
//     and hyphens only, starting with a letter) — verified against the live
//     Dataplex API, which accepts the dotted/underscored `slug` ids for entries
//     but rejects them for entry links — so link ids use a separate `linkSlug`.
//
// Live validation (against real Dataplex): the aspect-data shapes below were
// confirmed writable — the `semantic-*` aspect types accept them and the nested
// model-aspect relationship (join keys included) round-trips through a write+read.
// Two constraints remain server-side: aspect types validate a CLOSED schema (an
// undeclared data field is rejected), and the `semantic-relationship` entry link
// *type* is a system type that is not user-creatable and not yet provisioned, so
// the directed relationship edges emitted here cannot be written until it lands
// (no predefined link type is both directed and valid over `semantic-entity`
// endpoints). See kc.ts.
//

import type { Entry, Aspect } from '../gcp/dataplex';
import { SemanticModel, Entity, Field, Relationship, RelationshipEnd, Metric, DataSource } from './ir';
import { dedupe, referencedEntityNames } from './expr';

// Where the `semantic-*` system entry/aspect/link types live. Option 1 of the KC
// semantic-model design lands the system types in project `dataplex-types`,
// location `global`; callers may override for a staging project.
const DEFAULT_TYPE_PROJECT = 'dataplex-types';
const DEFAULT_TYPE_LOCATION = 'global';

export interface KcGenerateOptions {
  project: string;      // project the entries/links are created in (destination)
  location: string;     // destination location
  entryGroup: string;   // destination entry group
  systemTypeProject?: string;   // default 'dataplex-types'
  systemTypeLocation?: string;  // default 'global'
}

// The bare type ids of the semantic types push provisions and references. Entry
// types and aspect types share these ids (the aspect type is the parallel
// resource of the same name); there is one aspect metadataTemplate per id below.
export const SEMANTIC_TYPE_IDS = ['semantic-model', 'semantic-entity', 'semantic-measure'] as const;

// ---------------------------------------------------------------------------
// Aspect-type metadataTemplates
//
// A Dataplex aspect type validates its aspects against a CLOSED schema (an
// undeclared data field is rejected). These metadataTemplates are that schema for
// the `semantic-*` aspect data emitted above — their field names and nesting must
// match aspectMap's `data` payloads EXACTLY (keys/description/synonyms/source/
// fields, expression/entities/expressionDialect, name/relationships/join keys).
// They are the write-side counterpart of the read-side aspect shapes; the live
// KC-emitter validation confirmed these exact templates accept the emitted data
// and round-trip it. They live here, beside the emitter, so a schema change and
// the aspect shape it must match are one reviewable diff.
// ---------------------------------------------------------------------------

// A metadataTemplate field for an array of strings.
function tplStrArray(name: string, index: number): Record<string, any> {
  return { name, type: 'array', index, arrayItems: { name: `${name}_item`, type: 'string' } };
}

// A record of {project, dataset, table} — the DataSource shape (sourceData).
function tplSourceRecord(name: string, index: number): Record<string, any> {
  return {
    name, type: 'record', index, recordFields: [
      { name: 'project', type: 'string', index: 1 },
      { name: 'dataset', type: 'string', index: 2 },
      { name: 'table', type: 'string', index: 3 },
    ],
  };
}

// A field record — the Field shape (fieldData).
function tplFieldRecord(index: number, itemName = 'field'): Record<string, any> {
  return {
    name: itemName, type: 'record', index, recordFields: [
      { name: 'name', type: 'string', index: 1 },
      { name: 'expression', type: 'string', index: 2 },
      { name: 'type', type: 'string', index: 3 },
      { name: 'description', type: 'string', index: 4 },
      tplStrArray('synonyms', 5),
      { name: 'expressionDialect', type: 'string', index: 6 },
    ],
  };
}

// A relationship end — the RelationshipEnd shape (endData): entity + join keys.
function tplEndRecord(name: string, index: number): Record<string, any> {
  return {
    name, type: 'record', index, recordFields: [
      { name: 'entity', type: 'string', index: 1 },
      {
        name: 'joinKeys', type: 'record', index: 2, recordFields: [
          tplStrArray('relationshipColumns', 1),
          tplStrArray('entityColumns', 2),
        ],
      },
    ],
  };
}

// The metadataTemplate for each `semantic-*` aspect type, keyed by type id. The
// publisher (kc.ts) passes the entry for a given id to createAspectType.
export function aspectTypeTemplates(): Record<string, any> {
  return {
    'semantic-measure': {
      type: 'record', name: 'semantic_measure', recordFields: [
        { name: 'expression', type: 'string', index: 1 },
        tplStrArray('entities', 2),
        { name: 'description', type: 'string', index: 3 },
        tplStrArray('synonyms', 4),
        { name: 'expressionDialect', type: 'string', index: 5 },
      ],
    },
    'semantic-entity': {
      type: 'record', name: 'semantic_entity', recordFields: [
        tplStrArray('keys', 1),
        { name: 'description', type: 'string', index: 2 },
        tplStrArray('synonyms', 3),
        tplSourceRecord('source', 4),
        { name: 'fields', type: 'array', index: 5, arrayItems: tplFieldRecord(1) },
      ],
    },
    'semantic-model': {
      type: 'record', name: 'semantic_model', recordFields: [
        { name: 'name', type: 'string', index: 1 },
        { name: 'description', type: 'string', index: 2 },
        {
          name: 'relationships', type: 'array', index: 3, arrayItems: {
            name: 'relationship', type: 'record', recordFields: [
              { name: 'name', type: 'string', index: 1 },
              { name: 'description', type: 'string', index: 2 },
              tplStrArray('synonyms', 3),
              tplEndRecord('source', 4),
              tplEndRecord('destination', 5),
              tplStrArray('keys', 6),
              tplSourceRecord('dataSource', 7),
              { name: 'fields', type: 'array', index: 8, arrayItems: tplFieldRecord(1) },
            ],
          },
        },
      ],
    },
  };
}


// One endpoint of an EntryLink. Dataplex EntryLinks carry only references, not
// free-form data, so relationship metadata lives elsewhere (see file header).
export interface EntryReference {
  name: string;                 // referenced entry resource name
  type: 'SOURCE' | 'TARGET';
}

// A directed catalog edge between two entries. The Dataplex REST API does expose
// entryLinks.create (verified live), but our CatalogClient does not wrap it yet
// and the `semantic-relationship` entryLinkType it references is a server-side
// system type that is not user-creatable and not yet provisioned — so writing
// these edges is deferred to the orchestration layer. Defined here so the emitter
// is complete and produces a typed value to write once that type lands.
export interface EntryLink {
  name: string;                 // full entryLink resource name
  entryLinkType: string;        // full entryLinkType resource name
  entryReferences: EntryReference[];
}

export interface KcResources {
  entries: Entry[];
  entryLinks: EntryLink[];
  warnings: string[];
}

/**
 * Generates the Knowledge Catalog resources for a semantic model.
 *
 * Returns the entries, entry links, and any warnings collected while mapping the
 * IR (missing entities, dangling references, empty keys). The resources reference
 * the `semantic-*` system types; they do not create them.
 */
export function generateCatalogResources(model: SemanticModel,
                                         opts: KcGenerateOptions): KcResources {
  const warnings: string[] = [];
  const entities = model.entities ?? [];
  const relationships = model.relationships ?? [];
  const metrics = model.metrics ?? [];

  if (!entities.length) {
    warnings.push('model has no entities; only the semantic-model entry will be generated');
  }

  const names = new Namer(opts);
  const known = new Set(entities.map(e => e.name));

  // Entry and entry-link IDs must be unique within their Dataplex collection
  // (entries / entryLinks). Two source names that normalize to the same id (see
  // slug), or exact duplicates the loader did not reject, would otherwise emit
  // two resources with the same name — and the later write would silently
  // overwrite the earlier. Track emitted ids and skip a collision with a warning
  // rather than publish an overwrite.
  const seenEntryIds = new Set<string>();
  const seenLinkIds = new Set<string>();

  // The model entry is the anchor and the parent of every entity/measure entry,
  // so it must be created first. That ordering is encoded structurally: it is
  // always entries[0] (unshifted in below), and the publisher creates entries in
  // array order. Its id is reserved up front so nothing else can claim it.
  const modelEntryName = names.entry(names.modelId(model));
  claim(seenEntryIds, names.modelId(model), 'entry', `model '${model.name}'`, warnings);

  const entries: Entry[] = [];

  for (const entity of entities) {
    const entityId = names.entityId(model, entity);
    if (!claim(seenEntryIds, entityId, 'entry', `entity '${entity.name}'`, warnings)) continue;
    if (!entity.keys || !entity.keys.length) {
      warnings.push(`entity '${entity.name}': no keys; the semantic-entity aspect will have an empty key list`);
    }
    entries.push({
      name: names.entry(entityId),
      entryType: names.typeName('entry', 'semantic-entity'),
      parentEntry: modelEntryName,
      entrySource: source(entity.name, entity.description),
      aspects: aspectMap(names, 'semantic-entity', compact({
        keys: entity.keys ?? [],
        description: entity.description,
        synonyms: entity.synonyms?.length ? entity.synonyms : undefined,
        source: sourceData(entity.dataSource),
        fields: (entity.fields ?? []).map(fieldData),
      })),
    });
  }

  for (const metric of metrics) {
    const measureId = names.measureId(model, metric);
    if (!claim(seenEntryIds, measureId, 'entry', `metric '${metric.name}'`, warnings)) continue;
    // A measure names the entities it spans. Flag references the model does not
    // declare rather than silently emitting a dangling entry reference.
    const refs = (metric.entities ?? []);
    const unknown = refs.filter(e => !known.has(e));
    if (unknown.length) {
      warnings.push(
        `metric '${metric.name}': references unknown ${plural(unknown.length, 'entity', 'entities')} ` +
        `${unknown.map(e => `'${e}'`).join(', ')}; still emitted (reference may not resolve)`);
    }
    entries.push({
      name: names.entry(measureId),
      entryType: names.typeName('entry', 'semantic-measure'),
      parentEntry: modelEntryName,
      entrySource: source(metric.name, metric.description),
      aspects: aspectMap(names, 'semantic-measure', compact({
        expression: metric.expression,
        entities: refs.map(e => names.entry(names.entityIdFor(model, e))),
        description: metric.description,
        synonyms: metric.synonyms?.length ? metric.synonyms : undefined,
        expressionDialect: metric.expressionDialect,
      })),
    });
  }

  // Each relationship becomes one EntryLink (the KC-native graph edge). Only a
  // relationship whose endpoints both resolve to a declared entity is emitted; one
  // with an unknown endpoint is dropped from BOTH the links and the model aspect
  // (below), so the model aspect never advertises an edge to an entity that has no
  // entry. The accepted set feeds the model aspect's join-key detail, which the
  // endpoint-only EntryLink cannot carry.
  const entryLinks: EntryLink[] = [];
  const acceptedRels: Relationship[] = [];
  for (const rel of relationships) {
    const dangling = [rel.source?.entity, rel.destination?.entity].filter(e => !e || !known.has(e));
    if (dangling.length) {
      warnings.push(
        `relationship '${rel.name}': references unknown entity ` +
        `${dangling.map(e => `'${e ?? ''}'`).join(', ')}; relationship omitted (no entry link, absent from model aspect)`);
      continue;
    }
    const linkId = names.relationshipId(model, rel);
    if (!claim(seenLinkIds, linkId, 'entry link', `relationship '${rel.name}'`, warnings)) continue;
    acceptedRels.push(rel);
    entryLinks.push({
      name: names.link(linkId),
      entryLinkType: names.typeName('entryLink', 'semantic-relationship'),
      entryReferences: [
        { name: names.entry(names.entityIdFor(model, rel.source.entity)), type: 'SOURCE' },
        { name: names.entry(names.entityIdFor(model, rel.destination.entity)), type: 'TARGET' },
      ],
    });
  }

  // The anchor carries the model-level relationship structure (join keys, edge
  // properties) an EntryLink cannot hold, built from the accepted set so it stays
  // consistent with the emitted links. Unshifted so it is created before its
  // children (see the ordering note above).
  const modelEntry: Entry = {
    name: modelEntryName,
    entryType: names.typeName('entry', 'semantic-model'),
    entrySource: source(model.name, model.description),
    aspects: aspectMap(names, 'semantic-model', compact({
      name: model.name,
      description: model.description,
      relationships: acceptedRels.length ? acceptedRels.map(relationshipData) : undefined,
    })),
  };
  entries.unshift(modelEntry);

  return { entries, entryLinks, warnings: dedupe(warnings) };
}


// Builds the fully-qualified resource names for a destination. Kept in one place
// so entry/link/type name construction is consistent and the emitter body reads
// as pure mapping.
class Namer {
  private readonly typeProj: string;
  private readonly typeLoc: string;
  constructor(private readonly opts: KcGenerateOptions) {
    this.typeProj = opts.systemTypeProject ?? DEFAULT_TYPE_PROJECT;
    this.typeLoc = opts.systemTypeLocation ?? DEFAULT_TYPE_LOCATION;
  }

  // Full resource name of a system type. `kind` selects the collection:
  // entryTypes / aspectTypes / entryLinkTypes.
  typeName(kind: 'entry' | 'aspect' | 'entryLink', name: string): string {
    return `projects/${this.typeProj}/locations/${this.typeLoc}/${kind}Types/${name}`;
  }

  // Aspect-map key: the `project.location.type` reference form the client uses to
  // key an entry's aspects (see snapshot.toServiceEntry / dataplex._fixEntry).
  aspectRef(name: string): string {
    return `${this.typeProj}.${this.typeLoc}.${name}`;
  }

  entry(entryId: string): string {
    return `${this.container()}/entries/${entryId}`;
  }

  link(linkId: string): string {
    return `${this.container()}/entryLinks/${linkId}`;
  }

  private container(): string {
    return `projects/${this.opts.project}/locations/${this.opts.location}/entryGroups/${this.opts.entryGroup}`;
  }

  modelId(model: SemanticModel): string {
    return slug(model.name);
  }
  entityId(model: SemanticModel, entity: Entity): string {
    return this.entityIdFor(model, entity.name);
  }
  entityIdFor(model: SemanticModel, entityName: string): string {
    return `${slug(model.name)}.entities.${slug(entityName)}`;
  }
  measureId(model: SemanticModel, metric: Metric): string {
    return `${slug(model.name)}.measures.${slug(metric.name)}`;
  }
  relationshipId(model: SemanticModel, rel: Relationship): string {
    // Entry link ids are stricter than entry ids (see linkSlug): the dotted
    // `<model>.relationships.<rel>` form used for entries is rejected for links.
    return linkSlug(`${model.name}-relationships-${rel.name}`);
  }
}


// Serializes a relationship verbatim into the model aspect. Entity references
// stay as declared names (resolvable within the model); join keys and edge
// properties are preserved so the EntryLink's endpoint-only shape loses nothing.
function relationshipData(rel: Relationship): Record<string, any> {
  return compact({
    name: rel.name,
    description: rel.description,
    synonyms: rel.synonyms?.length ? rel.synonyms : undefined,
    source: endData(rel.source),
    destination: endData(rel.destination),
    keys: rel.keys?.length ? rel.keys : undefined,
    dataSource: rel.dataSource ? sourceData(rel.dataSource) : undefined,
    fields: rel.fields?.length ? rel.fields.map(fieldData) : undefined,
  });
}

function endData(end: RelationshipEnd): Record<string, any> {
  return {
    entity: end.entity,
    joinKeys: {
      relationshipColumns: end.joinKeys.relationshipColumns,
      entityColumns: end.joinKeys.entityColumns,
    },
  };
}

function fieldData(field: Field): Record<string, any> {
  return compact({
    name: field.name,
    expression: field.expression,
    type: field.type,
    description: field.description,
    synonyms: field.synonyms?.length ? field.synonyms : undefined,
    expressionDialect: field.expressionDialect,
  });
}

function sourceData(ds: DataSource | undefined): Record<string, any> | undefined {
  if (!ds) return undefined;
  return compact({ project: ds.project, dataset: ds.dataset, table: ds.table });
}


// Wraps one aspect's data as the single-entry aspect map keyed by the client's
// `project.location.type` reference form, with the fully-qualified aspectType.
//
// NOTE: the `data` field names produced by the callers (e.g. `joinKeys`,
// `relationshipColumns`, `expressionDialect`, `dataSource`) are the emitter's
// contract with the server-side `semantic-*` aspect-type schemas. Those schemas
// do not exist yet; when they land, the field names here must match them exactly
// or writes will fail aspect-schema validation. The golden tests pin this shape
// so any schema-driven rename is a visible, reviewable diff.
function aspectMap(names: Namer, type: string, data: Record<string, any>): Record<string, Aspect> {
  return { [names.aspectRef(type)]: { aspectType: names.typeName('aspect', type), data } };
}

// The native catalog entry source (display name + description), separate from the
// semantic-* aspect copy that carries full model fidelity.
function source(displayName: string, description?: string): Entry['entrySource'] {
  return compact({ displayName, description }) as Entry['entrySource'];
}

// Drops undefined-valued keys so the emitted JSON (and its golden) only shows
// fields the model actually set — matching how the BigQuery emitter omits empty
// OPTIONS rather than rendering blanks.
function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// Records a generated resource id in `seen`, returning true when it is new. On a
// repeat it warns and returns false so the caller can skip that resource: two
// resources sharing one name would otherwise have the later write silently
// overwrite the earlier one on publish.
function claim(seen: Set<string>, id: string, kind: string, label: string, warnings: string[]): boolean {
  if (seen.has(id)) {
    warnings.push(
      `${label}: generated ${kind} id '${id}' duplicates an earlier one; ` +
      `skipped (rename to avoid overwriting it on publish)`);
    return false;
  }
  seen.add(id);
  return true;
}

// Entry IDs allow letters, numbers, underscores, hyphens, and periods; map
// anything else to an underscore so a model/entity name with spaces or other
// characters still yields a valid, stable ID.
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// Entry LINK IDs are more restricted than entry IDs (confirmed against the live
// Dataplex API): lowercase letters, digits, and hyphens only, must start with a
// letter and end alphanumeric. Lowercase, replace every other run with a single
// hyphen, trim edge hyphens, and prefix a letter if what remains does not start
// with one. Distinct source names can still collapse to the same id; the caller's
// collision guard (claim) catches that.
function linkSlug(s: string): string {
  const body = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(body) ? body : `x-${body}`.replace(/-+$/g, '');
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}


// ---------------------------------------------------------------------------
// Reader: Knowledge Catalog resources -> Semantic Model IR
//
// The inverse of generateCatalogResources, used by the `pull` path (kc.ts reads
// the entries+aspects from Dataplex, this reconstructs the IR, serialize.ts
// writes it back to YAML). It is a PURE function of already-hydrated entries: the
// caller is responsible for fetching each entry's `semantic-*` aspect (BASIC list
// views omit aspect data). Resources are matched by type-name suffix, so a reader
// does not need to know the system-type project/location the emitter used.
//
// Fidelity mirrors the emitter: everything the emitter persisted in aspect data
// round-trips (keys, data sources, fields, join keys, expressions,
// expressionDialect, synonyms, descriptions). A measure's `entities` list is
// re-derived from its expression (as the loader does), not read from the aspect.
// ---------------------------------------------------------------------------

export interface ReadResult {
  models: SemanticModel[];
  warnings: string[];
}

/**
 * Reconstructs the Semantic Model IR from Knowledge Catalog entries.
 *
 * Groups `semantic-entity` / `semantic-measure` entries under their
 * `semantic-model` anchor (via `parentEntry`), reading each entry's `semantic-*`
 * aspect. Entries of other types are ignored. Returns one model per anchor plus
 * any warnings (missing anchor, orphaned children, entries without their aspect).
 */
export function modelsFromCatalogResources(entries: Entry[]): ReadResult {
  const warnings: string[] = [];

  const anchors = entries.filter(e => semanticType(e) === 'semantic-model');
  const entityEntries = entries.filter(e => semanticType(e) === 'semantic-entity');
  const measureEntries = entries.filter(e => semanticType(e) === 'semantic-measure');

  if (!anchors.length) {
    warnings.push('no semantic-model entry found; nothing to reconstruct');
    return { models: [], warnings: dedupe(warnings) };
  }

  // A child belongs to its anchor by parentEntry. When there is exactly one
  // anchor, children whose parentEntry does not resolve (e.g. a project-id
  // normalization mismatch) are still attached to it rather than dropped.
  const anchorNames = new Set(anchors.map(a => a.name));
  const soleAnchor = anchors.length === 1 ? anchors[0].name : undefined;
  const childrenOf = (anchorName: string, pool: Entry[]) => pool.filter(e =>
    e.parentEntry === anchorName || (soleAnchor === anchorName && !anchorNames.has(e.parentEntry ?? '')));

  const models = anchors.map(anchor => {
    const data = semanticData(anchor, 'semantic-model');
    const name = (data.name as string) ?? anchor.entrySource?.displayName ?? anchor.name;

    const entities = childrenOf(anchor.name, entityEntries).map(e => readEntity(e, warnings));
    const entityNames = entities.map(e => e.name);
    const metrics = childrenOf(anchor.name, measureEntries).map(
      e => readMetric(e, entityNames, warnings));
    const relationships = (asArray(data.relationships)).map(readRelationship);

    const model: SemanticModel = { name, entities, relationships, metrics };
    if (data.description !== undefined) model.description = data.description as string;
    return model;
  });

  // Flag children that resolved to no anchor at all (only possible with multiple
  // anchors, where the sole-anchor fallback does not apply).
  for (const child of [...entityEntries, ...measureEntries]) {
    if (!child.parentEntry || !anchorNames.has(child.parentEntry)) {
      if (!soleAnchor) {
        warnings.push(`entry '${child.name}' has no resolvable parent semantic-model; omitted`);
      }
    }
  }

  return { models, warnings: dedupe(warnings) };
}


function readEntity(entry: Entry, warnings: string[]): Entity {
  const data = semanticData(entry, 'semantic-entity');
  const name = entry.entrySource?.displayName ?? entry.name;
  if (!data || !Object.keys(data).length) {
    warnings.push(`entity '${name}': no semantic-entity aspect data (fetch with the aspect type)`);
  }

  const entity: Entity = {
    name,
    dataSource: readDataSource(data.source),
    keys: asStringArray(data.keys),
    fields: asArray(data.fields).map(readField),
  };
  if (data.description !== undefined) entity.description = data.description as string;
  if (asArray(data.synonyms).length) entity.synonyms = asStringArray(data.synonyms);
  return entity;
}


function readMetric(entry: Entry, entityNames: string[], warnings: string[]): Metric {
  const data = semanticData(entry, 'semantic-measure');
  const name = entry.entrySource?.displayName ?? entry.name;
  if (data.expression === undefined) {
    warnings.push(`metric '${name}': no expression in semantic-measure aspect`);
  }
  const expression = (data.expression as string) ?? '';

  const metric: Metric = {
    name,
    expression,
    // Re-derived from the expression, exactly as the loader computes it, rather
    // than read from the aspect's (fully-qualified entry-name) references.
    entities: referencedEntityNames(expression, entityNames),
  };
  if (data.description !== undefined) metric.description = data.description as string;
  if (asArray(data.synonyms).length) metric.synonyms = asStringArray(data.synonyms);
  if (data.expressionDialect !== undefined) metric.expressionDialect = data.expressionDialect as string;
  return metric;
}


function readRelationship(rd: any): Relationship {
  const rel: Relationship = {
    name: rd.name,
    source: readEnd(rd.source),
    destination: readEnd(rd.destination),
  };
  if (rd.description !== undefined) rel.description = rd.description;
  if (asArray(rd.synonyms).length) rel.synonyms = asStringArray(rd.synonyms);
  if (asArray(rd.keys).length) rel.keys = asStringArray(rd.keys);
  if (rd.dataSource) rel.dataSource = readDataSource(rd.dataSource);
  if (asArray(rd.fields).length) rel.fields = asArray(rd.fields).map(readField);
  return rel;
}


function readEnd(end: any): RelationshipEnd {
  return {
    entity: end.entity,
    joinKeys: {
      relationshipColumns: asStringArray(end?.joinKeys?.relationshipColumns),
      entityColumns: asStringArray(end?.joinKeys?.entityColumns),
    },
  };
}


function readField(fd: any): Field {
  const field: Field = { name: fd.name, expression: fd.expression };
  if (fd.type !== undefined) field.type = fd.type;
  if (fd.description !== undefined) field.description = fd.description;
  if (asArray(fd.synonyms).length) field.synonyms = asStringArray(fd.synonyms);
  if (fd.expressionDialect !== undefined) field.expressionDialect = fd.expressionDialect;
  return field;
}


function readDataSource(source: any): DataSource {
  const ds: DataSource = { table: source?.table ?? '' };
  if (source?.project !== undefined) ds.project = source.project;
  if (source?.dataset !== undefined) ds.dataset = source.dataset;
  return ds;
}


// The bare `semantic-*` type name of an entry, matched by entryType suffix so the
// system-type project/location need not be known. Returns undefined for entries
// that are not part of a semantic model.
function semanticType(entry: Entry): 'semantic-model' | 'semantic-entity' | 'semantic-measure' | undefined {
  for (const t of ['semantic-model', 'semantic-entity', 'semantic-measure'] as const) {
    if (entry.entryType?.endsWith(`/entryTypes/${t}`)) return t;
  }
  return undefined;
}


// The `data` payload of an entry's `semantic-<type>` aspect, matched by the
// aspect key's `.<type>` suffix or the aspectType's `/aspectTypes/<type>` suffix
// (robust to whichever system-type project/location the emitter used). Returns an
// empty object when the aspect is absent.
function semanticData(entry: Entry, type: string): Record<string, any> {
  const aspects = entry.aspects ?? {};
  for (const [key, aspect] of Object.entries(aspects)) {
    if (key.endsWith(`.${type}`) || aspect.aspectType?.endsWith(`/aspectTypes/${type}`)) {
      return aspect.data ?? {};
    }
  }
  return {};
}


function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: any): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
