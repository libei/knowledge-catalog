# An agent that acts on a semantic model

An agent is handed a business to work in and a set of things it may do. This
demo derives both from a semantic model and runs the result against a live
Spanner database: an English request goes in, and a row changes.

Nothing in `agent.ts` mentions credits, orders or tables. The tools come out of
the model — one lookup per entity, one write per action — with their names,
descriptions, parameter types and calling guidance all read from what the model
declares. Point the same file at another model and it offers other tools.

What runs here:

| | |
| --- | --- |
| `commerce.yaml` | the business: entities, relationships, one action, three constraints |
| `commerce.profiles/spanner.yaml` | where it lives: tables, columns, and the DML the action performs |
| `tools.ts` | the derived tools, printed — and callable by hand |
| `agent.ts` | the same tools bound to a Gemini agent through ADK |

## What you need

A cloud project with a Spanner instance, and application-default credentials —
the demo uses them for both Spanner and Gemini.

```bash
gcloud auth application-default login
export DEMO_CLOUD_PROJECT=sqlgen-testing            # defaults shown
export DEMO_SPANNER_INSTANCE=graph-unified-solution-demo
export DEMO_SPANNER_DATABASE=semantic_agent_demo
```

Run everything from the `toolbox/mdcode` package root.

```bash
npm run build                # builds dist/kcmd, used below
bash demo/agent/setup.sh     # creates the database and seeds three orders
(cd demo/agent && npm install)
```

The seed leaves order 12345 at $147.85 over four line items, 12346 at $18.00,
and 12347 at $200.00. Re-running `setup.sh` returns the database to exactly
that, whatever the demo has done to it since.

## One model, two files

`commerce.yaml` says what the business is. It names three entities, the
relationships between them, one action, and three rules. It names no table, no
column and no SQL — the same file would serve if the orders lived in AlloyDB.

`commerce.profiles/spanner.yaml` says where the business lives. Each entity gets
a Spanner table, each field a column, and `IssueCredit` gets the two statements
that perform it: insert a negative line, then recompute the order total from its
lines. A profile may supply physical facts and nothing else — the loader rejects
a profile that tries to add an entity or change what one means — so reading it
tells you the whole of what is deployment-specific here.

Both files sit in a `kcmd` workspace (`catalog/EntryGroups/commerce_demo/`), so
the CLI and the agent are reading the same two files rather than two copies that
can drift.

## What the model declares

```console
$ cd demo/agent && ../../dist/kcmd action list
Model 'commerce' (commerce_demo), profile 'spanner':
  IssueCredit: Credit a customer against one order -- a late delivery, a coupon, a shipping charge applied in error. The credit is added as a negative line and the order total is recomputed from the lines.
    parameters: order (Order, reference), amount (Decimal), memo (String)
    executor:   sql
    affects:    LineItem (create), Order (modify)
    run:        kcmd action run IssueCredit --arg order=<Order> --arg amount=<Decimal> --arg memo=<String>
```

Two warnings print above this, and they are the model reporting on itself:

```
Warning: [commerce] constraint 'CreditWithinOrderTotal' reads 'amount', a parameter
of action 'IssueCredit', but 'IssueCredit' does not list 'CreditWithinOrderTotal'
in guards. A constraint over an action's parameters is checked only as a guard of
that action.
```

That is accurate and deliberate — see [What is not wired up
yet](#what-is-not-wired-up-yet) below.

## What an agent is offered

The same model, read as tools:

```console
$ bun demo/agent/tools.ts
model 'commerce' under profile 'spanner', bound to sqlgen-testing/graph-unified-solution-demo/semantic_agent_demo

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
    ...
lookup  find_line_item  (LineItem)
    ...
```

Every line of that is the model's. The action's description and its
`ai_context.instructions` become the tool description; its typed parameters
become typed tool parameters; each entity's description and bound fields become
a lookup and its filters. The read tools are deliberately narrow — exact match
on any bound field, ANDed, capped, no joins or ranges or totals — which is
enough to find the object an action needs and keeps the generated SQL checkable
by eye.

## Calling one by hand

`tools.ts` will invoke any tool it lists, which is how you test the derivation
without an agent in the way:

```console
$ bun demo/agent/tools.ts find_order --customerId=1
orderId	customerId	total	status
12345	1	147.85	OPEN
12346	1	18	OPEN

$ bun demo/agent/tools.ts issue_credit --order=12345 --amount=12.50 \
    --memo='Expedited shipping applied in error'
{
  "applied": true,
  "actedOn": { "order": [ "12345" ] },
  "committedAt": "2026-09-12T17:38:45.551142Z"
}

$ bun demo/agent/tools.ts find_line_item --orderId=12345
lineItemId                            orderId	type      amount	memo
e509b51d-f5c3-4d6a-a453-be1e84dfa5aa  12345  	credit    -12.5 	Expedited shipping applied in error
li-12345-1                            12345  	item      89.99 	Cast iron skillet
li-12345-2                            12345  	item      34.5  	Enamel saucepan
li-12345-3                            12345  	shipping  12    	Expedited shipping
li-12345-4                            12345  	tax       11.36 	Sales tax

$ bun demo/agent/tools.ts find_order --orderId=12345
orderId	customerId	total	status
12345	1	135.35	OPEN
```

The credit line's key was generated by the runtime, because the action's
`affects` says the call creates a `LineItem`; the profile's INSERT names it as
`@newLineItemKey`. The total moved from 147.85 to 135.35 without the caller
doing any arithmetic — the second statement recomputes it from the lines, so an
order cannot stop adding up however this action is called.

Both statements run in one read-write transaction. If the second had failed, the
first would not be there.

## The agent

```console
$ cd demo/agent
$ bun agent.ts "Dana Reyes says the stand mixer she ordered arrived scratched. Give her \$20 off that order."
  -> find_customer({"name":"Dana Reyes"})
  <- {"entity":"Customer","fields":["customerId","name","email"],"rows":[["2","Dana Reyes","dana.reyes@example.com"]],"truncated":false}
  -> find_order({"customerId":2})
  <- {"entity":"Order","fields":["orderId","customerId","total","status"],"rows":[["12347","2","200","OPEN"]],"truncated":false}
  -> issue_credit({"amount":20,"memo":"stand mixer arrived scratched","order":"12347"})
  <- {"applied":true,"actedOn":{"order":["12347"]},"committedAt":"2026-09-12T17:39:46.686280Z"}
I issued a $20 credit to order 12347 for Dana Reyes, because the stand mixer arrived scratched.
```

Order 12347 is $180.00 afterwards. The request named a person and a product; the
agent found the customer, then the order, then acted — three derived tools, in
the order the model's guidance suggests.

The adapter that binds a derived tool to ADK is a dozen lines, and they are the
same dozen for any model. Nothing under `src/` imports an agent framework, so a
LangChain or MCP binding is a different dozen lines against the same derivation.

What the agent is *not* doing is the more interesting half. It never writes SQL:
the statements are in the binding profile, authored once and reviewed there. It
cannot widen its own reach, because the tools it has are the ones the model
declares. And it cannot compute a total — the action does that, in the same
transaction as the write.

Two things about it are the developer's, not the model's: the persona in
`agent.ts`, and the choice of which tools to bind. Both are visible in that file
and neither is hidden in the library.

## What is not wired up yet

`commerce.yaml` declares three constraints and references none of them. A
constraint is inert until an action names it in `guards`, and this runtime does
not evaluate constraints yet — so naming one would make the action *unrunnable*
rather than checked:

```console
$ bun demo/agent/tools.ts --guarded
action  issue_credit  (IssueCredit)
    ...
    This call is gated by CreditUnderReviewThreshold.

    Calling this will not work: Action 'IssueCredit' is guarded by
    'CreditUnderReviewThreshold', and this runtime does not evaluate constraints
    yet. Running it would apply a write the model says must be checked first, so
    it is refused rather than run unchecked. Report that rather than retrying.
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

```bash
bash demo/agent/cleanup.sh     # drops the database
```
