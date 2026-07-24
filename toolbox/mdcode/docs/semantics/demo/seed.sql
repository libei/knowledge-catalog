-- Seed tables for the kcmd --transpile demo.
--
-- Creates a small `orders` / `customer` pair (TPC-H-shaped) so the generated
-- property graph has real tables and columns to bind to. The @PROJECT@ and
-- @DATASET@ tokens are substituted by the demo commands in README.md.

CREATE SCHEMA IF NOT EXISTS `@PROJECT@.@DATASET@`;

CREATE OR REPLACE TABLE `@PROJECT@.@DATASET@.orders` AS
SELECT * FROM UNNEST([
  STRUCT(1  AS o_orderkey, 100 AS o_custkey, 'F' AS o_orderstatus, 'Clerk#001' AS o_clerk,
         'urgent order'    AS o_comment, 1200.50 AS o_totalprice,
         DATE '2026-01-05'  AS o_orderdate, DATE '2026-01-09' AS o_shipdate),
  STRUCT(2, 100, 'O', CAST(NULL AS STRING), 'follow-up', 340.00,  DATE '2026-02-11', DATE '2026-02-14'),
  STRUCT(3, 200, 'F', 'Clerk#002',          'gift wrap', 89.99,   DATE '2026-02-20', DATE '2026-02-22'),
  STRUCT(4, 300, 'O', 'Clerk#003',          CAST(NULL AS STRING), 5600.00, DATE '2026-03-01', DATE '2026-03-08')
]);

CREATE OR REPLACE TABLE `@PROJECT@.@DATASET@.customer` AS
SELECT * FROM UNNEST([
  STRUCT(100 AS c_custkey, '555-0100' AS c_phone, 'AUTOMOBILE' AS c_mktsegment),
  STRUCT(200,              'abc-1234',            'BUILDING'),
  STRUCT(300,              '555-0300',            'AUTO PARTS')
]);
