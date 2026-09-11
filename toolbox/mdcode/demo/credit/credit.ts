// The credit-flow demo: one declared action, three rules, against a live store.
//
//   demo/credit/seed.sh                                 seed the tables
//   bun credit.ts --list                                what is in there
//   bun credit.ts --order 12345 --amount 30 --memo "…"  escalates (rule 2)
//   bun credit.ts --order 12345 --amount 30 --memo "…" \
//     --approve CreditUnderReviewThreshold              commits
//   bun credit.ts --order 12347 --amount 10 --memo "…"  commits, no review
//   bun credit.ts --order 12345 --amount 30 --memo "…" --by-hand
//                                                       rejected (rule 3)
//   bun cleanup.ts                                      remove it
//
// `--by-hand` is the comparison the whole exercise is about. It runs the same
// action through a handler that writes the credit line and forgets to recompute
// the total -- which is what an agent emitting its own SQL can do -- and rule 3
// rejects it. Without `--by-hand` the write comes from the model's own DML, and
// rule 3 has nothing to catch.

import {
  ActionOutcome,
  ActionPlan,
  runAction,
  Violation,
} from '../../src/libts/semantic/runtime';

import {dataClient} from './config';
import {readFileSync} from 'node:fs';

import {loadModels} from '../../src/libts/semantic/loader';


interface Args {
  list: boolean;
  byHand: boolean;
  order?: string;
  amount?: string;
  memo?: string;
  approve: string[];
}


function parseArgs(argv: string[]): Args {
  const args: Args = {list: false, byHand: false, approve: []};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--list': args.list = true; break;
      case '--by-hand': args.byHand = true; break;
      case '--order': args.order = value(); break;
      case '--amount': args.amount = value(); break;
      case '--memo': args.memo = value(); break;
      case '--approve': args.approve.push(value()); break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  return args;
}


const args = parseArgs(process.argv.slice(2));
const model = loadModels(readFileSync(modelPath, 'utf8')).models[0];
const client = dataClient();

if (args.list) {
  await list();
} else if (args.order === undefined || args.amount === undefined) {
  console.error('Give --order and --amount (and a --memo), or --list.');
  process.exit(2);
} else {
  await issue(args.order, args.amount, args.memo ?? '');
}


// The pre-state, so the reader can see what the rules are about before tripping
// one of them.
async function list(): Promise<void> {
  const rows = await read(`
    SELECT o.order_id, c.name, c.email, CAST(o.total AS STRING),
           CAST(COALESCE((SELECT SUM(li.amount) FROM LineItem li
                          WHERE li.order_id = o.order_id), 0) AS STRING),
           CAST((SELECT COUNT(*) FROM LineItem li
                 WHERE li.order_id = o.order_id) AS STRING)
    FROM Orders o JOIN Customer c ON c.customer_id = o.customer_id
    ORDER BY o.order_id`);
  console.log('order    customer                                total  lines  sum of lines');
  for (const [id, name, email, total, sum, lines] of rows) {
    const who = `${name} (${email})`;
    console.log(`#${id}  ${who.padEnd(36)} ${money(total).padStart(8)}  ${
        lines.padStart(5)}  ${money(sum).padStart(12)}`);
  }
}


// Spanner returns NUMERIC as a decimal string with no trailing zeros, so an
// order of exactly eighteen dollars comes back as "18". Money reads as money.
function money(value: string): string {
  return `$${Number(value).toFixed(2)}`;
}


async function issue(
    order: string, amount: string, memo: string): Promise<void> {
  const outcome = await runAction({
    model,
    actionName: 'IssueCredit',
    args: {order, amount, memo},
    client,
    approvals: args.approve,
    handler: args.byHand ? byHand : undefined,
  });
  await report(outcome, order, amount, memo);
  if (outcome.status === 'error') process.exit(1);
}


// The illustration's path: the caller writes the SQL. This one adds the credit
// line and does not recompute the order total -- the single omission rule 3
// exists to catch. Everything else about the run is identical, which is what
// makes the comparison worth printing.
async function byHand(): Promise<ActionPlan> {
  const id = `li-hand-${Date.now()}`;
  return {
    statements: [{
      sql: `INSERT INTO LineItem (line_item_id, order_id, type, amount, memo)
            VALUES (@id, @order, 'credit', -@amount, @memo)`,
      params: {
        id,
        order: args.order,
        amount: args.amount,
        memo: args.memo ?? '',
      },
      paramTypes: {
        id: {code: 'STRING'},
        order: {code: 'INT64'},
        amount: {code: 'NUMERIC'},
        memo: {code: 'STRING'},
      },
    }],
    touched: {LineItem: [id], Order: [args.order!]},
  };
}


// The review card from the design: business facts, not a SQL diff.
async function report(
    outcome: ActionOutcome, order: string, amount: string,
    memo: string): Promise<void> {
  const who = await customerOf(order);
  const action = (model.actions ?? []).find(a => a.name === 'IssueCredit')!;
  const affects = (action.affects ?? [])
                      .map(a => `${a.concept}${
                          a.fields?.length ? '.' + a.fields.join('/') : ''} (${
                          a.operation})`)
                      .join(', ');

  console.log();
  console.log(`IssueCredit          order #${order}${who ? ` -- ${who}` : ''}`);
  console.log(`  amount             $${amount}`);
  console.log(`  memo               ${memo}`);
  console.log(`  affects            ${affects}`);
  if (args.byHand) {
    console.log(`  executor           a hand-written statement from the caller`);
  }

  switch (outcome.status) {
    case 'committed':
      console.log(`  checked            ${outcome.checked.join(', ')}`);
      for (const w of outcome.warnings) {
        console.log(`  warning            ${w.constraint}`);
      }
      console.log(`  APPLIED            at ${outcome.commitTimestamp}`);
      console.log();
      await list();
      return;
    case 'escalated':
      for (const v of outcome.violations) printRule('rule not met', v);
      console.log(`  NEEDS A DECISION   re-run with ${
          outcome.approvalRequired.map(n => `--approve ${n}`).join(' ')}`);
      return;
    case 'rejected':
      for (const v of outcome.violations) printRule('REJECTED', v);
      console.log(`  no review offered  an invariant is not a policy`);
      return;
    case 'error':
      console.log(`  ERROR              ${outcome.message}`);
      return;
  }
}


function printRule(label: string, v: Violation): void {
  console.log(`  ${label.padEnd(18)} ${v.constraint}`);
  for (const line of wrap(description(v.constraint), 58)) {
    console.log(`                     ${line}`);
  }
}


function description(name: string): string {
  const c = (model.constraints ?? []).find(c => c.name === name);
  return `"${(c?.description ?? name).replace(/\s+/g, ' ').trim()}"`;
}


function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = '';
    }
    line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}


async function customerOf(order: string): Promise<string> {
  const rows = await read(
      `SELECT c.name, c.email FROM Orders o
       JOIN Customer c ON c.customer_id = o.customer_id
       WHERE CAST(o.order_id AS STRING) = @order`,
      {order});
  if (!rows.length) return '';
  return `${rows[0][0]} (${rows[0][1]})`;
}


// A plain read, outside any action. Used only to show the state.
async function read(
    sql: string, params?: Record<string, string>): Promise<string[][]> {
  return await client.withSession(async sessionName => {
    const paramTypes = Object.fromEntries(
        Object.keys(params ?? {}).map(k => [k, {code: 'STRING'}]));
    const res =
        await client.executeQuery(sessionName, {sql, params, paramTypes});
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${res.message ?? res.status} (while running: ${sql})`);
    }
    return res.result?.rows ?? [];
  });
}
