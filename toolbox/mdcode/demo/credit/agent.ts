// The same demo with an agent in front of it.
//
//   GOOGLE_API_KEY=... bun agent.ts "Andy Brook was charged shipping on order
//                                    12345 by mistake. Credit him the $12."
//
// The agent is a Google ADK 2.0 LlmAgent with exactly two tools, both local
// functions: one to look up orders, one to issue a credit. There is no MCP
// server and no HTTP hop -- `issue_credit` calls runAction in this process,
// which opens the Spanner transaction, checks the guards, runs the model's DML
// and commits or rolls back.
//
// What the agent is NOT allowed to do is the point. It never writes SQL. It
// supplies three values, and every rule in the model is decided inside the
// transaction, by the runtime, against the uncommitted rows. An agent that
// hallucinates an amount gets a rejection it has to report; an agent that is
// talked into a large credit gets a review request it cannot approve itself.
//
// ADK has its own confirmation hook (`requireConfirmation` on a FunctionTool),
// and this demo deliberately does not use it. That gate lives in the agent
// process, so it stops a well-behaved agent and nothing else. `severity:
// escalate` in the model stops every caller, including the ones that never went
// near an agent.

import {FunctionTool, InMemoryRunner, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {ActionOutcome, runAction} from '../../src/libts/semantic/runtime';

import {dataClient} from './config';
import {creditModel} from './model';


const model = creditModel();
const client = dataClient();

const findOrders = new FunctionTool({
  name: 'find_orders',
  description:
      'List orders with their customer, current total, and line items. Use ' +
      'this to find the order number and check what is on it before issuing ' +
      'a credit.',
  parameters: z.object({
    customer: z.string().describe(
        'Part of a customer name or email to filter by; empty for all.'),
  }),
  async execute({customer}) {
    return await query(
        `SELECT CAST(o.order_id AS STRING), c.name, c.email,
                CAST(o.total AS STRING), li.type, CAST(li.amount AS STRING),
                li.memo
         FROM Orders o
         JOIN Customer c ON c.customer_id = o.customer_id
         LEFT JOIN LineItem li ON li.order_id = o.order_id
         WHERE @customer = '' OR LOWER(c.name) LIKE LOWER('%' || @customer || '%')
            OR LOWER(c.email) LIKE LOWER('%' || @customer || '%')
         ORDER BY o.order_id, li.line_item_id`,
        {customer});
  },
});

const issueCredit = new FunctionTool({
  name: 'issue_credit',
  description:
      'Credit a customer against one order. The order may be given as its ' +
      'number or as the customer name. The credit is added as a line and the ' +
      'order total is recomputed; you do not compute the new total yourself. ' +
      'The call may come back needing a supervisor decision, in which case ' +
      'report the reason and stop.',
  parameters: z.object({
    order: z.string().describe('The order number, e.g. "12345".'),
    amount: z.string().describe('The credit in dollars, e.g. "12.00".'),
    memo: z.string().describe('Why the credit is being issued.'),
  }),
  async execute({order, amount, memo}) {
    const outcome = await runAction({
      model,
      actionName: 'IssueCredit',
      args: {order, amount, memo},
      client,
    });
    return summarize(outcome);
  },
});


// What the agent is told about an outcome. A rejection and an escalation read
// differently on purpose: one is something to fix and retry, the other is
// something to report and stop. Neither leaves the agent an approval to grant.
function summarize(outcome: ActionOutcome): Record<string, unknown> {
  switch (outcome.status) {
    case 'committed':
      return {
        applied: true,
        at: outcome.commitTimestamp,
        rulesChecked: outcome.checked,
      };
    case 'escalated':
      return {
        applied: false,
        needsSupervisorDecision: outcome.approvalRequired,
        reason: outcome.message,
        whatToDo:
            'Report this to the customer-service supervisor. Do not retry ' +
            'with a smaller amount unless the customer asked for one.',
      };
    case 'rejected':
      return {
        applied: false,
        ruleBroken: outcome.violations.map(v => v.constraint),
        reason: outcome.message,
      };
    case 'error':
      return {applied: false, error: outcome.message};
  }
}


async function query(
    sql: string, params: Record<string, string>): Promise<string[][]> {
  return await client.withSession(async sessionName => {
    const paramTypes = Object.fromEntries(
        Object.keys(params).map(k => [k, {code: 'STRING'}]));
    const res =
        await client.executeQuery(sessionName, {sql, params, paramTypes});
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${res.message ?? res.status}`);
    }
    return res.result?.rows ?? [];
  });
}


const agent = new LlmAgent({
  name: 'credit_desk',
  model: process.env.DEMO_MODEL ?? 'gemini-2.5-flash',
  description: 'Issues customer credits against orders.',
  instruction:
      'You work the customer-service credit desk. Find the order the ' +
      'customer means, then issue the credit with issue_credit. Never ' +
      'invent an order number: look it up. Never compute a new order total: ' +
      'the tool does that. If the tool says a supervisor decision is needed, ' +
      'say so plainly and stop -- you cannot approve it yourself.',
  tools: [findOrders, issueCredit],
});


const prompt = process.argv.slice(2).join(' ');
if (!prompt) {
  console.error('Give the agent something to do, in quotes.');
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
