// The semantic runtime against real Cloud Spanner.
//
// tests/libts/semantic/runtime.test.ts drives runAction() through a FakeSpanner
// whose answers are programmed by the test. That is the right way to pin the
// runtime's SEQUENCING -- that the probe runs after the write, that a violation
// rolls back, that an unevaluable constraint never opens a transaction -- and
// it can assert things a live test cannot, such as which calls were made in
// which order.
//
// What it cannot do is establish that the sequencing produces the intended
// EFFECT, because the fake has no transaction. "Rolled back" against a fake
// means `rollback` was called. Against Spanner it means the money is still in
// the account it started in, and that is the claim the feature actually makes.
// Each test below therefore ends by reading the committed state back.
//

import {afterAll, beforeEach, describe, expect, test} from 'bun:test';

import {SemanticModel} from '../../src/libts/semantic/ir';
import {loadModels} from '../../src/libts/semantic/loader';
import {
  ActionContext,
  ActionOutcome,
  ActionPlan,
  runAction,
} from '../../src/libts/semantic/runtime';

import {
  balances,
  dataClient,
  LIVE,
  readCommitted,
  readModelYaml,
  reseed,
} from './live';


let model: SemanticModel;

// Transfer ids have to be unique across a run, and several tests commit.
let nextTransferId = 5000;

// The demo's handler, kept here rather than imported so the live suite does not
// depend on the demo's configuration (which points at the demo's own database).
async function transferHandler(ctx: ActionContext): Promise<ActionPlan> {
  const source = ctx.refs.source.keys[0];
  const target = ctx.refs.target.keys[0];
  const amount = Number(ctx.args.amount);
  if (!Number.isFinite(amount)) {
    throw new Error(`'${ctx.args.amount}' is not an amount.`);
  }
  const transferId = `${nextTransferId++}`;
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

function transfer(
    source: string, target: string, amount: number,
    over: Partial<SemanticModel> = {}): Promise<ActionOutcome> {
  return runAction({
    model: {...model, ...over},
    actionName: 'TransferFunds',
    args: {source, target, amount},
    client: dataClient(),
    handler: transferHandler,
  });
}


describe.skipIf(!LIVE)('the semantic runtime on real Spanner', () => {
  beforeEach(async () => {
    model = loadModels(readModelYaml(), {dialect: 'ANSI_SQL'}).models[0];
    await reseed();
  });

  afterAll(async () => {
    await reseed();
  });

  describe('a write that satisfies every constraint', () => {
    test('commits, and the money is where it was sent', async () => {
      const outcome = await transfer('1', '3', 100);
      expect(outcome.status).toBe('committed');
      if (outcome.status !== 'committed') return;
      expect(outcome.commitTimestamp).toBeTruthy();
      // The claim the fake cannot make.
      expect(await balances()).toMatchObject({'1': '2400', '3': '500'});
    });

    test('records the transfer it was asked to record', async () => {
      await transfer('1', '3', 25);
      const rows = await readCommitted(
          'SELECT CAST(source_account_id AS STRING), ' +
          'CAST(target_account_id AS STRING), CAST(amount AS STRING) ' +
          'FROM Transfer');
      expect(rows).toEqual([['1', '3', '25']]);
    });

    test('reports which constraints it checked', async () => {
      const outcome = await transfer('1', '3', 10);
      if (outcome.status !== 'committed') throw new Error(outcome.message);
      expect(outcome.checked).toEqual([
        'NonNegativeBalance',
        'AboveMinimumBalance',
        'PositiveAmount',
        'OpenAccountsOnly',
      ]);
    });

    test('and returns the rows its object references resolved to', async () => {
      const outcome = await transfer('Alice Checking', 'Bob Checking', 10);
      if (outcome.status !== 'committed') throw new Error(outcome.message);
      expect(outcome.refs.source).toEqual(
          {entity: 'Account', keys: ['1'], input: 'Alice Checking'});
      expect(outcome.refs.target).toEqual(
          {entity: 'Account', keys: ['3'], input: 'Bob Checking'});
    });
  });

  describe('a write that would break a constraint', () => {
    test('an overdraft is refused and the money never moves', async () => {
      const before = await balances();
      const outcome = await transfer('1', '3', 5000);
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') return;
      expect(outcome.message).toContain('An account cannot be overdrawn');
      expect(outcome.violations.map(v => v.constraint)).toContain(
          'NonNegativeBalance');
      // Not "rollback was called" -- the balances are unchanged, and the
      // transaction that briefly held the debited value is gone.
      expect(await balances()).toEqual(before);
      expect(await readCommitted('SELECT CAST(COUNT(*) AS STRING) FROM Transfer'))
          .toEqual([['0']]);
    });

    test('a per-account floor is enforced separately from zero', async () => {
      // Account 2 holds 18000 with a floor of 5000: 14000 leaves it solvent and
      // still breaks its own rule.
      const outcome = await transfer('2', '3', 14000);
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') return;
      expect(outcome.violations.map(v => v.constraint)).toEqual([
        'AboveMinimumBalance'
      ]);
      expect(outcome.message).toContain('minimum balance');
      expect(await balances()).toMatchObject({'2': '18000', '3': '400'});
    });

    test('a frozen account cannot be paid', async () => {
      const outcome = await transfer('1', '4', 10);
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') return;
      expect(outcome.violations.map(v => v.constraint)).toEqual([
        'OpenAccountsOnly'
      ]);
      expect(outcome.violations[0].violatingKeys).toEqual([['4']]);
      expect(await balances()).toMatchObject({'1': '2500', '4': '900'});
    });

    test('a negative amount is refused by the rule on the transfer itself',
         async () => {
           const outcome = await transfer('1', '3', -50);
           expect(outcome.status).toBe('rejected');
           if (outcome.status !== 'rejected') return;
           expect(outcome.violations.map(v => v.constraint)).toEqual([
             'PositiveAmount'
           ]);
           expect(await balances()).toMatchObject({'1': '2500', '3': '400'});
         });

    test('a rejection leaves the database able to take the corrected write',
         async () => {
           // The loop the whole feature is for: an agent is told what it did
           // wrong and retries. If a rejection left a transaction or a lock
           // behind, this is where it would show.
           const rejected = await transfer('1', '3', 5000);
           expect(rejected.status).toBe('rejected');
           const accepted = await transfer('1', '3', 500);
           expect(accepted.status).toBe('committed');
           expect(await balances()).toMatchObject({'1': '2000', '3': '900'});
         });
  });

  describe('the gate fails closed', () => {
    test('a constraint that cannot be lowered aborts the action', async () => {
      const outcome = await transfer('1', '3', 10, {
        constraints: [
          ...model.constraints!,
          {name: 'Unlowerable', expression: 'COUNT(*) > 0'},
        ],
      });
      expect(outcome.status).toBe('error');
      if (outcome.status !== 'error') return;
      expect(outcome.message).toContain('unchecked');
      expect(outcome.message).toContain('Unlowerable');
      expect(await balances()).toMatchObject({'1': '2500', '3': '400'});
    });

    test('a constraint the SERVER rejects also aborts, rather than committing',
         async () => {
           // A lowering can be well-formed and still produce a query Spanner
           // refuses -- here a STRING column compared to a BOOL. The hermetic
           // suite cannot produce this case at all, because its fake answers
           // every query. What matters is which way the runtime falls: the
           // write must not commit merely because the check could not be run.
           const outcome = await transfer('1', '3', 10, {
             constraints: [
               ...model.constraints!,
               {name: 'TypeMismatch', expression: 'Account.status = TRUE'},
             ],
           });
           expect(outcome.status).toBe('error');
           if (outcome.status !== 'error') return;
           expect(outcome.message).toContain('rolled back');
           expect(await balances()).toMatchObject({'1': '2500', '3': '400'});
         });

    test('a handler that throws after writing leaves nothing behind',
         async () => {
           const outcome = await runAction({
             model,
             actionName: 'TransferFunds',
             args: {source: '1', target: '3', amount: 10},
             client: dataClient(),
             handler: async ctx => {
               // Write first, then fail: a partial plan is the case where a
               // missing rollback would corrupt the data rather than just
               // return an error.
               await ctx.query({
                 sql: 'UPDATE Account SET balance = 0 WHERE account_id = 1',
               });
               throw new Error('the executor gave up');
             },
           });
           expect(outcome.status).toBe('error');
           if (outcome.status !== 'error') return;
           expect(outcome.message).toContain('the executor gave up');
           expect(await balances()).toMatchObject({'1': '2500'});
         });
  });

  describe('when the handler reports no touched rows', () => {
    test('every constraint is checked over its whole table', async () => {
      // Correct but blunt: account 4 is frozen in the seed, so an unscoped
      // OpenAccountsOnly refuses a transfer that had nothing to do with it.
      // This is exactly why the handler reports what it touched, and the live
      // database is the only place the difference is visible.
      const outcome = await runAction({
        model,
        actionName: 'TransferFunds',
        args: {source: '1', target: '3', amount: 10},
        client: dataClient(),
        handler: async ctx => {
          const plan = await transferHandler(ctx);
          return {statements: plan.statements};
        },
      });
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') return;
      expect(outcome.violations.map(v => v.constraint)).toEqual([
        'OpenAccountsOnly'
      ]);
      expect(await balances()).toMatchObject({'1': '2500', '3': '400'});
    });

    test('and a violation the action itself caused is still caught', async () => {
      const outcome = await runAction({
        model: {...model, constraints: [model.constraints![0]]},
        actionName: 'TransferFunds',
        args: {source: '1', target: '3', amount: 99999},
        client: dataClient(),
        handler: async ctx => {
          const plan = await transferHandler(ctx);
          return {statements: plan.statements};
        },
      });
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') return;
      expect(outcome.violations[0].constraint).toBe('NonNegativeBalance');
      expect(await balances()).toMatchObject({'1': '2500'});
    });
  });

  describe('resolving an object reference against real rows', () => {
    test('matches on the key', async () => {
      const outcome = await transfer('1', '3', 1);
      if (outcome.status !== 'committed') throw new Error(outcome.message);
      expect(outcome.refs.source.keys).toEqual(['1']);
    });

    test('matches on the display name', async () => {
      const outcome = await transfer('Alice Savings', '3', 1);
      if (outcome.status !== 'committed') throw new Error(outcome.message);
      expect(outcome.refs.source.keys).toEqual(['2']);
    });

    test('refuses a reference that matches nothing', async () => {
      const outcome = await transfer('Nobody Checking', '3', 1);
      expect(outcome.status).toBe('error');
      if (outcome.status !== 'error') return;
      expect(outcome.message).toBe("No Account matches 'Nobody Checking'.");
      expect(await readCommitted(
                 'SELECT CAST(COUNT(*) AS STRING) FROM Transfer'))
          .toEqual([['0']]);
    });

    test('refuses an ambiguous reference and names the candidates', async () => {
      // Accounts 5 and 6 are both called 'Shared Name'. Guessing between two
      // real rows is the one failure an agent must never be allowed to make
      // silently.
      const outcome = await transfer('Shared Name', '3', 1);
      expect(outcome.status).toBe('error');
      if (outcome.status !== 'error') return;
      expect(outcome.message).toContain('matches more than one Account');
      expect(outcome.message).toContain('5');
      expect(outcome.message).toContain('6');
    });

    test('refuses a missing required reference before any store call',
         async () => {
           const outcome = await transfer('', '3', 1);
           expect(outcome.status).toBe('error');
           if (outcome.status !== 'error') return;
           expect(outcome.message).toContain("requires 'source'");
         });
  });

  test('an unknown action is refused', async () => {
    const outcome = await runAction({
      model,
      actionName: 'CloseAccount',
      args: {},
      client: dataClient(),
      handler: async () => ({statements: []}),
    });
    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.message).toContain("declares no action 'CloseAccount'");
  });
});
