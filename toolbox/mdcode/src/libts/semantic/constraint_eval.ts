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
const OPERATORS = ['>=', '<=', '!=', '<>', '=', '>', '<'] as const;


// A single `<Entity>.<field> <op> <operand>` comparison, as parsed.
interface Comparison {
  entity: string;
  field: string;
  operator: string;
  // Exactly one of these is set: a literal (kept verbatim, already SQL-shaped)
  // or a reference to another field on the same entity.
  literal?: string;
  rightField?: string;
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

  const parsed = parseConstraint(constraint.expression);
  if ('error' in parsed) return fail(parsed.error);

  const entityNames =
      new Set(parsed.comparisons.map(c => c.entity));
  if (entityNames.size > 1) {
    return fail(
        `it spans more than one entity (${
            [...entityNames].sort().join(', ')}); the evaluator probes a ` +
        `single entity's table, so split it into one constraint per entity`);
  }

  const entityName = parsed.comparisons[0].entity;
  const entity = (model.entities ?? []).find(e => e.name === entityName);
  if (!entity) {
    return fail(`entity '${entityName}' is not declared in the model`);
  }
  if (entity.abstract) {
    return fail(
        `entity '${entityName}' is abstract, so it has no table to probe`);
  }

  // Every field the expression mentions has to resolve to a real column.
  const columns = new Map<string, string>();
  for (const c of parsed.comparisons) {
    for (const fieldName of [c.field, c.rightField]) {
      if (!fieldName || columns.has(fieldName)) continue;
      const col = columnFor(entity, fieldName);
      if ('error' in col) return fail(col.error);
      columns.set(fieldName, col.column);
    }
  }

  const keys = keyColumns(entity);
  if ('error' in keys) return fail(keys.error);

  const predicate = renderPredicate(parsed, columns);
  const warnings: string[] = [];
  const table = spannerTable(
      entity.dataSource, warnings, `entity '${entity.name}'`);
  if (warnings.length) {
    return fail(
        `entity '${entityName}' has no usable table (${warnings.join('; ')})`);
  }

  // NOT COALESCE(<predicate>, FALSE) rather than a plain NOT: SQL three-valued
  // logic makes `NULL >= 0` unknown, and `NOT unknown` is unknown, so a NULL
  // column would slip past a plain negation. Treating unknown as "did not
  // satisfy the invariant" makes the row a violation -- the fail-closed reading,
  // and the right one for a gate.
  const violating = `NOT COALESCE(${predicate}, FALSE)`;
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
    },
  };
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


// Renders the parsed expression with logical field names replaced by their
// physical columns. Each comparison is parenthesized, so a mixed AND/OR
// expression keeps the precedence the SQL engine would give it rather than one
// this module invents.
function renderPredicate(
    parsed: ParsedExpression, columns: Map<string, string>): string {
  const parts = parsed.comparisons.map(c => {
    const left = columns.get(c.field)!;
    const right =
        c.rightField !== undefined ? columns.get(c.rightField)! : c.literal!;
    return `(${left} ${c.operator} ${right})`;
  });
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    out = `${out} ${parsed.joiners[i - 1]} ${parts[i]}`;
  }
  return out;
}


// Parses a constraint expression into comparisons and the AND/OR between them.
//
// The grammar:
//
//   expression := comparison (('AND'|'OR') comparison)*
//   comparison := <Entity>.<field> <op> (literal | <Entity>.<field>)
//   op         := >= | <= | != | <> | = | > | <
//   literal    := a number, a single-quoted string, TRUE, FALSE, or NULL
//
// `= NULL` and `!= NULL` are read as null tests and lowered to IS NULL /
// IS NOT NULL; NULL with an ordering operator is refused. See parseComparison.
//
// Parentheses, function calls, IN/BETWEEN/LIKE, and metric references are all
// outside it -- on purpose. Each is a real thing a constraint might want, and
// each needs a decision (how to evaluate a metric inside a row-level probe, for
// one) that this prototype does not make. They are rejected with a reason
// rather than partially handled.
function parseConstraint(expression: string): ParsedExpression|{error: string} {
  const expr = expression.trim();
  if (!expr) return {error: 'the expression is empty'};
  if (/[()]/.test(expr)) {
    return {
      error: `it uses parentheses or a function call (${
          expr}), which the evaluator does not parse`,
    };
  }

  const segments = splitOnLogicalOperators(expr);
  const comparisons: Comparison[] = [];
  for (const segment of segments.parts) {
    const comparison = parseComparison(segment);
    if ('error' in comparison) return comparison;
    comparisons.push(comparison);
  }
  return {comparisons, joiners: segments.joiners};
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


function parseComparison(segment: string): Comparison|{error: string} {
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

  const left = parseFieldRef(lhs);
  if (!left) {
    return {
      error: `the left side of '${text}' is not an <Entity>.<field> reference`,
    };
  }
  if (!rhs) return {error: `'${text}' has nothing on the right of the operator`};

  const right = parseFieldRef(rhs);
  if (right) {
    if (right.entity !== left.entity) {
      return {
        error: `'${text}' compares fields of two entities (${left.entity}, ${
            right.entity})`,
      };
    }
    return {
      entity: left.entity,
      field: left.field,
      operator: normalizeOperator(found.operator),
      rightField: right.field,
    };
  }

  if (!isLiteral(rhs)) {
    return {
      error: `'${rhs}' in '${text}' is neither a literal nor an ` +
          `<Entity>.<field> reference`,
    };
  }

  const operator = normalizeOperator(found.operator);

  // NULL is not an operand any comparison operator accepts -- GoogleSQL rejects
  // `col = NULL` outright rather than evaluating it to unknown, so lowering it
  // verbatim would emit a probe that can never run. An author writing
  // `Account.ownerId != NULL` means the column must be populated, which SQL
  // spells IS NOT NULL, so translate the two operators that have a null-test
  // reading and refuse the four that do not: an ordering comparison against
  // NULL has no meaning to preserve.
  if (/^NULL$/i.test(rhs)) {
    if (operator !== '=' && operator !== '!=') {
      return {
        error: `'${text}' compares with NULL using '${operator}', which has no ` +
            `meaning; write '= NULL' or '!= NULL' to test whether the field is ` +
            `set`,
      };
    }
    return {
      entity: left.entity,
      field: left.field,
      operator: operator === '=' ? 'IS' : 'IS NOT',
      literal: 'NULL',
    };
  }

  return {
    entity: left.entity,
    field: left.field,
    operator,
    literal: rhs,
  };
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


// `!=` and `<>` mean the same thing; GoogleSQL accepts both, so pick one and
// emit it consistently.
function normalizeOperator(operator: string): string {
  return operator === '<>' ? '!=' : operator;
}


function parseFieldRef(text: string): {entity: string; field: string}|null {
  const m = text.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
  return m ? {entity: m[1], field: m[2]} : null;
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
