# Modeling write operations

A semantic model says what the data means. An **action** says what can be done to
it, and a **constraint** says what has to stay true while it is done. A model
with both is something an agent can act through rather than only read from.

An action names a business operation and leaves the mechanics to an
**executor**. The model adds two things on top of a plain tool schema. The first
is parameters typed by the ontology, so an entity-typed argument is an object
reference rather than a value. The second is a gate: the model's constraints are
checked against the result of the write before that write is allowed to stand.

Actions and constraints are write-side, so they have no representation in the
graph. `kcmd push` publishes both to Knowledge Catalog on the model's anchor
entry and warns once that nothing was placed in the graph. Enforcing them is a
separate job from publishing them, done by the runtime in
[`src/libts/semantic/runtime.ts`](../../src/libts/semantic/runtime.ts); the
runnable version of everything below is in
[`demo/action/`](../../demo/action/README.md).

## When to use it

Declare an action when an agent has to change data and you want the rules that
keep that data correct to live in the model. The rules then hold for every
caller, and a caller that is refused is told what to do differently in the words
you wrote.

Do not declare an action for a question about the data; that is a
[metric](README.md#1-author-a-model). Do not write a constraint to say who is
allowed to see what. A constraint explains itself to the caller so the caller
can correct its next move, and an explanation of an access rule describes the
data the rule protects.

## The one rule

Every constraint in the model is checked on every action, and the check looks at
the rows the action touched:

> **An action must not introduce a violation among the rows it changes.**

An account that was already below its floor before the call was not put there by
this action, and it does not block the call. An account the action *changed* has
to come out satisfying every constraint. Scoping the check this way also keeps
the cost of a write independent of table size; probing whole tables on every
write would make each call cost more as the data grows.

## 1. Declare the action

An action is model-level, beside metrics. It carries a name, an executor, and
its parameters:

```yaml
version: "0.2.0.dev0"
semantic_model:
  - name: payments
    entities:
      - name: Account
        primary_key: [accountId]
        source: my-project.bank.account
        fields:
          - { name: accountId,      datatype: Integer, expression: account_id }
          - { name: name,           datatype: String,  expression: name }
          - { name: balance,        datatype: Float,   expression: balance }
          - { name: minimumBalance, datatype: Float,   expression: minimum_balance }
          - { name: status,         datatype: String,  expression: status }
      - name: Transfer
        primary_key: [transferId]
        source: my-project.bank.transfer
        fields:
          - { name: transferId, datatype: Integer, expression: transfer_id }
          - { name: amount,     datatype: Float,   expression: amount }
    actions:
      - name: TransferFunds
        description: Move money from one account to another.
        executor:                                  # exactly one kind: mcp / rest / grpc
          mcp:
            server: //agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/payments
            tool: transfer_funds
        parameters:
          - { name: source, type: Account }        # an entity type: an object reference
          - { name: target, type: Account }
          - { name: amount, type: Float }
        ai_context:
          instructions: >-
            Resolve both accounts before calling. If the call is rejected, read
            the reason: it names the rule that was broken and what to change.
```

`source` and `target` are typed `Account`, which is an entity in this model, so
they are object references. A caller supplies something human — an account id or
a display name — and the runtime works out which row that denotes, failing when
nothing matches and when more than one thing does. `amount` is typed `Float`,
one of the scalar datatypes, so it is an ordinary value and is passed through.

The executor says where the operation lives. `mcp` (`{server, tool}`) references
a tool already registered in Agent Registry; `rest` (`{endpoint, method}`) and
`grpc` (`{service, method}`) are the other kinds, and exactly one kind is
required. An executor names no statement, which is why the runtime does not
produce the write itself — see
[What is not modeled yet](#what-is-not-modeled-yet).

## 2. State the rules as constraints

A constraint is a named boolean invariant over the ontology, written in the same
expression language as a metric:

```yaml
    constraints:
      - name: NonNegativeBalance
        expression: Account.balance >= 0
        description: >-
          An account cannot be overdrawn. Transfer a smaller amount, or move
          money from an account that holds enough.
      - name: AboveMinimumBalance
        expression: Account.balance >= Account.minimumBalance
        description: >-
          This account has to keep a minimum balance. Move less, or draw from an
          account with more room above its floor.
      - name: PositiveAmount
        expression: Transfer.amount > 0
        description: >-
          A transfer has to move a positive amount. To reverse a payment, make a
          transfer in the other direction.
      - name: OpenAccountsOnly
        expression: Account.status != 'FROZEN'
        description: >-
          A frozen account cannot send or receive money. Choose a different
          account, or have this one unfrozen first.
```

Two things decide whether this block does its job.

**A constraint belongs to the model rather than to an action.** No action lists
the constraints it cares about; every constraint is checked on every action. A
rule you write once holds for `TransferFunds` and for the next action you add.

**The description is the error message.** It comes back verbatim when the rule
is broken, so write it as an instruction to whoever tripped it. "Transfer a
smaller amount, or move money from an account that holds enough" tells an agent
what to try next. "Invalid balance" sends it back to retry the same call.

## 3. Push the model

```bash
kcmd push
```

Push emits no node, edge, or measure for an action or a constraint, and warns
once for each kind that they were not placed in the graph. Both are published to
Knowledge Catalog instead, on the model's anchor entry, where `kcmd pull`
recovers them. What that entry holds is in
[Reference → What gets created in Knowledge Catalog](reference.md#what-gets-created-in-knowledge-catalog).

Publishing puts the rules where anything reading the model can see them. It does
not enforce them. Enforcement is step 4.

## 4. Run the action

The runtime takes the model, the action's name, the caller's arguments, a
Spanner client, and a handler that produces the write:

```ts
const outcome = await runAction({
  model,
  actionName: 'TransferFunds',
  args: {source: 'Alice Checking', target: 'Bob Checking', amount: 500},
  client,
  handler: transferHandler,
});
```

It then runs four steps:

1. **Resolve.** Each entity-typed argument becomes the row it denotes. `"Alice
   Checking"` becomes account 1.
2. **Apply.** A read-write transaction opens and the handler's statements run
   inside it. Nothing is visible to anyone else yet.
3. **Gate.** Every constraint is lowered to a query that returns violating rows,
   and each one runs in that same transaction, so it observes the uncommitted
   write.
4. **Decide.** Any violation rolls the transaction back and returns the violated
   constraint's `description`. No violation commits.

A transfer that satisfies every rule commits, and the outcome names what was
checked and what was resolved:

```
Committed. Checked NonNegativeBalance, AboveMinimumBalance, PositiveAmount,
OpenAccountsOnly. Resolved Alice Checking -> 1, Bob Checking -> 3.
```

A transfer of 5000 out of an account holding 2500 is refused, and the message is
the one the model author wrote:

```
REJECTED (rolled back): An account cannot be overdrawn. Transfer a smaller
amount, or move money from an account that holds enough. Rejected by constraint
'NonNegativeBalance' (Account.balance >= 0). Violating Account: 1. ...
```

Two constraints fail in that example and both are reported: the balance goes
below zero and below the account's own floor. The database is left as it was.

An argument that names nothing fails before any transaction opens:

```
ERROR: No Account matches 'Dave Checking'.
```

An ambiguous reference is reported the same way, with the candidates listed, so
the caller can pick one.

## 5. Let an agent act

Expose the action as a tool and the rejection becomes the useful part of the
loop. An agent asks for a transfer that overdraws an account, reads back
"transfer a smaller amount, or move money from an account that holds enough",
checks the balances, and tries again with a workable figure. The rule was never
written into its prompt. It lives in the model, and the model is what the agent
was handed.

[`demo/action/mcp.ts`](../../demo/action/mcp.ts) is a worked example: an MCP
server over stdio exposing `describe_model`, `list_accounts`, and
`transfer_funds`.

## What the gate can check

The expression grammar is small on purpose: comparisons between a field and
either a literal or another field of the same entity, joined by `AND` and `OR`.
The operators are `>=`, `<=`, `!=`, `<>`, `=`, `>`, and `<`. A single constraint
ranges over one entity, so `Account.balance >= Account.minimumBalance` is inside
the grammar and a comparison across two entities is outside it. Aggregates and
function calls are outside it as well, and parentheses are not parsed at all. A
chain that mixes `AND` and `OR` is accepted and grouped by SQL precedence, so
`AND` binds tighter than `OR`.

A NULL counts as a violation. `Account.balance >= 0` is unknown when the balance
is NULL, and the gate reads unknown as unsatisfied, so a row with a NULL in a
constrained field is refused. To ask whether a field is populated, write
`= NULL` or `!= NULL`; those two lower to `IS NULL` and `IS NOT NULL`, and NULL
with an ordering operator is refused as meaningless.

An expression the runtime cannot lower does not quietly pass. The action is
refused before the transaction opens, because the runtime cannot tell an
unevaluated invariant from a satisfied one, and resolving that doubt in favor of
the write is how data gets corrupted.

## What is not modeled yet

This is a prototype, and four gaps are worth knowing before you build on it.

- **An action has no `precondition` and no `affects`.** The gate is model-level:
  every constraint is checked on every action. The rows an action touched are
  used to keep each probe cheap, and they never narrow which rules apply.
- **The runtime does not call the executor.** An action names where an operation
  lives rather than what statement it runs, so the caller supplies a handler
  that produces the statements. Executor dispatch is the seam where MCP, REST,
  and gRPC would later slot in.
- **The write path is Spanner.** `runAction` takes a Spanner client, and the
  gate depends on running the probes inside the same transaction as the write.
- **No `kcmd` command runs an action.** Push publishes the action and its
  constraints; running one means calling the runtime, as `demo/action/` does.

## When an action is refused and you did not expect it

- **A row that only gains value is still checked.** A transfer into a frozen
  account is refused by `OpenAccountsOnly` even though the transfer only adds
  money, because the action touched that row and a touched row has to satisfy
  every constraint.
- **Enough money is not the rule the model states.** An account holding 18000
  with a 5000 floor refuses a transfer of 14000, and the constraint that
  refuses it is `AboveMinimumBalance`. If that is wrong, the expression is what
  to change.
- **A constraint outside the grammar refuses everything.** The action aborts
  before it writes, and the message names the constraint that could not be
  lowered. Rewrite it inside the grammar, or take it out of the model and check
  it elsewhere.
- **A pre-existing violation is not the cause.** Probes are scoped to the rows
  the action touched, so an account that was already below its floor before the
  call does not block an unrelated transfer.

Actions and constraints reach Knowledge Catalog the same way for a BigQuery
model and a Spanner model, and neither backend's graph carries them. Enforcement
today runs against Spanner.
