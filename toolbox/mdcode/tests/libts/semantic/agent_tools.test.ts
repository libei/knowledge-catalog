// Behavior specification for deriving agent tools from a model.
//
// The claim under test is that a model already carries what an agent needs, so
// an agent framework adapter has nothing left to invent: the tool's name, its
// description, its parameter types and the guidance a caller should follow all
// come out of the model. These tests read those out and check them, and check
// the outcome mapping an agent reads after a call.
//
// Nothing here opens a Spanner transaction. Deriving the tools is pure, which
// is the point: what an agent is offered can be checked without a database.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {actionTools, describeOutcome, entityTools} from '../../../src/libts/semantic/agent_tools';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';

const FIXTURES = path.join(__dirname, 'fixtures');

// The tools never touch it: every test here reads the derivation, not a call.
const NO_CLIENT = {} as any;

function loadFixtureModel(name: string): SemanticModel {
  return loadModels(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
      .models[0];
}


describe('action tools', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const tools = actionTools({model, client: NO_CLIENT});

  test('one tool per action, named the way tool APIs expect', () => {
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('place_order');
    expect(tools[0].actionName).toBe('PlaceOrder');
  });

  test('the description carries what the action says it does', () => {
    const action = model.actions![0];
    expect(action.description).toBeTruthy();
    expect(tools[0].description).toContain(action.description!.trim());
  });

  test('the description carries the guidance for AI callers', () => {
    const instructions = model.actions![0].aiContext?.instructions;
    expect(instructions).toBeTruthy();
    expect(tools[0].description).toContain(instructions!.trim());
  });

  test('the description names the rules that gate the call', () => {
    // A caller learns the shape of a refusal before it hits one.
    for (const guard of model.actions![0].guards ?? []) {
      expect(tools[0].description).toContain(guard);
    }
    expect(tools[0].description).toContain('human');
  });

  test('an entity parameter asks for a reference, a scalar for its type', () => {
    const byName = Object.fromEntries(tools[0].parameters.map(p => [p.name, p]));

    // `customer` is typed by the ontology, so the caller supplies something
    // that identifies one rather than a key it may not have.
    expect(byName['customer'].type).toBe('string');
    expect(byName['customer'].description).toContain('customer');
    expect(byName['customer'].description).toContain('more than one');

    expect(byName['quantity'].type).toBe('integer');
    expect(byName['quantity'].description).toContain('whole number');
  });

  test('every action parameter is required', () => {
    expect(tools[0].parameters.every(p => p.required)).toBe(true);
    expect(tools[0].parameters.map(p => p.name))
        .toEqual(model.actions![0].parameters.map(p => p.name));
  });

  test('a model with no actions yields no write tools', () => {
    const readOnly: SemanticModel = {...model, actions: []};
    expect(actionTools({model: readOnly, client: NO_CLIENT})).toEqual([]);
  });

  test('a tool offers no way to approve anything', () => {
    // The caller that needs approving is not the party that grants it, so
    // `approvals` is unreachable from a tool by construction. Guard the shape
    // rather than the wording: a parameter that took approvals would show up.
    const names = tools[0].parameters.map(p => p.name.toLowerCase());
    expect(names.some(n => n.includes('approv'))).toBe(false);
    expect(Object.keys(tools[0])).not.toContain('approvals');
  });
});


describe('entity tools', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const tools = entityTools({model, client: NO_CLIENT});

  test('one lookup tool per entity', () => {
    expect(tools.map(t => t.name)).toEqual(model.entities.map(
        e => `find_${e.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`));
  });

  test('the filters are the fields the profile bound to columns', () => {
    const orders = tools.find(t => t.entityName === 'orders')!;
    expect(orders.parameters.map(p => p.name))
        .toEqual(model.entities.find(e => e.name === 'orders')!.fields.map(
            f => f.name));
  });

  test('every filter is optional', () => {
    // Giving none returns the first rows, which is how an agent starts looking.
    for (const tool of tools) {
      expect(tool.parameters.every(p => !p.required)).toBe(true);
    }
  });

  test('the description states what the tool cannot do', () => {
    // An agent that knows the limits asks a question the tool can answer.
    const orders = tools.find(t => t.entityName === 'orders')!;
    expect(orders.description).toContain('exact match');
    expect(orders.description).toContain('cannot join');
  });
});


describe('what a caller is told about an outcome', () => {
  test('a commit reports the rules it checked', () => {
    const result = describeOutcome({
      status: 'committed',
      commitTimestamp: '2026-09-11T00:00:00Z',
      refs: {},
      checked: ['OrderTotalMatchesLineItems'],
      warnings: [],
    });
    expect(result.applied).toBe(true);
    expect(result.rulesChecked).toEqual(['OrderTotalMatchesLineItems']);
    expect(result.needsApprovalFor).toBeUndefined();
  });

  test('a held write names what a human must sign off', () => {
    const result = describeOutcome({
      status: 'escalated',
      message: 'A credit over $25 is above the self-service ceiling.',
      violations: [{
        constraint: 'CreditUnderReviewThreshold',
        entity: '',
        message: 'above the ceiling',
        violatingKeys: [],
        severity: 'escalate',
        stage: 'guard',
      }],
      approvalRequired: ['CreditUnderReviewThreshold'],
    });
    expect(result.applied).toBe(false);
    expect(result.needsApprovalFor).toEqual(['CreditUnderReviewThreshold']);
    expect(result.reason).toContain('ceiling');
    // The caller is told to stop rather than to retry, because retrying the
    // same call changes nothing.
    expect(result.whatToDo).toContain('cannot approve it yourself');
  });

  test('a refusal names the rules and offers no approval', () => {
    const result = describeOutcome({
      status: 'rejected',
      message: 'An order must equal the sum of its line items.',
      violations: [{
        constraint: 'OrderTotalMatchesLineItems',
        entity: 'Order',
        message: 'does not add up',
        violatingKeys: [['12346']],
        severity: 'reject',
        stage: 'invariant',
      }],
    });
    expect(result.applied).toBe(false);
    expect(result.rulesBroken).toEqual(['OrderTotalMatchesLineItems']);
    expect(result.needsApprovalFor).toBeUndefined();
    expect(result.whatToDo).toContain('Nobody can approve');
  });

  test('a warning commits and is still reported', () => {
    const result = describeOutcome({
      status: 'committed',
      refs: {},
      checked: ['UnusualAmount'],
      warnings: [{
        constraint: 'UnusualAmount',
        entity: 'Order',
        message: 'larger than this customer usually asks for',
        violatingKeys: [['12345']],
        severity: 'warn',
        stage: 'invariant',
      }],
    });
    expect(result.applied).toBe(true);
    expect(result.reason).toContain('larger than this customer usually asks');
  });

  test('an error is a failure the caller can read', () => {
    const result =
        describeOutcome({status: 'error', message: "No Order matches 'xyz'."});
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('No Order matches');
  });
});
