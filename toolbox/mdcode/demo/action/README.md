# Actions and constraints: a model that can be acted on

A semantic model usually describes what data means. This one also describes what
can be *done* to it, and what has to stay true while it is being done.

The model is `payments.yaml`: accounts, their owners, transfers between them, one
action called `TransferFunds`, and four constraints. The demo runs that action
against a real Spanner database and shows what happens when a transfer would
break one of the rules.

## What the pieces are

**The action** says a transfer takes two accounts and an amount. Both accounts
are typed `Account`, which makes them object references rather than values: the
caller says `"Alice Checking"` or `1` and the runtime works out which row that
is.

**The constraints** are named invariants written in the model:

| Constraint | Expression |
| --- | --- |
| `NonNegativeBalance` | `Account.balance >= 0` |
| `AboveMinimumBalance` | `Account.balance >= Account.minimumBalance` |
| `PositiveAmount` | `Transfer.amount > 0` |
| `OpenAccountsOnly` | `Account.status != 'FROZEN'` |

Each one carries a description, and the description is written as an
instruction -- "transfer a smaller amount, or move money from an account that
holds enough" -- because that text is what comes back when the rule is broken.

**The runtime** puts them together. It resolves the account references, opens a
read-write transaction, applies the debit and credit, and then checks every
constraint against the result *before committing*. The checks run inside the
same transaction, so they see the new balances even though nobody else can yet.
If any check fails, the transaction is rolled back and the constraint's
description is returned. If they all pass, it commits.

Two things about that are worth stating plainly.

The runtime does not invent the write. An action names an executor, not SQL, so
the DML lives in `action.ts` and the runtime calls it. The model contributes the
typed resolution and the gate.

The gate fails closed. If a constraint cannot be turned into a check -- an
aggregate, a function call, anything outside the small expression grammar -- the
action is refused before the transaction is even opened. A gate that quietly
lets writes through is worse than no gate, because it is believed.

## Configuration

You need a project with Spanner, and an instance to create a database in.

```bash
export DEMO_CLOUD_PROJECT=<GCP_PROJECT_ID>
export DEMO_SPANNER_INSTANCE=<SPANNER_INSTANCE>
gcloud auth application-default login
gcloud config set project $DEMO_CLOUD_PROJECT
```

The demo defaults to `sqlgen-testing` / `graph-unified-solution-demo` and always
creates its own database, `semantic_action_demo`, so nothing that was already in
the instance is touched.

## Set up

Creates the database, the three tables, a property graph over them, and four
seeded accounts.

```bash
bun setup.ts
bun transfer.ts --list
```

```
id  account          balance     floor    status
1   Alice Checking        2500      100  OPEN
2   Alice Savings        18000     5000  OPEN
3   Bob Checking           400        0  OPEN
4   Carol Savings          900        0  FROZEN
```

## A transfer that is allowed

```bash
bun transfer.ts "Alice Checking" "Bob Checking" 500
```

```
Committed. Checked NonNegativeBalance, AboveMinimumBalance, PositiveAmount,
OpenAccountsOnly. Resolved Alice Checking -> 1, Bob Checking -> 3.
```

Both names resolved to account ids, all four constraints held against the
post-transfer balances, and the transaction committed.

## Four transfers that are refused

Each of these leaves the database exactly as it was. Run `bun transfer.ts --list`
after any of them to confirm.

**Overdrawing an account.** Alice Checking holds 2500.

```bash
bun transfer.ts "Alice Checking" "Bob Checking" 5000
```

```
REJECTED (rolled back): An account cannot be overdrawn. Transfer a smaller
amount, or move money from an account that holds enough. Rejected by constraint
'NonNegativeBalance' (Account.balance >= 0). Violating Account: 1. ...
```

Two constraints fail here, and both are reported: the balance goes below zero
*and* below the account's own floor.

**Breaking an account's minimum balance.** Alice Savings holds 18000 and has to
keep 5000.

```bash
bun transfer.ts "Alice Savings" "Bob Checking" 14000
```

```
REJECTED (rolled back): This account has to keep a minimum balance. Move less,
or draw from an account with more room above its floor. Rejected by constraint
'AboveMinimumBalance' (Account.balance >= Account.minimumBalance). Violating
Account: 2.
```

There is enough money for the transfer. It is still refused, because "enough
money" is not the rule the model states.

**Touching a frozen account.**

```bash
bun transfer.ts "Alice Checking" "Carol Savings" 100
```

```
REJECTED (rolled back): A frozen account cannot send or receive money. Choose a
different account, or have this one unfrozen first. Rejected by constraint
'OpenAccountsOnly' (Account.status != 'FROZEN'). Violating Account: 4.
```

Carol's account was never going to go wrong -- the transfer only adds to it --
but the action touched it, and a touched row has to satisfy every constraint.

**A negative amount.**

```bash
bun transfer.ts "Alice Checking" "Bob Checking" -50
```

```
REJECTED (rolled back): A transfer has to move a positive amount. To reverse a
payment, make a transfer in the other direction. Rejected by constraint
'PositiveAmount' (Transfer.amount > 0). ...
```

Nothing in the handler checks the sign of the amount. The model does.

## A reference that does not resolve

```bash
bun transfer.ts "Dave Checking" "Bob Checking" 10
```

```
ERROR: No Account matches 'Dave Checking'.
```

An ambiguous reference is reported the same way, with the candidates listed, so
the caller can pick one.

## What the constraints are checked against

The probes are scoped to the rows the action touched. An account that was
already below its floor before the demo started is not the transfer's fault and
does not block it; an account the transfer *changed* has to come out satisfying
every rule.

That is the enforcement contract: an action must not introduce a violation among
the rows it changes. It is also the only version that scales -- re-reading a
whole table on every write would make each transfer cost more as the bank grows.

## The same model, as a graph

`setup.ts` also creates a Spanner property graph over the same tables, so the
transfers the runtime committed are queryable as edges:

```bash
gcloud spanner databases execute-sql semantic_action_demo \
  --instance=$DEMO_SPANNER_INSTANCE --project=$DEMO_CLOUD_PROJECT \
  --sql="GRAPH payments
         MATCH (src:Account)-[t:Transfers]->(dst:Account)
         RETURN src.name AS source, dst.name AS target, t.amount AS amount"
```

```
source          target          amount
Alice Checking  Bob Checking    500
```

Only the committed transfer is there. The four refused ones left no trace.

## Letting an agent act

`mcp.ts` is an MCP server over stdio exposing three tools: `describe_model`,
`list_accounts`, and `transfer_funds`.

```bash
bun mcp.ts
```

To use it from Claude Code, register it and then ask for a transfer in plain
language:

```bash
claude mcp add payments -- bun /absolute/path/to/demo/action/mcp.ts
```

The loop closes because a refusal is useful. Ask for a transfer that overdraws
an account and the tool returns the constraint's description; the agent reads
"transfer a smaller amount, or move money from an account that holds enough",
checks the balances, and tries again with a workable figure -- without the rule
having been written into its prompt. The rule lives in the model, and the model
is what the agent was handed.

## Clean up

```bash
bun cleanup.ts
```

Deletes the `semantic_action_demo` database and nothing else.
