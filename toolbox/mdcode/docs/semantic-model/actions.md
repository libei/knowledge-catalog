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

Do not declare an action for a question about the data; that is a
[metric](README.md#1-author-a-model). Do not expect an action to run: `kcmd`
publishes the declaration and never calls the executor. What each caller has to
supply is covered in [What is not modeled yet](#what-is-not-modeled-yet).

## The one thing the model adds

A hand-written tool schema can already say that an input is an integer or a
string. Only a model that knows the ontology can say what an input *denotes*:

> **A parameter typed by an entity is an object reference.**

`{name: source, type: Account}` says the argument names an account. The loader
resolves `Account` against the model's entities and marks the parameter as an
entity reference, so a consumer generating a tool schema knows to accept an
identifier and resolve it against `Account`'s key rather than pass a number
through. A parameter typed by a scalar datatype is an ordinary value.

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
          - { name: accountId, datatype: Integer, expression: account_id }
          - { name: name,      datatype: String,  expression: name }
          - { name: balance,   datatype: Float,   expression: balance }
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
Naming two is a parse error: `executor requires exactly one kind, but 2 given
(mcp, rest)`.

`description` and `ai_context.instructions` are both carried through to the
catalog. Write the instructions for the agent that will call the action, as
above.

## 2. Check it before pushing

```bash
kcmd push --validate-only
```

Two things about an action can be statically wrong once the document parses, and
both are hard errors:

```
action 'TransferFunds' in model 'payments' (payments.yaml) has parameter
'target' whose type 'BankAccount' is neither a known entity nor a scalar
datatype.

action 'TransferFunds' in model 'payments' (payments.yaml) has an mcp executor
missing its 'tool'.
```

A parameter type that resolves to neither an entity nor a scalar means the model
cannot say what that argument denotes, which is the whole contribution an action
makes. An executor missing a coordinate cannot be dispatched by whatever picks
the action up. Both checks are static, so they run on every push whatever the
destination.

## 3. Push it

```bash
kcmd push
```

An action has no graph construct. It is write-side, and a property graph is a
read surface, so the push emits no node, edge, or measure for it and warns once:

```
model 'payments': 1 action(s) published to the model's overview aspect
(actions have no BigQuery Graph representation).
```

Knowledge Catalog is where actions land. They have no `semantic-*` system type
of their own, so they ride the model anchor's built-in `overview` aspect: a
Markdown section for a person reading the catalog, followed by a JSON block that
a pull reads back. For the model above, the aspect holds:

````markdown
## Actions

Write operations defined on this model -- the write-side counterpart to
metrics. Actions have no BigQuery Graph representation; they are published here
for discovery and are round-tripped by `kcmd pull`.

### TransferFunds

Move money from one account to another.

- Executor: MCP tool `transfer_funds` on server `//agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/payments`
- Parameters:
  - `source`: Account (entity reference)
  - `target`: Account (entity reference)
  - `amount`: Float

<!-- kcmd:actions v1 -->
```json
[ … the same actions, verbatim, as the canonical copy … ]
```
````

Because that leg is the only destination an action has, a graph-only push has
nowhere to put one. `kcmd push --no-kc` validates the actions and then warns
that they will not be deployed.

Writing the overview needs `dataplex.entryGroups.useOverviewAspect` on the
destination entry group, in addition to the permissions any push needs — see
[Reference → Permissions](reference.md#permissions).

## 4. Pull it back

```bash
kcmd pull
```

Pull reads the JSON block after the `<!-- kcmd:actions v1 -->` marker and
rebuilds each action, so a name, a description, an executor, and typed
parameters survive the round trip unchanged. The Markdown above the marker is
for people; the JSON is the canonical copy. What every part of a model does and
does not survive is in
[What push and pull preserve](fidelity.md).

## What is not modeled yet

This is a prototype. Four things a reader reasonably expects are absent, and
knowing which they are decides how much you can lean on it.

- **An action declares no precondition and no effects.** `precondition` (what
  has to hold before the call) and `affects` (what the call changes) are out of
  scope here. A separate change adds model-level **constraints** and a runtime
  that checks them against a write before it commits.
- **Nothing checks the write.** Until that change lands, an action is a
  declaration, and the correctness of what the executor does is the executor's
  business.
- **`kcmd` does not call the executor.** Push publishes the action. Dispatching
  it is the job of whatever reads the model, which is why the executor names
  coordinates rather than a statement.
- **Parameter types are the whole type story.** An entity-typed parameter says
  which entity an argument denotes. Resolving a caller's `"Alice Checking"` to
  a row is left to the consumer.
