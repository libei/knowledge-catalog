# Stating what must stay true

A **constraint** is a named boolean invariant over the ontology: something the
model asserts about every instance of an entity, written in the same expression
language as a metric. `Account.balance >= 0` says an account is never overdrawn.
That is part of what the model means by an account, and it holds however the row
got there — a bulk load, a hand-written `UPDATE`, or an agent calling a tool.

Stating the rule in the model puts it beside the entities it talks about, where
anything reading the model can find it. A rule that lives in one application's
code holds for that application. The same rule in the model is available to
everything the model reaches, and the sentence you write to explain a violation
becomes the sentence a caller is refused with.

The word is used for other things nearby. A constraint on this page is a
statement about the domain. An entity's `unique_keys` describe the shape of the
data behind it, and a `CHECK` clause is a rule one database enforces for itself;
neither is what this page means.

## Where a constraint is checked

A rule stated in the model can be checked anywhere the model is used. Today one
place checks it: the runtime that runs an [action](actions.md) refuses a write
that would introduce a violation. That gate is what the rest of this page walks
through.

Nothing else acts on a constraint yet. Pushing a model publishes its constraints
to Knowledge Catalog, which puts them where other consumers could read them, and
a reader is free to compile one into a `CHECK` clause or a data-quality rule.
`kcmd` does neither, and a constraint that no action ever runs against is
published metadata that nothing checks.

## The rule the gate applies

The model on this page is the payments model from
[Modeling write operations](actions.md): accounts, transfers between them, and
one action called `TransferFunds`. The runtime in
[`src/libts/semantic/runtime.ts`](../../src/libts/semantic/runtime.ts) is what
enforces the constraints. The runnable version of everything below, against a
live Spanner database, is [`demo/action/`](../../demo/action/README.md).

Every constraint in the model is checked on every action, and the check looks at
the rows the action touched:

> **An action must not introduce a violation among the rows it changes.**

An account that was already below its floor before the call was not put there by
this action, and it does not block the call. An account the action *changed* has
to come out satisfying every constraint. Scoping the check this way also keeps
the cost of a write independent of table size; probing whole tables on every
write would make each call cost more as the data grows.

## 1. State the rules

Constraints sit at model level, beside actions and metrics:

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

**No action lists the constraints it cares about.** Every constraint is checked
on every action, so a rule you write once holds for the action you have now and
for the next one you add.

**The description is the error message.** It comes back verbatim when the rule
is broken, so write it as an instruction to whoever tripped it. "Transfer a
smaller amount, or move money from an account that holds enough" tells an agent
what to try next. "Invalid balance" sends it back to retry the same call.

## 2. Push the model

```bash
kcmd push
```

Like actions, constraints are write-side and have no graph construct. The push
emits nothing for them and warns once:

```
model 'payments': 4 constraint(s) published as semantic-constraint entries
(constraints have no BigQuery Graph representation).
```

Knowledge Catalog is where they land. Each constraint becomes its own entry,
parented to the model entry, the way an action does. The expression rides an
aspect; the description is the entry's own summary, because it is the sentence a
person reads when the rule refuses a write:

```yaml
# .../entryGroups/<group>/entries/payments.constraints.NonNegativeBalance
entryType: projects/<project>/locations/global/entryTypes/semantic-constraint
parentEntry: .../entryGroups/<group>/entries/payments
entrySource:
  displayName: NonNegativeBalance
  description: >-
    An account cannot be overdrawn. Transfer a smaller amount, or move money
    from an account that holds enough.
aspects:
  <project>.global.semantic-constraint:
    expression: Account.balance >= 0
```

`semantic-constraint` is a custom entry type and aspect type pair, provisioned
by `kcmd init --semantic-model` in your own project at `global`, for the same
reason `semantic-action` is: every other element of a model maps to a built-in
system type under `dataplex-types/global`, and there is no built-in type for a
constraint. A later push writes only entries.

The entry shape buys the same two things it buys an action. A catalog search can
list every rule in a project by entry type. And dropping a constraint from the
document deletes its entry on the next push, because the model owns the
`<model>.constraints.` id prefix.

Knowledge Catalog is the only destination a constraint has, so `kcmd push
--no-kc` validates the constraints and then warns that they will not be
deployed.

`kcmd pull` collects the `semantic-constraint` entries under the model entry and
rebuilds each rule, so a name, an expression, a description, and
`ai_context.instructions` survive the round trip unchanged.

Publishing puts the rules where anything reading the model can see them. It does
not enforce them. Enforcement is the next step.

## 3. Run an action through the gate

No `kcmd` command runs an action. The gate is a function you call from your own
code: `runAction`, exported by
[`src/libts/semantic/runtime.ts`](../../src/libts/semantic/runtime.ts) along
with the types a handler is written against. Give it a loaded model, the name of
one of that model's actions, the arguments the caller supplied, a client for the
database the data lives in, and a handler.

The last two need saying more fully.

**The database is Spanner.** The gate runs its checks inside the same
transaction as the write, so it needs a client that exposes a read-write
transaction, and Spanner is the store this is implemented against. `client` is a
`SpannerDataClient` pointed at the database holding the accounts.

**The handler is the write itself.** An action names the executor that carries
the operation out and stops there, so the model never says what SQL moves the
money. You supply that as a function. Everything around it comes from the
ontology: which rows the arguments denote, which constraints apply, and whether
the result may commit.

A handler is given the action's arguments with the entity-typed ones already
resolved to rows, and returns the statements to run together with the rows they
touch:

```ts
async function transferHandler(ctx: ActionContext): Promise<ActionPlan> {
  const source = ctx.refs.source.keys[0];  // 'Alice Checking' resolved to '1'
  const target = ctx.refs.target.keys[0];
  const amount = Number(ctx.args.amount);
  const transferId = String(Date.now());
  return {
    statements: [
      debit(source, amount),
      credit(target, amount),
      record(transferId, source, target, amount),
    ],
    // Which rows to check. An entity left out here is checked over its whole
    // table, which is correct and slower.
    touched: {Account: [source, target], Transfer: [transferId]},
  };
}
```

Running it:

```ts
const outcome = await runAction({
  model,  // loadModels(readFileSync('payments.yaml', 'utf8')).models[0]
  actionName: 'TransferFunds',
  args: {source: 'Alice Checking', target: 'Bob Checking', amount: 500},
  client,  // new SpannerDataClient(ctx, project, instance, database)
  handler: transferHandler,
});
```

`debit`, `credit`, and `record` stand in for three parameterised DML
statements. Both snippets are shortened from
[`demo/action/action.ts`](../../demo/action/action.ts), which spells them out.

`runAction` then goes through four steps:

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

## 4. Let an agent act

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

- **An action has no `precondition` and no `affects`.** The gate is model-level:
  every constraint is checked on every action. The rows an action touched are
  used to keep each probe cheap, and they never narrow which rules apply.
- **The runtime does not dispatch to the executor.** Nothing reads an action's
  `mcp`, `rest`, or `grpc` block and calls it; the handler you pass is what
  runs. That dispatch is the seam those three would later slot into.
- **The write path is Spanner.** No other store has a gated path, because the
  gate depends on running its probes inside the same transaction as the write.
- **No `kcmd` command runs an action.** Push publishes the action and its
  constraints; running one means calling `runAction`, as `demo/action/` does.
- **Nothing outside an action checks a constraint.** Push publishes it to
  Knowledge Catalog and stops there. No `CHECK` clause, data-quality scan, or
  load-time validation is generated from a constraint.

## When an action is refused and you did not expect it

- **A row that only gains value is still checked.** A transfer into a frozen
  account is refused by `OpenAccountsOnly` even though the transfer only adds
  money, because the action touched that row and a touched row has to satisfy
  every constraint.
- **Enough money is not the rule the model states.** An account holding 18000
  with a 5000 floor refuses a transfer of 14000, and the constraint that refuses
  it is `AboveMinimumBalance`. If that is wrong, the expression is what to
  change.
- **A constraint outside the grammar refuses everything.** The action aborts
  before it writes, and the message names the constraint that could not be
  lowered. Rewrite it inside the grammar, or take it out of the model and check
  it elsewhere.
- **A pre-existing violation is not the cause.** Probes are scoped to the rows
  the action touched, so an account that was already below its floor before the
  call does not block an unrelated transfer.
