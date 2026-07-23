// Literal-aware helpers for the entity-qualified SQL expressions used across the
// semantic-model layer.
//
// Expressions reference columns as `<Entity>.<column>`. Detecting and stripping
// those qualifiers must ignore text inside string literals, so a value such as
// 'orders.note' is treated as data, not as a reference to the `orders` entity.
// Both the loader (metric-entity inference) and the BigQuery generator (measure
// placement / qualifier stripping) share this one implementation.
//

// Matches a single- or double-quoted SQL string literal, honoring backslash
// escapes. (Triple-quoted / raw literals are uncommon in these expressions and
// are treated as ordinary text.)
export const STRING_LITERAL = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;

// Escapes a string so it can be embedded literally in a RegExp.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replaces string-literal contents with blanks of equal length, so scanning sees
// literal-free text without shifting any offsets.
export function blankStringLiterals(expression: string): string {
  return expression.replace(STRING_LITERAL, m => ' '.repeat(m.length));
}

// Applies `fn` only to the parts of `expression` that lie outside string
// literals, leaving each literal verbatim.
export function mapOutsideStringLiterals(
    expression: string, fn: (segment: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of expression.matchAll(STRING_LITERAL)) {
    out += fn(expression.slice(last, m.index));
    out += m[0];
    last = m.index! + m[0].length;
  }
  out += fn(expression.slice(last));
  return out;
}

// Returns the entity names whose `<name>.` qualifier appears in an expression,
// ignoring text inside string literals.
export function referencedEntityNames(expression: string, entityNames: string[]): string[] {
  const scannable = blankStringLiterals(expression);
  return entityNames.filter(
    name => new RegExp(`\\b${escapeRegExp(name)}\\.`).test(scannable));
}

// Removes the `<entity>.` qualifier so an expression references table-local
// columns, without touching text inside string literals.
export function stripQualifier(expression: string, entity: string): string {
  const re = new RegExp(`\\b${escapeRegExp(entity)}\\.`, 'g');
  return mapOutsideStringLiterals(expression, seg => seg.replace(re, ''));
}

// Returns the input with duplicate entries removed, preserving first-seen order.
export function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
