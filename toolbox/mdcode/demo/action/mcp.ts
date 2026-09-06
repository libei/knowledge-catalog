// An MCP server exposing the model's action, so an agent can act through it.
//
// This is the last link: the model already says what a transfer is and what
// must stay true; the runtime already enforces that; this makes both reachable
// by a language model over stdio. Three tools, in the order an agent uses them:
// read the rules, read the state, act.
//
// The rejection path is what makes an agent loop out of a tool call. A refused
// transfer comes back as the constraint's description -- "an account cannot be
// overdrawn, transfer a smaller amount or move money from an account that holds
// enough" -- so the agent has what it needs to fix its own next call without
// anyone hard-coding the rule into its prompt.
//

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

import {listAccounts, loadModel, transferFunds} from './action';

const server = new McpServer({name: 'payments-actions', version: '0.1.0'});

server.registerTool(
    'describe_model',
    {
      description:
          'The payments semantic model: its entities, the actions that can be ' +
          'taken, and the constraints every action is checked against. Read ' +
          'this first -- the constraints are the rules a transfer has to obey.',
    },
    async () => {
      const model = loadModel();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(
              {
                name: model.name,
                description: model.description,
                entities: model.entities.map(
                    e => ({name: e.name, fields: e.fields.map(f => f.name)})),
                actions: (model.actions ?? []).map(a => ({
                                                     name: a.name,
                                                     description: a.description,
                                                     parameters: a.parameters,
                                                   })),
                constraints: model.constraints ?? [],
              },
              null, 2),
        }],
      };
    });

server.registerTool(
    'list_accounts',
    {description: 'Every account with its balance, its minimum balance, and whether it is open or frozen.'},
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify(await listAccounts(), null, 2),
      }],
    }));

server.registerTool(
    'transfer_funds',
    {
      description:
          'Move money between two accounts. Either account may be given as an ' +
          'account id or as its display name. The transfer is applied and then ' +
          'checked against the model\'s constraints before it commits: if any ' +
          'constraint would be broken the whole transfer is rolled back and the ' +
          'reason explains what to change.',
      inputSchema: {
        source: z.string().describe('The account to debit -- an id or a display name.'),
        target: z.string().describe('The account to credit -- an id or a display name.'),
        amount: z.number().describe('How much to move, in dollars.'),
      },
    },
    async ({source, target, amount}) => {
      const outcome = await transferFunds(source, target, amount);
      if (outcome.status === 'committed') {
        return {
          content: [{
            type: 'text',
            text: `Transferred ${amount} from ${source} to ${target}. ` +
                `Checked: ${outcome.checked.join(', ')}.`,
          }],
        };
      }
      // A rejection is reported as an error so the agent notices it, with the
      // constraint's own words as the message -- that text is the instruction.
      return {
        isError: true,
        content: [{type: 'text', text: outcome.message}],
      };
    });

await server.connect(new StdioServerTransport());
