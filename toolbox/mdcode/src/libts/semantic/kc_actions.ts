// How a model's ACTIONS are persisted in Knowledge Catalog.
//
// This file holds the whole encoding, and it exists to be replaced.
//
// Every other construct in the model maps to a BUILT-IN system type under
// `projects/dataplex-types/locations/global`. A model, entity, or metric gets
// its own entry (`semantic-model` / `semantic-entity` / `semantic-metric`); a
// relationship becomes a `schema-join` entry link; the built-in `schema` and
// `guidelines` aspects carry the rest. There is no built-in type for an action.
// Until there is, this file defines a CUSTOM pair, an entry type and an aspect
// type both named `semantic-action`, provisioned in the destination project at
// `global` by `kcmd init --semantic-model`. An action is then published exactly
// the way a metric is: one entry per action, parented to the model anchor,
// carrying one aspect that holds the executor and the typed parameters.
//
// The custom pair is what makes an action explicit in the catalog. A search can
// tell an action apart from anything else by its entry type, and the aspect's
// fields are typed and queryable rather than prose a reader has to interpret.
//
// WHEN A BUILT-IN ACTION TYPE SHIPS. Change actionTypeHome to return the
// system-type home the caller already passes for every other construct, then
// delete ACTION_ASPECT_TYPE_SPEC, actionEntryTypeSpec, and the
// provisionActionTypes call in `kcmd init`. Nothing else moves: the entry
// shape, the entry ids, the owned prefix, the reader, and all four call sites
// stay as they are.
//
// The call sites are `knowledge_catalog.ts` (emit the entries),
// `kc_converter.ts` (read them back), `pull_kc.ts` (hydrate the aspect), and
// `src/tool/commands.ts` (provision the two types at init).
//
// `instructions` rides the action's own aspect rather than the built-in
// `guidelines` aspect that an entity or metric uses. A pull derives which
// aspect types to hydrate from the project the ENTRY type lives in, so an
// action entry, whose type is custom and therefore in the destination project,
// would ask for a `guidelines` aspect type that only exists under
// `dataplex-types`. Keeping the field on the action's own aspect keeps the
// whole encoding inside the one type this file provisions.
//
// The helpers at the bottom duplicate a few lines from the modules above on
// purpose. This module imports only the IR and the catalog client, so it can be
// swapped or deleted as a unit.

import {AspectType, CatalogClient, Entry, EntryType} from '../gcp/dataplex';

import {Action, ActionParameter, AiContext, DATA_TYPES, Executor, SemanticModel} from './ir';

// The bare id shared by the custom entry type and the custom aspect type. They
// are separate collections, so one name serves both, the way the built-in
// `semantic-metric` entry type and aspect type share theirs.
export const ACTION_TYPE_ID = 'semantic-action';

// Custom types are provisioned at `global` so an entry group in any region can
// reference them, matching where the built-in system types live.
const ACTION_TYPE_LOCATION = 'global';

// Where a destination's action types live. Today that is the destination
// project itself, because the types are custom and `kcmd init` creates them
// there. See the file header for what changes when a built-in type ships.
export function actionTypeHome(dest: {project: string}):
    {project: string; location: string} {
  return {project: dest.project, location: ACTION_TYPE_LOCATION};
}


// ---------------------------------------------------------------------------
// The custom types themselves.
// ---------------------------------------------------------------------------

// The aspect that carries an action's mechanics.
//
// The executor is FLATTENED rather than nested one record per kind: an aspect
// holds exactly one executor, and a flat record shows the reader which one at a
// glance instead of three sibling records of which two are empty. `parameters`
// mirrors ActionParameter, including the derived `isEntityRef` so a consumer
// that has not loaded the model can still tell an object reference from a
// scalar.
//
// Dataplex rejects a backwards-incompatible template change. A new field must
// be APPENDED with a fresh index; renumbering an existing one breaks the update
// for every project that already provisioned this type.
export const ACTION_ASPECT_TYPE_SPEC: Omit<AspectType, 'name'> = {
  displayName: 'Semantic Action',
  description:
      'A write operation defined on a semantic model: how it is executed, ' +
      'and the inputs it takes.',
  metadataTemplate: {
    name: ACTION_TYPE_ID,
    type: 'record',
    recordFields: [
      {
        index: 1,
        name: 'executorKind',
        type: 'string',
        constraints: {required: true},
        annotations: {
          displayName: 'Executor Kind',
          description:
              'How the action is executed: `mcp`, `rest`, or `grpc`. The ' +
              'fields for that kind, and only those, are set.',
        },
      },
      {
        index: 2,
        name: 'mcpServer',
        type: 'string',
        annotations: {
          displayName: 'MCP Server',
          description: 'Resource name of the MCP server hosting the tool.',
        },
      },
      {
        index: 3,
        name: 'mcpTool',
        type: 'string',
        annotations: {
          displayName: 'MCP Tool',
          description: 'Name of the tool to call on the MCP server.',
        },
      },
      {
        index: 4,
        name: 'restEndpoint',
        type: 'string',
        annotations: {
          displayName: 'REST Endpoint',
          description: 'URL the request is sent to.',
        },
      },
      {
        index: 5,
        name: 'restMethod',
        type: 'string',
        annotations: {
          displayName: 'REST Method',
          description: 'HTTP method, for example POST.',
        },
      },
      {
        index: 6,
        name: 'grpcService',
        type: 'string',
        annotations: {
          displayName: 'gRPC Service',
          description: 'Fully qualified name of the gRPC service.',
        },
      },
      {
        index: 7,
        name: 'grpcMethod',
        type: 'string',
        annotations: {
          displayName: 'gRPC Method',
          description: 'Method on the gRPC service.',
        },
      },
      {
        index: 8,
        name: 'parameters',
        type: 'array',
        arrayItems: {
          name: 'parameter',
          type: 'record',
          recordFields: [
            {
              index: 1,
              name: 'name',
              type: 'string',
              constraints: {required: true},
              annotations: {displayName: 'Name'},
            },
            {
              index: 2,
              name: 'type',
              type: 'string',
              constraints: {required: true},
              annotations: {
                displayName: 'Type',
                description:
                    'The authored type: an entity name, or a scalar datatype.',
              },
            },
            {
              index: 3,
              name: 'isEntityRef',
              type: 'bool',
              annotations: {
                displayName: 'Is Entity Reference',
                description:
                    'True when `type` names an entity, so the parameter ' +
                    'refers to an object rather than carrying a value.',
              },
            },
          ],
        },
        annotations: {
          displayName: 'Parameters',
          description:
              'The inputs the action takes, each typed by the ontology.',
        },
      },
      {
        index: 9,
        name: 'instructions',
        type: 'string',
        annotations: {
          displayName: 'Instructions',
          description:
              'Guidance for AI consumers (the action\'s ai_context ' +
              'instructions).',
        },
      },
    ],
  },
};

// The entry type an action's entry carries. It requires the aspect above, so an
// action entry cannot exist without its mechanics.
export function actionEntryTypeSpec(dest: {project: string}):
    Omit<EntryType, 'name'> {
  return {
    displayName: 'Semantic Action',
    description: 'A write operation defined on a semantic model.',
    requiredAspects: [{type: actionAspectTypeName(dest)}],
  };
}

// Full resource name of the action entry type for a destination.
export function actionEntryTypeName(dest: {project: string}): string {
  const home = actionTypeHome(dest);
  return `projects/${home.project}/locations/${home.location}/entryTypes/${
      ACTION_TYPE_ID}`;
}

// Full resource name of the action aspect type for a destination.
export function actionAspectTypeName(dest: {project: string}): string {
  const home = actionTypeHome(dest);
  return `projects/${home.project}/locations/${home.location}/aspectTypes/${
      ACTION_TYPE_ID}`;
}

// Aspect-map key: the `project.location.type` reference form the client keys an
// entry's aspects by (see dataplex._nameToTypeRef).
export function actionAspectKey(dest: {project: string}): string {
  const home = actionTypeHome(dest);
  return `${home.project}.${home.location}.${ACTION_TYPE_ID}`;
}

/**
 * Creates the two custom action types in a destination, returning an error
 * message or undefined on success.
 *
 * Called from `kcmd init --semantic-model`, beside the entry group it already
 * provisions, so a push still writes nothing but entries. Each type is created
 * and then, if it is already there, patched: a project provisioned by an
 * earlier version of kcmd holds an older template, and pushing a field that
 * template lacks fails with an opaque parsing error. Dataplex rejects a
 * backwards-incompatible change, so the patch only ever adds appended fields.
 */
export async function provisionActionTypes(
    cat: CatalogClient, dest: {project: string}): Promise<string|undefined> {
  const home = actionTypeHome(dest);

  const aspect = await cat.createAspectType(
      home.project, home.location, ACTION_TYPE_ID, ACTION_ASPECT_TYPE_SPEC);
  if (aspect.status === 409) {
    const upd = await cat.updateAspectType(
        home.project, home.location, ACTION_TYPE_ID, ACTION_ASPECT_TYPE_SPEC,
        ['description', 'display_name', 'metadata_template']);
    if (upd.status !== 200)
      return `updating aspect type '${ACTION_TYPE_ID}': ${
          upd.message || upd.status}`;
  } else if (aspect.status !== 200) {
    return `creating aspect type '${ACTION_TYPE_ID}': ${
        aspect.message || aspect.status}`;
  }

  // The entry type requires the aspect type above, so it is created second. An
  // existing one is left alone rather than patched: unlike the aspect type it
  // carries no template that grows over time, and its required-aspect list is
  // what an entry already published depends on.
  const entryType = await cat.createEntryType(
      home.project, home.location, ACTION_TYPE_ID, actionEntryTypeSpec(dest));
  if (entryType.status !== 200 && entryType.status !== 409) {
    return `creating entry type '${ACTION_TYPE_ID}': ${
        entryType.message || entryType.status}`;
  }

  return undefined;
}


// ---------------------------------------------------------------------------
// Write side: the IR -> one entry per action.
// ---------------------------------------------------------------------------

// What the emitter supplies so this file need not rebuild entry names or repeat
// the id-collision bookkeeping it already does for entities and metrics.
export interface ActionEmitContext {
  // The destination project, which is where the custom types live.
  project: string;
  // Full entry resource name for an entry id (Namer.entry).
  entry(entryId: string): string;
  // Full entry resource name of the model anchor, the parent of every action.
  anchor: string;
  // Reserves an entry id, returning false when it collides with one already
  // emitted (knowledge_catalog.claim).
  claim(entryId: string, label: string): boolean;
}

// The entry id of one action: `<model>.actions.<name>`, alongside
// `<model>.entities.<name>` and `<model>.metrics.<name>`.
export function actionEntryId(modelId: string, actionName: string): string {
  return `${modelId}.actions.${slug(actionName)}`;
}

// The entry-id prefix a model's actions occupy, so delete reconciliation
// removes the entry of an action dropped from the model.
export function actionOwnedPrefix(modelId: string): string {
  return `${modelId}.actions.`;
}

/**
 * One entry per action, to append to the model's entries.
 *
 * Empty when the model declares no actions, so a model without actions is
 * unchanged from before actions existed. Warns once when it is non-empty:
 * actions reach Knowledge Catalog and nowhere else, which is worth saying out
 * loud on a push that also deploys a graph.
 */
export function actionEntries(
    model: SemanticModel, modelId: string, ctx: ActionEmitContext,
    warnings: string[]): Entry[] {
  const actions = model.actions ?? [];
  if (!actions.length) return [];
  warnings.push(
      `model '${model.name}': ${actions.length} action(s) published as ` +
      `${ACTION_TYPE_ID} entries (actions have no BigQuery Graph ` +
      `representation).`);

  const entries: Entry[] = [];
  for (const action of actions) {
    const id = actionEntryId(modelId, action.name);
    if (!ctx.claim(id, `action '${action.name}'`)) continue;
    entries.push({
      name: ctx.entry(id),
      entryType: actionEntryTypeName(ctx),
      parentEntry: ctx.anchor,
      entrySource: compact({
                     displayName: action.name,
                     description: action.description,
                   }) as Entry['entrySource'],
      aspects: {
        [actionAspectKey(ctx)]: {
          aspectType: actionAspectTypeName(ctx),
          data: actionAspectData(action),
        },
      },
    });
  }
  return entries;
}

// The aspect payload for one action: the executor flattened to the fields of
// its kind, the typed parameters, and any AI instructions.
function actionAspectData(action: Action): Record<string, any> {
  return compact({
    ...executorData(action.executor),
    parameters: action.parameters.map(
        p => compact({name: p.name, type: p.type, isEntityRef: p.isEntityRef})),
    instructions: action.aiContext?.instructions || undefined,
  });
}

// The executor's kind plus the two coordinates that kind uses. Only the fields
// of the live kind are set, so the aspect never shows blanks for the others.
function executorData(ex: Executor): Record<string, any> {
  switch (ex.kind) {
    case 'mcp':
      return {
        executorKind: 'mcp',
        mcpServer: ex.mcp.server,
        mcpTool: ex.mcp.tool,
      };
    case 'rest':
      return {
        executorKind: 'rest',
        restEndpoint: ex.rest.endpoint,
        restMethod: ex.rest.method,
      };
    case 'grpc':
      return {
        executorKind: 'grpc',
        grpcService: ex.grpc.service,
        grpcMethod: ex.grpc.method,
      };
  }
}


// ---------------------------------------------------------------------------
// Read side: an action entry -> the IR.
// ---------------------------------------------------------------------------

// True when an entry is one of a model's actions, matched by the entry type's
// id suffix so the project the type lives in need not be known -- which is what
// lets a pull keep working when the custom type is replaced by a built-in one.
export function isActionEntry(entry: Entry): boolean {
  return entry.entryType?.endsWith(`/entryTypes/${ACTION_TYPE_ID}`) ?? false;
}

// The aspect type resource names to hydrate for an action entry. Named through
// the entry type's own project so the pull follows the type wherever it lives.
export function actionAspectTypes(entryTypeBase: string): string[] {
  return [`${entryTypeBase}/aspectTypes/${ACTION_TYPE_ID}`];
}

/**
 * Recovers one action from its entry, the inverse of actionEntries.
 *
 * `isEntityRef` is re-derived against `entityNames` (as the loader does) rather
 * than trusted from the stored aspect, so it stays consistent with the model
 * actually pulled. Returns undefined, with a warning, for an entry whose
 * executor is missing or malformed: one bad entry degrades itself rather than
 * the pull.
 */
export function readAction(
    entry: Entry, entityNames: string[], warnings: string[]): Action|undefined {
  const name = entry.entrySource?.displayName || idOf(entry.name);
  const data = actionAspectDataOf(entry);
  const executor = readExecutor(data);
  if (!executor) {
    warnings.push(
        `action '${name}': the ${ACTION_TYPE_ID} aspect has no usable ` +
        `executor; the action is skipped`);
    return undefined;
  }
  const entitySet = new Set(entityNames);
  const parameters =
      asArray(data.parameters)
          .map((p: any) => readParameter(p, entitySet, name, warnings))
          .filter((p): p is ActionParameter => p !== undefined);

  const action: Action = {name, executor, parameters};
  const description = entry.entrySource?.description;
  if (description !== undefined && description !== '')
    action.description = description;
  if (typeof data.instructions === 'string' && data.instructions !== '')
    action.aiContext = {instructions: data.instructions} as AiContext;
  return action;
}

// One action parameter from its aspect record, re-deriving isEntityRef against
// the model's entities (a scalar datatype otherwise). A record missing a name is
// dropped.
function readParameter(
    p: any, entityNames: Set<string>, actionName: string,
    warnings: string[]): ActionParameter|undefined {
  const name = typeof p?.name === 'string' ? p.name : '';
  const type = typeof p?.type === 'string' ? p.type : '';
  if (!name) return undefined;
  const param: ActionParameter = {name, type};
  if (entityNames.has(type)) {
    param.isEntityRef = true;
  } else if ((DATA_TYPES as readonly string[]).includes(type)) {
    param.isEntityRef = false;
  } else {
    // The type resolves to neither an entity in the pulled model nor a scalar
    // datatype -- e.g. an entity-typed parameter whose entity was not part of
    // this pull. Leave isEntityRef unset (push-side validate flags it) and warn
    // so the gap is visible rather than silently dropped.
    warnings.push(
        `action '${actionName}': parameter '${name}' type '${type}' is ` +
        `neither a known entity nor a scalar datatype; pulled without a ` +
        `resolved type`);
  }
  return param;
}

// The IR executor from the aspect's flat fields, the inverse of executorData.
// Returns undefined when the kind is unknown or either of its coordinates is
// missing.
function readExecutor(data: Record<string, any>): Executor|undefined {
  // A coordinate must be a present, NON-BLANK string. An aspect edited by hand
  // can carry an empty one; treat that as malformed so the reader rejects it
  // exactly as push-side validate would, rather than recovering an action the
  // next push cannot deploy.
  const str = (v: any): v is string => typeof v === 'string' && v.trim() !== '';
  switch (data.executorKind) {
    case 'mcp':
      if (str(data.mcpServer) && str(data.mcpTool))
        return {kind: 'mcp', mcp: {server: data.mcpServer, tool: data.mcpTool}};
      return undefined;
    case 'rest':
      if (str(data.restEndpoint) && str(data.restMethod))
        return {
          kind: 'rest',
          rest: {endpoint: data.restEndpoint, method: data.restMethod}
        };
      return undefined;
    case 'grpc':
      if (str(data.grpcService) && str(data.grpcMethod))
        return {
          kind: 'grpc',
          grpc: {service: data.grpcService, method: data.grpcMethod}
        };
      return undefined;
    default:
      return undefined;
  }
}


// ---------------------------------------------------------------------------
// Local helpers (see the file header on why they are not shared).
// ---------------------------------------------------------------------------

// The action aspect's `data` from an entry, matched by the aspect key's
// `.semantic-action` suffix or the aspectType's `/aspectTypes/semantic-action`
// suffix, so it is found whichever project the type was provisioned in.
function actionAspectDataOf(entry: Entry): Record<string, any> {
  for (const [key, aspect] of Object.entries(entry.aspects ?? {})) {
    if (key.endsWith(`.${ACTION_TYPE_ID}`) ||
        aspect.aspectType?.endsWith(`/aspectTypes/${ACTION_TYPE_ID}`)) {
      return aspect.data ?? {};
    }
  }
  return {};
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
