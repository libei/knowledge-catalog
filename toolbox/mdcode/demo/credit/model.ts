// Loads the credit-flow model, the same way every leg of the demo needs it.

import {readFileSync} from 'node:fs';

import {loadModels} from '../../src/libts/semantic/loader';
import {SemanticModel} from '../../src/libts/semantic/ir';

import {modelPath} from './config';


export function creditModel(): SemanticModel {
  // loadModels throws on a structurally invalid document, so reaching the next
  // line means the model parsed; `warnings` carries the softer notes, of which
  // this model has exactly one, about SQL dialect.
  const loaded = loadModels(readFileSync(modelPath, 'utf8'));
  if (!loaded.models.length) {
    throw new Error(`${modelPath} declares no semantic model.`);
  }
  return loaded.models[0];
}
