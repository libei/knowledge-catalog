// The semantic runtime: executing a model's action against a live store, gated
// by the model's constraints.
//
// A semantic model has always described what things MEAN. Actions describe what
// can be DONE, and constraints describe what must stay true. This module is
// where those three meet an actual database:
//
//   1. RESOLVE. An action's parameters are typed by the ontology, so an
//      entity-typed argument is an object reference, not a value. The caller
//      (often an agent) supplies something human -- an account id, a person's
//      name -- and the runtime turns it into the row that argument denotes,
//      failing loudly on "no such thing" and on "more than one such thing".
//   2. GUARD. A constraint that reads an action's parameters describes the
//      proposed CALL, not the stored data, so it is checked BEFORE the write,
//      with the arguments bound. "A credit may not exceed the order total" is
//      about the number the caller asked for; once the write has happened there
//      is no longer an `amount` for it to read.
//   3. APPLY. A read-write transaction is opened and the action's writes are
//      run inside it. Nothing is visible to anyone else yet.
//   4. GATE. Every constraint over stored state is lowered to a probe and run
//      IN THE SAME transaction, so it observes the uncommitted writes
//      (read-your-writes). A probe returning rows means the write would leave
//      the store violating an invariant.
//   5. DECIDE. A violation of a `reject` constraint rolls the transaction back
//      and returns the constraint's own `description` -- text the model author
//      wrote to tell the caller what to do differently. An `escalate` violation
//      also rolls back, but comes back as a review request the caller can
//      re-submit with an approval. A `warn` violation is reported and committed.
//      No violation at all commits.
//
// The gate fails closed. If a constraint cannot be lowered, the action is
// aborted rather than run unchecked: the runtime cannot tell an unevaluated
// invariant from a satisfied one, and guessing in favour of the write is how
// data gets corrupted.
//
// Where the write comes from. An action with a `sql` executor carries its own
// DML, and the runtime runs those statements itself: every value the caller
// supplied is bound as a query parameter, never interpolated, and the touched
// rows are known from the action's `affects`, so the probes can be scoped. An
// action with an `mcp`, `rest` or `grpc` executor names an operation that lives
// in another system, which this module cannot call and could not roll back if
// it did; for those the caller supplies a handler that produces the statements.

import * as spanner from '../gcp/spanner';

import {
  ConstraintProbe,
  lowerConstraint,
  violationMessage,
} from './constraint_eval';
import {
  Action,
  ActionParameter,
  ConstraintSeverity,
  Entity,
  generatedKeyParam,
  SemanticModel,
} from './ir';
import {spannerTable} from './spanner';
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
  // The rows the statements touch, by entity name. Used to scope the constraint
  // probes: a probe restricted to these keys costs the same whether the table
  // has a thousand rows or a billion. An entity omitted here is probed over its
  // whole table, which is correct but slower -- so omit only when the touched
  // set genuinely is not known.
  touched?: Record<string, string[]>;
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


// A constraint the call or the post-state violated.
export interface Violation {
  constraint: string;
  // The entity whose rows the probe walked, or '' for a constraint that reads
  // only the action's arguments and so ranges over no table.
  entity: string;
  message: string;
  violatingKeys: string[][];
  severity: ConstraintSeverity;
  // Whether the violation was found before the write (a guard, reading the
  // arguments) or after it (an invariant, reading the uncommitted rows).
  stage: 'guard'|'invariant';
}


export type ActionOutcome = {
  status: 'committed';
  commitTimestamp?: string;
  refs: Record<string, EntityRef>;
  // The constraints that were checked, so a caller can show its work.
  checked: string[];
  // Violations of `warn` constraints. The write went through; these are what
  // the caller should be told about anyway.
  warnings: Violation[];
}|{
  status: 'rejected';
  // Why the write was refused, assembled from the violated constraints'
  // descriptions. This is the text an agent reads to correct itself.
  message: string;
  violations: Violation[];
}|{
  status: 'escalated';
  // Why the write needs a human. Same text as a rejection, but the caller has
  // somewhere to go: re-submit the identical arguments with these constraint
  // names in `approvals`.
  message: string;
  violations: Violation[];
  // The constraint names an approver must sign off, sorted.
  approvalRequired: string[];
}|{
  status: 'error';
  // A failure that is not a constraint violation: an argument that resolved to
  // nothing, a constraint that could not be lowered, a store-level error. The
  // transaction is rolled back in every case, so no partial write survives.
  message: string;
};


export interface RunActionOptions {
  model: SemanticModel;
  actionName: string;
  args: Record<string, unknown>;
  client: spanner.SpannerDataClient;
  // Supplies the writes for an action whose executor lives in another system.
  // Omit it for a `sql` executor, whose writes are in the model.
  handler?: ActionHandler;
  // Constraint names an approver has signed off. An `escalate` violation of a
  // named constraint stops blocking the write; every other severity is
  // unaffected, so an approval cannot wave through a `reject`.
  approvals?: readonly string[];
  // Cap on the violating rows a probe reports. Defaults to the lowering
  // module's own cap.
  violationLimit?: number;
}


const TOUCHED_PARAM = 'touchedKeys';

// Action arguments reach a constraint probe under this prefix, so an action
// parameter named `touchedKeys` cannot collide with the probe's own binding.
// The DML in a `sql` executor binds the same values under their bare names,
// because that is what the model author wrote.
const PARAM_PREFIX = 'p_';


// Runs one action end to end. Never throws for an expected failure -- an
// unresolvable argument, a violated constraint, a rejected statement all come
// back as an outcome, because the caller is usually an agent that needs to read
// the reason and try again.
export async function runAction(opts: RunActionOptions):
    Promise<ActionOutcome> {
  const {model, client, args} = opts;
  const action =
      (model.actions ?? []).find(a => a.name === opts.actionName);
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
          `transaction and could not be rolled back if a constraint failed. ` +
          `Supply a handler that performs the write as DML, or declare the ` +
          `action with a 'sql' executor.`,
    };
  }

  // Lower the constraints BEFORE touching the store. A model whose invariants
  // cannot be checked should fail without having opened a transaction at all.
  const lowered = lowerForAction(model, action, opts.violationLimit);
  if ('error' in lowered) {
    return {
      status: 'error',
      message: `Action '${action.name}' was not run because the model's ` +
          `constraints cannot all be evaluated, and running an unchecked ` +
          `write is not safe: ${lowered.error}`,
    };
  }
  const {guards, invariants} = lowered;
  const approvals = new Set(opts.approvals ?? []);
  const checked = [...guards, ...invariants].map(p => p.constraint.name);

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

      const run = async(stmt: spanner.Statement) => {
        const res = await client.executeSql(sessionName, transactionId, stmt);
        if (res.status < 200 || res.status >= 300) {
          throw new StoreError(
              `${res.message ?? 'request failed'} (while running: ${stmt.sql})`);
        }
        return res.result ?? {};
      };
      const query = async(stmt: spanner.Statement) =>
          (await run(stmt)).rows ?? [];

      // Everything from here on is inside the transaction, so any failure must
      // roll back rather than leave it open.
      try {
        const rollback = async(outcome: ActionOutcome) => {
          await client.rollback(sessionName, transactionId);
          return outcome;
        };

        const resolved = await resolveArguments(model, action, args, query);
        if ('error' in resolved) {
          return await rollback({status: 'error', message: resolved.error});
        }
        const refs = resolved.refs;

        const bound = bindArguments(model, action, args, refs);
        if ('error' in bound) {
          return await rollback({status: 'error', message: bound.error});
        }

        // The rows the call already names. Enough to scope a guard, which runs
        // before anything has been written.
        const touched: Record<string, string[]> = {};
        for (const ref of Object.values(refs)) {
          if (ref.keys.length === 1) addTouched(touched, ref.entity, ref.keys[0]);
        }

        const guardViolations =
            await checkConstraints(guards, touched, bound, 'guard', query);
        const guardCall = decide(guardViolations, approvals);
        if (guardCall) return await rollback(guardCall);

        // Rows the action is about to create. Their keys are generated here
        // rather than by the store, so the DML can bind them and the probes can
        // be scoped to them.
        const generated = generatedKeys(action);
        for (const [concept, key] of Object.entries(generated)) {
          addTouched(touched, concept, key);
        }

        const plan = opts.handler ?
            await opts.handler({model, action, args, refs, query}) :
            planFromExecutor(action, bound, generated, touched);
        if ('error' in plan) {
          return await rollback({status: 'error', message: plan.error});
        }
        for (const stmt of plan.statements) {
          await run(stmt);
        }

        // A handler that reports no touched rows gets whole-table probes. The
        // rows the ARGUMENTS name are not a safe substitute: a handler may have
        // written rows the call never mentioned, and scoping to the mentioned
        // ones would check a subset of what changed.
        const postViolations = await checkConstraints(
            invariants, plan.touched ?? {}, bound, 'invariant', query);
        const postCall = decide(postViolations, approvals);
        if (postCall) return await rollback(postCall);

        const committed = await client.commit(sessionName, transactionId);
        if (committed.status < 200 || committed.status >= 300) {
          return {
            status: 'error',
            message: `The write passed every constraint but the commit ` +
                `failed: ${committed.message ?? committed.status}.`,
          } as ActionOutcome;
        }
        return {
          status: 'committed',
          commitTimestamp: committed.result?.commitTimestamp,
          refs,
          checked,
          warnings: [...guardViolations, ...postViolations].filter(
              v => v.severity === 'warn'),
        } as ActionOutcome;
      } catch (err) {
        await client.rollback(sessionName, transactionId);
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


// Splits the model's constraints into the ones checked before this action's
// write and the ones checked after it.
//
// A constraint that reads an action parameter is a GUARD: it can only be
// evaluated with the arguments in hand, which is before the write. Everything
// else is an INVARIANT over stored state and is checked against the uncommitted
// result. A constraint the author also NAMED in `guards` is checked at both
// moments when it reads no parameter -- naming it buys an earlier failure, and
// does not remove the later one.
//
// A constraint that cannot be lowered aborts the action, with one exception: if
// it gates some OTHER action, its parameters are not in scope here and its
// failure to lower says nothing about this call. Skipping it is not a hole,
// because the action it does gate cannot run without it.
function lowerForAction(
    model: SemanticModel, action: Action, limit?: number):
    {guards: ConstraintProbe[]; invariants: ConstraintProbe[]}|{error: string} {
  const parameters = action.parameters.map(p => p.name);
  const named = new Set(action.guards ?? []);
  const gatesAnother = new Set<string>();
  for (const other of model.actions ?? []) {
    if (other.name === action.name) continue;
    for (const name of other.guards ?? []) gatesAnother.add(name);
  }

  const guards: ConstraintProbe[] = [];
  const invariants: ConstraintProbe[] = [];
  const errors: string[] = [];
  for (const constraint of model.constraints ?? []) {
    const result = lowerConstraint(model, constraint, {
      parameters,
      parameterPrefix: PARAM_PREFIX,
      touchedKeysParam: TOUCHED_PARAM,
      limit,
    });
    if (!result.ok) {
      if (!named.has(constraint.name) && gatesAnother.has(constraint.name)) {
        continue;
      }
      errors.push(result.reason);
      continue;
    }
    const probe = result.probe;
    if (probe.readsParameter) {
      guards.push(probe);
    } else {
      if (named.has(constraint.name)) guards.push(probe);
      invariants.push(probe);
    }
  }
  if (errors.length) return {error: errors.join('; ')};
  return {guards, invariants};
}


// The action arguments, bound as query parameters.
interface Bindings {
  // Keyed by the bare parameter name; the probe prefix is applied on use.
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
          `to a constraint or a statement.`,
    };
  }
  const entity = (model.entities ?? []).find(e => e.name === param.type);
  const keyField =
      entity?.fields.find(f => f.name === (entity.keys ?? [])[0]);
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


// A key for every concept the action creates, named as the DML expects it.
// Generated here rather than left to the store because the probes have to be
// scoped to the new rows, and a server-assigned key is not known until after
// the statement that would need it.
function generatedKeys(action: Action): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const affected of action.affects ?? []) {
    if (affected.operation !== 'create') continue;
    keys[affected.concept] = crypto.randomUUID();
  }
  return keys;
}


// Builds the plan from the action's own DML. Every `@name` in a statement is
// either a declared parameter or a key this call generates; validate.ts refuses
// a model where it is neither, so an unbound reference cannot reach here.
function planFromExecutor(
    action: Action, bound: Bindings, generated: Record<string, string>,
    touched: Record<string, string[]>): ActionPlan|{error: string} {
  if (action.executor.kind !== 'sql') {
    return {error: `Action '${action.name}' has no 'sql' executor.`};
  }
  const values: Record<string, unknown> = {...bound.params};
  const types: Record<string, {code: string}> = {...bound.types};
  for (const [concept, key] of Object.entries(generated)) {
    values[generatedKeyParam(concept)] = key;
    types[generatedKeyParam(concept)] = {code: 'STRING'};
  }

  const statements: spanner.Statement[] = [];
  for (const sql of action.executor.sql.statements) {
    const params: Record<string, unknown> = {};
    const paramTypes: Record<string, {code: string}> = {};
    for (const name of referencedParameters(sql)) {
      if (!(name in values)) {
        return {
          error: `Action '${action.name}' binds '@${name}', which is neither ` +
              `a parameter it declares nor a key it generates.`,
        };
      }
      params[name] = values[name];
      paramTypes[name] = types[name];
    }
    statements.push({sql, params, paramTypes});
  }
  return {statements, touched};
}


// Runs every probe and collects the violations. A probe whose entity has no
// touched keys runs unscoped; one whose entity was touched is restricted to
// those rows. A probe reading action parameters gets exactly the ones it reads,
// bound under the prefix the lowering used.
async function checkConstraints(
    probes: ConstraintProbe[], touched: Record<string, string[]>,
    bound: Bindings, stage: 'guard'|'invariant',
    query: (stmt: spanner.Statement) => Promise<string[][]>):
    Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const probe of probes) {
    const params: Record<string, unknown> = {};
    const paramTypes: spanner.ParamTypes = {};
    for (const name of probe.parameters) {
      params[`${PARAM_PREFIX}${name}`] = bound.params[name];
      paramTypes[`${PARAM_PREFIX}${name}`] = bound.types[name];
    }

    const keys = touched[probe.entity];
    let sql = probe.unscopedSql;
    if (probe.scoped && keys && keys.length) {
      // The key values arrive as strings, matching the cast the probe applies.
      sql = probe.sql;
      params[TOUCHED_PARAM] = keys;
      paramTypes[TOUCHED_PARAM] = {
        code: 'ARRAY',
        arrayElementType: {code: 'STRING'},
      };
    }
    // No touched keys for this entity, so check the whole table. Passing an
    // empty array to the scoped probe instead would match nothing and the
    // constraint would pass vacuously -- the exact silent-success failure the
    // gate exists to prevent.

    // Omitted rather than sent empty when the probe binds nothing, so a
    // constraint over stored state produces the same request it always did.
    const stmt: spanner.Statement = Object.keys(params).length ?
        {sql, params, paramTypes} :
        {sql};
    const rows = await query(stmt);
    if (rows.length) {
      violations.push({
        constraint: probe.constraint.name,
        entity: probe.entity,
        message: violationMessage(probe, rows),
        // A constraint reading only the action's arguments ranges over no
        // table. Its probe returns one placeholder row meaning "the test
        // failed", which is not a key of anything and is not reported as one.
        violatingKeys: probe.entity ? rows : [],
        severity: probe.constraint.severity ?? 'reject',
        stage,
      });
    }
  }
  return violations;
}


// The outcome a set of violations forces, or null to carry on.
//
// A `reject` always stops the write. An `escalate` stops it too, but names
// itself so an approver can let the same call through; an approval is scoped to
// one constraint and cannot lift a rejection. A `warn` never stops anything and
// is reported on the committed outcome.
function decide(violations: Violation[], approvals: Set<string>): ActionOutcome|
    null {
  const rejected = violations.filter(v => v.severity === 'reject');
  if (rejected.length) {
    return {
      status: 'rejected',
      message: rejected.map(v => v.message).join(' '),
      violations: rejected,
    };
  }
  const escalated = violations.filter(
      v => v.severity === 'escalate' && !approvals.has(v.constraint));
  if (escalated.length) {
    return {
      status: 'escalated',
      message: escalated.map(v => v.message).join(' '),
      violations: escalated,
      approvalRequired: [...new Set(escalated.map(v => v.constraint))].sort(),
    };
  }
  return null;
}


function addTouched(
    touched: Record<string, string[]>, entity: string, key: string): void {
  const keys = touched[entity] ?? (touched[entity] = []);
  if (!keys.includes(key)) keys.push(key);
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
    return {
      error: `Cannot resolve a ${entity.name}: ${warnings.join('; ')}.`,
    };
  }

  const keyColumns: string[] = [];
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
  }
  if (!keyColumns.length) {
    return {error: `Cannot resolve a ${entity.name}: it declares no key.`};
  }

  const predicates =
      keyColumns.map(c => `CAST(${c} AS STRING) = @ref`);
  const label = identifyingColumn(entity);
  if (label) predicates.push(`CAST(${label} AS STRING) = @ref`);

  // LIMIT 2 is enough to tell "one match" from "more than one", and avoids
  // dragging back a large candidate set just to reject it.
  const rows = await query({
    sql: `SELECT ${keyColumns.join(', ')} FROM ${table} WHERE ${
        predicates.join(' OR ')} LIMIT 2`,
    params: {ref: input},
    paramTypes: {ref: {code: 'STRING'}},
  });

  if (!rows.length) {
    return {
      error: `No ${entity.name} matches '${input}'.`,
    };
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
