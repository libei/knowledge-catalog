// Behavior specification for the link between an action and the constraints
// that gate it: the action's `guards` list.
//
// A constraint that quantifies over data alone holds for every write and is
// enforced without being named anywhere. A constraint that reads an action's
// parameters describes the call instead, so the only moment it can be checked
// is before that call runs -- which happens only when the action names it. That
// asymmetry is what these tests pin down: naming resolves (or fails to resolve)
// at push time, and an unnamed parameter-reading constraint is reported at load
// time as text nothing will evaluate.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {fromDocument, LoadedModel, loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const FIXTURES = path.join(__dirname, 'fixtures');
const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg'
};

const MCP_EXECUTOR = {
  mcp: {server: '//agentregistry.googleapis.com/x', tool: 'place_order'},
};

// One entity, one action, and whatever constraints a test needs. `guards` is
// passed through verbatim so a test can name a constraint that does not exist.
function withGuards(
    guards: string[]|undefined, constraints: any[] = [],
    parameters: any[] = [{name: 'quantity', type: 'Integer'}]) {
  return fromDocument({
    version: '0.2.0.dev0/google',
    semantic_model: [{
      name: 'm',
      datasets: [{
        name: 'customer',
        source: 'p.d.c',
        primary_key: ['id'],
        fields: [{
          name: 'balance',
          expression:
              {dialects: [{dialect: 'ANSI_SQL', expression: 'balance'}]},
        }],
      }],
      actions: [{
        name: 'PlaceOrder',
        executor: MCP_EXECUTOR,
        parameters,
        ...(guards ? {guards} : {}),
      }],
      constraints,
    }],
  });
}


describe('loader parses an action\'s guards', () => {
  test('carries the constraint names onto the action', () => {
    const {models} = withGuards(
        ['PositiveQuantity'],
        [{name: 'PositiveQuantity', expression: 'quantity > 0'}]);
    expect(models[0].actions![0].guards).toEqual(['PositiveQuantity']);
  });

  test('omits guards entirely when the action names none', () => {
    const {models} = withGuards(undefined);
    expect(models[0].actions![0].guards).toBeUndefined();
  });

  test('a repeated guard is a hard load error', () => {
    // Checking one constraint twice reads as two rules, so it is rejected the
    // way every other duplicate name is.
    expect(
        () => withGuards(['C', 'C'], [{name: 'C', expression: 'quantity > 0'}]))
        .toThrow(/duplicate guard 'C'/);
  });

  test(
      'guards are rejected under vanilla Ossie, as actions themselves are',
      () => {
        expect(
            () => fromDocument({
              version: '0.2.0.dev0',
              semantic_model: [{
                name: 'm',
                datasets: [{
                  name: 'c',
                  source: 'p.d.c',
                  primary_key: ['id'],
                  fields: [{
                    name: 'balance',
                    expression: {
                      dialects: [{dialect: 'ANSI_SQL', expression: 'balance'}]
                    },
                  }],
                }],
                actions: [{
                  name: 'PlaceOrder',
                  executor: MCP_EXECUTOR,
                  guards: ['C'],
                }],
              }],
            }))
            .toThrow(/actions/);
      });
});


describe('validatePushRequirements resolves every guard', () => {
  const googleExt = {
    vendorName: 'GOOGLE',
    data: JSON.stringify({
      deploymentTargets:
          ['//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g']
    }),
  };

  function loaded(guards: string[], constraintNames: string[]): LoadedModel {
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'customer',
        dataSource: 'p.d.c',
        keys: ['id'],
        fields: [{name: 'balance'}],
      }],
      relationships: [],
      metrics: [],
      actions: [{
        name: 'PlaceOrder',
        executor: {kind: 'mcp', mcp: {server: 's', tool: 't'}},
        parameters: [{name: 'quantity', type: 'Integer', isEntityRef: false}],
        guards,
      }],
      constraints: constraintNames.map(
          name => ({name, expression: 'customer.balance >= 0'})),
      customExtensions: [googleExt],
    };
    return {document: 'doc', model};
  }

  test('a guard naming a declared constraint passes', () => {
    expect(validatePushRequirements([loaded(['C'], ['C'])])).toEqual([]);
  });

  test('a guard naming no constraint is a hard error', () => {
    // The author believes the write is checked; nothing checks it. Failing the
    // push is the only way that belief gets corrected.
    const errs = validatePushRequirements([loaded(['Typo'], ['C'])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(`action 'PlaceOrder'`);
    expect(errs[0]).toContain(`guarded by 'Typo'`);
    expect(errs[0]).toContain('declares no constraint');
  });

  test(
      'a model that declares no constraints at all still reports the guard',
      () => {
        const errs = validatePushRequirements([loaded(['C'], [])]);
        expect(errs).toHaveLength(1);
        expect(errs[0]).toContain(`guarded by 'C'`);
      });

  test('one error per unresolved guard', () => {
    const errs = validatePushRequirements([loaded(['A', 'B'], [])]);
    expect(errs).toHaveLength(2);
  });
});


describe(
    'an unguarded parameter-reading constraint is reported at load', () => {
      test('warns when a constraint reads a parameter no action guards', () => {
        const {warnings} = withGuards(
            undefined,
            [{name: 'PositiveQuantity', expression: 'quantity > 0'}]);
        const w = warnings.find(x => x.includes('PositiveQuantity'));
        expect(w).toBeDefined();
        expect(w).toContain(`reads 'quantity'`);
        expect(w).toContain(`parameter of action 'PlaceOrder'`);
        expect(w).toContain('guards');
      });

      test('stays silent once the action names it', () => {
        const {warnings} = withGuards(
            ['PositiveQuantity'],
            [{name: 'PositiveQuantity', expression: 'quantity > 0'}]);
        expect(warnings.some(w => w.includes('PositiveQuantity'))).toBe(false);
      });

      test('a qualified name is not a parameter read', () => {
        // `OrderedAs.quantity` is a field of something in the ontology that
        // happens to share the parameter's name. Warning here would train an
        // author to ignore the warning, so the scan consumes a qualified name
        // whole.
        const {warnings} = withGuards(
            undefined,
            [{name: 'PositiveQuantity', expression: 'OrderedAs.quantity > 0'}]);
        expect(warnings.some(w => w.includes('PositiveQuantity'))).toBe(false);
      });

      test(
          'a constraint over data alone needs no guard and draws no warning',
          () => {
            const {warnings} = withGuards(
                undefined,
                [{name: 'NonNegative', expression: 'customer.balance >= 0'}]);
            expect(warnings.some(w => w.includes('NonNegative'))).toBe(false);
          });

      test('the parameter must belong to the action being reported', () => {
        // `quantity` is not a parameter of an action that takes only a
        // customer, so that action is not the one told to guard the constraint.
        const {warnings} = withGuards(
            undefined, [{name: 'PositiveQuantity', expression: 'quantity > 0'}],
            [{name: 'customer', type: 'customer'}]);
        expect(warnings.some(w => w.includes('PositiveQuantity'))).toBe(false);
      });
    });


describe('guards survive every round trip', () => {
  const model = (() => {
    const text = fs.readFileSync(
        path.join(FIXTURES, 'actions_place_order.yaml'), 'utf8');
    return loadModels(text).models[0];
  })();

  test(
      'the fixture action is guarded by a constraint the model declares',
      () => {
        expect(model.actions![0].guards).toEqual([
          'RequestedQuantityIsPositive'
        ]);
        expect(model.constraints!.map(c => c.name))
            .toContain('RequestedQuantityIsPositive');
      });

  test('OSI serialize -> reload', () => {
    const {yaml} = serializeModel(model);
    expect(loadModels(yaml).models[0].actions![0].guards).toEqual([
      'RequestedQuantityIsPositive'
    ]);
  });

  test('Knowledge Catalog publish -> pull', () => {
    const {entries} = generateCatalogResources(model, OPTS);
    const pulled = modelsFromCatalogResources(entries).models[0];
    expect(pulled.actions![0].guards).toEqual(['RequestedQuantityIsPositive']);
  });

  test('an action with no guards publishes no guards field', () => {
    const bare: SemanticModel = {
      ...model,
      actions: [{...model.actions![0], guards: undefined}],
    };
    const {entries} = generateCatalogResources(bare, OPTS);
    const action =
        entries.find(e => e.entrySource?.displayName === 'PlaceOrder')!;
    const data = Object.values(action.aspects!)[0].data!;
    expect(Object.keys(data)).not.toContain('guards');
  });
});
