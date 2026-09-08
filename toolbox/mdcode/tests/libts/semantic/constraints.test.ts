// Behavior specification for model-level CONSTRAINTS: the named invariants a
// model states over its ontology. Covers the whole pipeline -- loader parsing,
// the push-time validation gate, the OSI round trip, and the Knowledge Catalog
// publish/pull round trip. Dataplex has no built-in constraint type, so a
// constraint publishes as one entry under the custom `semantic-constraint`
// type, the way an action publishes under `semantic-action`.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {fromDocument, LoadedModel, loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';
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
    version: '0.2.0.dev0/google',
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
      version: '0.2.0.dev0/google',
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

  test('duplicate constraint names are rejected', () => {
    // A duplicate name is a hard load error in every other scope, and for the
    // same reason: an action naming a constraint would not say which it meant.
    expect(() => withConstraints([
             {name: 'C', expression: 'customer.balance >= 0'},
             {name: 'C', expression: 'customer.balance < 100'},
           ])).toThrow(/duplicate constraint name 'C'/);
  });

  test('ai_context rides the constraint onto the IR', () => {
    const {models} = withConstraints([{
      name: 'C',
      expression: 'customer.balance >= 0',
      ai_context: {instructions: 'Explain the shortfall in currency terms.'},
    }]);
    expect(models[0].constraints![0].aiContext)
        .toEqual({instructions: 'Explain the shortfall in currency terms.'});
  });

  test('custom_extensions on a constraint is rejected', () => {
    // A constraint is a native key of the extended profile, and that profile
    // has no `custom_extensions` surface at all -- the native keys replace it.
    expect(() => withConstraints([{
             name: 'C',
             expression: 'customer.balance >= 0',
             custom_extensions: [{vendor_name: 'ACME', data: '{}'}],
           }])).toThrow(/custom_extensions/);
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
         // `OrderedAs` names a relationship rather than an entity. Guessing
         // here would falsely reject a valid constraint, so validation stays
         // out of it.
         const errs = validatePushRequirements(
             [loaded([{name: 'C', expression: 'OrderedAs.quantity > 0'}])]);
         expect(errs).toEqual([]);
       });

  test('an expression that does not open with a field ref passes', () => {
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: 'COUNT(*) > 0'}])]);
    expect(errs).toEqual([]);
  });

  // The field check reads a field list, and by the time this gate runs the
  // model's field lists are no longer what the author wrote. Both directions
  // of that gap rejected a valid constraint.

  // `extends` is flattened by the graph legs, which run AFTER this gate, so a
  // subtype's own `fields` omit everything it inherits.
  function withInheritance(expression: string): LoadedModel {
    const model: SemanticModel = {
      name: 'm',
      entities: [
        {
          name: 'account',
          dataSource: 'p.d.a',
          keys: ['id'],
          fields: [{name: 'balance'}],
        },
        {
          name: 'savings',
          dataSource: 'p.d.s',
          keys: ['id'],
          fields: [],
          extends: ['account'],
        },
      ],
      relationships: [],
      metrics: [],
      constraints: [{name: 'C', expression}],
      customExtensions: [googleExt],
    };
    return {document: 'doc', model};
  }

  test('a constraint over an INHERITED field passes', () => {
    const errs = validatePushRequirements([withInheritance('savings.balance >= 0')]);
    expect(errs).toEqual([]);
  });

  test('a typo is still caught on an entity that inherits', () => {
    const errs = validatePushRequirements([withInheritance('savings.blance >= 0')]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(`declares no field 'blance'`);
  });

  test('the field check stands down once the profile has pruned fields', () => {
    // A profile push drops every field the profile leaves unbound before this
    // gate sees the model, so the author's field is gone rather than misspelt.
    // A constraint reaches no graph in any case, so failing the push here would
    // refuse a deploy for no reason.
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: 'customer.unbound >= 0'}])],
        {fieldsPruned: true});
    expect(errs).toEqual([]);
  });

  test('an empty expression is rejected even on a pruned model', () => {
    // Standing down applies to the field check alone; the expression itself is
    // still the constraint's whole content.
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: '   '}])], {fieldsPruned: true});
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('empty expression');
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
  const CONSTRAINT_ENTRY_TYPE = '/entryTypes/semantic-constraint';
  const CONSTRAINT_ASPECT = 'dest.global.semantic-constraint';

  function constraintEntriesOf(m: SemanticModel) {
    return generateCatalogResources(m, OPTS)
        .entries.filter(e => e.entryType.endsWith(CONSTRAINT_ENTRY_TYPE));
  }

  test('every constraint becomes one entry, parented to the model anchor',
       () => {
         const {entries, warnings} = generateCatalogResources(model, OPTS);
         const constraints =
             entries.filter(e => e.entryType.endsWith(CONSTRAINT_ENTRY_TYPE));
         expect(constraints.map(e => e.name.split('/entries/')[1])).toEqual([
           'sales.constraints.NonNegativeOrderTotal',
           'sales.constraints.PositiveQuantity',
         ]);
         for (const e of constraints) expect(e.parentEntry).toBe(entries[0].name);
         // Author is warned constraints are catalog-only.
         expect(warnings.some(w => w.includes('constraint(s) published')))
             .toBe(true);
       });

  test('the entry type is custom, so it lives in the destination project',
       () => {
         // Every built-in type is referenced from `dataplex-types`; this one is
         // provisioned by `kcmd init` in the project being pushed to.
         const [first] = constraintEntriesOf(model);
         expect(first.entryType)
             .toBe('projects/dest/locations/global/entryTypes/' +
                   'semantic-constraint');
         expect(first.aspects![CONSTRAINT_ASPECT].aspectType)
             .toBe('projects/dest/locations/global/aspectTypes/' +
                   'semantic-constraint');
       });

  test('the aspect carries the expression and the entry source the description',
       () => {
         // PositiveQuantity is the fixture's constraint with no `ai_context`,
         // so its aspect is the expression alone.
         const positive = constraintEntriesOf(model).find(
             e => e.entrySource!.displayName === 'PositiveQuantity')!;
         expect(positive.aspects![CONSTRAINT_ASPECT].data)
             .toEqual({expression: 'OrderedAs.quantity > 0'});
         // The description is the message a violation quotes back, so it is the
         // entry's human-readable summary rather than an aspect field.
         expect(positive.entrySource!.description)
             .toBe('An order line must be for at least one unit.');
       });

  test('the whole ai_context rides the constraint\'s own aspect', () => {
    // Not `instructions` alone: the built-in guidelines aspect has a home for
    // that part only, and a custom aspect kcmd defines has no reason to lose
    // the other two. The fixture declares all three so this is browsable.
    const [nonNegative] = constraintEntriesOf(model);
    expect(nonNegative.entrySource!.displayName).toBe('NonNegativeOrderTotal');
    expect(nonNegative.aspects![CONSTRAINT_ASPECT].data).toEqual({
      expression: 'orders.o_totalprice >= 0',
      aiContext: {
        instructions:
            'Quote the shortfall in the customer\'s own currency when refusing.',
        synonyms: ['NoNegativeTotals', 'NonNegativeTotal'],
        examples: ['Why was my order rejected?'],
      },
    });
  });

  test('a pull recovers every part of the ai_context', () => {
    // The emit side above and this read side are what make the annotation
    // survive a round trip; dropping either would lose a declared field
    // silently, since the pull rewrites the document it read.
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].constraints![0].aiContext).toEqual({
      instructions:
          'Quote the shortfall in the customer\'s own currency when refusing.',
      synonyms: ['NoNegativeTotals', 'NonNegativeTotal'],
      examples: ['Why was my order rejected?'],
    });
    // The constraint that declares none stays clean rather than gaining an
    // empty record.
    expect(models[0].constraints![1].aiContext).toBeUndefined();
  });

  test('a model with no constraints publishes no constraint entry', () => {
    const none: SemanticModel = {...model, constraints: undefined};
    expect(constraintEntriesOf(none)).toEqual([]);
  });

  test('the constraint prefix is owned, so a dropped constraint is deleted',
       () => {
         // Delete reconciliation removes server entries under an owned prefix
         // that this push did not re-emit; without the prefix a constraint
         // dropped from the model would linger in the catalog.
         const {ownedPrefixes} = generateCatalogResources(model, OPTS);
         expect(ownedPrefixes).toContain('sales.constraints.');
       });

  test('a pull recovers the constraints', () => {
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

  test('a second push of the pulled model produces the same entries', () => {
    // Push -> pull -> push has to be a fixed point: if it were not, a pull
    // followed by a push would rewrite entries that nobody edited.
    const first = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(first.entries, first.entryLinks);
    const second = generateCatalogResources(models[0], OPTS);

    const constraintsOf = (entries: typeof first.entries) =>
        entries.filter(e => e.entryType.endsWith(CONSTRAINT_ENTRY_TYPE))
            .map(e => [e.name, e.aspects![CONSTRAINT_ASPECT].data])
            .sort();
    expect(constraintsOf(second.entries))
        .toEqual(constraintsOf(first.entries));
  });

  test('an entry whose expression is blank is skipped and warned', () => {
    // A hand-edited aspect can carry a blank expression. Such a constraint
    // states no invariant, so it degrades itself rather than the pull.
    const {entries} = generateCatalogResources(model, OPTS);
    const broken = entries.find(
        e => e.entrySource?.displayName === 'PositiveQuantity')!;
    broken.aspects![CONSTRAINT_ASPECT].data!.expression = '  ';
    const {models, warnings} = modelsFromCatalogResources(entries);
    expect(models[0].constraints!.map(c => c.name)).toEqual([
      'NonNegativeOrderTotal'
    ]);
    expect(warnings.some(
               w => w.includes("constraint 'PositiveQuantity'") &&
                   w.includes('no expression')))
        .toBe(true);
    // The actions, published under their own type, are unaffected.
    expect(models[0].actions).toHaveLength(1);
  });
});


// Knowledge Catalog is the only system an action or a constraint reaches, so a
// push to any other target deploys neither. Dropping them silently is the
// failure mode worth guarding: an author who declared a rule and sees a clean
// push has no way to learn it went nowhere.
describe('a graph leg says what it dropped', () => {
  const model = () => loadFixtureModel('actions_place_order.yaml');

  for (const [backend, generate] of [
           ['BigQuery', generatePropertyGraph],
           ['Spanner', generateSpannerPropertyGraph],
  ] as const) {
    test(`the ${backend} leg warns about actions and constraints`, () => {
      const {warnings} = generate(model());
      // The fixture declares one action and two constraints.
      expect(warnings.some(
                 w => /1 action\(s\) reach Knowledge Catalog only/.test(w)))
          .toBe(true);
      expect(warnings.some(
                 w => /2 constraint\(s\) reach Knowledge Catalog only/.test(w)))
          .toBe(true);
      // Named the system it does reach, and the one that drops it.
      expect(warnings.some(w => w.includes(`the ${backend} push deploys none`)))
          .toBe(true);
    });
  }

  test('a model with neither is quiet about both', () => {
    const {warnings} = generatePropertyGraph(
        loadFixtureModel('star_orders_customer.yaml'));
    expect(warnings.some(w => /reach Knowledge Catalog only/.test(w)))
        .toBe(false);
  });
});
