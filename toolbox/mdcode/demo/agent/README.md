# Build an agent that acts on a semantic model

This is a recipe, not an exhibit. Follow it and you end up with an agent that
takes an English request and changes a row in Spanner — and with an
understanding of why almost none of the work was agent work.

The whole agent is one file, `agent.ts`, 68 lines of code. Not one of them
mentions credits, orders, customers, Spanner tables or SQL. Four steps: open the
workspace, derive the tools, adapt them to the framework, run. Everything that
knows what business this is lives in the model, where it outlives the agent.

Everything else you need is already a command: `kcmd` for the model and its
actions, `gcloud` for the store, ADK for the agent.

## Before you start

A cloud project with a Spanner instance, and application-default credentials —
used for both Spanner and Gemini.

```bash
gcloud auth application-default login
```

Build the CLI from the `toolbox/mdcode` package root. From step 2 on,
everything runs in `demo/agent`, which is why `kcmd` appears as
`../../dist/kcmd`.

```bash
npm run build                # builds dist/kcmd
(cd demo/agent && npm install)
```

## 1. Write the model

Two files, and the split between them is the whole design.

`catalog/EntryGroups/commerce_demo/commerce.yaml` says what the business is:
three entities, the relationships between them, one action, three rules. It
names no table, no column and no SQL. The same file would serve if the orders
lived in AlloyDB.

`catalog/EntryGroups/commerce_demo/commerce.profiles/spanner.yaml` says where
the business lives: a table per entity, a column per field, and the two
statements that perform `IssueCredit` — insert a negative line, then recompute
the order total from its lines. A profile may supply physical facts and nothing
else; the loader rejects one that tries to add an entity or change what one
means. So reading that one file tells you the whole of what is
deployment-specific here, including where it runs:

```yaml
deployment_target: //spanner.googleapis.com/projects/sqlgen-testing/instances/graph-unified-solution-demo/databases/semantic_agent_demo/propertyGraphs/commerce
```

Point that line at your own instance and everything follows it: the commands
below create and drop the database it names, the tools read and write there, and
the agent bills Gemini to the same project. There is nothing else to keep in
step.

Both files sit in a `kcmd` workspace (`catalog.yaml` scopes it and names
`spanner` as the default profile), so the CLI and the agent read the same two
files rather than two copies that can drift.

### Put the persona in the model too

`commerce.yaml` carries a model-level `ai_context`:

```yaml
    ai_context:
      instructions: >-
        You are working a customer-service desk for this business. The person
        in front of you has an order and describes it the way a customer does
        -- a name, a product, what went wrong -- so expect to be given a
        description where the model expects a number.
```

This is the part people reflexively write into the agent's source, and it is the
part that should least be there. It is true of every agent that acts on this
model, including the ones nobody has written yet, and a rule an agent keeps
privately can be changed without the people who own the model finding out.

Only what is specific to *this business* belongs there. How to use a lookup, and
what to do when a write is refused, are properties of the derived tools rather
than of commerce, so the derivation supplies those and the model does not repeat
them.

## 2. Create the store

Four `gcloud` commands, and none of them names a database. Ask the model where
it lives instead — `kcmd action list --store` prints the deployment target as
`project/instance/database` and nothing else, so a shell can read it:

```bash
cd demo/agent
IFS=/ read -r PROJECT INSTANCE DATABASE <<<"$(../../dist/kcmd action list --store)"
```

Naming it a second time here is how you end up seeding one database while the
agent talks to another.

```bash
gcloud spanner databases create "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" --ddl-file=schema.sql
```

`schema.sql` is three tables. It is a file rather than a command because
`--ddl-file` wants one, and because `kcmd push` deploys a graph over tables that
already exist rather than creating them.

Then the rows — two customers, three orders, six line items:

```bash
gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="INSERT INTO Customer (customer_id, name, email) VALUES
    (1, 'Andy Brook', 'andy.brook@example.com'),
    (2, 'Dana Reyes', 'dana.reyes@example.com')"

gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="INSERT INTO Orders (order_id, customer_id, total, status) VALUES
    (12345, 1, NUMERIC '147.85', 'OPEN'),
    (12346, 1, NUMERIC  '18.00', 'OPEN'),
    (12347, 2, NUMERIC '200.00', 'OPEN')"

gcloud spanner databases execute-sql "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT" \
  --sql="INSERT INTO LineItem (line_item_id, order_id, type, amount, memo) VALUES
    ('li-12345-1', 12345, 'item',     NUMERIC  '89.99', 'Cast iron skillet'),
    ('li-12345-2', 12345, 'item',     NUMERIC  '34.50', 'Enamel saucepan'),
    ('li-12345-3', 12345, 'shipping', NUMERIC  '12.00', 'Expedited shipping'),
    ('li-12345-4', 12345, 'tax',      NUMERIC  '11.36', 'Sales tax'),
    ('li-12346-1', 12346, 'item',     NUMERIC  '18.00', 'Silicone spatula set'),
    ('li-12347-1', 12347, 'item',     NUMERIC '200.00', 'Stand mixer')"
```

That leaves order 12345 at $147.85 over four line items, 12346 at $18.00, and
12347 at $200.00. To start over, drop the database with the command under
[Cleaning up](#cleaning-up) and run these four again.

## 3. Check what the model declares

```console
$ ../../dist/kcmd action list
Model 'commerce' (commerce_demo), profile 'spanner':
  store: sqlgen-testing/graph-unified-solution-demo/semantic_agent_demo
  IssueCredit: Credit a customer against one order -- a late delivery, a coupon, a shipping charge applied in error. The credit is added as a negative line and the order total is recomputed from the lines.
    parameters: order (Order, reference), amount (Decimal), memo (String)
    executor:   sql
    affects:    LineItem (create), Order (modify)
    run:        kcmd action run IssueCredit --arg order=<Order> --arg amount=<Decimal> --arg memo=<String>
```

Two warnings print above this, and they are the model reporting on itself:

```
Warning: [commerce] model 'commerce': constraint 'CreditWithinOrderTotal' reads 'amount',
a parameter of action 'IssueCredit', but 'IssueCredit' does not list 'CreditWithinOrderTotal'
in guards. A constraint over an action's parameters is checked only as a guard of that action.
```

That is accurate and deliberate — see [What is not wired up
yet](#what-is-not-wired-up-yet).

The action runs from the command line before any agent exists:

```console
$ ../../dist/kcmd action run IssueCredit --arg order=12346 --arg amount=3.00 --arg memo="Coupon applied late"
Running 'IssueCredit' on projects/sqlgen-testing/instances/graph-unified-solution-demo/databases/semantic_agent_demo...
  order: '12346' -> Order 12346
Committed at 2026-09-12T20:10:55.151292Z.
```

`order=12346` was text; the runtime resolved it to a row and says which one. The
total moved from $18.00 to $15.00 with nobody doing arithmetic — the second
statement recomputes it from the lines, so the order cannot stop adding up
however the action is called. Both statements ran in one read-write transaction.
Read it back with plain SQL:

```console
$ gcloud spanner databases execute-sql semantic_agent_demo \
    --instance=graph-unified-solution-demo --project=sqlgen-testing \
    --sql="SELECT order_id, total FROM Orders ORDER BY order_id"
order_id  total
12345     147.85
12346     15
12347     180
```

## 4. Look at the tools before writing the agent

`kcmd agent tools` prints exactly what an agent will be handed. No API key, no
language model, no agent code yet:

```console
$ ../../dist/kcmd agent tools
Model 'commerce' (commerce_demo), profile 'spanner':
  store: sqlgen-testing/graph-unified-solution-demo/semantic_agent_demo

  action  issue_credit  (IssueCredit)
      Credit a customer against one order -- a late delivery, a coupon, a shipping charge applied in error. The credit is added as a negative line and the order total is recomputed from the lines.

      Give the order as its number, the amount in dollars, and a memo saying why. Look the order up first if you were given a customer name rather than a number: an Order is identified by its key alone.
      order: string  -- Which Order this applies to. Give its key, or text that identifies exactly one; the call fails when nothing matches or more than one does.
      amount: number  -- The amount, as a decimal number.
      memo: string  -- The memo, as text.

  lookup  find_customer  (Customer)
      Look up Customer records.

      Returns customerId, name, email. Every argument is an exact match and every one is optional; giving none returns the first rows. This tool cannot join, compare ranges, or total anything.
      filters: customerId, name, email

  lookup  find_order  (Order)
      A customer order. Its total is the sum of its line items: items, tax and fees add, credits subtract. A positive total is money owed to the company.

      Returns orderId, customerId, total, status. Every argument is an exact match and every one is optional; giving none returns the first rows. This tool cannot join, compare ranges, or total anything.
      filters: orderId, customerId, total, status

  lookup  find_line_item  (LineItem)
      One line of an order. A charge line is positive; a credit line is negative, so that the order total is always a plain sum.

      Returns lineItemId, orderId, type, amount, memo. Every argument is an exact match and every one is optional; giving none returns the first rows. This tool cannot join, compare ranges, or total anything.
      filters: lineItemId, orderId, type, amount, memo

  instruction:
      You are working a customer-service desk for this business. The person in front of you has an order and describes it the way a customer does -- a name, a product, what went wrong -- so expect to be given a description where the model expects a number.

      Never invent an identifier. When you are given a name or a description instead of one, find it with the lookup tools rather than asking for it -- that is what they are for, and asking wastes the caller's time. Never compute a total or a balance yourself; the tools do that. When a tool reports that a write did not happen, read the reason it gives and repeat it plainly; if it says a person has to decide, say so and stop, because you cannot approve it yourself. Finish by saying what you changed.
```

Every line of that came from somewhere other than an agent. The action's
description and its `ai_context.instructions` became the tool description; its
typed parameters became typed tool parameters; each entity's description and
bound fields became a lookup and its filters. The instruction is the model's
persona followed by the tool contract the derivation itself defines.

The read tools are deliberately narrow — exact match on any bound field, ANDed,
capped, no joins, ranges or totals. That is enough to find the object an action
needs, and it keeps the generated SQL checkable by eye. When a lookup is not
enough, the answer is a query, not a wider tool.

## 5. Write the agent

All of it. The four steps, with the framework's own API doing the work:

```ts
// 1. Open the workspace kcmd reads, and the store the model says it lives in.
const opened = await openWorkspace({path: import.meta.dir});
if ('error' in opened) throw new Error(opened.error);
const [{model}] = opened.models;

const store = spannerStore(model);
if ('error' in store) throw new Error(store.error);

// 2. Derive the tools and what to say about them -- what `kcmd agent tools`
//    just printed.
const {lookups, actions, instruction} =
    modelTools({model, client: store.client});

// 3. Adapt each one to the framework.
const tools = [...lookups, ...actions].map(
    tool => new FunctionTool({
      name: tool.name,
      description: tool.description,
      parameters: schemaFor(tool.parameters),
      execute: (args: unknown) => tool.invoke(args as Record<string, unknown>),
    }));

// 4. Run.
const agent = new LlmAgent({
  name: 'model_agent',
  model: 'gemini-2.5-flash',
  description: model.description,
  instruction,
  tools,
});
```

`agent.ts` adds three things to that sketch and nothing else: `schemaFor`, which
turns a tool parameter into a Zod field; a filter that leaves out any tool the
runtime cannot run today, printing why; and the loop that prints each call and
each answer.

The test the file exists to fail is easy to state: the moment something about
*this business* has to be written in it, the model was missing that thing, and
the fix belongs in the model.

## 6. Run it

```console
$ bun agent.ts "Dana Reyes says the stand mixer she ordered arrived scratched. Give her \$20 off that order."
  -> find_customer({"name":"Dana Reyes"})
  <- {"entity":"Customer","fields":["customerId","name","email"],"rows":[["2","Dana Reyes","dana.reyes@example.com"]],"truncated":false}
  -> find_order({"customerId":2})
  <- {"entity":"Order","fields":["orderId","customerId","total","status"],"rows":[["12347","2","200","OPEN"]],"truncated":false}
  -> issue_credit({"amount":20,"order":"12347","memo":"stand mixer arrived scratched"})
  <- {"applied":true,"actedOn":{"order":["12347"]},"committedAt":"2026-09-12T20:10:40.451811Z"}
I've issued a $20 credit to Dana Reyes for order 12347 due to the scratched stand mixer.
```

The request named a person and a product. The agent found the customer, then the
order, then acted — three derived tools, in the order the model's guidance
suggests. Check it with SQL:

```console
$ gcloud spanner databases execute-sql semantic_agent_demo \
    --instance=graph-unified-solution-demo --project=sqlgen-testing \
    --sql="SELECT line_item_id, order_id, type, amount, memo FROM LineItem WHERE order_id = 12347 ORDER BY type"
line_item_id                          order_id  type    amount  memo
27d39b8f-f813-4bda-bebc-bf9a6e20d58d  12347     credit  -20     stand mixer arrived scratched
li-12347-1                            12347     item    200     Stand mixer
```

The credit line's key was generated by the runtime, because the action's
`affects` says the call creates a `LineItem`; the profile's INSERT names it as
`@newLineItemKey`. Order 12347 is $180.00 afterwards.

What the agent is *not* doing is the more interesting half. It never writes SQL:
the statements are in the binding profile, authored once and reviewed there. It
cannot widen its own reach, because the tools it has are the ones the model
declares. It cannot compute a total — the action does that, in the same
transaction as the write. And it carries no opinion of its own about how to
treat a customer, because that opinion is in `commerce.yaml`.

## What is not wired up yet

`commerce.yaml` declares three constraints and references none of them. A
constraint is inert until an action names it in `guards`, and this runtime does
not evaluate constraints yet — so naming one makes the action *unrunnable*
rather than checked. Try it: add `guards: [CreditUnderReviewThreshold]` to the
action and run `kcmd agent tools` again.

```console
  action  issue_credit  (IssueCredit)
      ...
      This call is gated by CreditUnderReviewThreshold.

      Calling this will not work: Action 'IssueCredit' is guarded by 'CreditUnderReviewThreshold', and this runtime does not evaluate constraints yet. Running it would apply a write the model says must be checked first, so it is refused rather than run unchecked. Report that rather than retrying.
      ...
      NOT RUNNABLE: Action 'IssueCredit' is guarded by 'CreditUnderReviewThreshold', ...
```

Refusing is the point. A write the model says must be checked is not run because
the checker is missing; it is not run *unchecked*. The tool is still derived,
still named and still described — an action the model declares should not vanish
from what the model offers — and `agent.ts` reports it and leaves it unbound, so
the agent has no call to make and nothing to retry.

The two warnings at load time say the same thing from the other direction: the
policy is written down and it is not attached. Attaching it is the next piece of
work, not a forgotten one.

## Cleaning up

One command. Everything the demo made is in the database the model names.

```bash
gcloud spanner databases delete "$DATABASE" \
  --instance="$INSTANCE" --project="$PROJECT"
```
