// The tools an agent gets from this model, and a way to call one by hand.
//
// There is no language model in this file. Everything an agent would be handed
// is derived here and printed, and any of it can be invoked directly -- so the
// question "what does the model actually offer, and does calling it work" has
// an answer that does not depend on an API key or on what an LLM decided to do
// that turn. agent.ts is the same tools wired to a real agent.
//
//   bun demo/agent/tools.ts                     what the model offers
//   bun demo/agent/tools.ts --guarded           what attaching a guard changes
//   bun demo/agent/tools.ts find_customer --name='Andy Brook'
//   bun demo/agent/tools.ts find_order --customerId=1
//   bun demo/agent/tools.ts issue_credit --order=12345 --amount=12.50 \
//       --memo='Late delivery'

import {ActionTool, EntityTool, modelTools} from '../../src/libts/semantic/agent_tools';
import {SemanticModel} from '../../src/libts/semantic/ir';

import {loadModel, openStore, profileName} from './model';

async function main(argv: string[]): Promise<number> {
  const guarded = argv.includes('--guarded');
  const positional = argv.filter(a => !a.startsWith('--'));
  const flags = parseFlags(argv.filter(a => a.startsWith('--')));

  let model = loadModel();
  if (guarded) model = withGuard(model, 'CreditUnderReviewThreshold');
  const {client, database} = openStore(model);
  const {lookups, actions} = modelTools({model, client});

  if (!positional.length) {
    console.log(`model '${model.name}' under profile '${profileName}', ` +
                `bound to ${database}\n`);
    for (const tool of actions) printAction(tool);
    for (const tool of lookups) printLookup(tool);
    console.log(
        guarded ?
            'A guarded action is offered and marked unrunnable, not hidden: ' +
                'the model still declares it, and an adapter that binds only ' +
                'the runnable ones leaves it out of the turn.' :
            'Pass --guarded to see what naming a constraint in `guards` does ' +
                'to this listing today.');
    return 0;
  }

  const [name] = positional;
  const action = actions.find(t => t.name === name);
  const lookup = lookups.find(t => t.name === name);
  if (!action && !lookup) {
    console.error(`No tool called '${name}'. This model offers ${
        [...actions, ...lookups].map(t => t.name).join(', ')}.`);
    return 2;
  }

  if (lookup) {
    const rows = await lookup.invoke(flags);
    if (rows.problem) {
      console.error(rows.problem);
      return 1;
    }
    console.log(rows.fields.join('\t'));
    for (const row of rows.rows) console.log(row.join('\t'));
    if (rows.truncated) console.log('... (more rows than the cap)');
    return 0;
  }

  const result = await action!.invoke(flags);
  console.log(JSON.stringify(result, null, 2));
  // An unknown outcome is not a success and not a failure: something has to
  // establish what happened before anything retries. Exiting 0 would invite a
  // script to move on; exiting 1 would invite it to try again.
  if (result.unknown) return 3;
  return result.applied ? 0 : 1;
}


function printAction(tool: ActionTool): void {
  console.log(`action  ${tool.name}  (${tool.actionName})`);
  console.log(indent(tool.description));
  for (const p of tool.parameters) {
    console.log(`    ${p.name}: ${p.type}${p.required ? '' : '?'}  -- ${
        p.description}`);
  }
  if (!tool.runnable) console.log(indent(`NOT RUNNABLE: ${tool.unavailable}`));
  console.log();
}


function printLookup(tool: EntityTool): void {
  console.log(`lookup  ${tool.name}  (${tool.entityName})`);
  console.log(indent(tool.description));
  console.log(`    filters: ${tool.parameters.map(p => p.name).join(', ')}`);
  console.log();
}


function indent(text: string): string {
  return text.trim()
      .split('\n')
      .map(line => line.trim() ? `    ${line.trim()}` : '')
      .join('\n');
}


// `--order=12345 --memo='Late delivery'`. Values stay strings: every tool
// parameter is typed by the model, and the runtime parses the text against
// that type rather than trusting whatever a shell or a JSON parser guessed.
function parseFlags(args: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) {
    if (arg === '--guarded') continue;
    const eq = arg.indexOf('=');
    if (eq < 0) continue;
    out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}


// Attaches a guard the model declares but does not reference, so the listing
// shows what that costs today. Done here rather than in the .yaml because the
// interesting thing is the difference between the two listings.
function withGuard(model: SemanticModel, constraint: string): SemanticModel {
  return {
    ...model,
    actions: (model.actions ?? []).map(a => ({...a, guards: [constraint]})),
  };
}


process.exitCode = await main(process.argv.slice(2));
