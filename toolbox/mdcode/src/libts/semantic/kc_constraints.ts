// How a model's CONSTRAINTS are encoded in Knowledge Catalog.
//
// A constraint is published exactly the way an action is: one entry per
// constraint, parented to the model anchor, carrying one aspect that holds the
// invariant. Its type is custom for the same reason an action's is -- Dataplex
// has no built-in constraint type -- so it uses the `semantic-constraint` pair
// DECLARED IN kc_custom_types.ts and created there by
// `kcmd init --semantic-model`. That file is the list of what is custom; this
// one is only the encoding that fills the aspect.
//
// An entry of its own is what makes the invariant governable. A search can list
// every rule a model enforces, the expression is a typed field rather than
// prose, and dropping a constraint from the model deletes its entry, so the
// catalog never advertises a rule the model stopped requiring.
//
// WHEN A BUILT-IN CONSTRAINT TYPE SHIPS, follow the instructions at the top of
// kc_custom_types.ts. Nothing in this file changes: the readers below match a
// type by its id suffix, so they do not care which project it lives in.
//
// The call sites are `knowledge_catalog.ts` (emit the entries),
// `kc_converter.ts` (read them back), and `pull_kc.ts` (hydrate the aspect).
//
// `description` rides the entry source rather than the aspect: a violation
// quotes it back to the caller as the error, which makes it the entry's
// human-readable summary, and it is where a pull of an action already looks for
// the same field. `instructions` rides the constraint's own aspect for the
// reason kc_actions.ts gives: a pull derives which aspect types to hydrate from
// the project the ENTRY type lives in, and the built-in `guidelines` type does
// not exist there.
//
// The helpers at the bottom duplicate a few lines from the modules above on
// purpose. This module imports only the IR, the entry shape and the type
// registry, so it can be swapped or deleted as a unit.

import {Entry} from '../gcp/dataplex';

import {AiContext, Constraint, SemanticModel} from './ir';
import {CONSTRAINT_TYPE_ID, customAspectKey, customAspectTypeName, customEntryTypeName} from './kc_custom_types';

// Full resource name of the constraint entry type for a destination.
export function constraintEntryTypeName(dest: {project: string}): string {
  return customEntryTypeName(CONSTRAINT_TYPE_ID, dest);
}

// Full resource name of the constraint aspect type for a destination.
export function constraintAspectTypeName(dest: {project: string}): string {
  return customAspectTypeName(CONSTRAINT_TYPE_ID, dest);
}

// Aspect-map key: the `project.location.type` reference form the client keys an
// entry's aspects by.
export function constraintAspectKey(dest: {project: string}): string {
  return customAspectKey(CONSTRAINT_TYPE_ID, dest);
}


// ---------------------------------------------------------------------------
// Write side: the IR -> one entry per constraint.
// ---------------------------------------------------------------------------

// What the emitter supplies so this file need not rebuild entry names or repeat
// the id-collision bookkeeping it already does for entities and metrics.
export interface ConstraintEmitContext {
  // The destination project, which is where the custom types live.
  project: string;
  // Full entry resource name for an entry id (Namer.entry).
  entry(entryId: string): string;
  // Full entry resource name of the model anchor, the parent of every
  // constraint.
  anchor: string;
  // Reserves an entry id, returning false when it collides with one already
  // emitted (knowledge_catalog.claim).
  claim(entryId: string, label: string): boolean;
}

// The entry id of one constraint: `<model>.constraints.<name>`, alongside
// `<model>.metrics.<name>` and `<model>.actions.<name>`.
export function constraintEntryId(
    modelId: string, constraintName: string): string {
  return `${modelId}.constraints.${slug(constraintName)}`;
}

// The entry-id prefix a model's constraints occupy, so delete reconciliation
// removes the entry of a constraint dropped from the model.
export function constraintOwnedPrefix(modelId: string): string {
  return `${modelId}.constraints.`;
}

/**
 * One entry per constraint, to append to the model's entries.
 *
 * Empty when the model declares no constraints, so a model without them is
 * unchanged from before constraints existed. Warns once when it is non-empty:
 * constraints reach Knowledge Catalog and nowhere else, which is worth saying
 * out loud on a push that also deploys a graph.
 */
export function constraintEntries(
    model: SemanticModel, modelId: string, ctx: ConstraintEmitContext,
    warnings: string[]): Entry[] {
  const constraints = model.constraints ?? [];
  if (!constraints.length) return [];

  const entries: Entry[] = [];
  for (const constraint of constraints) {
    const id = constraintEntryId(modelId, constraint.name);
    if (!ctx.claim(id, `constraint '${constraint.name}'`)) continue;
    entries.push({
      name: ctx.entry(id),
      entryType: constraintEntryTypeName(ctx),
      parentEntry: ctx.anchor,
      entrySource: compact({
                     displayName: constraint.name,
                     description: constraint.description,
                   }) as Entry['entrySource'],
      aspects: {
        [constraintAspectKey(ctx)]: {
          aspectType: constraintAspectTypeName(ctx),
          data: constraintAspectData(constraint),
        },
      },
    });
  }
  // Counted from what was emitted rather than from the model, so a name
  // collision that skipped a constraint does not inflate the number.
  if (entries.length)
    warnings.push(
        `model '${model.name}': ${entries.length} constraint(s) published as ` +
        `${CONSTRAINT_TYPE_ID} entries (constraints have no BigQuery Graph ` +
        `representation).`);
  return entries;
}

// The aspect payload for one constraint: the invariant, and any AI
// instructions.
function constraintAspectData(constraint: Constraint): Record<string, any> {
  return compact({
    expression: constraint.expression,
    instructions: constraint.aiContext?.instructions || undefined,
  });
}


// ---------------------------------------------------------------------------
// Read side: a constraint entry -> the IR.
// ---------------------------------------------------------------------------

// True when an entry is one of a model's constraints, matched by the entry
// type's id suffix so the project the type lives in need not be known -- which
// is what lets a pull keep working when the custom type is replaced by a
// built-in one.
export function isConstraintEntry(entry: Entry): boolean {
  return entry.entryType?.endsWith(`/entryTypes/${CONSTRAINT_TYPE_ID}`) ??
      false;
}

// The aspect type resource names to hydrate for a constraint entry. Named
// through the entry type's own project so the pull follows the type wherever it
// lives.
export function constraintAspectTypes(entryTypeBase: string): string[] {
  return [`${entryTypeBase}/aspectTypes/${CONSTRAINT_TYPE_ID}`];
}

/**
 * Recovers one constraint from its entry, the inverse of constraintEntries.
 *
 * Returns undefined, with a warning, for an entry whose expression is missing
 * or blank: an invariant that states nothing would be pulled into a model that
 * then fails its own push-side validation, so one bad entry degrades itself
 * rather than the pull.
 */
export function readConstraint(entry: Entry, warnings: string[]): Constraint|
    undefined {
  const name = entry.entrySource?.displayName || idOf(entry.name);
  const data = constraintAspectDataOf(entry);
  const expression =
      typeof data.expression === 'string' ? data.expression.trim() : '';
  if (!expression) {
    warnings.push(
        `constraint '${name}': the ${CONSTRAINT_TYPE_ID} aspect has no ` +
        `expression; the constraint is skipped`);
    return undefined;
  }

  const constraint: Constraint = {name, expression};
  const description = entry.entrySource?.description;
  if (description !== undefined && description !== '')
    constraint.description = description;
  if (typeof data.instructions === 'string' && data.instructions !== '')
    constraint.aiContext = {instructions: data.instructions} as AiContext;
  return constraint;
}


// ---------------------------------------------------------------------------
// Local helpers (see the file header on why they are not shared).
// ---------------------------------------------------------------------------

// The constraint aspect's `data` from an entry, matched by the aspect key's
// `.semantic-constraint` suffix or the aspectType's
// `/aspectTypes/semantic-constraint` suffix, so it is found whichever project
// the type was provisioned in.
function constraintAspectDataOf(entry: Entry): Record<string, any> {
  for (const [key, aspect] of Object.entries(entry.aspects ?? {})) {
    if (key.endsWith(`.${CONSTRAINT_TYPE_ID}`) ||
        aspect.aspectType?.endsWith(`/aspectTypes/${CONSTRAINT_TYPE_ID}`)) {
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
