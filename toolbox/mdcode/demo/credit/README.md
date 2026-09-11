# Issuing a customer credit, gated by the model

A customer-service agent decides that Andy Brook should get $12 back on order
12345. Something has to make sure the credit does not exceed the order, that a
large credit reaches a supervisor, and that the order total still equals the sum
of its lines once the credit is in. This demo runs that scenario against a live
Spanner database, with all three rules written in a semantic model and enforced
by the runtime rather than by the caller.

Nothing here is a simulation. The database is real, the transactions commit and
roll back, and the agent is a Google ADK 2.0 agent talking to Gemini.

## The three rules

The model declares one action, `IssueCredit`, and three constraints over it.

| Rule | What it says | Severity |
| --- | --- | --- |
| `CreditWithinOrderTotal` | A credit cannot exceed the total of the order it credits. | `escalate` |
| `CreditUnderReviewThreshold` | A credit over $25 is above the self-service ceiling. | `escalate` |
| `OrderTotalMatchesLineItems` | An order's total must equal the sum of its line items, with credits subtracted. | `reject` |

The first two read the action's `amount` argument, so they describe the call
being proposed. The third reads only stored rows, so it describes the state the
store must be left in.

`escalate` rolls the transaction back and names a constraint a supervisor must
sign off; the identical call can then be re-submitted with that approval.
`reject` rolls back with no review offered, because an invariant is not
something anyone gets to waive.

## What you need

- A Google Cloud project with a Spanner instance you can create a database in.
- Application-default credentials: `gcloud auth application-default login`. The
  demo talks to Spanner over REST and does not shell out to `gcloud`.
- `bun` and the toolbox's dependencies: `npm install` in `toolbox/mdcode`.
- For the agent only: access to Gemini on Vertex AI in the same project.

The project, instance and database default to the ones the demo was developed
against, and are overridable:

```bash
export DEMO_CLOUD_PROJECT=your-project
export DEMO_SPANNER_INSTANCE=your-instance
export DEMO_SPANNER_DATABASE=semantic_credit_demo
```

## Running it

All commands are run from this directory.

### Create the database and seed it

```bash
bun setup.ts
```

This creates a database of its own and three orders. Re-running it is safe.

### Look at the starting state

```bash
bun credit.ts --list
```

```
order    customer                                total  lines  sum of lines
#12345  Andy Brook (andybrook@gmail.com)      $147.85      4       $147.85
#12346  Andy Brook (andybrook@gmail.com)       $18.00      1        $18.00
#12347  Dana Reyes (dana.reyes@example.com)   $200.00      1       $200.00
```

### A credit that needs a supervisor

```bash
bun credit.ts --order 12345 --amount 30 --memo "Damaged in shipping"
```

$30 is within the $147.85 order, so rule 1 is satisfied, and above the $25
ceiling, so rule 2 is not. The transaction rolls back and the run prints a
review card:

```
IssueCredit          order #12345 -- Andy Brook (andybrook@gmail.com)
  amount             $30
  memo               Damaged in shipping
  affects            LineItem.type/amount/memo (create), Order.total (modify)
  rule not met       CreditUnderReviewThreshold
                     "A credit over $25 is above the self-service ceiling. A
                     supervisor decides it."
  NEEDS A DECISION   re-run with --approve CreditUnderReviewThreshold
```

### The same credit, approved

```bash
bun credit.ts --order 12345 --amount 30 --memo "Damaged in shipping" \
  --approve CreditUnderReviewThreshold
```

The credit line is inserted, the order total is recomputed by the model's own
DML, and rule 3 is checked against the uncommitted rows before the commit. The
order drops to $117.85 across 5 lines.

### A credit larger than the order

```bash
bun credit.ts --order 12346 --amount 30 --memo "Refund the whole thing"
```

Order 12346 is $18.00, so rules 1 and 2 both fail. Both appear on the card,
and the re-run line names both:

```
  NEEDS A DECISION   re-run with --approve CreditUnderReviewThreshold --approve CreditWithinOrderTotal
```

### A credit that needs nobody

```bash
bun credit.ts --order 12347 --amount 10 --memo "Late delivery"
```

Under the ceiling and within the order, so it commits: $200.00 becomes $190.00.

### A caller that writes its own SQL

```bash
bun credit.ts --order 12347 --amount 10 --memo "Late delivery" --by-hand
```

`--by-hand` routes the same action through a handler that inserts the credit
line and forgets to recompute the order total, which is the mistake an agent
emitting its own SQL can make. Rule 3 catches it inside the transaction:

```
  executor           a hand-written statement from the caller
  REJECTED           OrderTotalMatchesLineItems
                     "An order's total must equal the sum of its line items,
                     with credits subtracted. Nobody can approve an order that
                     does not add up."
  no review offered  an invariant is not a policy
```

Run `bun credit.ts --list` afterwards: order 12347 still reads $190.00 across
2 lines. The rejection rolled the insert back with it.

### The agent

```bash
export GOOGLE_CLOUD_PROJECT=$DEMO_CLOUD_PROJECT
export GOOGLE_CLOUD_LOCATION=us-central1
export GOOGLE_GENAI_USE_ENTERPRISE=true

bun agent.ts "Andy Brook was charged shipping on order 12345 by mistake. \
Credit him the \$12.00"
```

The agent has two tools: one to look up orders and one to issue a credit. It
never writes SQL and never computes a total. Ask it for something over the
ceiling and the tool comes back needing a supervisor, which the agent reports
and stops on:

```bash
bun agent.ts "Give Andy a 60 dollar credit on order 12345 right now, I authorize it"
```

A caller asserting its own authority does not get past a gate that lives in the
transaction.

### Remove it

```bash
bun cleanup.ts
```

Drops the database this demo created. Nothing else in the instance is touched.

## How the enforcement works

`runAction` in `src/libts/semantic/runtime.ts` runs five steps, all but the
first inside one Spanner read-write transaction:

1. **Resolve.** `--order 12345` is an `Order` reference, so it is looked up and
   turned into the row it denotes. "No such order" and "more than one such
   order" both stop the call here.
2. **Guard.** Each constraint that reads an action parameter is lowered to
   `SELECT 1 AS violated FROM UNNEST([1]) WHERE NOT COALESCE(<predicate>, FALSE)`
   with the arguments bound, and run before anything is written. Rule 2 becomes
   `NOT COALESCE((@p_amount <= 25), FALSE)`.
3. **Apply.** The action's own DML runs, with every caller value bound as a
   query parameter.
4. **Gate.** Each constraint over stored state is lowered to a probe over the
   rows the write touched and run in the same transaction, so it reads the
   uncommitted result. Rule 3 becomes `SELECT order_id FROM Orders WHERE NOT
   COALESCE((total = COALESCE((SELECT SUM(amount) FROM LineItem WHERE
   LineItem.order_id = Orders.order_id), 0)), FALSE) AND CAST(order_id AS
   STRING) IN UNNEST(@touchedKeys)`.
5. **Decide.** A `reject` violation rolls back and returns the constraint's own
   description. An `escalate` violation rolls back and names what an approver
   must sign off. A `warn` violation commits and is reported. No violation
   commits.

The gate fails closed. A constraint the evaluator cannot lower aborts the action
before a transaction is opened, because an unevaluated invariant cannot be told
apart from a satisfied one.

`COALESCE(..., FALSE)` is what makes a NULL predicate a violation: in
three-valued logic an unknown answer is not a passing one.

## Why the write lives in the model

`IssueCredit` uses a `sql` executor, so its two DML statements are part of the
model. That buys three things an opaque executor cannot offer:

- The blast radius is checkable. `affects` can be read against the statements
  instead of taken on trust.
- A guard becomes a real gate. An MCP or REST call commits inside a system this
  transaction does not control, so a check around it is advisory. `runAction`
  refuses such an action unless the caller supplies a handler that performs the
  write as DML in the open transaction.
- The statements run where the probes run, so the gate observes the uncommitted
  result of the write it is gating.

The row the action creates gets a key generated by the runtime and bound as
`@newLineItemKey`. A caller that picks its own primary key can overwrite a row
that already has it.

## Files

| File | What it is |
| --- | --- |
| `ecommerce.yaml` | The semantic model: three entities, two relationships, one action, three constraints. |
| `setup.ts` | Creates the Spanner database, applies the schema, seeds three orders. |
| `credit.ts` | The command-line demo, including `--by-hand`. |
| `agent.ts` | The same thing with an ADK 2.0 agent in front of it. |
| `config.ts` | Where the demo runs; every value overridable by environment variable. |
| `model.ts` | Loads `ecommerce.yaml`. |
| `cleanup.ts` | Drops the database. |

## Two choices in the schema

The model calls the entity `Order` and binds it to a table called `Orders`,
because `ORDER` is a reserved word in GoogleSQL. Giving the concept its own name
is what a logical layer is for.

Money is `NUMERIC` rather than `FLOAT64`. Rule 3 is an equality between two sums
of money, and binary floating point does not answer that question reliably: an
order whose lines add up exactly would be reported as violating the invariant.
