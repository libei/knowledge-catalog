#!/bin/bash
# Seeds the three orders the credit demo runs against.
#
# Each statement is one visible gcloud call, so any of them can be copied out
# and run on its own. gcloud has a --ddl-file flag for schema and no equivalent
# for DML, which is why the schema is a .sql file and this is a script.
#
# Re-running replaces the rows it owns.
#
# Three orders, chosen so each rule has a case that trips it and a case that
# does not:
#
#   12345  $147.85  Andy Brook  a $30 credit is within the order and over the
#                               $25 ceiling, so one rule holds it
#   12346   $18.00  Andy Brook  a $30 credit exceeds the order as well, so two
#                               rules hold it
#   12347  $200.00  Dana Reyes  a $10 credit trips nothing and commits

set -euo pipefail

PROJECT=${PROJECT:-sqlgen-testing}
INSTANCE=${INSTANCE:-graph-unified-solution-demo}
DATABASE=${DATABASE:-semantic_credit_demo}

run() {
  echo "+ $1"
  gcloud spanner databases execute-sql "$DATABASE" \
    --instance="$INSTANCE" --project="$PROJECT" --sql="$1"
}

run "DELETE FROM LineItem WHERE TRUE"
run "DELETE FROM Orders WHERE TRUE"
run "DELETE FROM Customer WHERE TRUE"

run "INSERT INTO Customer (customer_id, name, email) VALUES
       (1, 'Andy Brook', 'andybrook@gmail.com'),
       (2, 'Dana Reyes', 'dana.reyes@example.com')"

run "INSERT INTO Orders (order_id, customer_id, total, status) VALUES
       (12345, 1, NUMERIC '147.85', 'OPEN'),
       (12346, 1, NUMERIC  '18.00', 'OPEN'),
       (12347, 2, NUMERIC '200.00', 'OPEN')"

run "INSERT INTO LineItem (line_item_id, order_id, type, amount, memo) VALUES
       ('li-12345-1', 12345, 'item',     NUMERIC  '89.99', 'Cast iron skillet'),
       ('li-12345-2', 12345, 'item',     NUMERIC  '34.50', 'Enamel saucepan'),
       ('li-12345-3', 12345, 'shipping', NUMERIC  '12.00', 'Labor Day sale shipping'),
       ('li-12345-4', 12345, 'tax',      NUMERIC  '11.36', 'Sales tax'),
       ('li-12346-1', 12346, 'item',     NUMERIC  '18.00', 'Silicone spatula set'),
       ('li-12347-1', 12347, 'item',     NUMERIC '200.00', 'Stand mixer')"
