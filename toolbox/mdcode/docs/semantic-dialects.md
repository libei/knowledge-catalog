# Semantic model: expression dialects & transpilation

Scope: how the semantic-model pipeline (`src/libts/semantic/`) selects a SQL
expression when the AI-first semantics format supplies several per-dialect
variants, and how the opt-in transpile pass rewrites a vendor-dialect expression
to the target dialect.

## Background

In the AI-first semantics format, each field/metric expression is authored as a
list of per-dialect variants:

```yaml
expression:
  dialects:
    - dialect: ANSI_SQL
      expression: SUM(orders.o_totalprice)
    - dialect: BIGQUERY
      expression: SUM(orders.o_totalprice)
```

`ANSI_SQL` is the format's **canonical, portable** dialect — ANSI SQL:2003 Core,
and the format's default when no dialect is chosen. It was deliberately picked to
be valid across engines (Snowflake, Databricks, PostgreSQL, **BigQuery**).
Vendor dialects (e.g. `SNOWFLAKE`, `DATABRICKS`) are optional extensions for
engine-specific SQL.

## Current behavior (`loader.ts:pickDialect`)

The loader collapses the variant list to one string. It performs **no
transpilation** — the chosen expression is passed through verbatim — and picks in
this order:

1. The requested target dialect (default `BIGQUERY`). No diagnostic.
2. The canonical portable dialect (`ANSI_SQL`). Because emitting the ANSI core
   subset to a target that accepts it (BigQuery does) is the *intended* authoring
   path, this is reported as a single informational `note:`, worded
   field-agnostically so identical notes dedupe to **one line per document**.
3. The first listed variant (a vendor dialect). This is a genuine risk — the
   expression may use syntax the target does not accept — so it is **warned per
   field/metric**, naming the dialect.

This split is why golden `-- warnings --` blocks no longer carry one
"not transpiled" line per column: an ANSI-only model yields a single note, and
the block is left to surface the diagnostics that actually need attention
(unplaceable metrics, empty KEYs, multi-table measures).

## Why not the BigQuery Translation API

The BigQuery Migration / Translation API (`bigquerymigration.googleapis.com`)
transpiles named source dialects into GoogleSQL, but it is a poor fit here:

- It lists specific dialects (Snowflake, Postgres, Teradata, …) but **no generic
  ANSI SQL** source — the exact case (2) above.
- It is a **whole-query** translator; our inputs are expression *fragments*
  (`SUM(orders.x)`), which would need wrapping/unwrapping.
- It is an **async, auth-gated network service** (Bearer token, IAM role, API
  enablement). Wiring it into the loader would break the loader's pure, offline,
  deterministic contract that the golden e2e tests rely on.
- Unsupported functions get rewritten to `bqutil.fn.cw_*` helper UDFs the caller
  must deploy — undesirable for MEASURE bodies.

## Transpiling the vendor-dialect case (case 3)

Case 3 is transpiled to the target dialect by an opt-in pass,
`transpile.ts:transpileModel`, using **sqlglot** — a local, offline,
deterministic SQL parser/transpiler with a `bigquery` writer dialect. It works on
expression fragments and needs no network or auth.

The pipeline is: `loadModels` → `transpileModel(model, { target: 'BIGQUERY' })` →
`generatePropertyGraph`. The pass is **default OFF**: a caller that skips it gets
today's verbatim-with-a-warning behavior, so existing goldens and hermetic tests
are unchanged.

Design:

- **A separate, target-parameterized pass, not the loader or emitter.** The
  loader stays destination-agnostic (it only records provenance, below);
  `bigquery.ts` stays sync and untouched. `transpileModel(model, { target,
  transpiler })` returns a `structuredClone` — the portable IR is never mutated.
- **Provenance drives it.** The loader sets `expressionDialect` on a `Field`/
  `Metric` **only** in the vendor-fallback case (case 3). The pass rewrites only
  those expressions and clears the marker; target/canonical expressions (cases
  1–2) carry no marker and are left verbatim — the canonical ANSI path already
  targets BigQuery by design.
- **Graceful degradation.** sqlglot is Python-only and can't be bundled into the
  `bun --compile` binary, so it is an **optional** dependency invoked out of
  process (`$KCMD_PYTHON` or `python3`). A missing interpreter, a missing
  sqlglot, a non-zero exit, or unparseable output all degrade to verbatim + a
  per-expression warning — never a throw. Install it with
  `pip install sqlglot` to enable real transpilation.
- **Qualifier-preservation guard.** `expr.ts` matches `<Entity>.` qualifiers
  case-sensitively for measure placement, and sqlglot may re-case or quote an
  identifier. After transpiling, if the set of referenced entities changed, the
  rewrite is rejected (kept verbatim + warned) so a metric can never silently
  drop.

### Testing & verification

- `transpile.test.ts` — hermetic, injected fake transpiler (success, error,
  guard rejection, no-op, multi-dialect, non-mutation).
- `transpile.sqlglot.test.ts` — a *mechanism-invariant* test that always runs
  (asserts the adapter returns one result per request, `sql` XOR `error`, never
  throws, even with sqlglot absent), plus a transformation test gated on sqlglot.
- `transpile.e2e.test.ts` — the transpiled golden
  (`fixtures/vendor_dialects.bigquery.transpiled.golden.sql`), gated on sqlglot.
- `transpile.bigquery.verify.test.ts` — dry-runs every transpiled expression
  against a real BigQuery instance; gated on `KCMD_BQ_VERIFY=1`. Every GoogleSQL
  expression in the transpiled golden was validated this way.

### Out of scope

ANSI:2003 has constructs GoogleSQL renders differently, but the canonical case
(2) stays verbatim: it is the intended, portable authoring path. Transpiling it
too could be a future opt-in.
