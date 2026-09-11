// A Google ADK agent over whatever semantic model it is pointed at.
//
//   GOOGLE_API_KEY=... bun agent.ts "Andy Brook was charged shipping on order
//                                    12345 by mistake. Credit him the $12."
//
// Nothing below mentions credits, orders or Spanner tables. The tools are
// derived from the model: one lookup tool per entity, one write tool per
// action, with names, descriptions, parameter types and calling guidance all
// taken from what the model declares. Point this at a different model and it
// offers different tools.
//
// AGENT.md walks through building this file step by step, and reports which
// parts are the model's and which are the developer's.
//
// What the agent cannot do is the point. It never writes SQL, and it has no
// way to approve anything: `approvals` is not reachable from a tool, by
// construction. Every rule is decided by the runtime inside the Spanner
// transaction, against the uncommitted rows. An agent that invents an amount
// gets a refusal it has to report; an agent that is talked into a large credit
// gets a review request it cannot grant itself.
//
// ADK has its own confirmation hook (`requireConfirmation` on a FunctionTool),
// and this demo does not use it. That gate lives in the agent process, so it
// stops a well-behaved agent and nothing else. `severity: escalate` in the
// model stops every caller, including the ones that never went near an agent.

import {readFileSync} from 'node:fs';

import {FunctionTool, InMemoryRunner, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {actionTools, entityTools, ToolParameter} from '../../src/libts/semantic/agent_tools';
import {loadModels} from '../../src/libts/semantic/loader';

import {dataClient, modelPath} from './config';


// Step 1. Load the model. In the pipeline this is the workspace `kcmd init
// --pull` built, so what the agent reads is what the catalog gave back.
const loaded = loadModels(readFileSync(modelPath, 'utf8'));
if (!loaded.models.length) throw new Error(`${modelPath} declares no model.`);
const model = loaded.models[0];
const client = dataClient();


// Step 2. Derive the tools. Reads first, then writes, which is also the order
// the agent needs them in: find the object, then act on it.
const derived = [
  ...entityTools({model, client}),
  ...actionTools({model, client}),
];


// Step 3. Adapt each one to ADK. This is the only framework-specific code in
// the file, and it is the same eight lines for any model.
const tools = derived.map(
    tool => new FunctionTool({
      name: tool.name,
      description: tool.description,
      parameters: schemaFor(tool.parameters),
      execute: (args: Record<string, unknown>) => tool.invoke(args),
    }));


// ADK takes its parameter schema as Zod. A tool parameter carries a JSON type
// and a description, which is exactly what a Zod field needs.
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


// Step 4. Give it a persona. This is the developer's to write, and it is the
// only part of the agent that knows what business it is in. Everything it says
// about rules is generic: the model supplies which rules exist and what they
// mean, and the runtime decides them.
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


// Step 5. Run it.
const prompt = process.argv.slice(2).join(' ');
if (!prompt) {
  console.error('Give the agent something to do, in quotes.');
  console.error(`Tools derived from ${model.name}: ${
      derived.map(t => t.name).join(', ')}`);
  process.exit(2);
}

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
