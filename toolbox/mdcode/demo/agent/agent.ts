// The same tools, handed to a real agent.
//
//   bun demo/agent/agent.ts "Andy Brook was charged for expedited shipping on
//                            order 12345 by mistake. Credit him the $12."
//
// Nothing below mentions credits, orders or Spanner tables. The tools are
// derived from the model: one lookup per entity, one write per action, with
// names, descriptions, parameter types and calling guidance all taken from what
// the model declares. Point this at another model and it offers other tools.
//
// The adapter is the only framework-specific code here, and it is the same
// dozen lines for any model -- which is why nothing in src/ imports an agent
// framework. A LangChain or MCP binding would be a different dozen lines
// against the same derivation.
//
// What the agent cannot do is the point. It never writes SQL: the statements
// are in the binding profile, authored once and reviewed there. It cannot widen
// its own reach, because the tools it has are the ones the model declares. And
// it cannot talk its way past a refusal -- an action the runtime will not run
// is not offered as a callable tool at all, so there is no call for it to
// retry.

import {FunctionTool, InMemoryRunner, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {modelTools, ToolParameter} from '../../src/libts/semantic/agent_tools';

import {loadModel, openStore} from './model';

// Step 1. Load the model under its binding profile, and open the store the
// profile points at.
const model = loadModel();
const {client, project} = openStore(model);


// ADK reaches Gemini through Vertex with application-default credentials, the
// same credentials the Spanner calls use, and in the project the binding
// profile names -- so one line in one file says where this demo runs. Set
// before the agent is constructed, because the client reads them then.
process.env.GOOGLE_GENAI_USE_ENTERPRISE ??= 'true';
process.env.GOOGLE_CLOUD_PROJECT ??= project;
process.env.GOOGLE_CLOUD_LOCATION ??= 'us-central1';


// Step 2. Derive the tools. `modelTools` returns both halves with their names
// already settled against each other, which matters here: ADK registers them
// in one namespace and two tools of one name is a bug the model cannot see.
const {lookups, actions} = modelTools({model, client});

// A tool this binding cannot serve is still declared, still published, and
// still listed -- but offering it as a callable would spend a turn on a call
// that cannot succeed, and teach the agent nothing it can act on. Both halves
// answer the same question, so both are filtered the same way: an entity with
// no readable binding is as useless to offer as an action the runtime refuses.
const derived = [...lookups, ...actions].filter(tool => {
  if (tool.runnable) return true;
  console.error(`(withheld) ${tool.name}: ${tool.unavailable}`);
  return false;
});


// Step 3. Adapt each one to ADK.
const tools = derived.map(
    tool => new FunctionTool({
      name: tool.name,
      description: tool.description,
      parameters: schemaFor(tool.parameters),
      // ADK types the argument as `unknown` because a tool's schema decides its
      // shape. The schema above is always an object, so the narrowing is safe
      // and it has to be written somewhere.
      execute: (args: unknown) => tool.invoke(args as Record<string, unknown>),
    }));


// ADK takes its parameter schema as Zod, and specifically as an object schema.
// A tool parameter carries a JSON type and a description, which is exactly what
// a Zod field needs. `integer` is kept distinct from `number` because the model
// drew that line: collapsing it lets a caller send 2.5 for an Integer and lose
// a turn to a rejection the schema could have prevented. The return type is inferred rather than widened to
// `ZodTypeAny`: FunctionTool will not accept a schema that might not be an
// object, and that is a distinction worth keeping.
function schemaFor(params: ToolParameter[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of params) {
    const base = param.type === 'boolean' ? z.boolean() :
        param.type === 'string'          ? z.string() :
        param.type === 'integer'         ? z.number().int() :
                                           z.number();
    const described = base.describe(param.description);
    shape[param.name] = param.required ? described : described.optional();
  }
  return z.object(shape);
}


// Step 4. Give it a persona. This is the developer's to write, and it is the
// only part of the agent that knows what business it is in. What it says about
// rules is generic: the model supplies which rules exist and what they mean.
const agent = new LlmAgent({
  name: 'model_agent',
  model: process.env.DEMO_MODEL ?? 'gemini-2.5-flash',
  description: model.description ?? `Acts on the ${model.name} model.`,
  instruction:
      'You work a customer-service desk. Never invent an identifier: when you ' +
      'are given a name, a product or a description instead of one, find it ' +
      'with the lookup tools rather than asking for it -- that is what they ' +
      'are for, and asking wastes the customer\'s time. When a tool reports ' +
      'that a write did not happen, read the reason it gives and repeat it ' +
      'plainly; if it says a ' +
      'human has to decide, say so and stop, because you cannot approve it ' +
      'yourself. Never compute a total or a balance yourself: the tools do ' +
      'that. Finish by saying what you changed.',
  tools,
});


// Step 5. Run it, printing each tool call and each answer so the transcript
// shows which tools the agent chose and what the store said back.
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
