// Behavior specification for model-level CONSTRAINTS -- the named invariants
// that gate an action -- across the pipeline: loader parsing, the push-time
// validation gate, the OSI round trip, and the Knowledge Catalog publish/pull
// round trip. Constraints have no semantic-* system type of their own, so they
// ride the model anchor's `overview` aspect alongside actions, each under its
// own marker.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {ACTIONS_OVERVIEW_MARKER, CONSTRAINTS_OVERVIEW_MARKER, generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {fromDocument, LoadedModel, loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const FIXTURES = path.join(__dirname, 'fixtures');
const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg'
};

function loadFixtureModel(name: string): SemanticModel {
  const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return loadModels(text).models[0];
}

// A one-entity document with a constraints array, for focused loader tests.
function withConstraints(constraints: any[], over: any = {}) {
  return fromDocument({
    semantic_model: [{
      name: 'm',
      datasets: [{
        name: 'customer',
        source: 'p.d.c',
        primary_key: ['id'],
        fields: [{
          name: 'balance',
          expression: {dialects: [{dialect: 'ANSI_SQL', expression: 'balance'}]},
        }],
      }],
      constraints,
      ...over,
    }],
  });
}


describe('loader parses constraints', () => {
  test('reads name, expression, and description', () => {
    const {models, warnings} = withConstraints([{
      name: 'NonNegativeBalance',
      expression: 'customer.balance >= 0',
      description: 'A balance cannot go negative.',
    }]);
    // Scoped to constraints: the fixture's field expression emits an unrelated
    // dialect note.
    expect(warnings.filter(w => w.includes('constraint'))).toEqual([]);
    expect(models[0].constraints).toEqual([{
      name: 'NonNegativeBalance',
      expression: 'customer.balance >= 0',
      description: 'A balance cannot go negative.',
    }]);
  });

  test('a model without constraints leaves model.constraints unset', () => {
    const {models} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets:
            [{name: 'customer', source: 'p.d.c', primary_key: ['id'], fields: []}],
      }],
    });
    expect(models[0].constraints).toBeUndefined();
  });

  test('description is optional', () => {
    const {models} =
        withConstraints([{name: 'C', expression: 'customer.balance >= 0'}]);
    expect(models[0].constraints).toEqual([
      {name: 'C', expression: 'customer.balance >= 0'}
    ]);
  });

  test('the expression is kept verbatim, not parsed', () => {
    // A compound expression the loader has no business interpreting: it belongs
    // to the evaluator, so it must survive character for character.
    const expr = 'customer.balance >= 0 AND (total_revenue > 100 OR NOT flagged)';
    const {models} = withConstraints([{name: 'C', expression: expr}]);
    expect(models[0].constraints![0].expression).toBe(expr);
  });

  test('a constraint with no expression is rejected at parse', () => {
    expect(() => withConstraints([{name: 'C'}])).toThrow();
  });

  test('duplicate constraint names warn', () => {
    const {warnings} = withConstraints([
      {name: 'C', expression: 'customer.balance >= 0'},
      {name: 'C', expression: 'customer.balance < 100'},
    ]);
    expect(warnings.some(w => w.includes('constraint name') && w.includes('C')))
        .toBe(true);
  });

  test('ai_context and custom_extensions round-trip onto the IR', () => {
    const {models} = withConstraints([{
      name: 'C',
      expression: 'customer.balance >= 0',
      ai_context: {instructions: 'Explain the shortfall in currency terms.'},
      custom_extensions: [{vendor_name: 'ACME', data: '{"severity":"hard"}'}],
    }]);
    const c = models[0].constraints![0];
    expect(c.aiContext)
        .toEqual({instructions: 'Explain the shortfall in currency terms.'});
    expect(c.customExtensions).toEqual([
      {vendorName: 'ACME', data: '{"severity":"hard"}'}
    ]);
  });
});


describe('validatePushRequirements gates constraints', () => {
  const target =
      '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
  const googleExt = {
    vendorName: 'GOOGLE',
    data: JSON.stringify({deploymentTargets: [target]})
  };

  function loaded(constraints: any[]): LoadedModel {
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
      constraints,
      customExtensions: [googleExt],
    };
    return {document: 'doc', model};
  }

  test('a well-formed constraint passes', () => {
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: 'customer.balance >= 0'}])]);
    expect(errs).toEqual([]);
  });

  test('an empty expression is a hard error', () => {
    const errs =
        validatePushRequirements([loaded([{name: 'C', expression: '   '}])]);
    expect(errs.some(e => e.includes("constraint 'C'") &&
                      e.includes('empty expression')))
        .toBe(true);
  });

  test('an unknown field on a KNOWN entity is a hard error', () => {
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: 'customer.blance >= 0'}])]);
    expect(errs.some(e => e.includes('customer.blance'))).toBe(true);
  });

  test('a leading qualifier that is not an entity is left to the evaluator',
       () => {
         // `OrderedAs` is a relationship, not an entity -- guessing here would
         // falsely reject a valid constraint, so validation stays out of it.
         const errs = validatePushRequirements(
             [loaded([{name: 'C', expression: 'OrderedAs.quantity > 0'}])]);
         expect(errs).toEqual([]);
       });

  test('an expression that does not open with a field ref passes', () => {
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: 'COUNT(*) > 0'}])]);
    expect(errs).toEqual([]);
  });
});


describe('OSI round trip', () => {
  test('constraints survive serialize -> reload', () => {
    const model = loadFixtureModel('actions_place_order.yaml');
    expect(model.constraints).toHaveLength(2);
    const {yaml} = serializeModel(model);
    expect(yaml).toContain('constraints:');
    const reloaded = loadModels(yaml).models[0];
    expect(reloaded.constraints).toEqual(model.constraints);
  });

  test('a model with no constraints emits no constraints key', () => {
    const model = loadFixtureModel('actions_place_order.yaml');
    const {yaml} = serializeModel({...model, constraints: undefined});
    expect(yaml).not.toContain('constraints:');
  });
});


describe('Knowledge Catalog publish/pull round trip', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('constraints are published to the anchor overview aspect', () => {
    const {entries, warnings} = generateCatalogResources(model, OPTS);
    const overview = entries[0].aspects?.['dataplex-types.global.overview'];
    expect(overview).toBeDefined();
    const content = overview!.data!.content as string;
    expect(overview!.data!.contentType).toBe('MARKDOWN');
    // Human-readable section + the machine-readable marker/JSON block.
    expect(content).toContain('## Constraints');
    expect(content).toContain('### NonNegativeOrderTotal');
    expect(content).toContain(CONSTRAINTS_OVERVIEW_MARKER);
    expect(content).toContain('"orders.o_totalprice >= 0"');
    // Author is warned constraints are catalog-only.
    expect(warnings.some(w => w.includes('constraint'))).toBe(true);
  });

  test('actions and constraints share one overview without overwriting', () => {
    const {entries} = generateCatalogResources(model, OPTS);
    const content = entries[0]
                        .aspects!['dataplex-types.global.overview']
                        .data!.content as string;
    expect(content).toContain(ACTIONS_OVERVIEW_MARKER);
    expect(content).toContain(CONSTRAINTS_OVERVIEW_MARKER);
    expect(content).toContain('## Actions');
    expect(content).toContain('## Constraints');
    // Each marker must be followed by its OWN JSON block, so a reader keyed on
    // one marker never picks up the other's payload.
    expect(content).toContain('"place_order"');
    expect(content).toContain('"PositiveQuantity"');
  });

  test('a pull recovers the constraints from the overview', () => {
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].constraints).toEqual(model.constraints);
  });

  test('a pull recovers actions and constraints together', () => {
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].actions).toEqual(model.actions);
    expect(models[0].constraints).toEqual(model.constraints);
  });

  test('a model with only constraints still carries an overview', () => {
    const onlyConstraints: SemanticModel = {...model, actions: undefined};
    const {entries} = generateCatalogResources(onlyConstraints, OPTS);
    const overview = entries[0].aspects?.['dataplex-types.global.overview'];
    expect(overview).toBeDefined();
    const content = overview!.data!.content as string;
    expect(content).toContain('## Constraints');
    expect(content).not.toContain('## Actions');
  });

  test('a constraint with no name is skipped and warned', () => {
    const {entries} = generateCatalogResources(model, OPTS);
    const anchor = entries[0];
    const overview = anchor.aspects!['dataplex-types.global.overview'];
    overview.data!.content =
        (overview.data!.content as string)
            .replace('"name": "PositiveQuantity"', '"name": ""');
    const {models, warnings} = modelsFromCatalogResources(entries);
    expect(models[0].constraints!.map(c => c.name)).toEqual([
      'NonNegativeOrderTotal'
    ]);
    expect(warnings.some(w => w.includes('no name'))).toBe(true);
  });

  test('a malformed constraint block warns and recovers none', () => {
    const {entries} = generateCatalogResources(model, OPTS);
    const overview = entries[0].aspects!['dataplex-types.global.overview'];
    const content = overview.data!.content as string;
    const marker = content.lastIndexOf(CONSTRAINTS_OVERVIEW_MARKER);
    overview.data!.content =
        content.slice(0, marker) + CONSTRAINTS_OVERVIEW_MARKER +
        '\n```json\n{not json\n```\n';
    const {models, warnings} = modelsFromCatalogResources(entries);
    expect(models[0].constraints).toBeUndefined();
    expect(warnings.some(w => w.includes('not valid JSON'))).toBe(true);
    // The actions block, under its own marker, is unaffected.
    expect(models[0].actions).toHaveLength(1);
  });
});
