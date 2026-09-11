# Building the agent

Step 8 of [PIPELINE.md](PIPELINE.md) runs an agent over the model. This page
builds that agent from nothing, and reports what each part cost.

The finished file is `agent.ts`: 68 lines of code in five steps. Not one of
those lines names a credit, an order, a threshold or a table. The reason is
that an agent needs two things from a model, and a semantic model already
declares both. It needs a
way to look at what is there, which the entities and their binding profile
describe. It needs a way to change it, which the actions describe, down to the
parameter types and the rules a call is checked against.

| Step | Code | Whose work |
| --- | --- | --- |
| Imports | 6 lines | boilerplate |
| 1. Load the model | 4 lines | the same for any model |
| 2. Derive the tools | 4 lines | the same for any model |
| 3. Adapt them to ADK | 18 lines | written once per framework |
| 4. Write the persona | 13 lines | yours, and it should stay yours |
| 5. Run it | 23 lines | ADK boilerplate |

Read step 2 first if you read only one. It is where the model does the work.

## What you install

```
npm install --no-save @google/adk
```

`--no-save` keeps ADK out of the toolbox manifest, because nothing but this
demo needs it. The tool derivation itself lives in
`src/libts/semantic/agent_tools.ts` and imports no agent framework at all.

## Step 1. Load the model

```ts
const loaded = loadModels(readFileSync(modelPath, 'utf8'));
if (!loaded.models.length) throw new Error(`${modelPath} declares no model.`);
const model = loaded.models[0];
const client = dataClient();
```

In the pipeline, `modelPath` points into the workspace `kcmd init --pull`
built, so the agent reads what Knowledge Catalog gave back rather than a file
that happened to be lying next to it.

## Step 2. Derive the tools

```ts
const derived = [
  ...entityTools({model, client}),
  ...actionTools({model, client}),
];
```

Reads first and writes second, which is the order an agent needs them in: find
the object, then act on it.

For the credit model this yields four tools, `find_customer`, `find_order`,
`find_line_item` and `issue_credit`. Here is what `issue_credit` offers a
caller, verbatim, with nothing added:

```
Credit a customer against one order -- a late delivery, a coupon, a shipping
charge applied in error. The credit is added as a negative line and the order
total is recomputed from the lines.

Give the order as its number, the amount in dollars, and a memo saying why.
Look the order up first if you were given a customer rather than a number: an
Order is identified by its key alone. If the call comes back needing review, do
not retry it with a smaller amount: report the reason and wait for a decision.

This call is checked against CreditWithinOrderTotal and
CreditUnderReviewThreshold. A check that fails comes back as a refusal or as a
request for a human decision, and the reason is text you should report as
given.

  order:  string (required)
          Which Order this applies to. Give its key, or text that identifies
          exactly one; the call fails when nothing matches or more than one
          does.
  amount: number (required)
          The amount, as a decimal number.
  memo:   string (required)
          The memo, as text.
```

The prose is the author's. The first paragraph is the action's
`description`. The second is its `ai_context.instructions`, which exists so an
author can tell a caller how to call well. The third is assembled from
`guards`, so a caller learns the shape of a refusal before it meets one.

The parameter list is generated from `parameters`, and this is where the
declared types earn their keep. `order: Order` is an ontology type, so it
becomes a reference the runtime resolves, and the description says what happens
when the reference is ambiguous. `amount: Decimal` becomes a JSON number rather
than a string, so a caller cannot pass "thirty dollars".

A lookup tool is derived the same way. `find_order` returns the fields the
binding profile mapped to columns, takes one optional exact-match filter per
field, and carries the entity's own description:

```
A customer order. Its total is the sum of its line items: items, tax and fees
add, credits subtract. A positive total is money owed to the company.

Returns orderId, customerId, total, status. Every argument is an exact match
and every one is optional; giving none returns the first rows. This tool cannot
join, compare ranges, or total anything.
```

The last sentence matters as much as the rest. A tool that says what it cannot
answer gets asked questions it can.

## Step 3. Adapt them to ADK

A derived tool is a plain object: a name, a description, a list of typed
parameters, and an `invoke`. Turning that into an ADK `FunctionTool` is the
only framework-specific code in the file.

```ts
const tools = derived.map(
    tool => new FunctionTool({
      name: tool.name,
      description: tool.description,
      parameters: schemaFor(tool.parameters),
      execute: (args: Record<string, unknown>) => tool.invoke(args),
    }));

function schemaFor(params: ToolParameter[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of params) {
    const base = param.type === 'boolean' ? z.boolean() :
        param.type === 'string'          ? z.string() :
                                           z.number();
    const described = base.describe(param.description);
    shape[param.name] = param.required ? described : described.optional();
  }
  return z.object(shape);
}
```

ADK wants its parameter schema as Zod, and a derived parameter carries a JSON
type and a description, which is what a Zod field needs. Writing the same
adapter for LangChain or for an MCP server is the same shape of work against a
different schema type. This is why `agent_tools.ts` describes tools rather than
building them: supporting a framework it knows nothing about costs one adapter,
and the derivation stays untouched.

## Step 4. Write the persona

```ts
const agent = new LlmAgent({
  name: 'model_agent',
  model: process.env.DEMO_MODEL ?? 'gemini-2.5-flash',
  description: model.description ?? `Acts on the ${model.name} model.`,
  instruction:
      'You work a customer-service desk. Look things up before you act, and ' +
      'never invent an identifier. When a tool reports that a write did not ' +
      'happen, read the reason it gives and repeat it plainly; if it says a ' +
      'human has to decide, say so and stop, because you cannot approve it ' +
      'yourself. Never compute a total or a balance yourself: the tools do ' +
      'that.',
  tools,
});
```

This is the part that is yours, and the part that should stay yours. It says
what job the agent holds and how it should behave, which is a product decision
rather than a fact about the data.

Notice what it does not say. It names no rule, no threshold and no table. It
does not tell the agent that a credit over $25 needs review, because the model
says that, and saying it twice means one copy goes stale. An instruction that
restates a rule is also the weakest possible enforcement of it: a prompt is
advice, and the transaction is where the decision is made.

## Step 5. Run it

```ts
const runner = new InMemoryRunner({agent});
for await (const event of runner.runEphemeral({
             userId: 'demo',
             newMessage: {parts: [{text: prompt}]},
           })) {
  for (const part of event.content?.parts ?? []) {
    if (part.text) console.log(part.text);
    if (part.functionCall) {
      console.log(`  -> ${part.functionCall.name}(${
          JSON.stringify(part.functionCall.args)})`);
    }
    if (part.functionResponse) {
      console.log(`  <- ${JSON.stringify(part.functionResponse.response)}`);
    }
  }
}
```

Standard ADK. Printing the calls and the responses is worth the few extra
lines, because which tool the agent reached for is the thing worth watching.

## What the agent cannot do

An agent gets a tool per action, and a tool has no approval argument. That is
by construction rather than by omission: `runAction` takes an `approvals` list,
and `agent_tools.ts` never passes one. The caller that needs approving is not
the party that grants it.

So a held write comes back to the agent as something to report:

```json
{
  "applied": false,
  "reason": "A credit over $25 is above the self-service ceiling. A supervisor decides it.",
  "needsApprovalFor": ["CreditUnderReviewThreshold"],
  "whatToDo": "Report this and stop. You cannot approve it yourself, and retrying the same call changes nothing."
}
```

ADK offers its own confirmation hook, `requireConfirmation` on a
`FunctionTool`, and this agent does not use it. That gate lives in the agent
process, so it stops a well-behaved agent and nothing else. `severity:
escalate` in the model stops every caller, including the ones that never went
near an agent.

## Where the model runs out

Three limits are worth stating plainly, because each is a place the model could
carry more than it does.

**A lookup tool can only match exactly.** One optional filter per bound field,
combined with AND, capped at fifty rows. No joins, no ranges, no ordering, no
totals. That is enough to find the object an action needs, and it keeps the
generated SQL something a reader can check by eye. Answering "which customers
are owed the most this quarter" needs a query surface the model declares,
rather than a cleverer generator over this one. The model already has metrics,
and wiring those into a tool is the obvious next piece.

**An entity is resolved by its key, or by a field that reads as a name.** The
credit model's `Order` has no name field, so `order=12345` resolves and
`order="Andy Brook"` does not. The runtime is conservative here on purpose:
guessing wrong would point an action at the wrong row, which is worse than
making the caller look it up. It does mean an agent has to chain two calls, and
the action's `ai_context.instructions` says so.

**The persona is unavoidably handwritten.** Nothing in a semantic model says
what job an agent holds. That seems right rather than a gap.

## The measurement

Of the 68 lines, 8 are about this model (loading it, deriving from it), 18 are
the ADK bridge, 13 are the persona, and the rest is boilerplate.

No line of code names a credit, an order, a threshold, a table or a column. Two
lines carry anything domain-shaped at all, and both are inside the persona: the
agent is told it works a customer-service desk, and told not to compute a total
itself. That is the developer's sentence to write.

So changing the threshold in the model, pushing and pulling gives you an agent
that enforces the new one without being touched. Publishing a second action
gives it a second tool on the next run.

The derivation is covered by `tests/libts/semantic/agent_tools.test.ts`, which
checks the tool names, the assembled descriptions, the parameter types, and
what a caller is told for each outcome, including the warning that commits and
is reported anyway. None of those tests opens a database, because deriving what
an agent is offered is pure.
