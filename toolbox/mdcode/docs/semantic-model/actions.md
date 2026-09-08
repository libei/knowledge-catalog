# Modeling write operations

A semantic model says what the data means, and its metrics say what can be read
from it. An **action** is the write-side counterpart: a named operation that
changes state, declared over the same concepts as everything else in the model.

An action does not contain the write. It names the operation, points at the
**executor** that performs it — an MCP tool, a REST endpoint, a gRPC method —
and types the operation's inputs against the ontology. Publishing it puts the
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
    actions:
      - name: TransferFunds
        description: Move money from one account to another.
        executor:                             # exactly one kind: mcp / rest / grpc
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
(`{service, method}`) are the other kinds, and exactly one kind is required.

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

`kcmd` reports a mismatch from either side. A guard that names no constraint
fails the push. A constraint over parameters that no action names loads with a
warning, because nothing will ever evaluate it.

**Status: nothing evaluates a guard yet.** `kcmd` parses `guards`, resolves each
name, publishes the list, and reads it back. No component checks a guard against
live data, so a guard states what must hold before the call and blocks no call.

## 3. Check it before pushing

```bash
kcmd push --validate-only
```

Three things about an action can be statically wrong once the document parses,
and each one is a hard error:

```
action 'TransferFunds' in model 'payments' (payments.yaml) has parameter
'target' whose type 'BankAccount' is neither a known entity nor a scalar
datatype.

action 'TransferFunds' in model 'payments' (payments.yaml) has an mcp executor
whose 'tool' is missing or blank.

action 'TransferFunds' in model 'payments' (payments.yaml) is guarded by
'AmountIsPostive', but model 'payments' declares no constraint of that name.
```

A parameter type that resolves to neither an entity nor a scalar means the model
cannot say what that argument denotes, which is the whole contribution an action
makes. An executor missing a coordinate cannot be dispatched by whatever picks
the action up. A guard that names no constraint — `AmountIsPostive` here, a
misspelling of the `AmountIsPositive` declared above — leaves the author
believing the write is checked when nothing checks it. All three checks are
static, so they run on every push whatever the destination.

## 4. Push it

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
    instructions: Resolve both accounts before calling. Name the account the money leaves as `source`.
```

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

## 5. Pull it back

```bash
kcmd pull
```

Pull collects the `semantic-action` entries under the model entry and rebuilds
each action, so a name, a description, an executor, typed parameters, its
`guards`, and `ai_context.instructions` survive the round trip unchanged. What
every part of a model does and does not survive is in
[What push and pull preserve](fidelity.md).

## What is not modeled yet

This is a prototype. Four things a reader reasonably expects are absent.

- **An action declares no effects.** `affects` — what the call changes — is out
  of scope here. What must hold *before* the call is modeled: a constraint the
  action names in [`guards`](#2-gate-it-with-a-constraint).
- **Nothing checks the write.** No component evaluates a constraint or a guard,
  so an action is a declaration and the correctness of what the executor does
  belongs to the executor.
- **`kcmd` does not call the executor.** Push publishes the action. Dispatching
  it is the job of whatever reads the model, which is why the executor names
  coordinates rather than a statement.
- **Parameter types are the whole type story.** An entity-typed parameter says
  which entity an argument denotes. Resolving a caller's `"Alice Checking"` to
  a row is left to the consumer.
