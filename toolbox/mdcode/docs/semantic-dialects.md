# Semantic model: expression dialects & transpilation

Scope: how the semantic-model pipeline (`src/libts/semantic/`) selects a SQL
expression when the AI-first semantics format supplies several per-dialect
variants, and the roadmap for actually transpiling to a target dialect.

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

## Roadmap: transpiling the vendor-dialect case (case 3)

When we want real transpilation, the right tool is **sqlglot** — a local,
offline, deterministic SQL parser/transpiler with a `bigquery` writer dialect
(`sqlglot.transpile(expr, read="snowflake", write="bigquery")`). It works on
fragments and needs no network or auth, so it preserves hermetic tests.

Design constraints:

- **Emitter, not loader.** Transpiling *to BigQuery* is destination-specific, so
  it belongs in `bigquery.ts`, not the destination-agnostic loader. The loader
  keeps choosing a variant + emitting the note/warning; the emitter would
  transpile the chosen expression when it is a vendor dialect.
- **Scope to case 3 only.** The canonical ANSI path (case 2) already targets
  BigQuery by design; leave it verbatim. Transpilation earns its keep only for
  vendor dialects the target does not accept.
- **Opt-in + hermetic.** Gate behind a flag and keep it out of the golden e2e
  path so tests stay offline. sqlglot is Python, so this implies an offline
  build-time helper (out-of-process) rather than an in-process TS dependency —
  acceptable, but a real dependency to weigh.

Until then, case 3 stays verbatim-with-a-warning, which is honest: the operator
is told the expression was not transpiled and should be reviewed.
