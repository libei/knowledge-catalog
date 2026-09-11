// Lowering a model's constraints to SQL probes.
//
// A constraint is a logical invariant over the ontology (`Account.balance >=
// 0`). To enforce it against a live store, something has to turn that logical
// statement into a query the store can answer. That is this module: given a
// model and a constraint, it produces a PROBE -- a SELECT returning the rows
// that VIOLATE the constraint. No violating rows means the invariant holds.
//
// A constraint expression is SQL already. Four substitutions separate it from a
// runnable query, and they are the whole of what happens here:
//
//   * `Order.total` names a logical field. It becomes the column the binding
//     profile mapped it to, on the table that profile chose. Change the
//     profile and the same constraint probes a different table.
//   * `amount` names an argument of the action being gated. It becomes a bound
//     query parameter, so a caller's value reaches the store as a value and
//     can never be read as SQL.
//   * `SUM(LineItem.amount)` reaches across a relationship. It becomes a
//     subquery correlated on the join columns the model declares, which lets an
//     invariant span a one-to-many edge that a per-row predicate cannot.
//   * The constraint states what must hold; the probe asks who breaks it. So
//     the predicate is negated, as NOT COALESCE(x, FALSE) rather than NOT x,
//     because three-valued logic would let a NULL through a plain negation.
//
// Everything the substitutions do not touch is handed to the store verbatim.
// Whether `BETWEEN`, `CASE`, a function call or a parenthesized subexpression
// is acceptable is the store's question, and the store answers it exactly; a
// grammar here would only answer it earlier and worse. That choice has a cost,
// and it is where a mistake surfaces: a name that is neither a field nor a
// parameter is not caught here, and comes back from the store as an
// unrecognized name the first time the probe runs.
//
// What this module still refuses is what it cannot substitute -- an undeclared
// field, an entity with no table or no key, an aggregate over an ambiguous
// relationship. Those are errors in the model rather than in the SQL, and no
// store can phrase them. Every refusal aborts the action: a gate that quietly
// lets writes through is worse than no gate, because it is believed.
//

import {Constraint, Entity, SemanticModel} from './ir';
import {quoteIdentifier, quoteIfReserved} from './sql_identifiers';
import {
  escapeRegExp,
  mapOutsideStringLiterals,
  referencedEntityNames,
} from './sql_expr_utils';
import {spannerTable} from './spanner';


// A lowered constraint, ready to run inside the action's transaction.
export interface ConstraintProbe {
  constraint: Constraint;
  // The logical entity the constraint ranges over, and the physical table it
  // resolves to under the model's current binding.
  entity: string;
  table: string;
  // The entity's key columns, selected so a violation can name the offending
  // instances rather than just report that one exists.
  keyColumns: string[];
  // A SELECT returning violating rows. Empty result means the invariant holds.
  // Restricted to the caller's touched keys when `scoped` is true.
  sql: string;
  // The same probe over the whole table. Both forms are emitted rather than one
  // being derived from the other, so a caller that turns out not to know the
  // touched keys has a correct query to fall back to instead of editing SQL.
  unscopedSql: string;
  // Whether `sql` differs from `unscopedSql`. False when the caller asked for
  // no scoping, or when the entity's composite key rules it out.
  scoped: boolean;
  // Whether the expression reads an action parameter. Such a constraint is a
  // GUARD: it describes a proposed call, so it is checked before the write with
  // the arguments bound, and it means nothing once the call is over. A
  // constraint that reads only stored state is an INVARIANT and is checked
  // against the uncommitted result instead. The runtime routes on this.
  readsParameter: boolean;
  // The action parameters the expression reads, sorted. The runtime binds
  // exactly these.
  parameters: string[];
}


export type LoweringResult = {
  ok: true; probe: ConstraintProbe;
}|{
  ok: false;
  // Why this constraint could not be lowered, phrased for the person who wrote
  // the model -- the runtime surfaces it when it aborts the action.
  reason: string;
};


export interface LowerOptions {
  // The action parameters a constraint may read, by name. A constraint that
  // reads one is a guard: it describes a proposed CALL rather than stored
  // state, so it can only be evaluated by an action that supplies the values.
  parameters?: readonly string[];
  // Prefix for the bound parameter carrying an action argument. The runtime
  // binds `<prefix><name>`; keeping it distinct from the probe's own bindings
  // means an action parameter called `touchedKeys` cannot collide with them.
  parameterPrefix?: string;
  // The query parameter holding the touched key values (an ARRAY<STRING>), when
  // the caller can scope the probe. An action touches a handful of rows, so
  // re-checking the whole table on every write would make the gate cost grow
  // with the data. Only usable on a single-key entity: a composite key needs a
  // struct-array comparison, which this does not emit, so a composite-key
  // entity is probed unscoped.
  touchedKeysParam?: string;
  // Cap on the violating rows returned. A gate only needs enough to explain
  // itself, not the full violation set.
  limit?: number;
}


const DEFAULT_LIMIT = 5;

// The aggregate functions that lower to a correlated subquery over a related
// entity. Any other call is left alone, so `LOWER(Order.status)` reaches the
// store as an ordinary function over the row's own column.
const AGGREGATES = ['SUM', 'COUNT', 'MIN', 'MAX', 'AVG'];

// `FN(Entity.field)`, the only shape that can reach across an edge.
const CALL = /\b([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\)/g;

// Any `Entity.field` qualifier, used to report one that resolved to nothing.
const QUALIFIER = /\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)/g;


// Applies a substitution to the parts of an expression outside string literals,
// so a value such as 'Order.total' is treated as data rather than a reference.
function rewrite(
    expression: string, pattern: RegExp,
    to: (...groups: string[]) => string): string {
  return mapOutsideStringLiterals(
      expression, segment => segment.replace(pattern, to as never));
}


// Emitted SQL is parked behind a placeholder as it is produced, so a later
// substitution cannot rewrite what an earlier one wrote. Without this, an action
// parameter named `total` would rewrite the `total` column that the field
// substitution had just emitted. The sentinels are control characters, which no
// model expression contains.
class Parked {
  private readonly sql: string[] = [];

  park(text: string): string {
    return `\u0001${this.sql.push(text) - 1}\u0001`;
  }

  expand(text: string): string {
    return text.replace(/\u0001(\d+)\u0001/g, (_, i) => this.sql[Number(i)]);
  }
}


// Lowers one constraint against `model`, or explains why it cannot.
export function lowerConstraint(
    model: SemanticModel, constraint: Constraint,
    opts: LowerOptions = {}): LoweringResult {
  const fail = (reason: string): LoweringResult => ({
    ok: false,
    reason: `constraint '${constraint.name}' cannot be evaluated: ${reason}`,
  });

  if (!constraint.expression.trim()) return fail('the expression is empty');

  const parked = new Parked();
  const expression = normalizeOperators(constraint.expression.trim());

  // The entity the probe walks is the one whose fields the expression names
  // directly. An entity named inside an aggregate is reached through a
  // relationship and lands in a subquery, so it does not widen the row being
  // probed and is blanked out before the search.
  let aggregate: string|undefined;
  const withoutAggregates = rewrite(expression, CALL, (whole, fn, entity) => {
    if (!isAggregate(model, fn, entity)) return whole;
    aggregate ??= whole;
    return ' ';
  });
  const direct =
      referencedEntityNames(
          withoutAggregates, (model.entities ?? []).map(e => e.name))
          .sort();
  if (direct.length > 1) {
    return fail(
        `it reads fields of more than one entity (${
            direct.join(', ')}) side by side; the probe walks one entity's ` +
        `rows, so relate them with an aggregate (SUM(Other.field)) or split ` +
        `it into one constraint per entity`);
  }

  // No entity at all: every operand is a parameter or a literal, so the
  // constraint decides on the arguments alone and never reads the store. It is
  // still lowered to SQL rather than compared here, so that one code path
  // decides every rule and the store's own comparison semantics apply
  // throughout.
  if (!direct.length) {
    if (aggregate) {
      return fail(
          `'${aggregate}' needs a row to correlate to, but the expression ` +
          `names no entity field to probe`);
    }
    const bound = bindParameters(expression, opts);
    if (!bound.parameters.length) {
      return fail(
          `it names no entity field and no action parameter, so there is ` +
          `nothing for it to range over`);
    }
    const sql = `SELECT 1 AS violated FROM UNNEST([1]) WHERE ${
        violatingTest(bound.sql)} LIMIT 1`;
    return {
      ok: true,
      probe: {
        constraint,
        entity: '',
        table: '',
        keyColumns: [],
        sql,
        unscopedSql: sql,
        scoped: false,
        readsParameter: true,
        parameters: bound.parameters,
      },
    };
  }

  const entity = findEntity(model, direct[0])!;
  if (entity.abstract) {
    return fail(
        `entity '${entity.name}' is abstract, so it has no table to probe`);
  }
  const table = tableFor(entity);
  if ('error' in table) return fail(table.error);
  const keys = keyColumns(entity);
  if ('error' in keys) return fail(keys.error);

  const correlated =
      substituteAggregates(expression, model, entity, table.table, parked);
  if ('error' in correlated) return fail(correlated.error);
  const resolved = substituteFields(correlated.sql, entity, parked);
  if ('error' in resolved) return fail(resolved.error);

  const bound = bindParameters(resolved.sql, opts);
  const violating = violatingTest(parked.expand(bound.sql));

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const select = (where: string) =>
      `SELECT ${keys.columns.join(', ')} FROM ${table.table} WHERE ${
          where} LIMIT ${limit}`;

  const unscopedSql = select(violating);
  let sql = unscopedSql;
  let scoped = false;
  if (opts.touchedKeysParam && keys.columns.length === 1) {
    // The key values arrive as strings, so the comparison casts rather than
    // requiring the caller to know whether the key is an INT64 or a STRING.
    // That gives up the index on the key column; on the handful of rows one
    // action touches that costs nothing, and it keeps the runtime from having
    // to carry a type map alongside the keys.
    sql = select(
        `${violating} AND CAST(${keys.columns[0]} AS STRING) IN UNNEST(@${
            opts.touchedKeysParam})`);
    scoped = true;
  }

  return {
    ok: true,
    probe: {
      constraint,
      entity: entity.name,
      table: table.table,
      keyColumns: keys.columns,
      sql,
      unscopedSql,
      scoped,
      readsParameter: bound.parameters.length > 0,
      parameters: bound.parameters,
    },
  };
}


// Folds the spellings a model author reaches for into the ones the store
// accepts. `==` is not SQL at all, and GoogleSQL rejects `= NULL` outright
// rather than evaluating it to unknown, so an author writing `Order.ownerId !=
// NULL` -- meaning the column must be populated -- gets the IS NOT NULL that
// spells it.
function normalizeOperators(expression: string): string {
  return mapOutsideStringLiterals(
      expression,
      segment => segment.replace(/==/g, '=')
                     .replace(/(!=|<>)\s*NULL\b/gi, 'IS NOT NULL')
                     .replace(/(?<![<>!])=\s*NULL\b/gi, 'IS NULL'));
}


// NOT COALESCE(<predicate>, FALSE) rather than a plain NOT: SQL three-valued
// logic makes `NULL >= 0` unknown, and `NOT unknown` is unknown, so a NULL
// column would slip past a plain negation. Treating unknown as "did not satisfy
// the invariant" makes the row a violation -- the fail-closed reading, and the
// right one for a gate.
function violatingTest(predicate: string): string {
  return `NOT COALESCE((${predicate}), FALSE)`;
}


function findEntity(model: SemanticModel, name: string): Entity|undefined {
  return (model.entities ?? []).find(e => e.name === name);
}


// Whether a matched call is an aggregate over a declared entity, and so reaches
// across an edge rather than operating on the probed row.
function isAggregate(
    model: SemanticModel, fn: string, entity: string): boolean {
  return AGGREGATES.includes(fn.toUpperCase()) && !!findEntity(model, entity);
}


// Rewrites each `AGG(Other.field)` to a subquery correlated to the row being
// probed, parking the result so nothing downstream rewrites it.
function substituteAggregates(
    expression: string, model: SemanticModel, rowEntity: Entity, table: string,
    parked: Parked): {sql: string}|{error: string} {
  let error: string|undefined;
  const sql = rewrite(expression, CALL, (whole, fn, entity, field) => {
    if (!isAggregate(model, fn, entity)) return whole;
    const sub = aggregateSubquery(
        model, {fn: fn.toUpperCase(), entity, field}, rowEntity, table);
    if ('error' in sub) {
      error ??= sub.error;
      return whole;
    }
    return parked.park(sub.sql);
  });
  return error ? {error} : {sql};
}


// Rewrites every `<Entity>.<field>` on the probed row to the column the binding
// profile gave it. A qualifier left standing afterwards named a field the entity
// does not declare, which is a typo worth catching here rather than letting the
// store report it as a missing column.
function substituteFields(expression: string, entity: Entity, parked: Parked):
    {sql: string}|{error: string} {
  let out = expression;
  for (const field of entity.fields) {
    const bound = boundExpression(entity, field.name);
    if ('error' in bound) continue;
    const parkedSql = parked.park(bound.sql);
    out = rewrite(
        out, qualifierPattern(entity.name, field.name), () => parkedSql);
  }

  let unresolved: string|undefined;
  rewrite(out, QUALIFIER, (whole, named, field) => {
    if (named === entity.name) unresolved ??= field;
    return whole;
  });
  if (unresolved === undefined) return {sql: out};
  return {
    error: entity.fields.some(f => f.name === unresolved) ?
        `field '${entity.name}.${unresolved}' is unbound under the current ` +
            `binding, so there is nothing to check it against` :
        `entity '${entity.name}' declares no field '${unresolved}'`,
  };
}


// Matches `Entity.field`, bare or backtick-quoted, and not as part of a longer
// identifier: the trailing guard keeps `Order.total` from matching inside
// `Order.total_tax`.
function qualifierPattern(entity: string, field: string): RegExp {
  return new RegExp(
      `(?<![\\w\`])\`?${escapeRegExp(entity)}\`?\\s*\\.\\s*\`?${
          escapeRegExp(field)}\`?(?!\\w)`,
      'g');
}


// Rewrites each declared action parameter to a bound query parameter, and
// reports which ones the expression actually read. The lookbehind keeps a
// parameter name from matching the tail of a qualified reference; every field is
// already parked behind a placeholder by this point, so a parameter and a column
// may share a name without colliding.
function bindParameters(expression: string, opts: LowerOptions):
    {sql: string; parameters: string[]} {
  const used = new Set<string>();
  let out = expression;
  for (const name of opts.parameters ?? []) {
    const pattern = new RegExp(`(?<![\\w.\`])${escapeRegExp(name)}\\b`, 'g');
    out = rewrite(out, pattern, () => {
      used.add(name);
      return `@${opts.parameterPrefix ?? ''}${name}`;
    });
  }
  return {sql: out, parameters: [...used].sort()};
}


// The SQL a field resolves to under the binding in force. Usually a bare column;
// an expression-bound field (`price * qty`) is inlined in parentheses, which is
// safe because the probe already ranges over that field's own table.
function boundExpression(entity: Entity, fieldName: string):
    {sql: string}|{error: string} {
  const field = entity.fields.find(f => f.name === fieldName);
  if (!field) {
    return {error: `entity '${entity.name}' declares no field '${fieldName}'`};
  }
  // No expression is what unbound means: the profile in force bound nothing to
  // this field, so there is no column to check the invariant against.
  const expr = (field.expression ?? '').trim();
  if (!expr) {
    return {
      error: `field '${entity.name}.${fieldName}' is unbound under the ` +
          `current binding, so there is nothing to check it against`,
    };
  }
  return {sql: isBareColumn(expr) ? quoteIfReserved(expr) : `(${expr})`};
}


function isBareColumn(expression: string): boolean {
  return /^[A-Za-z_]\w*$/.test(expression);
}


// The physical table backing an entity, or why there is none.
function tableFor(entity: Entity): {table: string}|{error: string} {
  const warnings: string[] = [];
  const table =
      spannerTable(entity.dataSource, warnings, `entity '${entity.name}'`);
  if (warnings.length) {
    return {
      error: `entity '${entity.name}' has no usable table (${
          warnings.join('; ')})`,
    };
  }
  return {table};
}


// The entity's key columns, resolved through its fields. A key has to be a bare
// column: the probe selects it and casts it to scope by it, so an expression
// there would leave the caller's touched keys nothing to match.
function keyColumns(entity: Entity): {columns: string[]}|{error: string} {
  if (!entity.keys.length) {
    return {
      error: `entity '${entity.name}' declares no key, so a violation could ` +
          `not be attributed to a row`,
    };
  }
  const columns: string[] = [];
  for (const key of entity.keys) {
    const bound = boundExpression(entity, key);
    if ('error' in bound) return {error: `key ${bound.error}`};
    if (!isBareColumn(bound.sql.replace(/`/g, ''))) {
      return {
        error: `key '${entity.name}.${key}' is bound to an expression rather ` +
            `than a bare column, so a violation could not be attributed to a ` +
            `row`,
      };
    }
    columns.push(bound.sql);
  }
  return {columns};
}


// Lowers `SUM(Other.field)` to a subquery correlated to the row being probed.
//
// The correlation comes from a DECLARED relationship, so the constraint author
// writes `Order.total == SUM(LineItem.amount)` and the join columns are read out
// of the model rather than guessed from the names. Exactly one relationship may
// connect the two entities: with two, the expression is ambiguous about which
// edge it means, and picking one would silently check a different rule than the
// one written.
function aggregateSubquery(
    model: SemanticModel, op: {fn: string; entity: string; field: string},
    rowEntity: Entity, table: string): {sql: string}|{error: string} {
  const cited = `${op.fn}(${op.entity}.${op.field})`;
  const inner = findEntity(model, op.entity)!;
  if (inner.abstract) {
    return {
      error: `entity '${op.entity}' is abstract, so it has no table to ` +
          `aggregate over`,
    };
  }

  const edges = (model.relationships ?? []).filter(
      r => !r.association &&
          ((r.source.entity === op.entity &&
            r.destination.entity === rowEntity.name) ||
           (r.source.entity === rowEntity.name &&
            r.destination.entity === op.entity)));
  if (!edges.length) {
    return {
      error: `no relationship connects '${op.entity}' to '${rowEntity.name}', ` +
          `so '${cited}' cannot be correlated to the row being checked; ` +
          `declare one`,
    };
  }
  if (edges.length > 1) {
    return {
      error: `${edges.length} relationships connect '${op.entity}' to '${
          rowEntity.name}' (${edges.map(e => e.name).sort().join(', ')}), so '${
          cited}' is ambiguous about which one it means`,
    };
  }
  const edge = edges[0];
  const [innerEnd, outerEnd] = edge.source.entity === op.entity ?
      [edge.source, edge.destination] :
      [edge.destination, edge.source];
  if (innerEnd.columns.length !== outerEnd.columns.length ||
      !innerEnd.columns.length) {
    return {
      error: `relationship '${edge.name}' does not pair its join columns, so '${
          cited}' cannot be correlated`,
    };
  }

  const measured = boundExpression(inner, op.field);
  if ('error' in measured) return {error: measured.error};
  const innerTable = tableFor(inner);
  if ('error' in innerTable) return {error: innerTable.error};

  // The outer table is unaliased, so its own name qualifies its columns.
  const on = innerEnd.columns
                 .map((c, i) => `${innerTable.table}.${quoteIfReserved(c)} = ${
                          table}.${quoteIfReserved(outerEnd.columns[i])}`)
                 .join(' AND ');

  // SUM and COUNT over no rows are 0, not NULL: an order with no line items has
  // a line-item total of zero, and leaving it NULL would make the comparison
  // unknown and so report a violation the data does not have. MIN, MAX and AVG
  // have no such identity, so they stay NULL and the fail-closed reading
  // applies.
  const body =
      `SELECT ${op.fn}(${measured.sql}) FROM ${innerTable.table} WHERE ${on}`;
  const zeroed = op.fn === 'SUM' || op.fn === 'COUNT';
  return {sql: zeroed ? `COALESCE((${body}), 0)` : `(${body})`};
}


// Lowers every constraint on the model. Returns the probes and the reasons for
// the ones that could not be lowered; the runtime treats a non-empty `errors`
// as an abort, since it cannot tell an un-checkable invariant from a satisfied
// one.
export function lowerConstraints(
    model: SemanticModel, opts: LowerOptions = {}):
    {probes: ConstraintProbe[]; errors: string[]} {
  const probes: ConstraintProbe[] = [];
  const errors: string[] = [];
  for (const constraint of model.constraints ?? []) {
    const result = lowerConstraint(model, constraint, opts);
    if (result.ok) {
      probes.push(result.probe);
    } else {
      errors.push(result.reason);
    }
  }
  return {probes, errors};
}


// The message returned when a probe finds violating rows. `description` is the
// model author's own words and leads, because it is what tells an agent what to
// do differently; the constraint name and expression follow as the citation.
export function violationMessage(
    probe: ConstraintProbe, violatingKeys: string[][]): string {
  const lead = probe.constraint.description ??
      `Constraint '${probe.constraint.name}' does not hold.`;
  // Named for what the severity actually does, so an escalation does not tell
  // the caller it was rejected when a supervisor can still let it through.
  const verb = {
    reject: 'Rejected by',
    escalate: 'Held for review by',
    warn: 'Flagged by',
  }[probe.constraint.severity ?? 'reject'];
  const cite = `${verb} constraint '${probe.constraint.name}' (${
      probe.constraint.expression}).`;
  // A constraint over the action's arguments alone ranges over no table, so it
  // has no violating rows to cite -- the probe returns a single placeholder row
  // meaning "the test failed", and printing it as a key would be noise.
  if (!violatingKeys.length || !probe.entity) return `${lead} ${cite}`;
  const rows = violatingKeys.map(k => k.join('/')).join(', ');
  return `${lead} ${cite} Violating ${probe.entity}: ${rows}.`;
}


// Re-exported so a caller building a probe by hand quotes identifiers the same
// way this module does.
export {quoteIdentifier};
