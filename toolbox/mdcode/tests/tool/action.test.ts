// Tests for `kcmd action` (src/tool/commands.ts, action()) -- the command in
// front of the semantic runtime.
//
// Nothing here reaches a store, and that is not a compromise: `list` never
// opens one, and every `run` covered fails before the first request. The
// argument parse, the choice of database, and the runtime's own refusal to run
// an action a constraint is supposed to decide all happen before a session
// exists. What is under test is the wiring -- that the command finds the model,
// merges the profile, parses the arguments, picks the database from the
// deployment target rather than from a flag, and hands the runtime's answer
// back as an exit code. It runs in a temp working directory with a pinned
// context, mirroring profiles.test.ts.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../src/libts/gcp/context';
import {action} from '../../src/tool/commands';

const CTX = new ApiContext('test-project', 'us', 'test-token');

const SPANNER = '//spanner.googleapis.com/projects/acme-ops/instances/prod';

// The model as authored: bound to Spanner, with one action the runtime could
// run and one it could not, plus the two constraint shapes -- an invariant over
// stored data and a guard over an argument.
const MODEL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: ${SPANNER}/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER}/databases/commerce/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
          - { name: total, expression: Total }
      - name: Entry
        source: ${SPANNER}/databases/commerce/tables/LedgerEntry
        primary_key: [key]
        fields:
          - { name: key, expression: EntryId }
          - { name: amount, expression: Amount }
    actions:
      - name: IssueCredit
        description: Credit an order
        executor:
          sql:
            statements:
              - >-
                INSERT INTO LedgerEntry (EntryId, OrderId, Amount)
                VALUES (@newEntryKey, @order, @amount)
        parameters:
          - {name: order, type: Order}
          - {name: amount, type: Decimal}
        guards: [CreditIsPositive]
        affects:
          - {concept: Entry, operation: create}
      - name: NotifyCustomer
        executor:
          mcp:
            server: //agentregistry.googleapis.com/projects/acme-ops/locations/us-central1/mcpServers/commerce
            tool: notify
        parameters:
          - {name: order, type: Order}
    constraints:
      - name: TotalStaysPositive
        expression: Order.total >= 0
        description: An order total never goes negative.
      - name: CreditIsPositive
        expression: amount > 0
        description: A credit must be for a positive amount.
`;

// The same model with nothing to run.
const NO_ACTIONS = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: ${SPANNER}/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER}/databases/commerce/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`;

// An analytical binding: the same concepts, deployed to BigQuery.
const ANALYTICAL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/propertyGraphs/commerce
    entities:
      - name: Order
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
        fields:
          - { name: key, expression: order_id }
          - { name: total, expression: total }
      - name: Entry
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/ledger
        fields:
          - { name: key, expression: entry_id }
          - { name: amount, expression: amount }
`;

// A binding whose deployment target and entity sources disagree about which
// database they mean.
const MISMATCHED = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: ${SPANNER}/databases/archive/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER}/databases/commerce/tables/Orders
        fields:
          - { name: key, expression: OrderId }
          - { name: total, expression: Total }
      - name: Entry
        source: ${SPANNER}/databases/commerce/tables/LedgerEntry
        fields:
          - { name: key, expression: EntryId }
          - { name: amount, expression: Amount }
`;

let dir = '';
let cwd = '';
let logs: string[] = [];

function writeWorkspace(modelText = MODEL): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
  fs.writeFileSync(path.join(eg, 'commerce.yaml'), modelText);
  fs.writeFileSync(
      path.join(eg, 'commerce.profiles', 'analytical.yaml'), ANALYTICAL);
  fs.writeFileSync(
      path.join(eg, 'commerce.profiles', 'mismatched.yaml'), MISMATCHED);
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-action-'));
  process.chdir(dir);
  logs = [];
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  for (const channel of ['log', 'warn', 'error'] as const) {
    spyOn(console, channel).mockImplementation((...a: any[]) => {
      logs.push(a.join(' '));
    });
  }
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});


describe('kcmd action list', () => {
  test('prints each action with what it takes, what it touches, and the ' +
           'command line that runs it',
       async () => {
         writeWorkspace();
         const code = await action('list', undefined);
         expect(code).toBe(0);
         const out = logs.join('\n');

         expect(out).toContain("Model 'commerce' (commerce_eg), profile 'default'");
         expect(out).toContain('IssueCredit: Credit an order');

         // An entity-typed parameter is marked as a reference: the caller
         // passes something to look up, not a value.
         expect(out).toContain('parameters: order (Order, reference), amount (Decimal)');
         expect(out).toContain('executor:   sql');
         expect(out).toContain('guards:     CreditIsPositive');
         expect(out).toContain('affects:    Entry (create)');

         // The point of the listing: the reader can copy this and run it.
         expect(out).toContain(
             'run:        kcmd action run IssueCredit --arg order=<Order> ' +
             '--arg amount=<Decimal>');

         // An action with no description, guards or blast radius shows only
         // what it declares.
         expect(out).toContain('NotifyCustomer');
         expect(out).toContain('executor:   mcp');
         expect(out).toContain('run:        kcmd action run NotifyCustomer --arg order=<Order>');
       });

  test('says so when a model declares no actions', async () => {
    writeWorkspace(NO_ACTIONS);
    const code = await action('list', undefined);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('declares no actions.');
  });

  test('reads the model under a named profile', async () => {
    writeWorkspace();
    const code = await action('list', undefined, {profile: 'analytical'});
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain("profile 'analytical'");
  });

  test('names the profiles that exist when given one that does not',
       async () => {
         writeWorkspace();
         const code = await action('list', undefined, {profile: 'nope'});
         expect(code).toBe(1);
         const out = logs.join('\n');
         expect(out).toContain("unknown binding profile 'nope'");
         expect(out).toContain('analytical');
       });

  test('rejects a subcommand that is neither list nor run', async () => {
    writeWorkspace();
    const code = await action('explain', 'IssueCredit');
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain("expected 'list' or 'run'");
  });
});


describe('kcmd action run: what it will not send to a store', () => {
  test('needs an action name', async () => {
    writeWorkspace();
    const code = await action('run', undefined);
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('needs an action name');
  });

  test('names the declared actions when asked for one that is not there',
       async () => {
         writeWorkspace();
         const code = await action('run', 'IssueRefund');
         expect(code).toBe(1);
         const out = logs.join('\n');
         expect(out).toContain("declares an action 'IssueRefund'");
         expect(out).toContain('declared: IssueCredit, NotifyCustomer.');
       });

  test('rejects an --arg that does not name a parameter', async () => {
    writeWorkspace();
    const code = await action(
        'run', 'IssueCredit', {arg: ['order=12345', 'amount']});
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain("--arg expects <name>=<value>, but got 'amount'");
  });

  test('rejects the same parameter given twice', async () => {
    writeWorkspace();
    const code =
        await action('run', 'IssueCredit', {arg: ['amount=30', 'amount=40']});
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('--arg amount was given twice.');
  });

  test('takes a single --arg, which cac hands over as a bare string',
       async () => {
         writeWorkspace();
         // Reaches the runtime rather than the argument parser: the refusal
         // below is about the guard, which is proof the parse succeeded.
         const code = await action('run', 'IssueCredit', {arg: 'amount=30'});
         expect(code).toBe(1);
         expect(logs.join('\n')).toContain('does not evaluate constraints yet');
       });

  test('refuses an action whose executor runs outside the transaction',
       async () => {
         writeWorkspace();
         const code = await action('run', 'NotifyCustomer', {arg: 'order=1'});
         expect(code).toBe(1);
         expect(logs.join('\n')).toContain('which runs outside this transaction');
       });

  test('refuses a guarded action while nothing evaluates the guard',
       async () => {
         writeWorkspace();
         const code = await action(
             'run', 'IssueCredit', {arg: ['order=12345', 'amount=30']});
         expect(code).toBe(1);
         const out = logs.join('\n');
         expect(out).toContain("is guarded by 'CreditIsPositive'");
         // It got as far as choosing a database, so the refusal is the
         // runtime's and not a wiring failure earlier on.
         expect(out).toContain(
             "Running 'IssueCredit' on projects/acme-ops/instances/prod/databases/commerce");
       });
});


describe('kcmd action run: where the write would go', () => {
  test('refuses a profile that deploys to BigQuery', async () => {
    writeWorkspace();
    const code = await action(
        'run', 'IssueCredit',
        {profile: 'analytical', arg: ['order=12345', 'amount=30']});
    expect(code).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain('declares no Spanner deployment target');
    expect(out).toContain('this profile deploys to BigQuery');
  });

  test('refuses a binding whose sources sit in a different database than ' +
           'its deployment target',
       async () => {
         writeWorkspace();
         const code = await action(
             'run', 'IssueCredit',
             {profile: 'mismatched', arg: ['order=12345', 'amount=30']});
         expect(code).toBe(1);
         const out = logs.join('\n');
         expect(out).toContain(
             "binds 'Order' to projects/acme-ops/instances/prod/databases/commerce");
         expect(out).toContain(
             'deployment target is projects/acme-ops/instances/prod/databases/archive');
         expect(out).toContain('address a table by name alone');
       });
});
