// The semantic runtime: executing a model's action against a live store.
//
// A semantic model has always described what things MEAN. Actions describe what
// can be DONE. This module is where the two meet an actual database:
//
//   1. RESOLVE. An action's parameters are typed by the ontology, so an
//      entity-typed argument is an object reference, not a value. The caller
//      (often an agent) supplies something human -- an account id, a person's
//      name -- and the runtime turns it into the row that argument denotes,
//      failing loudly on "no such thing" and on "more than one such thing".
//   2. BIND. Every argument becomes a query parameter of the store type its
//      declared ontology type implies. Nothing is interpolated into SQL.
//   3. APPLY. A read-write transaction is opened, the action's writes are run
//      inside it, and it is committed. Any failure before the commit rolls
//      back, so no partial write survives. A failure OF the commit is the one
//      case nothing here can resolve -- the store may have applied it and lost
//      the response -- and it is reported as the unknown it is rather than as
//      a rollback.
//
// Where the write comes from. An action with a `sql` executor carries its own
// DML, and the runtime runs those statements itself. An action with an `mcp`,
// `rest` or `grpc` executor names an operation that lives in another system,
// which this module cannot call and could not roll back if it did; for those
// the caller supplies a handler that produces the statements.
//
// What this does NOT do yet: evaluate the model's constraints. A constraint is
// still text nothing checks, so an action whose outcome a constraint is
// supposed to decide is REFUSED here rather than run unchecked -- see
// `unsafeToRunUnchecked`. Refusing is the point. A model that declares a rule
// and a runtime that quietly ignores it is worse than no runtime at all,
// because the model states the write is checked and nothing says otherwise.

import * as spanner from '../gcp/spanner';

import {
  Action,
  ActionParameter,
  Entity,
  generatedKeyParam,
  SemanticModel,
} from './ir';
import {spannerTable} from './spanner';
import {referencedEntityNames} from './sql_expr_utils';
import {quoteIfReserved, referencedParameters} from './sql_identifiers';


// An entity-typed argument, resolved to the row it denotes.
export interface EntityRef {
  entity: string;
  // Key values in the entity's declared key order, as strings (Spanner's REST
  // surface returns every scalar as a string, and the runtime keeps them that
  // way so a caller need not know the physical types).
  keys: string[];
  // How the caller referred to it, kept for error messages.
  input: string;
}


// The writes an action performs: either built from its `sql` executor or
// produced by the caller's handler.
export interface ActionPlan {
  // DML to run inside the transaction, in order.
  statements: spanner.Statement[];
}


// What the handler is given: the action, its arguments with entity-typed ones
// already resolved, and a reader scoped to the open transaction (so a handler
// can look at the pre-state before deciding what to write).
export interface ActionContext {
  model: SemanticModel;
  action: Action;
  args: Record<string, unknown>;
  refs: Record<string, EntityRef>;
  query(stmt: spanner.Statement): Promise<string[][]>;
}


export type ActionHandler = (ctx: ActionContext) => Promise<ActionPlan>;


export type ActionOutcome = {
  status: 'committed';
  commitTimestamp?: string;
  refs: Record<string, EntityRef>;
}|{
  status: 'error';
  // A failure that stopped the write: an argument that resolved to nothing, an
  // action this runtime will not run unchecked, a store-level error. The
  // transaction is rolled back, so no partial write survives -- except in the
  // one case `indeterminate` marks.
  message: string;
  // Set when the write may in fact have landed: the statements ran and the
  // COMMIT itself failed. Spanner reports a deadline or a 5xx on commit for a
  // commit that succeeded as well as for one that did not, and nothing can
  // undo it from here. A caller must not read this as "nothing happened" and
  // retry.
  indeterminate?: boolean;
};


export interface RunActionOptions {
  model: SemanticModel;
  actionName: string;
  args: Record<string, unknown>;
  client: spanner.SpannerDataClient;
  // Supplies the writes for an action whose executor lives in another system.
  // Omit it for a `sql` executor, whose writes are in the model.
  handler?: ActionHandler;
}


// Runs one action end to end. Never throws for an expected failure -- an
// unresolvable argument, a refused action, a rejected statement all come back
// as an outcome, because the caller is usually an agent that needs to read the
// reason and try again.
export async function runAction(opts: RunActionOptions):
    Promise<ActionOutcome> {
  const {model, client, args} = opts;
  const action = (model.actions ?? []).find(a => a.name === opts.actionName);
  if (!action) {
    return {
      status: 'error',
      message: `Model '${model.name}' declares no action '${opts.actionName}'.`,
    };
  }
  if (!opts.handler && action.executor.kind !== 'sql') {
    return {
      status: 'error',
      message: `Action '${action.name}' is executed by ${
          action.executor.kind.toUpperCase()}, which runs outside this ` +
          `transaction and could not be rolled back if the commit failed. ` +
          `Supply a handler that performs the write as DML, or declare the ` +
          `action with a 'sql' executor.`,
    };
  }

  // Decided BEFORE touching the store, so an action this runtime will not run
  // fails without having opened a transaction at all.
  const unsafe = unsafeToRunUnchecked(model, action);
  if (unsafe) return {status: 'error', message: unsafe};

  try {
    return await client.withSession(async sessionName => {
      const begun = await client.beginReadWrite(sessionName);
      const transactionId = begun.result?.id;
      if (!transactionId) {
        return {
          status: 'error',
          message: `Could not begin a transaction on ${client.database} (${
              begun.status}${begun.message ? `: ${begun.message}` : ''}).`,
        } as ActionOutcome;
      }

      const run = async (stmt: spanner.Statement) => {
        const res = await client.executeSql(sessionName, transactionId, stmt);
        if (res.status < 200 || res.status >= 300) {
          throw new StoreError(
              `${res.message ?? 'request failed'} (while running: ${stmt.sql})`);
        }
        return res.result ?? {};
      };
      const query = async (stmt: spanner.Statement) =>
          (await run(stmt)).rows ?? [];

      // Everything from here on is inside the transaction, so any failure must
      // roll back rather than leave it open.
      try {
        // A rollback that itself fails must not replace the reason the action
        // stopped -- that reason is what the caller acts on, and the server
        // aborts an abandoned transaction on its own.
        const rollback = async (outcome: ActionOutcome) => {
          try {
            await client.rollback(sessionName, transactionId);
          } catch {
          }
          return outcome;
        };

        const resolved = await resolveArguments(model, action, args, query);
        if ('error' in resolved) {
          return await rollback({status: 'error', message: resolved.error});
        }
        const refs = resolved.refs;

        // The bindings exist to fill the model's OWN statements, so they are
        // built only when the model is what supplies them. A handler is given
        // `refs` whole and may write a composite key, which this pass refuses
        // because a single statement parameter cannot carry one.
        let plan: ActionPlan|{error: string};
        if (opts.handler) {
          plan = await opts.handler({model, action, args, refs, query});
        } else {
          const bound = bindArguments(model, action, args, refs);
          if ('error' in bound) {
            return await rollback({status: 'error', message: bound.error});
          }
          plan = planFromExecutor(model, action, bound, generatedKeys(action));
        }
        if ('error' in plan) {
          return await rollback({status: 'error', message: plan.error});
        }
        for (const stmt of plan.statements) {
          await run(stmt);
        }

        const committed = await client.commit(sessionName, transactionId);
        if (committed.status < 200 || committed.status >= 300) {
          // Deliberately NOT rolled back. Once commit has been called the
          // transaction's fate is the server's, and a deadline or a 5xx is
          // exactly the shape of failure Spanner returns for a commit that
          // landed and lost its response. Reporting "rolled back" here would
          // be a guess, and the caller acting on it would retry a write that
          // already happened.
          return {
            status: 'error',
            indeterminate: true,
            message: `Action '${action.name}' ran, but committing it failed ` +
                `on ${client.database}: ${
                    committed.message ?? committed.status}. Whether the write ` +
                `landed is unknown -- the store may have applied it and lost ` +
                `the response -- so read the affected data before retrying.`,
          } as ActionOutcome;
        }
        return {
          status: 'committed',
          commitTimestamp: committed.result?.commitTimestamp,
          refs,
        } as ActionOutcome;
      } catch (err) {
        try {
          await client.rollback(sessionName, transactionId);
        } catch {
        }
        throw err;
      }
    });
  } catch (err) {
    return {
      status: 'error',
      message: `Action '${action.name}' failed and was rolled back: ${
          err instanceof Error ? err.message : String(err)}`,
    };
  }
}


// A store-level failure, distinguished from a programming error so the message
// surfaced to the caller stays about the store.
class StoreError extends Error {}


// Why this runtime will not run `action`, or null if it is safe to run.
//
// Nothing here evaluates a constraint yet, so the only honest thing to do with
// an action a constraint is supposed to decide is refuse it. Three shapes say a
// constraint may bear on this call:
//
//   * The action NAMES one in `guards`. That is the author stating the
//     constraint is checked before this call, which is precisely what is
//     missing.
//   * A constraint reads an entity the action `affects`. The author never had
//     to link the two -- an invariant over stored data holds for every write,
//     however the row arrived -- so the overlap is the only signal there is. It
//     is computed from the expression's qualifiers, the same derivation the
//     emitters use.
//   * The model declares constraints and the action declares no `affects` at
//     all. Then there is nothing to compare and no way to rule an overlap out,
//     so this refuses too. Reading silence as "nothing is constrained" is the
//     one guess that fails open, and `affects` is the fix the author can make.
//
// An action over entities no constraint mentions runs today, which is what
// makes this runtime useful before the evaluator exists.
function unsafeToRunUnchecked(
    model: SemanticModel, action: Action): string|null {
  const guards = action.guards ?? [];
  if (guards.length) {
    return `Action '${action.name}' is guarded by ${quoteList(guards)}, and ` +
        `this runtime does not evaluate constraints yet. Running it would ` +
        `apply a write the model says must be checked first, so it is ` +
        `refused rather than run unchecked.`;
  }

  const constraints = model.constraints ?? [];
  if (constraints.length && !(action.affects ?? []).length) {
    return `Action '${action.name}' declares no 'affects', so there is no ` +
        `way to tell whether the ${constraints.length} constraint(s) this ` +
        `model states bear on its write, and this runtime does not evaluate ` +
        `constraints yet. Declare what the action changes and it will run if ` +
        `nothing constrains that data.`;
  }

  const bearing = constraintsOverAffected(model, action);
  if (bearing.length) {
    return `Action '${action.name}' writes data that ${quoteList(bearing)} ` +
        `could constrain, and this runtime does not evaluate constraints ` +
        `yet. The write could leave the store violating a rule the model ` +
        `states, so it is refused rather than run unchecked.`;
  }
  return null;
}


// The names of constraints whose expression may read a concept this action
// affects, sorted so a message is stable.
//
// This is the one place the refusal rule could fail open, so it errs the other
// way twice. A constraint's expression is a logical invariant this module does
// not parse, and `affects` names an entity OR a relationship, so:
//
//   * The scan covers relationships as well as entities. Validation
//     deliberately permits a relationship-qualified name like
//     `OrderedAs.quantity`, and an M:N `create` writes exactly the junction
//     table such a constraint is about.
//   * A constraint matching no known concept counts as bearing on all of them.
//     An unqualified expression (`amount > 0`) names nothing this can compare,
//     and "it mentions no entity, so it constrains none" is the reading that
//     runs an unchecked write.
//
// The cost of both is refusing an action that would have been fine, which the
// evaluator will then let through. That is the direction to be wrong in.
function constraintsOverAffected(
    model: SemanticModel, action: Action): string[] {
  const constraints = model.constraints ?? [];
  const affected = new Set((action.affects ?? []).map(a => a.concept));
  if (!constraints.length || !affected.size) return [];

  const conceptNames = [
    ...(model.entities ?? []).map(e => e.name),
    ...(model.relationships ?? []).map(r => r.name),
  ];
  const names: string[] = [];
  for (const c of constraints) {
    const read = referencedEntityNames(c.expression, conceptNames);
    if (!read.length || read.some(name => affected.has(name))) {
      names.push(c.name);
    }
  }
  return names.sort();
}


function quoteList(names: readonly string[]): string {
  const quoted = names.map(n => `'${n}'`);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}


interface Bindings {
  params: Record<string, unknown>;
  types: Record<string, {code: string}>;
}


// Turns each declared parameter into a bound value: an entity-typed one into
// the key of the row it resolved to, a scalar into a value of the store's
// matching type. Nothing is interpolated into SQL, so no argument can reach the
// store as anything but data.
function bindArguments(
    model: SemanticModel, action: Action, args: Record<string, unknown>,
    refs: Record<string, EntityRef>): Bindings|{error: string} {
  const params: Record<string, unknown> = {};
  const types: Record<string, {code: string}> = {};
  for (const param of action.parameters) {
    const bound = param.isEntityRef ?
        bindReference(model, param, refs[param.name]) :
        bindScalar(param, args[param.name]);
    if ('error' in bound) return {error: bound.error};
    params[param.name] = bound.value;
    types[param.name] = {code: bound.code};
  }
  return {params, types};
}


// An object reference as its key value, typed by the ontology. Resolution
// returns every key as a string, because that is what the store's REST surface
// gives back; binding it into a statement needs the type the KEY FIELD declares,
// or an integer-keyed row would be handed to the store as text.
function bindReference(
    model: SemanticModel, param: ActionParameter, ref: EntityRef|undefined):
    {value: unknown; code: string}|{error: string} {
  if (!ref) return {error: `Parameter '${param.name}' was not resolved.`};
  if (ref.keys.length !== 1) {
    return {
      error: `Parameter '${param.name}' refers to a ${param.type}, whose key ` +
          `has ${ref.keys.length} parts; the runtime binds an object ` +
          `reference as a single value, so a composite key cannot be passed ` +
          `to a statement.`,
    };
  }
  const entity = (model.entities ?? []).find(e => e.name === param.type);
  const keyField = entity?.fields.find(f => f.name === (entity.keys ?? [])[0]);
  return bindScalar(
      {name: param.name, type: keyField?.type ?? 'String'}, ref.keys[0]);
}


// One scalar argument as a Spanner value. The declared ontology type picks the
// store type, so a `Decimal` amount is compared as a number rather than as text
// -- which is the difference between "9" being less than "10" and not.
function bindScalar(param: ActionParameter, raw: unknown):
    {value: unknown; code: string}|{error: string} {
  if (raw === undefined || raw === null || `${raw}`.trim() === '') {
    return {
      error: `Action parameter '${param.name}' (${param.type}) was not given ` +
          `a value.`,
    };
  }
  const text = `${raw}`.trim();
  switch (param.type) {
    case 'Integer':
      if (!/^[-+]?\d+$/.test(text)) {
        return {error: `'${param.name}' is an Integer, but '${text}' is not.`};
      }
      // INT64 travels as a string over the REST surface; a JSON number would
      // lose precision above 2^53.
      return {value: text, code: 'INT64'};
    case 'Float':
      if (!Number.isFinite(Number(text))) {
        return {error: `'${param.name}' is a Float, but '${text}' is not.`};
      }
      return {value: Number(text), code: 'FLOAT64'};
    case 'Decimal':
      if (!/^[-+]?\d+(\.\d+)?$/.test(text)) {
        return {error: `'${param.name}' is a Decimal, but '${text}' is not.`};
      }
      // NUMERIC travels as a string, for the same reason: an exact decimal
      // routed through a JSON number stops being exact.
      return {value: text, code: 'NUMERIC'};
    case 'Boolean':
      if (!/^(true|false)$/i.test(text)) {
        return {error: `'${param.name}' is a Boolean, but '${text}' is not.`};
      }
      return {value: /^true$/i.test(text), code: 'BOOL'};
    case 'Date':
      return {value: text, code: 'DATE'};
    case 'DateTime':
    case 'DateTimeTz':
      return {value: text, code: 'TIMESTAMP'};
    default:
      return {value: text, code: 'STRING'};
  }
}


// A key for every concept the action creates, named as the DML expects it. The
// model's own statements bind `@new<Concept>Key`, so the value has to exist
// before the statement runs -- which rules out letting the store assign it.
//
// The value is a UUID, so the key it fills has to be text. Whether that fits
// is `unusableGeneratedKey`'s question, asked where a statement actually binds
// one.
function generatedKeys(action: Action): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const affected of action.affects ?? []) {
    if (affected.operation !== 'create') continue;
    keys[affected.concept] = crypto.randomUUID();
  }
  return keys;
}


// Why a UUID cannot fill the key the action's DML asks for, or null if it can.
// The store would reject an INT64 key bound as text, but it reports that as a
// rejected statement -- naming neither the entity nor the reason -- so this
// answers first, from the model.
function unusableGeneratedKey(
    model: SemanticModel, action: Action, concept: string): string|null {
  const entity = (model.entities ?? []).find(e => e.name === concept);
  if (!entity) return null;
  const declared = entity.keys ?? [];
  if (declared.length > 1) {
    return `Action '${action.name}' binds a generated key for the ${
        concept} it creates, but ${concept}'s key has ${
        declared.length} parts. A composite key has to be written by the ` +
        `statement itself.`;
  }
  const keyField = entity.fields.find(f => f.name === declared[0]);
  const type = keyField?.type ?? 'String';
  if (type !== 'String') {
    return `Action '${action.name}' binds a generated key for the ${
        concept} it creates, but ${concept}'s key '${declared[0]}' has type ${
        type}, and the runtime generates a UUID -- which is text. Key ${
        concept} by a String, or have the statement supply the key itself.`;
  }
  return null;
}


// Builds the plan from the action's own DML. Every `@name` in a statement is
// either a declared parameter or a key this call generates; validate.ts refuses
// a model where it is neither, so an unbound reference cannot reach here.
function planFromExecutor(
    model: SemanticModel, action: Action, bound: Bindings,
    generated: Record<string, string>): ActionPlan|{error: string} {
  if (action.executor.kind !== 'sql') {
    return {error: `Action '${action.name}' has no 'sql' executor.`};
  }
  // Null-prototype maps throughout. Parameter names come from the model, and
  // `'toString' in {}` is true, so a plain object would let `@toString` pass
  // the "declared or generated" check below and reach the store bound to
  // Object.prototype's own member.
  const values: Record<string, unknown> =
      Object.assign(Object.create(null), bound.params);
  const types: Record<string, {code: string}> =
      Object.assign(Object.create(null), bound.types);
  const conceptOfKey: Record<string, string> = Object.create(null);
  for (const [concept, key] of Object.entries(generated)) {
    values[generatedKeyParam(concept)] = key;
    types[generatedKeyParam(concept)] = {code: 'STRING'};
    conceptOfKey[generatedKeyParam(concept)] = concept;
  }

  const statements: spanner.Statement[] = [];
  for (const sql of action.executor.sql.statements) {
    const params: Record<string, unknown> = {};
    const paramTypes: Record<string, {code: string}> = {};
    for (const name of referencedParameters(sql)) {
      if (!Object.hasOwn(values, name)) {
        return {
          error: `Action '${action.name}' binds '@${name}', which is neither ` +
              `a parameter it declares nor a key it generates.`,
        };
      }
      // Asked only where a statement actually binds a generated key: an
      // INT64-keyed entity whose DML supplies its own key must not be refused
      // over a value it never uses.
      if (Object.hasOwn(conceptOfKey, name)) {
        const unusable = unusableGeneratedKey(model, action, conceptOfKey[name]);
        if (unusable) return {error: unusable};
      }
      params[name] = values[name];
      paramTypes[name] = types[name];
    }
    statements.push({sql, params, paramTypes});
  }
  return {statements};
}


// Turns each entity-typed argument into the row it denotes. Scalar arguments
// pass through untouched; this is only about object references.
async function resolveArguments(
    model: SemanticModel, action: Action, args: Record<string, unknown>,
    query: (stmt: spanner.Statement) => Promise<string[][]>):
    Promise<{refs: Record<string, EntityRef>}|{error: string}> {
  const refs: Record<string, EntityRef> = {};
  for (const param of action.parameters) {
    if (!param.isEntityRef) continue;
    const raw = args[param.name];
    if (raw === undefined || raw === null || `${raw}`.trim() === '') {
      return {
        error: `Action '${action.name}' requires '${param.name}', a reference ` +
            `to a ${param.type}, but none was given.`,
      };
    }
    const entity = (model.entities ?? []).find(e => e.name === param.type);
    if (!entity) {
      return {
        error: `Parameter '${param.name}' is typed '${param.type}', which the ` +
            `model does not declare as an entity.`,
      };
    }
    const resolved = await resolveEntityRef(entity, `${raw}`, query);
    if ('error' in resolved) return {error: resolved.error};
    refs[param.name] = resolved.ref;
  }
  return {refs};
}


// Resolves one object reference. `input` is matched against the entity's key
// and, when it has one, its identifying text field -- so an agent can say
// "Account 1" or "Alice" and the runtime finds the same row either way.
//
// Both failure modes are reported precisely, because both are things the caller
// can act on: nothing matched (the reference is wrong) or several matched (the
// reference is ambiguous, and the candidates are listed).
async function resolveEntityRef(
    entity: Entity, input: string,
    query: (stmt: spanner.Statement) => Promise<string[][]>):
    Promise<{ref: EntityRef}|{error: string}> {
  const warnings: string[] = [];
  const table =
      spannerTable(entity.dataSource, warnings, `entity '${entity.name}'`);
  if (warnings.length) {
    return {error: `Cannot resolve a ${entity.name}: ${warnings.join('; ')}.`};
  }

  const keyColumns: string[] = [];
  const keyTypes: string[] = [];
  for (const key of entity.keys) {
    const field = entity.fields.find(f => f.name === key);
    const expr = (field?.expression ?? '').trim();
    if (!expr || !/^[A-Za-z_]\w*$/.test(expr)) {
      return {
        error: `Cannot resolve a ${entity.name}: its key field '${
            key}' is not bound to a plain column.`,
      };
    }
    keyColumns.push(quoteIfReserved(expr));
    keyTypes.push(field?.type ?? 'String');
  }
  if (!keyColumns.length) {
    return {error: `Cannot resolve a ${entity.name}: it declares no key.`};
  }

  // Each column is compared as ITSELF, against the input parsed to the type
  // that column's field declares. Casting them all to STRING would let one
  // predicate shape serve every key type, but no index can answer it -- and
  // this SELECT runs inside the action's read-write transaction, so a scan
  // would hold read locks over the whole table for the length of the write.
  // Input that is not a value of a key's type cannot name that key, so its
  // predicate is dropped rather than made to match by casting.
  const predicates: string[] = [];
  const params: Record<string, unknown> = {};
  const paramTypes: Record<string, {code: string}> = {};
  keyColumns.forEach((column, i) => {
    const bound = bindScalar({name: 'ref', type: keyTypes[i]}, input);
    if ('error' in bound) return;
    predicates.push(`${column} = @ref${i}`);
    params[`ref${i}`] = bound.value;
    paramTypes[`ref${i}`] = {code: bound.code};
  });
  // An identifying column is a String field by construction, so the input is
  // already a value of its type.
  const label = identifyingColumn(entity);
  if (label) {
    predicates.push(`${label} = @ref`);
    params['ref'] = input;
    paramTypes['ref'] = {code: 'STRING'};
  }
  if (!predicates.length) {
    // The input is not a value of any key's type and there is no text field to
    // match it against, so no row in the table can be the one meant.
    return {error: `No ${entity.name} matches '${input}'.`};
  }

  // LIMIT 2 is enough to tell "one match" from "more than one", and avoids
  // dragging back a large candidate set just to reject it.
  const rows = await query({
    sql: `SELECT ${keyColumns.join(', ')} FROM ${table} WHERE ${
        predicates.join(' OR ')} LIMIT 2`,
    params,
    paramTypes,
  });

  if (!rows.length) {
    return {error: `No ${entity.name} matches '${input}'.`};
  }
  if (rows.length > 1) {
    return {
      error: `'${input}' matches more than one ${entity.name} (${
          rows.map(r => r.join('/')).join(', ')}); use a key to disambiguate.`,
    };
  }
  return {ref: {entity: entity.name, keys: rows[0], input}};
}


// The entity's identifying text field, if it has an obvious one: a String field
// that is not part of the key and whose name reads as a name. Deliberately
// conservative -- guessing wrong would make an agent's reference resolve to the
// wrong row, which is worse than making it supply a key.
function identifyingColumn(entity: Entity): string|null {
  const keys = new Set(entity.keys);
  for (const field of entity.fields) {
    if (keys.has(field.name)) continue;
    if (field.type !== 'String') continue;
    if (!/^(name|full_name|fullname|title|label|display_name)$/i.test(
            field.name)) {
      continue;
    }
    const expr = (field.expression ?? '').trim();
    if (!expr || !/^[A-Za-z_]\w*$/.test(expr)) continue;
    return quoteIfReserved(expr);
  }
  return null;
}
