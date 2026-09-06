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
//   2. APPLY. A read-write transaction is opened and the action's writes are
//      run inside it. Nothing is visible to anyone else yet.
//   3. GATE. Every constraint is lowered to a probe and run IN THE SAME
//      transaction, so it observes the uncommitted writes (read-your-writes).
//      A probe returning rows means the write would leave the store violating
//      an invariant.
//   4. DECIDE. Any violation rolls the transaction back and returns the
//      constraint's own `description` -- text the model author wrote to tell
//      the caller what to do differently. No violation commits.
//
// The gate fails closed. If a constraint cannot be lowered, the action is
// aborted rather than run unchecked: the runtime cannot tell an unevaluated
// invariant from a satisfied one, and guessing in favour of the write is how
// data gets corrupted.
//
// What the runtime does NOT do is invent the write itself. An action declares
// an executor -- it names where the operation lives, not what SQL it runs -- so
// the caller supplies a handler that produces the statements. The ontology
// contributes typed resolution and the constraint gate; the mutation body comes
// from the handler. That split is deliberate and is where a real executor
// dispatch (MCP, REST, gRPC) would later slot in.
//

import * as spanner from '../gcp/spanner';

import {
  ConstraintProbe,
  lowerConstraints,
  violationMessage,
} from './constraint_eval';
import {Action, Entity, SemanticModel} from './ir';
import {spannerTable} from './spanner';
import {quoteIfReserved} from './sql_identifiers';


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


// The writes an action performs, produced by the caller's handler.
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


// A constraint that the post-state violated.
export interface Violation {
  constraint: string;
  entity: string;
  message: string;
  violatingKeys: string[][];
}


export type ActionOutcome = {
  status: 'committed';
  commitTimestamp?: string;
  refs: Record<string, EntityRef>;
  // The constraints that were checked, so a caller can show its work.
  checked: string[];
}|{
  status: 'rejected';
  // Why the write was refused, assembled from the violated constraints'
  // descriptions. This is the text an agent reads to correct itself.
  message: string;
  violations: Violation[];
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
  handler: ActionHandler;
  // Cap on the violating rows a probe reports. Defaults to the lowering
  // module's own cap.
  violationLimit?: number;
}


const TOUCHED_PARAM = 'touchedKeys';


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

  // Lower the constraints BEFORE touching the store. A model whose invariants
  // cannot be checked should fail without having opened a transaction at all.
  const lowered = lowerConstraints(
      model,
      {touchedKeysParam: TOUCHED_PARAM, limit: opts.violationLimit});
  if (lowered.errors.length) {
    return {
      status: 'error',
      message: `Action '${action.name}' was not run because the model's ` +
          `constraints cannot all be evaluated, and running an unchecked ` +
          `write is not safe: ${lowered.errors.join('; ')}`,
    };
  }

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
        const refs = await resolveArguments(model, action, args, query);
        if ('error' in refs) {
          await client.rollback(sessionName, transactionId);
          return {status: 'error', message: refs.error} as ActionOutcome;
        }

        const plan = await opts.handler(
            {model, action, args, refs: refs.refs, query});
        for (const stmt of plan.statements) {
          await run(stmt);
        }

        const violations = await checkConstraints(
            lowered.probes, plan.touched ?? {}, query);
        if (violations.length) {
          await client.rollback(sessionName, transactionId);
          return {
            status: 'rejected',
            message: violations.map(v => v.message).join(' '),
            violations,
          } as ActionOutcome;
        }

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
          refs: refs.refs,
          checked: lowered.probes.map(p => p.constraint.name),
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


// Runs every probe and collects the violations. A probe whose entity has no
// touched keys runs unscoped; one whose entity was touched is restricted to
// those rows.
async function checkConstraints(
    probes: ConstraintProbe[], touched: Record<string, string[]>,
    query: (stmt: spanner.Statement) => Promise<string[][]>):
    Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const probe of probes) {
    const keys = touched[probe.entity];
    let stmt: spanner.Statement;
    if (probe.scoped && keys && keys.length) {
      stmt = {
        sql: probe.sql,
        params: {[TOUCHED_PARAM]: keys},
        paramTypes: {
          [TOUCHED_PARAM]:
              {code: 'ARRAY', arrayElementType: {code: 'STRING'}},
        },
      };
    } else {
      // No touched keys for this entity, so check the whole table. Passing an
      // empty array to the scoped probe instead would match nothing and the
      // constraint would pass vacuously -- the exact silent-success failure the
      // gate exists to prevent.
      stmt = {sql: probe.unscopedSql};
    }
    const rows = await query(stmt);
    if (rows.length) {
      violations.push({
        constraint: probe.constraint.name,
        entity: probe.entity,
        message: violationMessage(probe, rows),
        violatingKeys: rows,
      });
    }
  }
  return violations;
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
