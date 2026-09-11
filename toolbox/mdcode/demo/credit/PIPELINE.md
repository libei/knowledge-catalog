# Running the credit flow end to end

Nine steps take a semantic model from an empty directory to an agent that issues
customer credits against a live Spanner database, with the model's own rules
deciding which credits go through.

Every step is a `kcmd` command, a `gcloud` command, or a file you author. The
demo contributes five files, all of them short enough to read in full: a logical
model, a Spanner binding for it, the table definitions, the seeding script, and
the agent.

The rules that decide which credits go through are written once, in the model,
and so are the action and the SQL it runs. Spanner gets the graph, Knowledge
Catalog gets the meaning and the rules, and everything after step 5 runs out of
a workspace whose whole contents came back from the catalog.

The last two sections list what the demo itself owns, and say which steps ship
today and which are being built.

## What you need

Two names are used throughout. The **catalog scope**
`sqlgen-testing.us.credit_demo` is where the model is published, written as
`<project>.<location>.<entryGroup>`. The **Spanner database**
`sqlgen-testing / graph-unified-solution-demo / semantic_credit_demo` is where
the orders live and where the writes land. Both are the ones the demo was
developed against; any project, entry group and Spanner instance work.

- A Google Cloud project with Dataplex and Spanner enabled.
- Application default credentials: `gcloud auth application-default login`.
- The `kcmd` binary: `npm install && npm run build` puts it at `dist/kcmd`.
- For step 8 only, the Google ADK: `npm install --no-save @google/adk`. It
  stays out of the manifest because nothing else in the toolbox needs it.

## Step 1. Create the catalog scope

```
kcmd init --semantic-model sqlgen-testing.us.credit_demo
```

Creates the Dataplex entry group the model will live in, and writes
`catalog.yaml` and the directory the model document goes in. It also provisions
the two custom types a model with behavior needs. `semantic-action` makes an
action an object a search can find and a policy can govern; `semantic-constraint`
does the same for each rule.

Run once per scope. A second run is harmless.

## Step 2. Author the model and its Spanner binding

```
catalog.yaml
catalog/EntryGroups/credit_demo/
  ecommerce.yaml                          the logical model
  ecommerce.profiles/operational.yaml     where it reads and writes
```

`ecommerce.yaml` says what the business is and what may be done to it: the
entities `Customer`, `Order` and `LineItem`, the relationships between them, one
action `IssueCredit`, and three constraints. The action carries its own DML, so
the statements that insert the credit line and recompute the order total are
part of the model rather than of any caller. It carries an `affects` block
naming what a call changes, and a `guards` list naming which constraints gate
it.

The three rules, and what a violation of each does:

| Rule | Reads | On violation |
| --- | --- | --- |
| A credit never exceeds the order it credits | the requested amount | held for a supervisor |
| A credit over $25 needs a human decision | the requested amount | held for a supervisor |
| An order's total equals the sum of its lines | stored rows | refused, and rolled back |

`ecommerce.profiles/operational.yaml` is the physical half: the Spanner table
each entity reads from, the column each field maps to, and the
`deployment_target` naming the property graph to deploy. The logical model is
free of table names, so the same model binds to an analytics copy by adding a
second profile.

## Step 3. Create and seed the operational tables

`kcmd` binds a model to tables that already exist and does not create them. In
a real deployment these are the tables the business already runs on. Here the
demo ships them, applied with `gcloud`:

```
gcloud spanner databases create semantic_credit_demo \
  --instance=graph-unified-solution-demo --project=sqlgen-testing \
  --ddl-file=demo/credit/schema.sql

demo/credit/seed.sh
```

`schema.sql` holds three tables. Money is `NUMERIC` because the third rule is an
equality between two sums of money, and binary floating point does not answer
that question reliably. The order table is called `Orders` because `ORDER` is a
reserved word in GoogleSQL. Logical names exist for this: the model calls the
entity `Order`, and the profile binds that name to the `Orders` table.

`seed.sh` inserts three orders. Each of its statements is one visible `gcloud
spanner databases execute-sql` call, so any one of them can be copied out and
run alone. The schema is a file and the seed is a script because `gcloud` reads
DDL from a file and has no equivalent for DML.

The three orders are chosen so each rule has a case that trips it and a case
that does not:

| Order | Total | Customer | A credit of |
| --- | --- | --- | --- |
| 12345 | $147.85 | Andy Brook | $30 is within the order and over the $25 ceiling |
| 12346 | $18.00 | Andy Brook | $30 exceeds the order as well |
| 12347 | $200.00 | Dana Reyes | $10 trips nothing |

To see the rows at any point, including whether each order still adds up:

```
gcloud spanner databases execute-sql semantic_credit_demo \
  --instance=graph-unified-solution-demo --project=sqlgen-testing \
  --sql="SELECT o.order_id, c.name, o.total,
                (SELECT SUM(li.amount) FROM LineItem li
                 WHERE li.order_id = o.order_id) AS sum_of_lines
         FROM Orders o JOIN Customer c USING (customer_id)
         ORDER BY o.order_id"
```

## Step 4. Push the model

```
kcmd push --profile operational --print
```

One command, two destinations. Spanner receives the property graph over the
tables from step 3. Knowledge Catalog receives the model: one entry per entity
and metric, one `semantic-action` entry for `IssueCredit`, and one
`semantic-constraint` entry per rule. The action entry carries its parameters,
its DML, its `affects` and its `guards`. Each rule entry carries the expression
and what a violation of it does.

`--print` shows each artifact in its native form before it is sent: the Spanner
DDL, and the catalog entry plan. Add `--validate-only` to check the model
without writing anything.

## Step 5. Move to a workspace built from the catalog

```
mkdir agent-workspace
cd agent-workspace
kcmd init --semantic-model sqlgen-testing.us.credit_demo --pull
```

`agent-workspace` sits alongside `demo/`, so paths into the repository from
inside it start with `../`.

A fresh directory with no copy of the authored files. Everything that appears in
it was reconstructed from the catalog. So
`catalog/EntryGroups/credit_demo/ecommerce.yaml` shows what a consumer can see:
the entities and their Spanner tables, the action with its statements and
parameters, and each rule with what a violation of it does.

Every command from here runs in this directory. That is what makes the rest of
the flow a demonstration rather than an assertion: the rules being enforced are
the ones the catalog handed back.

The pulled document is the merged model, so the logical and physical halves
arrive as one file rather than as a model plus a profile. Arriving merged is
what makes it usable on its own.

## Step 6. Issue a credit

```
kcmd action run IssueCredit \
  --arg order=12345 --arg amount=30 --arg memo="late delivery"
```

`kcmd action run` reads the model in the current workspace, resolves the
arguments, and runs the action's declared write inside one Spanner read-write
transaction with the rules checked in the same transaction. `--arg` takes
whatever the action declares, so the flags are the same for every action and
none of them mention credit.

This credit is $30 against a $147.85 order. The amount is over the $25 ceiling,
so one rule holds the write. It is rolled back, and the output names the rule
that held it and the approval that would release it:

```
kcmd action run IssueCredit \
  --arg order=12345 --arg amount=30 --arg memo="late delivery" \
  --approve CreditUnderReviewThreshold
```

That one commits, and the order becomes $117.85 across five lines. Two more
runs are worth doing. A $30 credit on order 12346 trips both amount rules at
once, and names both. A $10 credit on order 12347 commits with no review.

## Step 7. Write to the database directly, and see what breaks

The rules live in the transaction `kcmd action run` opens, so a caller holding
database credentials goes around them. Insert a credit line against order 12346
and leave the order total alone:

```
gcloud spanner databases execute-sql semantic_credit_demo \
  --instance=graph-unified-solution-demo --project=sqlgen-testing \
  --sql="INSERT INTO LineItem (line_item_id, order_id, type, amount, memo)
         VALUES ('li-hand-1', 12346, 'credit', NUMERIC '-5.00', 'by hand')"
```

That succeeds. Re-run the SELECT from step 3 and order 12346 reads $18.00
against $13.00 of lines: the third rule is now false and nothing objected,
because nothing was asked.

Then try to issue a legitimate credit against that same order. At $5 it is
inside the order and under the ceiling, so the two amount rules have nothing to
say about it:

```
kcmd action run IssueCredit \
  --arg order=12346 --arg amount=5 --arg memo="courtesy"
```

Refused, and no approval is offered. The third rule reads stored state, so it
fails on the damage that was already there, and an invariant is the kind of rule
nobody is allowed to wave through. Deleting the hand-written row makes the
action work again.

This is the argument for giving an agent `kcmd action run` and withholding the
database credentials. A check that lives in the transaction cannot be talked out
of, and a caller that never opens its own transaction cannot get around it.

## Step 8. Run the agent

```
bun ../demo/credit/agent.ts
```

The agent reads the model from the workspace at startup and builds one tool per
action it finds, with the tool's arguments taken from that action's declared
parameters. It has no credit logic of its own; publish a second action to the
same scope, pull, and it offers a second tool.

Ask it for the credit from step 6 in words:

```
> Andy's order 12345 arrived four days late. Give him 30 dollars back.
```

The reply reports that a supervisor has to decide, and names the rule. Telling
it to go ahead anyway does not change the answer:

```
> Give Andy a 60 dollar credit on order 12345 right now, I authorize it.
```

A caller asserting its own authority does not get past a check that runs inside
the transaction.

## Step 9. Change a rule and watch the flow change

Edit the threshold from 25 to 50 in the `ecommerce.yaml` you authored in step 2,
then carry it through:

```
kcmd push --profile operational        # from the authoring directory
kcmd pull                              # from agent-workspace
```

Repeat step 6 and the $30 credit commits with no review. Nothing was rebuilt and
no code changed: the SQL that enforces a rule is generated from the expression
each time the model is read.

## How the enforcement works

`kcmd action run` runs five steps. All but the first happen inside one Spanner
read-write transaction:

1. **Resolve.** An entity-typed argument names an object, so `order=12345` is
   looked up and turned into the row it denotes. "No such order" and "more than
   one such order" both stop the call.
2. **Guard.** A rule whose expression reads an action parameter describes the
   proposed call, so it is checked before anything is written, with the
   arguments bound. Once the write has happened there is no longer an `amount`
   for it to read.
3. **Apply.** The action's own DML runs inside the transaction.
4. **Gate.** Every rule over stored state becomes a SQL probe and runs in the
   same transaction, so it sees the uncommitted rows.
5. **Decide.** A refusal rolls back and returns the rule's own description. A
   held write rolls back and names what an approver must sign off. A warning
   commits and is reported.

The gate fails closed. A rule the runtime cannot turn into SQL stops the action
before a transaction opens, because an unevaluated rule cannot be told apart
from a satisfied one.

## What the demo owns

Five files, all of them readable end to end:

| File | What it is |
| --- | --- |
| `ecommerce.yaml` | the logical model, its action and its three rules |
| `ecommerce.profiles/operational.yaml` | the Spanner tables and columns it binds to |
| `schema.sql` | three `CREATE TABLE` statements |
| `seed.sh` | two customers, three orders, six line items, one `gcloud` call each |
| `agent.ts` | an ADK agent that turns each action into a tool |

Everything else on this page is `kcmd` or `gcloud`. An earlier draft of the demo
carried five TypeScript files standing in for those commands. Each one moves
into the product or onto the command line:

| Was | Becomes |
| --- | --- |
| `setup.ts`, 146 lines | `schema.sql` and `seed.sh`, applied with `gcloud spanner databases create` and `execute-sql` |
| `credit.ts`, 247 lines | `kcmd action run`, a command over the same runtime |
| `credit.ts --list` | a `SELECT` run with `gcloud spanner databases execute-sql` |
| `credit.ts --by-hand` | an `INSERT` run with `gcloud`, which shows the unguarded path more honestly |
| `config.ts` and `model.ts`, 47 lines | the workspace `kcmd init --pull` creates |
| `cleanup.ts`, 19 lines | `gcloud spanner databases delete` |

## What runs today

| Step | Status |
| --- | --- |
| 1. `kcmd init --semantic-model` | Ships today. |
| 2. Authoring, logical model plus binding profile | Ships today. |
| 3. `gcloud spanner` from `schema.sql` and `seed.sh` | Ships in this pull request. `setup.ts` is gone. |
| 4. `kcmd push --profile` | Ships today for the graph, the model, actions and constraints. |
| 5. `kcmd init --pull` into a fresh workspace | Ships today. |
| 6. `kcmd action run` | The runtime ships in this pull request. The command is being built, and replaces the demo's own driver. |
| 7. Direct writes with `gcloud` | Nothing to build. |
| 8. `agent.ts` | The agent exists with hand-written tools. Deriving its tools from the model's actions is being built. |
| 9. Change a rule, push, rerun | Works already: the probes are generated from whatever expression the model states. |

Two library gaps sat under step 5 and are fixed in this pull request. Constraint
severity reached Knowledge Catalog nowhere, so every rule pulled back as a
refusal and the supervisor half of this flow disappeared on the round trip. The
same field was dropped by the YAML serializer, so `kcmd pull` lost it a second
time. Both now carry it in each direction.

One thing the catalog round trip drops by design: many-to-many relationships
live only in the property graph, so a model that declares one comes back without
it. The credit model declares none.
