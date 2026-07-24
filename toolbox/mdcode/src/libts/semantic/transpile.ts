// Transpiles vendor-dialect expressions in a Semantic Model to a target SQL
// dialect (default BigQuery/GoogleSQL).
//
// The loader (./loader) collapses each field/metric to one expression string and
// records `expressionDialect` only when it had to fall back to a vendor dialect
// (e.g. SNOWFLAKE) the target may not accept verbatim. This pass rewrites those
// marked expressions to the target dialect and clears the provenance; expressions
// already in the target or in the portable canonical dialect are left untouched.
//
// Design (see docs/semantics/semantic-dialects.md):
//   - Target-agnostic: `transpileModel(model, {target, transpiler})`. The actual
//     mechanism is injectable so tests can run hermetically; the default adapter
//     shells out to Python's `sqlglot` out of process.
//   - Non-mutating: returns a `structuredClone`, so the portable IR is preserved.
//   - Graceful degradation: if the transpiler is missing, errors, or would alter
//     which entities an expression references (the qualifier-preservation guard),
//     the expression is left verbatim and a warning is emitted — never a throw.
//

import { spawn } from 'node:child_process';
import { SemanticModel, Field, Metric } from './ir';
import { referencedEntityNames, dedupe } from './expr';

const DEFAULT_TARGET = 'BIGQUERY';

// One expression to transpile. `id` correlates a response to its request; the
// caller assigns it and never interprets it.
export interface TranspileRequest {
  id: string;
  dialect: string;       // source dialect, as authored (e.g. 'SNOWFLAKE')
  expression: string;
}

// The result for one request: exactly one of `sql` (success) or `error` (the
// expression could not be transpiled and should be left verbatim).
export interface TranspileResponse {
  id: string;
  sql?: string;
  error?: string;
}

// The pluggable transpilation mechanism. Must return one response per request
// (order-independent; correlated by `id`) and must not throw — an unavailable or
// failing engine is reported per-request via `error`.
export type SqlTranspiler =
  (requests: TranspileRequest[], target: string) => Promise<TranspileResponse[]>;

export interface TranspileOptions {
  target?: string;            // target dialect; default 'BIGQUERY'
  transpiler?: SqlTranspiler; // mechanism; default `sqlglotTranspiler`
}

export interface TranspileResult {
  model: SemanticModel;
  warnings: string[];
}

// A pending rewrite: the vendor expression to transpile plus a callback that
// applies the resulting SQL to the (cloned) IR node.
interface Pending {
  request: TranspileRequest;
  ctx: string;                       // human label for diagnostics
  accept: (sql: string) => void;     // writes the transpiled SQL into the clone
}

/**
 * Rewrites every vendor-dialect expression (those the loader marked with
 * `expressionDialect`) in `model` to `opts.target`, returning a clone plus
 * diagnostics. The input model is never mutated. When no expression is marked,
 * the clone is returned unchanged and the transpiler is not invoked.
 */
export async function transpileModel(
    model: SemanticModel, opts: TranspileOptions = {}): Promise<TranspileResult> {
  const target = opts.target ?? DEFAULT_TARGET;
  const transpiler = opts.transpiler ?? sqlglotTranspiler;
  const clone: SemanticModel = structuredClone(model);
  const entityNames = clone.entities.map(e => e.name);
  const warnings: string[] = [];

  const pending: Pending[] = [];
  const add = (node: Field | Metric, ctx: string) => {
    if (!node.expressionDialect) return;
    const id = String(pending.length);
    const dialect = node.expressionDialect;
    pending.push({
      request: { id, dialect, expression: node.expression },
      ctx,
      accept: (sql: string) => {
        node.expression = sql;
        delete node.expressionDialect;
        // A metric caches the entities its expression references; recompute it in
        // case transpilation changed the referenced set (the guard below allows
        // through only rewrites that keep the set identical, so this is a no-op in
        // practice, but keeps the cache honest).
        if ('entities' in node) {
          node.entities = referencedEntityNames(node.expression, entityNames);
        }
      },
    });
  };

  for (const e of clone.entities) {
    for (const f of e.fields) add(f, `field '${e.name}.${f.name}'`);
  }
  for (const r of clone.relationships) {
    for (const f of r.fields ?? []) add(f, `relationship '${r.name}' field '${f.name}'`);
  }
  for (const m of clone.metrics) add(m, `metric '${m.name}'`);

  if (!pending.length) return { model: clone, warnings };

  const responses = await transpiler(pending.map(p => p.request), target);
  const byId = new Map(responses.map(r => [r.id, r]));

  for (const p of pending) {
    const { ctx, request } = p;
    const res = byId.get(request.id);
    if (!res || res.sql === undefined) {
      const reason = res?.error ?? 'no result returned';
      warnings.push(
        `${ctx}: could not transpile '${request.dialect}' -> '${target}' ` +
        `(${reason}); left verbatim`);
      continue;
    }
    // Qualifier-preservation guard: the downstream BigQuery emitter locates
    // measures and strips qualifiers by matching `<Entity>.` case-sensitively
    // (see ./expr). If the transpiler re-cased or quoted a qualifier, the entity
    // set would change and the metric would silently drop. Reject any such
    // rewrite: keep the (valid, if non-target) original and warn.
    const before = referencedEntityNames(request.expression, entityNames);
    const after = referencedEntityNames(res.sql, entityNames);
    if (!sameSet(before, after)) {
      warnings.push(
        `${ctx}: transpiled '${request.dialect}' -> '${target}' but it altered the ` +
        `referenced entities (${fmtSet(before)} -> ${fmtSet(after)}); kept verbatim`);
      continue;
    }
    p.accept(res.sql);
    warnings.push(`${ctx}: transpiled '${request.dialect}' -> '${target}'`);
  }

  return { model: clone, warnings: dedupe(warnings) };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every(x => s.has(x));
}

function fmtSet(names: string[]): string {
  return names.length ? `{${names.join(', ')}}` : '{}';
}


// --- sqlglot adapter (the default mechanism) ---------------------------------

// Maps our dialect tokens (as authored in the AI-first format) to sqlglot's read
// dialect names. Unknown tokens fall through as their lower-cased form, which
// sqlglot either accepts or rejects (rejection degrades to verbatim + warning).
const SQLGLOT_DIALECTS: Record<string, string> = {
  BIGQUERY: 'bigquery',
  ANSI_SQL: '',            // sqlglot's dialect-neutral parser
  SNOWFLAKE: 'snowflake',
  DATABRICKS: 'databricks',
  SPARK: 'spark',
  POSTGRES: 'postgres',
  POSTGRESQL: 'postgres',
  TERADATA: 'teradata',
  PRESTO: 'presto',
  TRINO: 'trino',
  DUCKDB: 'duckdb',
  MYSQL: 'mysql',
  REDSHIFT: 'redshift',
  ORACLE: 'oracle',
  TSQL: 'tsql',
};

function sqlglotDialect(token: string): string {
  const up = token.toUpperCase();
  return up in SQLGLOT_DIALECTS ? SQLGLOT_DIALECTS[up] : token.toLowerCase();
}

// Embedded, dependency-free driver run as `python3 -c <SCRIPT>`. It reads one
// JSON request object from stdin and writes a JSON array of responses to stdout.
// A missing sqlglot is caught and reported per-item (exit 0), so the absence of
// the optional dependency degrades to verbatim rather than a hard failure.
const SQLGLOT_SCRIPT = `
import sys, json
data = json.load(sys.stdin)
write = data["write"]
items = data["items"]
try:
    import sqlglot
except Exception as e:
    print(json.dumps([{"id": it["id"], "error": "sqlglot unavailable: %s" % (e,)} for it in items]))
    sys.exit(0)
out = []
for it in items:
    try:
        tree = sqlglot.parse_one(it["expr"], read=(it["read"] or None))
        out.append({"id": it["id"], "sql": tree.sql(dialect=write)})
    except Exception as e:
        out.append({"id": it["id"], "error": str(e)})
print(json.dumps(out))
`;

/**
 * The default {@link SqlTranspiler}: transpiles via Python's `sqlglot` in a
 * subprocess. The Python interpreter is `$KCMD_PYTHON` or `python3`. It never
 * throws: a spawn failure (e.g. no interpreter), non-zero exit, or unparseable
 * output yields an `error` response for every request, so the caller degrades to
 * verbatim + warning. `sqlglot` itself is optional — see {@link SQLGLOT_SCRIPT}.
 */
export const sqlglotTranspiler: SqlTranspiler = (requests, target) => {
  if (!requests.length) return Promise.resolve([]);
  const write = sqlglotDialect(target) || 'bigquery';
  const payload = JSON.stringify({
    write,
    items: requests.map(r => ({ id: r.id, read: sqlglotDialect(r.dialect), expr: r.expression })),
  });
  const python = process.env.KCMD_PYTHON || 'python3';

  return new Promise<TranspileResponse[]>(resolve => {
    const fail = (reason: string) =>
      resolve(requests.map(r => ({ id: r.id, error: reason })));

    let child;
    try {
      child = spawn(python, ['-c', SQLGLOT_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err: any) {
      fail(`could not start '${python}': ${err?.message ?? err}`);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    // Decode as UTF-8 via the stream's StringDecoder so a multibyte character
    // split across two chunks is reassembled correctly (concatenating raw
    // Buffers would decode each half independently and corrupt it).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => done(() => fail(`could not run '${python}': ${err?.message ?? err}`)));
    child.on('close', code => done(() => {
      if (code !== 0) {
        fail(`'${python}' exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        fail(`could not parse transpiler output: ${stdout.slice(0, 200)}`);
        return;
      }
      if (!Array.isArray(parsed)) {
        fail('transpiler output was not a JSON array');
        return;
      }
      resolve(parsed as TranspileResponse[]);
    }));

    child.stdin.on('error', () => {/* handled via 'error'/'close' above */});
    child.stdin.end(payload);
  });
};
