// The demo agent, in full. There is no second file.
//
//   bun agent.ts "Find the order for Andy Brook (andybrook@gmail.com) that
//                 was placed on Labor Day. It was supposed to get free
//                 shipping but we had a glitch and the customer got charged.
//                 Please issue them a credit to offset the charge."
//
// Nothing here mentions credits, orders, Spanner tables or customer service.
// Four steps: open the workspace, derive the tools, adapt them to the
// framework, run. Point it at another semantic model and it is another agent,
// with no edit to this file.
//
// That is the property the file exists to test. Every line below is either the
// framework's own API or a short bridge between the framework's shape and the
// derivation's -- and the moment something about this business has to be
// written here, the model was missing it and the fix belongs there. An agent
// is replaced when the framework changes; the model is not.

import {FunctionTool, InMemoryRunner, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {modelTools, ToolParameter} from '../../src/libts/semantic/agent_tools';
import {openWorkspace, spannerStore} from '../../src/libts/semantic/workspace';

// Step 1. Open the workspace exactly as `kcmd` opens it: same directory, same
// default profile, same merge, same warnings. `kcmd action list` and this agent
// read one set of files, so neither can be right about the model while the
// other is wrong.
const opened = await openWorkspace({path: import.meta.dir});
if ('error' in opened) throw new Error(opened.error);
const [{model}] = opened.models;

// Where the model says it lives. The agent never names a database.
const store = spannerStore(model);
if ('error' in store) throw new Error(store.error);

// ADK reaches Gemini through Vertex with application-default credentials, the
// same credentials the Spanner calls use, in the project the binding profile
// names -- so one line in one file says where this demo runs. Set before the
// agent is constructed, because the client reads them then.
process.env.GOOGLE_GENAI_USE_ENTERPRISE ??= 'true';
process.env.GOOGLE_CLOUD_PROJECT ??= store.project;
process.env.GOOGLE_CLOUD_LOCATION ??= 'us-central1';


// Step 2. Derive the tools and what to say about them. `kcmd agent tools`
// prints exactly this, which is how the derivation can be read before any
// language model is involved.
const {lookups, actions, instruction} =
    modelTools({model, client: store.client});

// A tool this binding cannot serve is still declared, still published and still
// listed -- but offering it as callable would spend a turn on a call that
// cannot succeed, and teach the agent nothing it can act on. Both halves answer
// the same question, so both are filtered the same way.
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
      // shape. The schema below is always an object, so the narrowing is safe
      // and it has to be written somewhere.
      execute: (args: unknown) => tool.invoke(args as Record<string, unknown>),
    }));


// ADK takes its parameter schema as Zod, and specifically as an object schema.
// A tool parameter carries a JSON type and a description, which is exactly what
// a Zod field needs. `integer` is kept distinct from `number` because the model
// drew that line: collapsing it lets a caller send 2.5 for an Integer and lose
// a turn to a rejection the schema could have prevented. The return type is
// inferred rather than widened to `ZodTypeAny`: FunctionTool will not accept a
// schema that might not be an object, and that is a distinction worth keeping.
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


// Step 4. Run it, printing each tool call and each answer so the transcript
// shows which tools the agent chose and what the store said back.
//
// The instruction is the model's, not this file's. What this business asks of
// anything acting on it is in `ai_context` in commerce.yaml, and how to use a
// derived tool comes from the derivation -- so there is no prompt here to
// review, and none to drift out of step with the model it describes.
//
// The one thing added to it is today's date. A request says "Labor Day" and a
// filter wants 2026-09-07; resolving one to the other needs a calendar, which
// a language model has, and a clock, which it does not. That is a fact about
// when this agent is running, not about commerce, so the model is the wrong
// place to write it and this is the right one. Without it the agent guesses a
// year or stops to ask, and both waste the turn the instruction is trying to
// save.
const agent = new LlmAgent({
  name: 'model_agent',
  model: process.env.DEMO_MODEL ?? 'gemini-2.5-flash',
  description: model.description ?? `Acts on the ${model.name} model.`,
  instruction: `${instruction}\n\nToday is ${
      new Date().toISOString().slice(0, 10)}.`,
  tools,
});

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
