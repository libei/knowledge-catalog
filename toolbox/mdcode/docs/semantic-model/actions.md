# Modeling write operations

A semantic model says what the data means, and its metrics say what can be read
from it. An **action** is the write-side counterpart: a named operation that
changes state, declared over the same concepts as everything else in the model.

An action does not contain the write. It names the operation, types the
operation's inputs against the ontology, and says which concepts the call
changes. It also points at the **executor** that performs it — an MCP tool, a
REST endpoint, a gRPC method, or DML — which is the one physical part of an
action, and so may come from a binding profile rather than the model.
Publishing it puts the
operation in the same place as the data it acts on, so an agent that discovers
the model discovers what it can do as well as what it can ask.

## When to use it

Declare an action when your organization already has an operation that changes
the data this model describes, and you want that operation described where the
data is described. Anything reading the model then knows the operation exists,
what it takes, and where it lives.

An action does not answer a question about the data. Use a
[metric](README.md#1-author-the-logical-model) for that.

## 1. Declare the action

Actions sit at model level, beside metrics, and each one carries a name, an
executor, and its parameters:

```yaml
version: "0.2.0.dev0/google"    # `actions` is a kcmd extension key
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
          - { name: debitedId,  datatype: Integer, expression: debited_account_id }
    relationships:
      - name: TransferDebits
        from: Transfer
        to: Account
        from_columns: [debitedId]
        to_columns: [accountId]
    actions:
      - name: TransferFunds
        description: Move money from one account to another.
        executor:                             # exactly one kind: mcp / rest / grpc / sql
          mcp:
            server: //agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/payments
            tool: transfer_funds
        parameters:
          - { name: source, type: Account }   # an entity: an object reference
          - { name: target, type: Account }
          - { name: amount, type: Float }     # a scalar: an ordinary value
        ai_context:
          instructions: >-
            Resolve both accounts before calling. Name the account the money
            leaves as `source`.
```

The rest of the model — the deployment target, the entity bindings, the
relationships — is authored as it is for any model; see
[Deploying a semantic model](README.md).

The executor says where the operation lives. `mcp` (`{server, tool}`) references
a tool already registered in Agent Registry by the server's resource name plus
the tool's name within it. `rest` (`{endpoint, method}`) and `grpc`
(`{service, method}`) are the other two remote kinds. A fourth, `sql`, carries
the write itself rather than a pointer to whoever performs it — see
[Writing the statements in the model](#writing-the-statements-in-the-model).
Exactly one kind, where an executor is written at all.

`description` and `ai_context.instructions` are both carried through to the
catalog. Write the instructions for the agent that will call the action, as
above.

### The executor is a binding, and may come from a profile

Everything else an action declares is logical — what it takes, what gates it,
what it changes. The executor is not: it is *how* the change is carried out,
which depends on the store. Where the rows sit in a relational database the
write is DML; where they do not, it is a call to whoever owns them. Even two
relational stores differ, each with its own table names and dialect.

So the executor is a physical binding, like an entity's `source`, and a [binding
profile](profiles.md) may supply or replace it:

```yaml
# commerce.profiles/operational.yaml — this store owns the rows, so it writes them
semantic_model:
  - name: payments
    actions:
      - name: TransferFunds
        executor:
          sql:
            statements:
              - UPDATE account SET balance = balance - @amount WHERE account_id = @source
              - UPDATE account SET balance = balance + @amount WHERE account_id = @target
```

An action the profile does not mention keeps whatever the model declared, so the
executor written above serves as the default and a profile overrides only the
stores that perform the write differently. `executor: null` in a profile
withdraws it — a read-only binding that performs no writes at all.

Writing no executor anywhere is allowed. The action is then **declared but not
performable**: it still states what it does, what gates it, and what it changes,
which is the whole of what a reader needs, and it still publishes to the
catalog. `kcmd profiles` lists it under `cannot run:` for each binding that
supplies no executor for it.

### What an entity-typed parameter adds

A hand-written tool schema can say that an input is an integer or a string. A
parameter typed against the model says what the input *denotes*:

> **A parameter typed by an entity is an object reference.**

`{name: source, type: Account}` says the argument names an account, so a
consumer generating a tool schema knows to accept an identifier and resolve it
against `Account`'s key rather than pass a number through. A parameter typed by
a scalar datatype, such as `amount` above, is an ordinary value.

### Writing the statements in the model

The three kinds above name a system that performs the write, so what the write
does is opaque to the model: it states an `affects` list and nothing can check
that list against reality. The fourth kind, `sql`, contains the write instead.

```yaml
      - name: TransferFunds
        executor:
          sql:
            statements:
              - UPDATE Account SET balance = balance - @amount WHERE accountId = @source
              - UPDATE Account SET balance = balance + @amount WHERE accountId = @target
        parameters:
          - { name: source, type: Account }
          - { name: target, type: Account }
          - { name: amount, type: Float }
        affects:
          - { concept: Account, operation: modify, fields: [balance] }
```

Containing the write buys three things a pointer cannot:

- **The blast radius is checkable.** `affects` can be read against the
  statements rather than taken on trust.
- **A guard becomes a real gate.** An MCP, REST or gRPC call commits inside a
  system `kcmd` does not control, so a check wrapped around it is advisory. A
  statement runs in the caller's own transaction and can be rolled back.
- **The gate sees the write.** The statements run where the constraints are
  probed, so a check observes the uncommitted result of the write it is gating.

The narrowness is what makes that safe, and push enforces it:

- Each statement is a **single `INSERT`, `UPDATE` or `DELETE`**. A statement that
  reads is a query and belongs in a metric; one that reshapes the schema is not
  an action. A `;` inside a statement is rejected, because each list entry runs
  on its own and anything after the separator would silently not run.
- Every value arrives as a **bound `@parameter`** naming a parameter the action
  declares. Nothing is interpolated into the statement text, so an argument
  cannot become SQL.
- There is no control flow, and no statement composed at call time. An action
  whose body arrives with the call declares nothing, and a gate cannot check what
  was never declared.

An action that **creates** a row needs a key for it, and the key cannot come from
the caller: an agent that picks its own primary keys can overwrite an existing
row by choosing one that is already taken. Declare the creation in `affects` and
refer to the generated key as `@new<Concept>Key`:

```yaml
        executor:
          sql:
            statements:
              - >-
                INSERT INTO Transfer (transferId, amount, debitedId)
                VALUES (@newTransferKey, @amount, @source)
        affects:
          - { concept: Transfer, operation: create }
```

Nothing executes a statement yet. `kcmd` validates the statements, publishes
them to the catalog and reads them back; what runs them is the action runtime,
which lands separately.

## 2. Gate it with a constraint

A **constraint** is a named rule a model states over its ontology. Declaring one
adds it to the catalog and changes nothing by itself. A constraint takes effect
where something references it and nowhere else, so publishing a rule cannot
silently start refusing calls that succeeded yesterday.

An expression over stored data states a condition the data must satisfy:

```yaml
    constraints:
      - name: BalanceStaysPositive
        expression: Account.balance >= Account.minimumBalance
        description: >-
          An account cannot be taken below its minimum balance.
```

On its own that is a catalogued rule and no more. Nothing consults it, and no
write is refused for breaking it. It acquires effect when an action names it.

An expression that reads an action's **parameters** describes one call rather
than the stored data. The only moment it can be checked is before that call
runs:

```yaml
    constraints:
      - name: AmountIsPositive
        expression: amount > 0
        description: >-
          A transfer must move at least one unit. Ask the caller for the
          amount again before retrying.
    actions:
      - name: TransferFunds
        executor:
          mcp:
            server: //agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/payments
            tool: transfer_funds
        parameters:
          - { name: source, type: Account }
          - { name: target, type: Account }
          - { name: amount, type: Float }
        guards: [AmountIsPositive]
```

`guards` holds the names of constraints the same model declares, and it is how a
constraint acquires effect over an action. Both kinds of rule belong there. One
that reads the action's parameters has no other moment to run. One over stored
data, named as a guard, states that the call must not proceed on data that is
already broken.

Every guard is checked before the call, with the arguments bound. What each rule
reads decides how much that moment can tell you. A rule over the parameters is
settled completely there, since the arguments are the whole of what it reads. A
rule over stored data is a condition on the state a write produces, and checking
it before the call reports only that the call is not starting from a broken
state. It does not report that the call leaves a sound one. Nothing in the model
binds a rule to the result of a write, which is the gap between what a data rule
says and what a guard can enforce.

A rule meant to report rather than block is one that declares `warn`, checked at
the same moment and let through.

Whatever dispatches the call is what checks its guards. Handing a rule to the
store instead works only for some rules. A condition on a single row lowers to a
store-level `CHECK`. One that aggregates across a child table, such as an order
total matching the sum of its line items, lowers to neither Spanner nor
BigQuery.

The reference lives on the action rather than on the constraint, because the
same rule may gate `TransferFunds` and leave `CloseAccount` alone.

`guards` and `on_violation` answer different questions, and both can be set. A
guard says *when* the constraint is checked — before the write, with the
arguments bound. `on_violation` says what a breach does: `reject` refuses the
call, `escalate` holds it for an approver, `warn` reports it and lets the write
proceed. So guarding a constraint that declares `warn` is a real shape rather
than a contradiction: it is how a rule the organization is not yet ready to
block on still gets checked at the moment of the call and reported back.

### When no expression decides it

Some rules a business enforces cannot be written as a boolean. Whether a credit
memo explains the failure it claims to refund, whether a discount is justified
by the reason given — a query can read the text and cannot settle the question.
Such a rule goes in `judgment` instead of `expression`:

```yaml
    constraints:
      - name: CreditMemoNamesAServiceFailure
        judgment: >-
          LineItem.memo must name a specific, verifiable service failure on the
          order: a late delivery, a damaged item, a shipping charge applied in
          error. A memo that states only that the customer requested a credit
          does not satisfy this rule.
        description: >-
          Say what went wrong with the order in the credit memo.
        on_violation: warn
        severity: low
```

A constraint declares one body or the other, never both and never neither. A
judgment must state `on_violation`, and it may state any of the three words.
Leaving the key out is the one thing it may not do: an unmarked constraint
rejects, and that is too strong a consequence to inherit by silence.

### Writing a judgment

A language model reads the sentence at review time with the proposed write in
front of it. Five habits make that reading consistent.

**State what must be true of the data.** Write the condition — *the memo must
name a specific service failure* — rather than the procedure — *check whether
the memo is specific*. The sentence describes a clean write, and everything
about handling a breach lives elsewhere.

**Name fields model-qualified.** Write `LineItem.memo` rather than "the memo".
`kcmd` resolves every `Entity.field` token in the text against the model and
fails the push when the entity declares no such field, so a rename cannot leave
the sentence pointing at nothing. The qualified name also tells the judge
exactly which value to read.

**Say what does not count.** A rule with no negative example is graded against
whatever the model guesses the author had in mind. "A memo that states only that
the customer requested a credit does not satisfy this rule" buys more
consistency than any further description of what a good memo is.

**Leave the consequence out of the prose.** What happens on a breach is
`on_violation`. A judgment ending "…otherwise escalate to a supervisor" states a
routing nothing reads, and the engine routes by the field regardless.

**Keep it to one condition.** When the sentence needs "and also", the second
half is a second constraint. One `on_violation` cannot carry two consequences,
so two conditions that end differently cannot share a constraint.

### A policy whose rules end differently

Real policies have several rules, and the rules rarely end the same way. Take
the policy governing a customer-service credit, stated the way a business states
it:

1. a credit may not exceed the total of the order it credits;
2. a credit over 25 dollars needs a supervisor's decision;
3. an order's total always equals the sum of its line items;
4. the memo on a credit must name a specific service failure;
5. a credit must not be one larger credit split up to stay under the 25-dollar
   limit.

Five rules, three different outcomes, and two of them that no query settles. The
model has an `Order` with a `total`, a `LineItem` with an `amount` and a `memo`,
and an `IssueCredit` action taking the order, the amount and the memo. Each rule
becomes one constraint, carrying its own outcome in its own `on_violation`:

```yaml
    constraints:
      # Rules a query can compute.
      - name: CreditWithinOrderTotal              # rule 1
        expression: amount <= Order.total
        description: >-
          A credit cannot exceed the total of the order it credits. Lower the
          amount, or split it across the orders it actually covers.
        on_violation: escalate
        severity: high

      - name: CreditUnderSelfServiceLimit         # rule 2
        expression: amount <= 25
        description: >-
          A credit over 25 dollars is above the self-service limit. A
          supervisor decides it.
        on_violation: escalate
        severity: medium

      - name: OrderTotalMatchesLineItems          # rule 3
        expression: Order.total == SUM(LineItem.amount)
        description: >-
          An order's total must equal the sum of its line items, with credits
          subtracted.
        on_violation: reject
        severity: critical

      # Rules no query can compute.
      - name: CreditMemoNamesAServiceFailure      # rule 4
        judgment: >-
          LineItem.memo must name a specific, verifiable service failure on the
          order: a late delivery, a damaged item, a shipping charge applied in
          error. A memo that states only that the customer requested a credit
          does not satisfy this rule.
        description: >-
          Say what went wrong with the order in the credit memo.
        on_violation: warn
        severity: low

      - name: CreditIsNotSplitToAvoidReview       # rule 5
        judgment: >-
          A credit must not appear to be one larger credit divided into parts
          that each stay under the 25-dollar self-service limit. Read the
          proposed amount together with the other credits already on the same
          Order: several near-limit credits raised close together for related
          reasons are one credit, whatever each memo says on its own.
        description: >-
          Raise this as a single credit for the full amount and send it for
          supervisor review.
        on_violation: reject
        severity: critical

    actions:
      - name: IssueCredit
        executor:
          mcp:
            server: //agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/commerce
            tool: issue_credit
        parameters:
          - { name: order,  type: Order }
          - { name: amount, type: Decimal }
          - { name: memo,   type: String }
        guards:
          - CreditWithinOrderTotal
          - CreditUnderSelfServiceLimit
          - OrderTotalMatchesLineItems
          - CreditMemoNamesAServiceFailure
          - CreditIsNotSplitToAvoidReview
```

Reading down the `on_violation` column gives the branching that the policy
describes in prose, in a column a search can read.

**Rule 3 is named like the rest, because an unnamed rule does nothing.** It is
the one rule here that nobody in the business may approve: an order whose total
disagrees with its line items is broken rather than unusual, which is why it
says `reject`. That word buys nothing until an action names the rule. Left out
of every `guards` list it would be a rule the catalog records and no call
consults, and the strongest word in the policy would be the one with the least
effect.

Naming it makes `IssueCredit` refuse to run against an order whose books already
disagree. Catching the credit that *breaks* the agreement is a different check,
against the state the write produces, and the model cannot bind one yet. Rule 3
is the rule in this policy whose enforcement is furthest from what it says.

**Rules 4 and 5 are why the second body exists.** Neither reduces to arithmetic
over `Order` and `LineItem`, and before `judgment` they had nowhere to go but a
policy document nothing links to. Note what stays computable alongside them: the
threshold in rule 2 is arithmetic, so it remains an expression a query settles
and no model call is spent on. Folding rules 2, 4 and 5 into one paragraph of
prose, on the grounds that a model could read all three, would throw that away.

**Rule 5 is a judgment that declares `reject`.** Splitting a credit to evade
review is a rule the business means as unappealable, and no expression detects
it, so the alternative to writing it this way is leaving it out of the model.
The pairing carries a real cost, because a language model can decide two
identical credits differently and `reject` leaves nobody to appeal to. It is
published rather than forbidden, and made findable: every constraint carries a
derived `evaluation` field, which reads `judged` here, so an auditor asking
which unappealable rules a model settles gets an answer from one query.

### Two calls through that policy

A 30-dollar credit for a shipping charge billed in error, against an order
totalling 142 dollars:

```
IssueCredit(order=12345, amount=30.00,
            memo="refund of the shipping charge applied in error during the Labor Day sale")
```

Rules 1 and 3 hold: 30 is within the order, and the order's total agrees with
its line items. Rule 2 is violated, since 30 is over the self-service limit, and
its word is `escalate`. Rules 4 and 5 hold: the memo names a specific failure,
and a single credit is not a split one. One violation, so the call is held for a
supervisor, who reviews it as a credit against an order rather than as a SQL
diff.

Now three 9-dollar credits raised against the same order within the hour, each
memo reading some version of "customer asked":

```
IssueCredit(order=12345, amount=9.00, memo="customer asked")
```

Rules 1, 2 and 3 all hold — 9 is inside the order, inside the limit, and the
order's books agree — so every gate a query can compute lets this through. Rule 4 is violated and warns. Rule 5
is violated and rejects. This is the case the judged rules were added for: the
policy is being evaded precisely by staying inside the arithmetic.

When one call violates several guards, the strictest outcome applies: any
`reject` refuses the call; failing that, any `escalate` holds it; failing that,
any `warn` lets it through with the violations reported. So the first call is
held, and the second is refused with the memo warning reported alongside the
refusal.

That combination is fixed, and no part of the model states it. It is why an
action can name any number of guards without the author writing how to combine
them. It is also how `forbid` overrides `permit` in Cedar and how a deny wins in
Open Policy Agent, so a policy written this way lowers into either.

An action whose guards are *all* judged loads with a warning. Every gate then
costs a model call, none can lower to a store-level check, and each may decide
two identical calls differently. `IssueCredit` is clear of it: three of its five
guards are expressions.

**Status: nothing calls a judge.** `kcmd` parses `judgment`, validates it,
publishes it and reads it back, and publishes a derived `evaluation` field
saying whether the rule is `deterministic` or `judged` so a consumer can select
on it. No component asks a model to settle a judgment, and nothing combines
guard outcomes. The two calls above are what the published policy says should
happen, and `kcmd` publishes the fields an engine needs in order to make it
happen.

`kcmd` reports a mismatch from either side. A guard that names no constraint
fails the push. A constraint over parameters that no action names loads with a
warning, because nothing will ever evaluate it. That scan reads expressions
only: a judgment is prose, in which a word matching a parameter name is not a
read of that parameter.

**Status: nothing evaluates a guard yet.** `kcmd` parses `guards`, resolves each
name, publishes the list, and reads it back. No component checks a guard against
live data, so a guard states what must hold before the call and blocks no call.

## 3. Say what it changes

An executor is opaque. `mcp: {server, tool}` says where the operation lives and
nothing more — no reader of the model can see what that tool writes. So the blast
radius of a call is declared or it is unknown, and `affects` is where the author
declares it:

```yaml
        affects: [Account, Transfer]
```

That is the coarse form: these concepts are touched, in a way the model does not
spell out. It is enough to answer *which actions can change an account at all*,
which is already more than an executor name answers.

A record says more — which operation, and which fields the call writes:

```yaml
        affects:
          - concept: Account
            operation: modify
            fields: [balance]
          - concept: Transfer
            operation: create
          - concept: TransferDebits
            operation: create
```

The two shapes mix freely in one list, so an author can be precise about the
concepts they know and coarse about the rest. Every `concept` — bare or named
under the key — must be something the same model declares.

### One key for both kinds

`concept` names an entity or a relationship, and the model already knows which.
Asking the author to repeat it would add a second place to get it wrong and
change nothing about what the action affects. `TransferDebits` above is the edge
from the example model; it is written exactly like the two entities beside it.

### The operations

`create`, `modify`, `delete` — the same three whatever the concept is.

An edge is not only attached and detached. A many-to-many relationship is backed
by a junction table with fields of its own, so *modify the grade on an
Enrollment* is as ordinary a change as *modify an order's total*, and a
vocabulary that gave edges only `add` and `remove` could not express it.

`fields` narrows a `create` or a `modify` to the fields the call writes, which is
what makes *which actions can change `Account.balance`* answerable. A `delete`
takes the whole instance, so naming fields beside one is rejected rather than
ignored.

Both the operation and the fields are optional. `- concept: Account` on its own
says the same thing the bare `Account` does, and is written back as the bare
form.

**Status: nothing consumes `affects` yet.** `kcmd` parses it, checks every
concept against the model, publishes it and reads it back. No component computes
an impact from it, routes on it, or checks it against what the executor actually
does.

## 4. Check it before pushing

```bash
kcmd push --validate-only
```

Four things about an action can be statically wrong once the document parses,
and each one is a hard error:

```
action 'TransferFunds' in model 'payments' (payments.yaml) has parameter
'target' whose type 'BankAccount' is neither a known entity nor a scalar
datatype.

action 'TransferFunds' in model 'payments' (payments.yaml) has an mcp executor
whose 'tool' is missing or blank.

action 'TransferFunds' in model 'payments' (payments.yaml) is guarded by
'AmountIsPostive', but model 'payments' declares no constraint of that name.

action 'TransferFunds' in model 'payments' (payments.yaml) affects 'Acount',
which is neither an entity nor a relationship this model declares.
```

A parameter type that resolves to neither an entity nor a scalar means the model
cannot say what that argument denotes, which is the whole contribution an action
makes. An executor missing a coordinate cannot be dispatched by whatever picks
the action up. A guard that names no constraint — `AmountIsPostive` here, a
misspelling of the `AmountIsPositive` declared above — leaves the author
believing the write is checked when nothing checks it. An `affects` entry naming
`Acount` describes a blast radius over a concept that does not exist, so
anything reading it reads about nothing.

The rest of an entry is checked the same way and for the same reason: fields
beside a `delete`, and a field the concept does not declare, are each a hard
error too. An operation outside `create` / `modify` / `delete` never gets this
far — the vocabulary is closed, so the document does not parse at all. All of
these checks are static, so they run on every push whatever the destination.

## 5. Push it

```bash
kcmd push
```

Knowledge Catalog is the only system an action reaches. Every other push target
deploys nothing for it and warns once:

```
Warning: [payments] 1 action(s) reach Knowledge Catalog only; the BigQuery
push deploys none of them.
```

A graph-only `kcmd push --no-kc` therefore validates the actions and then warns
that they will not be deployed.

In Knowledge Catalog, each action becomes its own entry, parented to the model
entry, the same way a metric does. The entry carries one aspect holding the
executor and the typed parameters:

```yaml
# .../entryGroups/<group>/entries/payments.actions.TransferFunds
entryType: projects/<project>/locations/global/entryTypes/semantic-action
parentEntry: .../entryGroups/<group>/entries/payments
entrySource:
  displayName: TransferFunds
  description: Move money from one account to another.
aspects:
  <project>.global.semantic-action:
    executorKind: mcp
    mcpServer: //agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/payments
    mcpTool: transfer_funds
    parameters:
      - {name: source, type: Account, isEntityRef: true}
      - {name: target, type: Account, isEntityRef: true}
      - {name: amount, type: Float, isEntityRef: false}
    affects:
      - {concept: Account, operation: modify, fields: [balance]}
      - {concept: Transfer, operation: create}
      - {concept: TransferDebits, operation: create}
    instructions: Resolve both accounts before calling. Name the account the money leaves as `source`.
```

`affects` is published as the author wrote it and nothing more. Whether
`TransferDebits` is an entity or an edge is not stored: a consumer that needs to
know reads it off the model, which is the only thing that can say so correctly
after a rename.

Removing an action from the document deletes its entry on the next push, because
the model owns the `<model>.actions.` id prefix. A catalog search can list the
actions in a project by entry type, the way it lists entities or metrics.

`semantic-action` is a custom entry type, because Dataplex has no built-in type
for an action yet. `kcmd init --semantic-model` provisions the entry type and
its aspect type in your own project. Run init once before the first push of a
model that declares actions.

Publishing an action needs the permission to attach its aspect, in addition to
the permissions any push needs — see
[Reference → Permissions](reference.md#permissions).

## 6. Pull it back

```bash
kcmd pull
```

Pull collects the `semantic-action` entries under the model entry and rebuilds
each action, so a name, a description, an executor, typed parameters, its
`guards`, its `affects`, and `ai_context.instructions` survive the round trip
unchanged. What every part of a model does and does not survive is in
[What push and pull preserve](fidelity.md).

## What is not modeled yet

This is a prototype. Three things a reader reasonably expects are absent.

- **Nothing checks the write.** No component evaluates a constraint or a guard,
  so an action is a declaration and the correctness of what the executor does
  belongs to the executor.
- **`kcmd` does not call the executor.** Push publishes the action. Dispatching
  it is the job of whatever reads the model, which is why the executor names
  coordinates rather than a statement.
- **Parameter types are the whole type story.** An entity-typed parameter says
  which entity an argument denotes. Resolving a caller's `"Alice Checking"` to
  a row is left to the consumer.
