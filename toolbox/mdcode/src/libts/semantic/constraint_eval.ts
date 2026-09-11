// Lowering a model's constraints to SQL probes.
//
// A constraint is a logical invariant over the ontology (`Account.balance >=
// 0`). To enforce it against a live store, something has to turn that logical
// statement into a query the store can answer. That is this module: given a
// model and a constraint, it produces a PROBE -- a SELECT that returns the rows
// which VIOLATE the constraint. No violating rows means the invariant holds.
//
// Two properties matter more than expressive power here:
//
//   * The probe is scoped. An action touches a handful of rows, so re-checking
//     the whole table on every write would make the gate cost grow with the
//     data. When the caller knows which keys it touched, the probe restricts to
//     them.
//   * The lowering FAILS CLOSED. An expression this module cannot lower does
//     not silently pass -- it returns an error, and the runtime aborts the
//     action. A gate that quietly lets writes through is worse than no gate,
//     because it is believed.
//
// The grammar is deliberately small (see parseConstraint): comparisons between
// a field and a literal or another field of the same entity, joined by AND/OR.
// It covers the invariants an operational action actually trips -- a balance
// going negative, a quantity going to zero -- and everything outside it is
// reported rather than approximated.
//

import {Constraint, Entity, SemanticModel} from './ir';
import {quoteIdentifier, quoteIfReserved} from './sql_identifiers';
import {spannerTable} from './spanner';


// The comparison operators the grammar accepts. Ordered longest-first so the
// tokenizer matches `>=` before `>`.
const OPERATORS = ['>=', '<=', '!=', '<>', '==', '=', '>', '<'] as const;


// One side of a comparison.
//
// `field` and `literal` are what a stored-state invariant is made of. The other
// two are what a GUARD needs, and they are why this is a union rather than the
// two optional strings it started as:
//
//   * `param` is an argument of the action being gated. It has no column, so it
//     is bound as a query parameter and the comparison can be decided before the
//     write happens -- which is the whole point of a guard.
//   * `agg` is an aggregate over a RELATED entity (`SUM(LineItem.amount)`). It
//     lowers to a correlated subquery, so an invariant can span the one-to-many
//     edge that a per-row predicate cannot reach.
type Operand =
    {kind: 'field'; entity: string; field: string}|
    {kind: 'param'; name: string}|
    // Kept verbatim; already SQL-shaped and checked by isLiteral.
    {kind: 'literal'; text: string}|
    {kind: 'agg'; fn: string; entity: string; field: string};


// A single `<operand> <op> <operand>` comparison, as parsed.
interface Comparison {
  left: Operand;
  operator: string;
  right: Operand;
}


// A parsed constraint expression: comparisons joined by the logical operators
// between them (`joiners[i]` sits between `comparisons[i]` and `[i+1]`).
interface ParsedExpression {
  comparisons: Comparison[];
  joiners: string[];
}


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
  // reads one is a guard: it describes a proposed CALL rather than stored state,
  // so it can only be evaluated in the context of an action that supplies the
  // values. Absent or empty means no parameter is in scope, and a constraint
  // mentioning one is refused rather than lowered against a name that will never
  // be bound.
  parameters?: readonly string[];
  // Prefix for the bound parameter carrying an action argument. The runtime
  // binds `<prefix><name>`; keeping it distinct from the probe's own bindings
  // means an action parameter called `touchedKeys` cannot collide with them.
  parameterPrefix?: string;
  // The query parameter holding the touched key values (an ARRAY<STRING>), when
  // the caller can scope the probe. Only usable on a single-key entity: a
  // composite key needs a struct-array comparison, which the MVP does not emit,
  // so a composite-key entity is probed unscoped.
  touchedKeysParam?: string;
  // Cap on the violating rows returned. A gate only needs enough to explain
  // itself, not the full violation set.
  limit?: number;
}


const DEFAULT_LIMIT = 5;


// Lowers one constraint against `model`, or explains why it cannot.
export function lowerConstraint(
    model: SemanticModel, constraint: Constraint,
    opts: LowerOptions = {}): LoweringResult {
  const fail = (reason: string): LoweringResult => ({
    ok: false,
    reason: `constraint '${constraint.name}' cannot be evaluated: ${reason}`,
  });

  const parsed = parseConstraint(constraint.expression, opts.parameters ?? []);
  if ('error' in parsed) return fail(parsed.error);

  const operands = parsed.comparisons.flatMap(c => [c.left, c.right]);
  const readsParameter = operands.some(op => op.kind === 'param');

  // The entity the probe ranges over is the one whose fields the expression
  // names directly. An aggregate's entity is NOT that entity: it is reached
  // through a relationship and lands in a subquery, so it does not widen the
  // row the probe walks.
  const rowEntities = new Set(
      operands.filter(op => op.kind === 'field')
          .map(op => (op as {entity: string}).entity));
  if (rowEntities.size > 1) {
    return fail(
        `it reads fields of more than one entity (${
            [...rowEntities].sort().join(', ')}) side by side; the probe walks ` +
        `one entity's rows, so relate them with an aggregate ` +
        `(SUM(Other.field)) or split it into one constraint per entity`);
  }

  const entityName: string|undefined = [...rowEntities][0];

  // No entity at all: every operand is a parameter or a literal, so the
  // constraint decides on the arguments alone and never reads the store. It is
  // still lowered to SQL rather than compared here, so that one code path
  // decides every rule and the store's own comparison semantics apply
  // throughout.
  if (entityName === undefined) {
    if (!readsParameter) {
      return fail(
          `it names no entity field and no action parameter, so there is ` +
          `nothing for it to range over`);
    }
    const constant = renderPredicate(parsed, {model, columns: new Map(), opts});
    if ('error' in constant) return fail(constant.error);
    const sql = `SELECT 1 AS violated FROM UNNEST([1]) WHERE ${
        violatingTest(constant.sql)} LIMIT 1`;
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
        parameters: parameterNames(parsed),
      },
    };
  }

  const entity = (model.entities ?? []).find(e => e.name === entityName);
  if (!entity) {
    return fail(`entity '${entityName}' is not declared in the model`);
  }
  if (entity.abstract) {
    return fail(
        `entity '${entityName}' is abstract, so it has no table to probe`);
  }

  // Every field the expression mentions on the ROW entity has to resolve to a
  // real column. An aggregate's fields resolve inside aggregateSubquery,
  // against its own entity.
  const columns = new Map<string, string>();
  for (const op of operands) {
    if (op.kind !== 'field' || columns.has(op.field)) continue;
    const col = columnFor(entity, op.field);
    if ('error' in col) return fail(col.error);
    columns.set(op.field, col.column);
  }

  const keys = keyColumns(entity);
  if ('error' in keys) return fail(keys.error);

  const warnings: string[] = [];
  const table = spannerTable(
      entity.dataSource, warnings, `entity '${entity.name}'`);
  if (warnings.length) {
    return fail(
        `entity '${entityName}' has no usable table (${warnings.join('; ')})`);
  }

  const rendered =
      renderPredicate(parsed, {model, columns, opts, rowEntity: entity, table});
  if ('error' in rendered) return fail(rendered.error);

  const violating = violatingTest(rendered.sql);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const select = (where: string) =>
      `SELECT ${keys.columns.join(', ')} FROM ${table} WHERE ${where} LIMIT ${
          limit}`;

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
      entity: entityName,
      table,
      keyColumns: keys.columns,
      sql,
      unscopedSql,
      scoped,
      readsParameter,
      parameters: parameterNames(parsed),
    },
  };
}


// NOT COALESCE(<predicate>, FALSE) rather than a plain NOT: SQL three-valued
// logic makes `NULL >= 0` unknown, and `NOT unknown` is unknown, so a NULL
// column would slip past a plain negation. Treating unknown as "did not satisfy
// the invariant" makes the row a violation -- the fail-closed reading, and the
// right one for a gate.
function violatingTest(predicate: string): string {
  return `NOT COALESCE(${predicate}, FALSE)`;
}


// The action parameters an expression reads, in sorted order.
function parameterNames(parsed: ParsedExpression): string[] {
  const names = new Set<string>();
  for (const c of parsed.comparisons) {
    for (const op of [c.left, c.right]) {
      if (op.kind === 'param') names.add(op.name);
    }
  }
  return [...names].sort();
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
  const cite = `Rejected by constraint '${probe.constraint.name}' (${
      probe.constraint.expression}).`;
  if (!violatingKeys.length) return `${lead} ${cite}`;
  const rows = violatingKeys.map(k => k.join('/')).join(', ');
  return `${lead} ${cite} Violating ${probe.entity}: ${rows}.`;
}


// The physical column backing `fieldName` on `entity`, or why there is none.
// The MVP requires a BARE column: an expression-bound field (`price * qty`)
// would need the expression inlined and re-resolved, which the small grammar
// here does not attempt.
function columnFor(entity: Entity, fieldName: string):
    {column: string}|{error: string} {
  const field = entity.fields.find(f => f.name === fieldName);
  if (!field) {
    return {
      error: `entity '${entity.name}' declares no field '${fieldName}'`,
    };
  }
  // No expression is what unbound means: the profile in force bound nothing
  // to this field, so there is no column to check the invariant against.
  const expr = (field.expression ?? '').trim();
  if (!expr) {
    return {
      error: `field '${entity.name}.${fieldName}' is unbound under the ` +
          `current binding, so there is nothing to check it against`,
    };
  }
  if (!/^[A-Za-z_]\w*$/.test(expr)) {
    return {
      error: `field '${entity.name}.${fieldName}' is bound to an expression (${
          expr}) rather than a bare column; the evaluator lowers bare columns ` +
          `only`,
    };
  }
  return {column: quoteIfReserved(expr)};
}


// The entity's key columns, resolved through its fields.
function keyColumns(entity: Entity): {columns: string[]}|{error: string} {
  if (!entity.keys.length) {
    return {
      error: `entity '${entity.name}' declares no key, so a violation could ` +
          `not be attributed to a row`,
    };
  }
  const columns: string[] = [];
  for (const key of entity.keys) {
    const col = columnFor(entity, key);
    if ('error' in col) {
      return {error: `key ${col.error}`};
    }
    columns.push(col.column);
  }
  return {columns};
}


// What a predicate is rendered against: the row entity's column map plus what
// an aggregate needs in order to correlate back to that row.
interface RenderContext {
  model: SemanticModel;
  columns: Map<string, string>;
  opts: LowerOptions;
  // Absent for a constraint that reads no entity field at all.
  rowEntity?: Entity;
  table?: string;
}


// Renders the parsed expression into SQL. Each comparison is parenthesized, so
// a mixed AND/OR expression keeps the precedence the SQL engine would give it
// rather than one this module invents.
function renderPredicate(parsed: ParsedExpression, ctx: RenderContext):
    {sql: string}|{error: string} {
  const parts: string[] = [];
  for (const c of parsed.comparisons) {
    const left = renderOperand(c.left, ctx);
    if ('error' in left) return left;
    const right = renderOperand(c.right, ctx);
    if ('error' in right) return right;
    parts.push(`(${left.sql} ${c.operator} ${right.sql})`);
  }
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    out = `${out} ${parsed.joiners[i - 1]} ${parts[i]}`;
  }
  return {sql: out};
}


// One operand as SQL.
function renderOperand(op: Operand, ctx: RenderContext):
    {sql: string}|{error: string} {
  switch (op.kind) {
    case 'literal':
      return {sql: op.text};
    case 'field':
      return {sql: ctx.columns.get(op.field)!};
    case 'param':
      // Bound, never interpolated: the value is supplied by the caller, so it
      // must reach the store as a parameter rather than as text.
      return {sql: `@${ctx.opts.parameterPrefix ?? ''}${op.name}`};
    case 'agg':
      return aggregateSubquery(op, ctx);
  }
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
    op: {fn: string; entity: string; field: string},
    ctx: RenderContext): {sql: string}|{error: string} {
  if (!ctx.rowEntity || !ctx.table) {
    return {
      error: `'${op.fn}(${op.entity}.${op.field})' needs a row to correlate ` +
          `to, but the expression names no entity field to probe`,
    };
  }
  const rowEntity = ctx.rowEntity;
  const inner = (ctx.model.entities ?? []).find(e => e.name === op.entity);
  if (!inner) {
    return {error: `entity '${op.entity}' is not declared in the model`};
  }
  if (inner.abstract) {
    return {
      error: `entity '${op.entity}' is abstract, so it has no table to ` +
          `aggregate over`,
    };
  }

  const edges = (ctx.model.relationships ?? []).filter(
      r => !r.association &&
          ((r.source.entity === op.entity &&
            r.destination.entity === rowEntity.name) ||
           (r.source.entity === rowEntity.name &&
            r.destination.entity === op.entity)));
  if (!edges.length) {
    return {
      error: `no relationship connects '${op.entity}' to '${
          rowEntity.name}', so '${op.fn}(${op.entity}.${op.field})' cannot be ` +
          `correlated to the row being checked; declare one`,
    };
  }
  if (edges.length > 1) {
    return {
      error: `${edges.length} relationships connect '${op.entity}' to '${
          rowEntity.name}' (${
          edges.map(e => e.name).sort().join(', ')}), so '${op.fn}(${
          op.entity}.${op.field})' is ambiguous about which one it means`,
    };
  }
  const edge = edges[0];
  const [innerEnd, outerEnd] = edge.source.entity === op.entity ?
      [edge.source, edge.destination] :
      [edge.destination, edge.source];
  if (innerEnd.columns.length !== outerEnd.columns.length ||
      !innerEnd.columns.length) {
    return {
      error: `relationship '${edge.name}' does not pair its join columns, so ` +
          `'${op.fn}(${op.entity}.${op.field})' cannot be correlated`,
    };
  }

  const measured = columnFor(inner, op.field);
  if ('error' in measured) return {error: measured.error};

  const warnings: string[] = [];
  const innerTable =
      spannerTable(inner.dataSource, warnings, `entity '${inner.name}'`);
  if (warnings.length) {
    return {
      error: `entity '${op.entity}' has no usable table (${
          warnings.join('; ')})`,
    };
  }

  // The outer table is unaliased, so its own name qualifies its columns. That
  // keeps the emitted SQL for every existing (non-aggregate) constraint byte for
  // byte what it was.
  const on = innerEnd.columns
                 .map((c, i) => `${innerTable}.${quoteIfReserved(c)} = ${
                          ctx.table}.${quoteIfReserved(outerEnd.columns[i])}`)
                 .join(' AND ');

  // SUM and COUNT over no rows are 0, not NULL: an order with no line items has
  // a line-item total of zero, and leaving it NULL would make the comparison
  // unknown and so report a violation the data does not have. MIN, MAX and AVG
  // have no such identity, so they stay NULL and the fail-closed reading applies.
  const body = `SELECT ${op.fn}(${measured.column}) FROM ${innerTable} WHERE ${on}`;
  const zeroed = op.fn === 'SUM' || op.fn === 'COUNT';
  return {sql: zeroed ? `COALESCE((${body}), 0)` : `(${body})`};
}


// The aggregate functions an expression may apply to a related entity.
const AGGREGATES = ['SUM', 'COUNT', 'MIN', 'MAX', 'AVG'] as const;


// Parses a constraint expression into comparisons and the AND/OR between them.
//
// The grammar:
//
//   expression := comparison (('AND'|'OR') comparison)*
//   comparison := operand <op> operand
//   operand    := <Entity>.<field>            a column on the row being probed
//               | <parameter>                 an argument of the action
//               | <AGG>(<Entity>.<field>)     an aggregate over a related entity
//               | literal
//   op         := >= | <= | != | <> | == | = | > | <
//   literal    := a number, a single-quoted string, TRUE, FALSE, or NULL
//
// `= NULL` and `!= NULL` are read as null tests and lowered to IS NULL /
// IS NOT NULL; NULL with an ordering operator is refused. See parseComparison.
//
// Arbitrary parentheses, IN/BETWEEN/LIKE, arithmetic, and metric references are
// all outside the grammar -- on purpose. Each is a real thing a constraint might
// want, and each needs a decision that this evaluator does not make. They are
// rejected with a reason rather than partially handled, because a gate that
// approximates a rule is worse than one that admits it cannot check it.
function parseConstraint(expression: string, parameters: readonly string[]):
    ParsedExpression|{error: string} {
  const expr = expression.trim();
  if (!expr) return {error: 'the expression is empty'};

  const segments = splitOnLogicalOperators(expr);
  const comparisons: Comparison[] = [];
  for (const segment of segments.parts) {
    const comparison = parseComparison(segment, parameters);
    if ('error' in comparison) return comparison;
    comparisons.push(comparison);
  }
  return {comparisons, joiners: segments.joiners};
}


function parseComparison(segment: string, parameters: readonly string[]):
    Comparison|{error: string} {
  const text = segment.trim();
  const found = findOperator(text);
  if (!found) {
    return {
      error: `'${text}' is not a comparison (expected ${
          OPERATORS.join(', ')})`,
    };
  }
  const lhs = text.slice(0, found.index).trim();
  const rhs = text.slice(found.index + found.operator.length).trim();
  if (!rhs) return {error: `'${text}' has nothing on the right of the operator`};

  const left = parseOperand(lhs, parameters);
  if ('error' in left) {
    return {error: `the left side of '${text}' ${left.error}`};
  }
  if (left.operand.kind === 'literal') {
    return {
      error: `the left side of '${text}' is a literal, so the comparison ` +
          `does not range over anything`,
    };
  }
  const right = parseOperand(rhs, parameters);
  if ('error' in right) {
    return {error: `the right side of '${text}' ${right.error}`};
  }

  const operator = normalizeOperator(found.operator);

  // NULL is not an operand any comparison operator accepts -- GoogleSQL rejects
  // `col = NULL` outright rather than evaluating it to unknown, so lowering it
  // verbatim would emit a probe that can never run. An author writing
  // `Account.ownerId != NULL` means the column must be populated, which SQL
  // spells IS NOT NULL, so translate the two operators that have a null-test
  // reading and refuse the four that do not: an ordering comparison against
  // NULL has no meaning to preserve.
  if (right.operand.kind === 'literal' && /^NULL$/i.test(right.operand.text)) {
    if (operator !== '=' && operator !== '!=') {
      return {
        error: `'${text}' compares with NULL using '${operator}', which has no ` +
            `meaning; write '= NULL' or '!= NULL' to test whether the field is ` +
            `set`,
      };
    }
    return {
      left: left.operand,
      operator: operator === '=' ? 'IS' : 'IS NOT',
      right: {kind: 'literal', text: 'NULL'},
    };
  }

  return {left: left.operand, operator, right: right.operand};
}


// One side of a comparison, or why it is not one this evaluator can lower.
function parseOperand(text: string, parameters: readonly string[]):
    {operand: Operand}|{error: string} {
  const agg = text.match(/^([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\)$/);
  if (agg) {
    const fn = agg[1].toUpperCase();
    if (!(AGGREGATES as readonly string[]).includes(fn)) {
      return {
        error: `calls '${agg[1]}', which is not one of the aggregates the ` +
            `evaluator lowers (${AGGREGATES.join(', ')})`,
      };
    }
    return {operand: {kind: 'agg', fn, entity: agg[2], field: agg[3]}};
  }

  const field = text.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
  if (field) {
    return {operand: {kind: 'field', entity: field[1], field: field[2]}};
  }

  // A bare name is an action parameter or nothing. It is checked against the
  // action's declared parameters rather than accepted on sight, so a mistyped
  // field reference (`amout`) is refused here instead of lowering to a binding
  // the runtime would never supply.
  if (/^[A-Za-z_]\w*$/.test(text)) {
    if (parameters.includes(text)) {
      return {operand: {kind: 'param', name: text}};
    }
    return {
      error: `reads '${text}', which is neither an <Entity>.<field> reference ` +
          `nor a parameter of the action being checked${
              parameters.length ?
                  ` (declared: ${[...parameters].sort().join(', ')})` :
                  ''}`,
    };
  }

  if (isLiteral(text)) return {operand: {kind: 'literal', text}};

  return {
    error: `is '${text}', which is neither a literal, an <Entity>.<field> ` +
        `reference, an action parameter, nor an aggregate over a related entity`,
  };
}


// Splits an expression on top-level AND/OR, matching them as whole words so a
// field named `brand` or `android_id` is not torn apart. There are no
// parentheses to nest (parseConstraint rejects them), so every operator found
// is top level.
function splitOnLogicalOperators(expr: string):
    {parts: string[]; joiners: string[]} {
  const parts: string[] = [];
  const joiners: string[] = [];
  const pattern = /\s+(AND|OR)\s+/gi;
  let last = 0;
  let match: RegExpExecArray|null;
  while ((match = pattern.exec(expr)) !== null) {
    parts.push(expr.slice(last, match.index));
    joiners.push(match[1].toUpperCase());
    last = match.index + match[0].length;
  }
  parts.push(expr.slice(last));
  return {parts, joiners};
}

// The first comparison operator in `text`, longest match first so `>=` is not
// read as `>` followed by a stray `=`.
function findOperator(text: string): {operator: string; index: number}|null {
  let best: {operator: string; index: number}|null = null;
  for (const operator of OPERATORS) {
    const index = text.indexOf(operator);
    if (index < 0) continue;
    if (!best || index < best.index ||
        (index === best.index && operator.length > best.operator.length)) {
      best = {operator, index};
    }
  }
  return best;
}


// Several spellings mean the same comparison. `!=` and `<>` are both SQL, and
// `==` is not SQL at all but is what a model author reaches for; each is folded
// to the one form the probe emits.
function normalizeOperator(operator: string): string {
  if (operator === '<>') return '!=';
  if (operator === '==') return '=';
  return operator;
}



// A literal the probe can embed verbatim. Restricted to shapes with no quoting
// hazard: a number, a single-quoted string with no embedded quote or backslash,
// or one of the three keywords. Anything else is rejected rather than escaped,
// because a constraint expression is model text, not user input, and a
// surprising escape is harder to notice than a refusal.
function isLiteral(text: string): boolean {
  if (/^-?\d+(\.\d+)?$/.test(text)) return true;
  if (/^'[^'\\]*'$/.test(text)) return true;
  return /^(TRUE|FALSE|NULL)$/i.test(text);
}


// Re-exported so a caller building a probe by hand quotes identifiers the same
// way this module does.
export {quoteIdentifier};
