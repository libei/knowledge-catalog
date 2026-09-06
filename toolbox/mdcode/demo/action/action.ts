// The TransferFunds action: the model it comes from, the write it performs, and
// a one-call entry point the CLI and the MCP server both use.
//
// The division of labour is the interesting part. The model supplies the
// action's shape (two object references and an amount) and the constraints. The
// runtime supplies resolution, the transaction, the gate, and the decision. What
// is left -- the actual SQL that moves the money -- is here, in the handler,
// because an action declares an executor rather than a statement. In a
// production system the handler is whatever the executor points at; in this
// demo it is fifteen lines of DML, so the gate has something real to gate.
//

import {readFileSync} from 'node:fs';

import {loadModels} from '../../src/libts/semantic/loader';
import {SemanticModel} from '../../src/libts/semantic/ir';
import {
  ActionContext,
  ActionOutcome,
  ActionPlan,
  runAction,
} from '../../src/libts/semantic/runtime';

import {dataClient, modelPath} from './config';


export const ACTION_NAME = 'TransferFunds';


// Parsed once per process: the MCP server calls this on every tool invocation,
// and re-reading the file each time would repeat any load warning on every call.
let cached: SemanticModel|undefined;

export function loadModel(): SemanticModel {
  if (cached) return cached;
  // The model's expressions are written in the portable ANSI_SQL dialect, which
  // Spanner accepts; saying so keeps the loader from noting that it fell back
  // from its BigQuery default.
  const {models, warnings} =
      loadModels(readFileSync(modelPath, 'utf8'), {dialect: 'ANSI_SQL'});
  for (const w of warnings) console.warn(`Model warning: ${w}`);
  if (!models.length) throw new Error(`No semantic model in ${modelPath}`);
  cached = models[0];
  return cached;
}


// Debit, credit, and record. `touched` names the rows the statements changed so
// the constraint probes only look at those -- the accounts on either end of the
// transfer and the transfer row itself.
async function transferHandler(ctx: ActionContext): Promise<ActionPlan> {
  const source = ctx.refs.source.keys[0];
  const target = ctx.refs.target.keys[0];
  const amount = Number(ctx.args.amount);
  if (!Number.isFinite(amount)) {
    throw new Error(`'${ctx.args.amount}' is not an amount.`);
  }
  if (source === target) {
    throw new Error('The source and target accounts are the same.');
  }
  const transferId = `${Date.now()}`;

  const money = {
    params: {amount, source, target},
    paramTypes: {
      amount: {code: 'FLOAT64'},
      source: {code: 'STRING'},
      target: {code: 'STRING'},
    },
  };

  return {
    statements: [
      {
        sql: 'UPDATE Account SET balance = balance - @amount ' +
            'WHERE CAST(account_id AS STRING) = @source',
        ...money,
      },
      {
        sql: 'UPDATE Account SET balance = balance + @amount ' +
            'WHERE CAST(account_id AS STRING) = @target',
        ...money,
      },
      {
        sql: 'INSERT INTO Transfer ' +
            '(transfer_id, source_account_id, target_account_id, amount) ' +
            'VALUES (@transferId, CAST(@source AS INT64), ' +
            'CAST(@target AS INT64), @amount)',
        params: {...money.params, transferId},
        paramTypes: {...money.paramTypes, transferId: {code: 'INT64'}},
      },
    ],
    touched: {Account: [source, target], Transfer: [transferId]},
  };
}


// Runs one transfer. `source` and `target` are whatever the caller has -- an
// account id or a display name; the runtime resolves either to the same row.
export async function transferFunds(
    source: string, target: string, amount: number): Promise<ActionOutcome> {
  return await runAction({
    model: loadModel(),
    actionName: ACTION_NAME,
    args: {source, target, amount},
    client: dataClient(),
    handler: transferHandler,
  });
}


// The accounts as they stand, for orienting a caller before it acts. Read-only
// and outside any action, so it uses a throwaway transaction it never commits.
export async function listAccounts(): Promise<
    Array<{id: string; name: string; balance: string; floor: string; status: string}>> {
  const client = dataClient();
  return await client.withSession(async sessionName => {
    const begun = await client.beginReadWrite(sessionName);
    const transactionId = begun.result?.id;
    if (!transactionId) throw new Error(`Could not read accounts: ${begun.message}`);
    const res = await client.executeSql(sessionName, transactionId, {
      sql: 'SELECT CAST(account_id AS STRING), name, CAST(balance AS STRING), ' +
          'CAST(minimum_balance AS STRING), status FROM Account ORDER BY account_id',
    });
    await client.rollback(sessionName, transactionId);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Could not read accounts: ${res.message}`);
    }
    return (res.result?.rows ?? []).map(
        r => ({id: r[0], name: r[1], balance: r[2], floor: r[3], status: r[4]}));
  });
}
