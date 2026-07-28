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
//

import type { Entry, Aspect } from '../gcp/dataplex';
import { SemanticModel, Entity, Field, Relationship, RelationshipEnd, Metric, DataSource } from './ir';
import { dedupe } from './expr';

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

// One endpoint of an EntryLink. Dataplex EntryLinks carry only references, not
// free-form data, so relationship metadata lives elsewhere (see file header).
export interface EntryReference {
  name: string;                 // referenced entry resource name
  type: 'SOURCE' | 'TARGET';
}

// A directed catalog edge between two entries. Not yet part of the Dataplex
// client surface (no createEntryLink) — defined here so the emitter is complete
// and the orchestration layer has a typed value to write once the verb lands.
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
  const entries: Entry[] = [];

  // The model entry is the anchor/parent for the entity and measure entries. Its
  // aspect also carries the model-level relationship structure (join keys, edge
  // properties) that an EntryLink cannot hold.
  const modelEntry: Entry = {
    name: names.entry(names.modelId(model)),
    entryType: names.typeName('entry', 'semantic-model'),
    entrySource: source(model.name, model.description),
    aspects: aspectMap(names, 'semantic-model', compact({
      name: model.name,
      description: model.description,
      relationships: relationships.length ? relationships.map(relationshipData) : undefined,
    })),
  };
  entries.push(modelEntry);

  for (const entity of entities) {
    if (!entity.keys || !entity.keys.length) {
      warnings.push(`entity '${entity.name}': no keys; the semantic-entity aspect will have an empty key list`);
    }
    entries.push({
      name: names.entry(names.entityId(model, entity)),
      entryType: names.typeName('entry', 'semantic-entity'),
      parentEntry: modelEntry.name,
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
      name: names.entry(names.measureId(model, metric)),
      entryType: names.typeName('entry', 'semantic-measure'),
      parentEntry: modelEntry.name,
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

  // Each relationship becomes one EntryLink (the KC-native graph edge). The join
  // keys / edge properties already travel in the model aspect above; the link is
  // the traversable structure. Drop (with a warning) a link whose endpoints the
  // model does not declare, since the reference could not resolve.
  const entryLinks: EntryLink[] = [];
  for (const rel of relationships) {
    const dangling = [rel.source?.entity, rel.destination?.entity].filter(e => !e || !known.has(e));
    if (dangling.length) {
      warnings.push(
        `relationship '${rel.name}': references unknown entity ` +
        `${dangling.map(e => `'${e ?? ''}'`).join(', ')}; entry link omitted`);
      continue;
    }
    entryLinks.push({
      name: names.link(names.relationshipId(model, rel)),
      entryLinkType: names.typeName('entryLink', 'semantic-relationship'),
      entryReferences: [
        { name: names.entry(names.entityIdFor(model, rel.source.entity)), type: 'SOURCE' },
        { name: names.entry(names.entityIdFor(model, rel.destination.entity)), type: 'TARGET' },
      ],
    });
  }

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
    return `${slug(model.name)}.relationships.${slug(rel.name)}`;
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

// Entry/link IDs allow letters, numbers, underscores, hyphens, and periods; map
// anything else to an underscore so a model/entity name with spaces or other
// characters still yields a valid, stable ID.
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
