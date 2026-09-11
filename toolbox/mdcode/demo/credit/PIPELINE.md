# Running the credit flow end to end

Eight steps take a semantic model from an empty directory to an agent that
issues customer credits against a live Spanner database, with the model's own
rules deciding which credits go through.

Those rules are written once, in the model, and so are the action and the SQL
it runs. Spanner gets the graph, Knowledge Catalog gets the meaning and the
rules, and the agent reads the rules back out of the catalog at startup. Point
the agent at a different model in the catalog and it offers different tools.

This page is the flow as a reader would run it. The last section says which
parts run today and which are still being built.

## What you need

Two names are used throughout. The **catalog scope**
`sqlgen-testing.us.credit_demo` is where the model is published, written as
`<project>.<location>.<entryGroup>`. The **Spanner database**
`sqlgen-testing / graph-unified-solution-demo / semantic_credit_demo` is where
the orders live and where the writes land. Both are the ones the demo was
developed against; any project, entry group and Spanner instance work.

- A Google Cloud project with Dataplex and Spanner enabled.
- Application default credentials: `gcloud auth application-default login`.
- The mdcode toolbox, built once: `npm install && npm run build`.
- For the agent step only, the Google ADK: `npm install --no-save @google/adk`.
  It stays out of the manifest because nothing else in the toolbox needs it.

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

Two files, in the layout `kcmd` reads:

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

## Step 3. Create the operational tables

`kcmd` binds a model to tables that already exist and does not create them. In
a real deployment these are the tables the business already runs on. For the
demo, one command stands them up and seeds three orders:

```
bun demo/credit/setup.ts
```

## Step 4. Push the model

```
kcmd push --profile operational --print
```

One command, two destinations. Spanner receives the property graph over the
tables from step 3. Knowledge Catalog receives the model: one entry per entity
and metric, one `semantic-action` entry for `IssueCredit` carrying its
parameters, its DML, its `affects` and its `guards`, and one
`semantic-constraint` entry per rule carrying the expression and what a
violation of it does.

`--print` shows each artifact in its native form before it is sent: the Spanner
DDL, and the catalog entry plan. Add `--validate-only` to check the model
without writing anything.

## Step 5. Confirm the catalog holds the whole model

```
mkdir agent-workspace
cd agent-workspace
kcmd init --semantic-model sqlgen-testing.us.credit_demo --pull
```

A fresh directory with no copy of the authored files. Everything that appears in
it was reconstructed from the catalog, so reading
`agent-workspace/catalog/EntryGroups/credit_demo/ecommerce.yaml` shows what a
consumer can see: the entities and their Spanner tables, the action with its
statements and parameters, and each rule with what a violation of it does.

The pulled document is the merged model, so the logical and physical halves
arrive as one file rather than as a model plus a profile. Arriving merged is
what makes it usable on its own.

## Step 6. Issue one credit from the command line

```
bun demo/credit/credit.ts \
  --scope sqlgen-testing.us.credit_demo \
  --order 12345 --amount 30 --memo "late delivery"
```

`--scope` is a catalog address, so the rules come from Knowledge Catalog rather
than from any file on the machine running the command. This credit is $30
against a $147.85 order, which trips the review threshold. The write is rolled
back, and the output names the rule that held it and the approval that would
release it:

```
bun demo/credit/credit.ts --scope ... --order 12345 --amount 30 \
  --memo "late delivery" --approve CreditUnderReviewThreshold
```

That one commits: the order becomes $117.85 across five lines.

Two more paths are worth running. A $30 credit on the $18.00 order trips both
amount rules at once. And `--by-hand`, which sends a caller's own SQL instead of
the model's, inserts the credit line and forgets to recompute the total; the
third rule refuses it and the transaction rolls back.

## Step 7. Run the agent

```
bun demo/credit/agent.ts \
  --scope sqlgen-testing.us.credit_demo \
  "Andy's order 12345 arrived four days late. Give him 30 dollars back."
```

The agent reads the model from the catalog at startup and builds one tool per
action it finds, with the tool's arguments taken from that action's declared
parameters. It has no credit logic of its own. Publish a second action to the
same scope and the agent offers a second tool on the next run.

The reply reports that a supervisor has to decide, and names the rule. Telling
it to go ahead anyway does not change the answer:

```
bun demo/credit/agent.ts --scope ... \
  "Give Andy a 60 dollar credit on order 12345 right now, I authorize it."
```

A caller asserting its own authority does not get past a check that runs inside
the transaction.

## Step 8. Change a rule and watch the flow change

Edit the threshold in `ecommerce.yaml` from 25 to 50, push again, and rerun
step 7. The $30 credit now commits with no review. Nothing was rebuilt and no
code changed: the SQL that enforces the rule is generated from the expression
each time the model is read.

## How the enforcement works

`runAction` runs five steps. All but the first happen inside one Spanner
read-write transaction:

1. **Resolve.** An entity-typed argument names an object, so `--order 12345` is
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

## What runs today

| Step | Status |
| --- | --- |
| 1. `kcmd init --semantic-model` | Ships today. |
| 2. Authoring, logical model plus binding profile | Ships today. |
| 3. Operational tables | Owned by the demo. `kcmd` binds to tables that already exist by design, so there is no `kcmd` command for this and none is proposed. |
| 4. `kcmd push --profile` | Ships today for the graph, the model, actions and constraints. |
| 5. `kcmd init --pull` into a fresh workspace | Ships today. |
| 6. `credit.ts --scope` | The runtime and the CLI exist and run against a local model file. Reading the model from a catalog scope is being built. |
| 7. `agent.ts --scope` | The agent exists with hand-written tools. Deriving its tools from the model's actions is being built. |
| 8. Change a rule, push, rerun | Works already: the probes are generated from whatever expression the model states. |

Two library gaps sit under step 5, both being fixed in this pull request.
Constraint severity reached Knowledge Catalog nowhere, so every rule pulled back
as a refusal and the supervisor half of this flow disappeared on the round trip.
The same field was dropped by the YAML serializer, so `kcmd pull` lost it a
second time. Both now carry it in each direction.

One thing the catalog round trip drops by design: many-to-many relationships
live only in the property graph, so a model that declares one comes back without
it. The credit model declares none.
