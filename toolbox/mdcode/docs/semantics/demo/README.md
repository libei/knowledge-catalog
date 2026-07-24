# Demo: vendor-dialect semantic model → BigQuery property graph

This walks through `kcmd`'s semantic-model path end to end: author a model in the
AI-first semantics format using **vendor SQL dialects** (Snowflake / Postgres /
Databricks), then `push --transpile` to rewrite those expressions to GoogleSQL
and deploy a BigQuery `PROPERTY GRAPH` — metrics included, as graph `MEASURE`s.

Everything below is copy-paste and was verified live against `sqlgen-testing`.

Files in this directory:

- [`vendor_sales.yaml`](vendor_sales.yaml) — the model. Fields and metrics are
  written in vendor dialects BigQuery does **not** accept verbatim
  (`IFF`, `NVL`, `::text`, `::double`, `DATEADD`, `DATEDIFF`, `REGEXP_LIKE`, `ILIKE`).
- [`seed.sql`](seed.sql) — a tiny `orders` / `customer` pair to bind the graph to.

## Prerequisites

- The `kcmd` binary. From `toolbox/mdcode`:
  ```bash
  npm ci                 # install dependencies (skip if node_modules is present)
  npm run build          # produces ./dist/kcmd
  export PATH="$PWD/dist:$PATH"
  ```
  If you skip `npm ci`, the build's `npx tsc` step can't find a local TypeScript
  and fetches an unrelated stub package instead, printing
  *"This is not the tsc command you are looking for"* — run `npm ci` and rebuild.
- `bq` (the BigQuery CLI), authenticated to a project you can write to.
- **For `--transpile` only:** a Python interpreter with
  [`sqlglot`](https://pypi.org/project/sqlglot/) installed. `kcmd` shells out to
  it out of process; point `$KCMD_PYTHON` at it (defaults to `python3`):
  ```bash
  python3 -m venv /tmp/sqlglot-venv
  /tmp/sqlglot-venv/bin/pip install --index-url https://pypi.org/simple sqlglot
  export KCMD_PYTHON=/tmp/sqlglot-venv/bin/python
  ```
  (`--index-url https://pypi.org/simple` names the public PyPI index explicitly;
  it's a no-op on a machine that already defaults there, and it avoids a
  `No matching distribution found` error when `pip` defaults to a private or
  airlocked index that lacks `sqlglot`.)

  Without it, `--transpile` degrades gracefully: each vendor expression is left
  verbatim and flagged with a warning (the graph then likely fails to deploy).

## 0. Pick a project and dataset

```bash
export PROJECT=your-project
export DATASET=uss_transpile_demo
```

## 1. Seed the source tables

```bash
sed -e "s/@PROJECT@/$PROJECT/g" -e "s/@DATASET@/$DATASET/g" seed.sql \
  | bq query --project_id="$PROJECT" --use_legacy_sql=false
```

Creates `orders` (4 rows) and `customer` (3 rows).

## 2. Initialize a semantic-model workspace

`init` resolves the scope purely from its name — no Knowledge Catalog lookup —
and creates a `catalog/<id>/` directory for your model files.

```bash
mkdir demo-ws && cd demo-ws
kcmd init --semantic-model "$PROJECT.us.$DATASET"
cp ../vendor_sales.yaml catalog/$DATASET/
```

## 3. Dry-run: compile + transpile without deploying

```bash
kcmd push --project "$PROJECT" --dataset "$DATASET" --transpile --dry-run
```

You'll see one `transpiled '<DIALECT>' -> 'BIGQUERY'` warning per rewritten
expression, then the generated DDL. Note how the vendor SQL became GoogleSQL:

| authored (vendor)                              | emitted (GoogleSQL)                          |
|------------------------------------------------|----------------------------------------------|
| `IFF(o_orderstatus='F','fulfilled','open')`    | `IF(o_orderstatus='F','fulfilled','open')`   |
| `NVL(o_clerk,'unknown')`                        | `COALESCE(o_clerk,'unknown')`                |
| `o_comment::text`                               | `CAST(o_comment AS STRING)`                  |
| `o_totalprice::double`                          | `CAST(o_totalprice AS FLOAT64)`             |
| `DATEADD(day,7,o_orderdate)`                     | `DATE_ADD(o_orderdate, INTERVAL 7 DAY)`     |
| `DATEDIFF(day,o_orderdate,o_shipdate)`          | `DATE_DIFF(o_shipdate, o_orderdate, DAY)`   |
| `REGEXP_LIKE(c_phone,'[0-9]+')`                 | `REGEXP_CONTAINS(c_phone,'[0-9]+')`         |
| `c_mktsegment ILIKE 'AUTO%'`                     | `LOWER(c_mktsegment) LIKE LOWER('AUTO%')`   |

Metrics also lower to graph `MEASURE`s. A metric whose operand isn't already an
exposed property (e.g. `SUM(IFF(...))`) is materialized as a derived
`<metric>_input` property first, because BigQuery rejects an inline expression
inside `MEASURE(...)`:

```
IF(o_orderstatus = 'F', o_totalprice, 0) AS fulfilled_revenue_input,
MEASURE(SUM(fulfilled_revenue_input)) AS fulfilled_revenue
```

## 4. Deploy for real

```bash
kcmd push --project "$PROJECT" --dataset "$DATASET" --transpile
# -> Deployed property graph for model 'vendor_sales'.
```

## 5. Query it

**Scalar node fields** (the transpiled expressions executing) come back through
GQL:

```bash
bq query --project_id="$PROJECT" --use_legacy_sql=false "
GRAPH \`$PROJECT.$DATASET.vendor_sales\`
MATCH (o:orders)
RETURN o.o_orderkey AS k, o.order_status_label AS status,
       o.clerk_name AS clerk, o.due_date AS due, o.ship_days AS ship_days
ORDER BY k
"
```

**Metrics** (graph `MEASURE`s) are *not* projectable through GQL; read them with
the `GRAPH_EXPAND` table function, wrapping each in `AGG()`. The column name is
`<node_label>_<measure_name>`, and the graph name is a **string literal**, not a
backtick identifier:

```bash
bq query --project_id="$PROJECT" --use_legacy_sql=false "
SELECT
  AGG(orders_total_revenue)     AS total_revenue,
  AGG(orders_fulfilled_revenue) AS fulfilled_revenue,
  AGG(orders_avg_price_known)   AS avg_price_known
FROM GRAPH_EXPAND('$PROJECT.$DATASET.vendor_sales')
"
```

Expected, from the seed data:

| total_revenue | fulfilled_revenue | avg_price_known |
|---------------|-------------------|-----------------|
| 7230.49       | 1290.49           | 1807.6225       |

(`total` = sum of all four orders; `fulfilled` = the two `F` orders only;
`avg_price_known` = mean of `COALESCE(price, 0)`. Add `GROUP BY` to
`GRAPH_EXPAND`'s output for grouped rollups.)

## 6. Teardown

```bash
bq query --project_id="$PROJECT" --use_legacy_sql=false \
  "DROP PROPERTY GRAPH \`$PROJECT.$DATASET.vendor_sales\`"
bq rm -f -t "$PROJECT:$DATASET.orders"
bq rm -f -t "$PROJECT:$DATASET.customer"
```
