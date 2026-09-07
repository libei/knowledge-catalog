// How a model's ACTIONS are persisted in Knowledge Catalog.
//
// This file holds the whole encoding, and it exists to be replaced.
//
// Every other construct in the model maps to a built-in system type under
// `projects/dataplex-types/locations/global`. A model, entity, or metric gets
// its own entry (`semantic-model` / `semantic-entity` / `semantic-metric`); a
// relationship becomes a `schema-join` entry link; the built-in `schema` and
// `guidelines` aspects carry the rest. Actions have no such type. Until one
// exists they ride the model anchor's built-in `overview` aspect, whose
// `content` is free-form Markdown: a section for a person reading the catalog,
// then a fenced JSON block after ACTIONS_OVERVIEW_MARKER. The JSON block is the
// canonical copy and is what a pull parses; the Markdown above it is rendered
// from the same actions and is never read back.
//
// Nothing outside this file knows that encoding. There are four call sites:
// `knowledge_catalog.ts` asks for the aspects to attach to the anchor,
// `kc_converter.ts` asks for the actions to recover from it, and
// `deploy_knowledge_catalog.ts` and `pull_kc.ts` name the aspect types through
// ACTION_ANCHOR_ASPECT_TYPES rather than the literal 'overview'.
//
// WHEN A BUILT-IN ACTION TYPE SHIPS. If actions become an aspect on the anchor,
// point actionAnchorAspects and readActions at it and rename the member of
// ACTION_ANCHOR_ASPECT_TYPES; the four call sites do not change. If instead
// each action becomes its own entry, the way a metric is one, this file is
// deleted: the emitting and reading move beside the metric code in
// `knowledge_catalog.ts` and `kc_converter.ts`, and generateCatalogResources
// gains a `<model>.actions.` owned prefix so a removed action is reconciled
// away like a removed metric.
//
// The helpers at the bottom duplicate a few lines from those two modules on
// purpose. This module imports only the IR and the catalog resource types, so
// it can be swapped or deleted as a unit.

import type {Aspect, Entry} from '../gcp/dataplex';

import {Action, ActionParameter, AiContext, CustomExtension, DATA_TYPES, Executor, SemanticModel} from './ir';

// Fences the machine-readable action JSON inside the overview Markdown. Write
// and read locate the block by this marker, so they agree on one delimiter.
export const ACTIONS_OVERVIEW_MARKER = '<!-- kcmd:actions v1 -->';

// The bare aspect type ids this encoding attaches to the model anchor, and
// attaches CONDITIONALLY (a model with no actions carries none of them). The
// publisher names them when reconciling an updated anchor so a removed action
// clears the aspect, and a pull requests them so the actions come back.
export const ACTION_ANCHOR_ASPECT_TYPES = ['overview'] as const;

/**
 * The aspects carrying the model's actions, keyed by bare aspect type id, to
 * merge into the model anchor's aspect map.
 *
 * Empty when the model declares no actions, so an anchor without actions is
 * unchanged from before actions existed. Warns once when it is non-empty:
 * actions reach Knowledge Catalog and nowhere else, which is worth saying out
 * loud on a push that also deploys a graph.
 */
export function actionAnchorAspects(
    model: SemanticModel,
    warnings: string[]): Record<string, Record<string, any>> {
  const actions = model.actions ?? [];
  if (!actions.length) return {};
  warnings.push(
      `model '${model.name}': ${actions.length} action(s) published to the ` +
      `model's overview aspect (actions have no BigQuery Graph representation).`);
  return {
    overview: {
      content: renderActionsOverview(actions),
      contentType: 'MARKDOWN',
    },
  };
}

/**
 * Recovers the model's actions from the anchor, the inverse of
 * actionAnchorAspects.
 *
 * `isEntityRef` is re-derived against `entityNames` (as the loader does)
 * rather than trusted from the stored JSON, so it stays consistent with the
 * model actually pulled. Returns an empty list when the anchor carries no
 * actions, and warns rather than throwing when it carries a malformed block:
 * one bad action degrades itself, not the pull.
 */
export function readActions(
    anchor: Entry, entityNames: string[], warnings: string[]): Action[] {
  const content = overviewContent(anchor);
  if (content === undefined || !content.includes(ACTIONS_OVERVIEW_MARKER))
    return [];
  const json = jsonBlockAfterMarker(content, ACTIONS_OVERVIEW_MARKER);
  if (json === undefined) {
    warnings.push(
        `model actions: overview aspect has the actions marker but no parseable ` +
        `JSON block; actions are not recovered`);
    return [];
  }
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (err: any) {
    warnings.push(`model actions: overview action block is not valid JSON (${
        err.message || err}); actions are not recovered`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    warnings.push(
        `model actions: overview action block is not a JSON array; actions are ` +
        `not recovered`);
    return [];
  }
  const entitySet = new Set(entityNames);
  return parsed.map((a: any) => readAction(a, entitySet, warnings))
      .filter((a): a is Action => a !== undefined);
}


// ---------------------------------------------------------------------------
// Write side: the IR -> the overview aspect's content.
// ---------------------------------------------------------------------------

// Renders the actions overview: a Markdown section for humans, then the marker
// and a fenced JSON array (the canonical IR form) for a lossless pull.
function renderActionsOverview(actions: Action[]): string {
  const md: string[] = [
    '## Actions',
    '',
    'Write operations defined on this model -- the write-side counterpart to ' +
        'metrics. Actions have no BigQuery Graph representation; they are ' +
        'published here for discovery and are round-tripped by `kcmd pull`.',
    '',
  ];
  for (const a of actions) {
    md.push(`### ${a.name}`, '');
    if (a.description) md.push(a.description, '');
    md.push(`- Executor: ${describeExecutor(a.executor)}`);
    if (a.parameters.length) {
      md.push('- Parameters:');
      for (const p of a.parameters) {
        const kind = p.isEntityRef ? `${p.type} (entity reference)` : p.type;
        md.push(`  - \`${p.name}\`: ${kind}`);
      }
    }
    md.push('');
  }
  md.push(
      ACTIONS_OVERVIEW_MARKER, '```json',
      JSON.stringify(actions.map(actionJson), null, 2), '```', '');
  return md.join('\n');
}

// A one-line human description of an executor for the Markdown body.
function describeExecutor(ex: Executor): string {
  switch (ex.kind) {
    case 'mcp':
      return `MCP tool \`${ex.mcp.tool}\` on server \`${ex.mcp.server}\``;
    case 'rest':
      return `REST ${ex.rest.method} \`${ex.rest.endpoint}\``;
    case 'grpc':
      return `gRPC \`${ex.grpc.service}/${ex.grpc.method}\``;
  }
}

// The canonical JSON form of an action embedded in the overview, mirroring the
// IR so readAction reconstructs it verbatim. The executor's tagged union is
// flattened to the open format's single-key object, matching how osi_converter
// emits it to YAML.
function actionJson(a: Action): Record<string, any> {
  return compact({
    name: a.name,
    description: a.description,
    executor: executorJson(a.executor),
    parameters: a.parameters.map(
        p => compact({name: p.name, type: p.type, isEntityRef: p.isEntityRef})),
    aiContext: a.aiContext,
    customExtensions: a.customExtensions,
  });
}

function executorJson(ex: Executor): Record<string, any> {
  switch (ex.kind) {
    case 'mcp':
      return {mcp: {server: ex.mcp.server, tool: ex.mcp.tool}};
    case 'rest':
      return {rest: {endpoint: ex.rest.endpoint, method: ex.rest.method}};
    case 'grpc':
      return {grpc: {service: ex.grpc.service, method: ex.grpc.method}};
  }
}


// ---------------------------------------------------------------------------
// Read side: the overview aspect's content -> the IR.
// ---------------------------------------------------------------------------

// Extracts the first ```json ... ``` fenced block that follows `marker` in the
// content, returning the block's inner text (or undefined when none follows).
function jsonBlockAfterMarker(content: string, marker: string): string|
    undefined {
  const afterMarker =
      content.slice(content.lastIndexOf(marker) + marker.length);
  const fence = afterMarker.match(/```json\s*\n([\s\S]*?)\n```/);
  return fence ? fence[1] : undefined;
}

// Rebuilds one Action from its embedded JSON (the inverse of actionJson). A
// record missing a usable name or executor is skipped with a warning, so a
// malformed block degrades one action rather than the whole pull.
function readAction(
    a: any, entityNames: Set<string>, warnings: string[]): Action|undefined {
  const name = typeof a?.name === 'string' ? a.name : '';
  if (!name) {
    warnings.push(
        'model actions: an action in the overview has no name; skipped');
    return undefined;
  }
  const executor = readExecutor(a?.executor);
  if (!executor) {
    warnings.push(
        `action '${name}': overview executor is missing or malformed; the ` +
        `action is skipped`);
    return undefined;
  }
  const parameters =
      asArray(a?.parameters)
          .map((p: any) => readParameter(p, entityNames, name, warnings))
          .filter((p): p is ActionParameter => p !== undefined);
  const action: Action = {name, executor, parameters};
  if (typeof a?.description === 'string' && a.description !== '')
    action.description = a.description;
  if (a?.aiContext && typeof a.aiContext === 'object')
    action.aiContext = a.aiContext as AiContext;
  if (Array.isArray(a?.customExtensions))
    action.customExtensions = a.customExtensions as CustomExtension[];
  return action;
}

// One action parameter from its JSON, re-deriving isEntityRef against the
// model's entities (a scalar datatype otherwise). A record missing a name is
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

// The IR executor from the embedded single-key JSON object
// ({mcp}/{rest}/{grpc}, the inverse of executorJson). Returns undefined when no
// known kind is present or a coordinate is not a string.
function readExecutor(ex: any): Executor|undefined {
  // A coordinate must be a present, NON-BLANK string. The overview JSON can
  // carry an empty string (e.g. a hand-edited block); treat that as malformed
  // so the reader rejects it exactly as push-side validate would, rather than
  // recovering an action the next push cannot deploy.
  const str = (v: any): v is string => typeof v === 'string' && v.trim() !== '';
  if (ex?.mcp && str(ex.mcp.server) && str(ex.mcp.tool))
    return {kind: 'mcp', mcp: {server: ex.mcp.server, tool: ex.mcp.tool}};
  if (ex?.rest && str(ex.rest.endpoint) && str(ex.rest.method))
    return {
      kind: 'rest',
      rest: {endpoint: ex.rest.endpoint, method: ex.rest.method}
    };
  if (ex?.grpc && str(ex.grpc.service) && str(ex.grpc.method))
    return {
      kind: 'grpc',
      grpc: {service: ex.grpc.service, method: ex.grpc.method}
    };
  return undefined;
}


// ---------------------------------------------------------------------------
// Local helpers (see the file header on why they are not shared).
// ---------------------------------------------------------------------------

// The overview aspect's `content` string from the anchor's aspect map, matched
// by the aspect key's `.overview` suffix or the aspectType's
// `/aspectTypes/overview` suffix, so it is found whichever system-type
// project/location the emitter used. Undefined when the aspect is absent or
// carries no string content.
function overviewContent(anchor: Entry): string|undefined {
  for (const type of ACTION_ANCHOR_ASPECT_TYPES) {
    for (const [key, aspect] of Object.entries<Aspect>(anchor.aspects ?? {})) {
      if (!key.endsWith(`.${type}`) &&
          !aspect.aspectType?.endsWith(`/aspectTypes/${type}`))
        continue;
      const content = aspect.data?.content;
      if (typeof content === 'string') return content;
    }
  }
  return undefined;
}

// Drops undefined-valued keys so the emitted JSON (and its golden) only shows
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
