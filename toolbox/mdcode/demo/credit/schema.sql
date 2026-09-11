-- Tables the credit demo binds to.
--
-- Apply with:
--   gcloud spanner databases create semantic_credit_demo \
--     --instance=graph-unified-solution-demo --project=sqlgen-testing \
--     --ddl-file=demo/credit/schema.sql
--
-- Money is NUMERIC rather than FLOAT64. One of the model's rules is an
-- equality between two sums of money, and binary floating point does not
-- answer that question reliably: 0.1 + 0.2 is not 0.3 in FLOAT64, so an order
-- whose lines add up would be reported as violating the invariant.
--
-- The order table is called Orders because ORDER is a reserved word in
-- GoogleSQL. The model calls the entity Order and the binding profile maps it
-- to this table, which is what a logical name is for.

CREATE TABLE IF NOT EXISTS Customer (
  customer_id INT64 NOT NULL,
  name STRING(128),
  email STRING(256),
) PRIMARY KEY (customer_id);

CREATE TABLE IF NOT EXISTS Orders (
  order_id INT64 NOT NULL,
  customer_id INT64,
  total NUMERIC,
  status STRING(16),
) PRIMARY KEY (order_id);

CREATE TABLE IF NOT EXISTS LineItem (
  line_item_id STRING(64) NOT NULL,
  order_id INT64,
  type STRING(16),
  amount NUMERIC,
  memo STRING(MAX),
) PRIMARY KEY (line_item_id)
