# Modeling write operations

A semantic model says what the data means, and its metrics say what can be read
from it. An **action** is the write-side counterpart: a named operation that
changes state, declared over the same concepts as everything else in the model.

An action does not contain the write. It names the operation, points at the
**executor** that performs it — an MCP tool, a REST endpoint, a gRPC method —
types the operation's inputs against the ontology, and says which concepts the
call changes. Publishing it puts the
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
Exactly one kind is required.

`description` and `ai_context.instructions` are both carried through to the
catalog. Write the instructions for the agent that will call the action, as
above.

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

A **constraint** is a named boolean invariant a model states over its ontology.
An action needs none; declare one when a rule decides whether a call may proceed
at all. Where a constraint applies depends on what its expression reads.

An expression over stored data holds for every write, whatever performed that
write. No action has to name such a constraint:

```yaml
    constraints:
      - name: BalanceStaysPositive
        expression: Account.balance >= Account.minimumBalance
        description: >-
          An account cannot be taken below its minimum balance.
```

An expression that reads an action's **parameters** describes one call rather
than the stored data. The only moment it can be checked is before that call
runs, so the action names it in `guards`:

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

`guards` holds the names of constraints the same model declares. Naming one adds
an earlier check; it does not switch enforcement on. An invariant over stored
data is in force whether or not an action names it, so `guards` exists for the
constraints that have no other moment to run. Naming an invariant over stored
data as a guard is still useful. It states that the call must not proceed on
data that is already broken, and it puts that check before the call.

The reference lives on the action rather than on the constraint, because the
same rule may gate `TransferFunds` and leave `CloseAccount` alone.

`guards` and `on_violation` answer different questions, and both can be set. A
guard says *when* the constraint is checked — before the write, with the
arguments bound. `on_violation` says what a breach does: `reject` refuses the
call, `escalate` holds it for an approver, `warn` reports it and lets the write
proceed. So guarding a constraint that declares `warn` is a real shape rather
than a contradiction: it is how a rule the organization is not yet ready to
block on still gets checked at the moment of the call and reported back.

`kcmd` reports a mismatch from either side. A guard that names no constraint
fails the push. A constraint over parameters that no action names loads with a
warning, because nothing will ever evaluate it.

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
