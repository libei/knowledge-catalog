#!/bin/bash
# Creates the demo database if it is not there, and seeds the rows.
#
# Re-running is safe: the schema uses CREATE TABLE IF NOT EXISTS and the seed
# deletes the rows it owns before inserting them, so this returns the demo to a
# known state whatever was done to it.
#
# Each statement is one visible gcloud call, so any of them can be copied out
# and run on its own. gcloud has a --ddl-file flag for schema and no equivalent
# for DML, which is why the schema is a .sql file and this is a script.
#
# Three orders, seeded so the demo has something to find and something to
# choose between:
#
#   12345  $147.85  Andy Brook   four lines: two items, shipping, tax
#   12346   $18.00  Andy Brook   one item
#   12347  $200.00  Dana Reyes   one item
#
# Run from the mdcode package root:  bash demo/agent/setup.sh

set -euo pipefail

PROJECT=${DEMO_CLOUD_PROJECT:-sqlgen-testing}
INSTANCE=${DEMO_SPANNER_INSTANCE:-graph-unified-solution-demo}
DATABASE=${DEMO_SPANNER_DATABASE:-semantic_agent_demo}
HERE=$(dirname "$0")

if ! gcloud spanner databases describe "$DATABASE" \
       --instance="$INSTANCE" --project="$PROJECT" >/dev/null 2>&1; then
  echo "+ creating database $DATABASE"
  gcloud spanner databases create "$DATABASE" \
    --instance="$INSTANCE" --project="$PROJECT" --ddl-file="$HERE/schema.sql"
else
  echo "+ database $DATABASE exists; applying schema"
  gcloud spanner databases ddl update "$DATABASE" \
    --instance="$INSTANCE" --project="$PROJECT" --ddl-file="$HERE/schema.sql"
fi

run() {
  echo "+ $1"
  gcloud spanner databases execute-sql "$DATABASE" \
    --instance="$INSTANCE" --project="$PROJECT" --sql="$1"
}

run "DELETE FROM LineItem WHERE TRUE"
run "DELETE FROM Orders WHERE TRUE"
run "DELETE FROM Customer WHERE TRUE"

run "INSERT INTO Customer (customer_id, name, email) VALUES
       (1, 'Andy Brook', 'andy.brook@example.com'),
       (2, 'Dana Reyes', 'dana.reyes@example.com')"

run "INSERT INTO Orders (order_id, customer_id, total, status) VALUES
       (12345, 1, NUMERIC '147.85', 'OPEN'),
       (12346, 1, NUMERIC  '18.00', 'OPEN'),
       (12347, 2, NUMERIC '200.00', 'OPEN')"

run "INSERT INTO LineItem (line_item_id, order_id, type, amount, memo) VALUES
       ('li-12345-1', 12345, 'item',     NUMERIC  '89.99', 'Cast iron skillet'),
       ('li-12345-2', 12345, 'item',     NUMERIC  '34.50', 'Enamel saucepan'),
       ('li-12345-3', 12345, 'shipping', NUMERIC  '12.00', 'Expedited shipping'),
       ('li-12345-4', 12345, 'tax',      NUMERIC  '11.36', 'Sales tax'),
       ('li-12346-1', 12346, 'item',     NUMERIC  '18.00', 'Silicone spatula set'),
       ('li-12347-1', 12347, 'item',     NUMERIC '200.00', 'Stand mixer')"

echo
echo "Seeded $DATABASE on $INSTANCE ($PROJECT)."
