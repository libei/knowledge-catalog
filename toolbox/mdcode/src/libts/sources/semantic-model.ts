// Semantic model as Metadata Source
//
// A `semantic-model` scope is written as <project>.<location>.<entryGroup> (the
// same shape as an entryGroup scope). Nothing here is validated against Dataplex
// at init time. The scope triple is a *default* deploy destination, not a lock:
// push-time flags (`--project`/`--location`/`--entry-group`) override it, and the
// entryGroup segment doubles as the local workspace directory name
// (catalog/<entryGroup>/). The BigQuery push path compiles the local model YAML
// directly and never enumerates service entries, so the entry-sync members below
// are intentionally unsupported (they belong to the deferred KC entry sync).

import * as gcp from '../gcp';
import { Layouts } from '../layout';
import { CatalogSource } from '../source';


export class SemanticModelSource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries = false;
  readonly layout = Layouts.SEMANTIC_MODEL;

  private readonly _name: string[];

  constructor(type: string, name: string) {
    this.type = type;
    this.name = name;

    this._name = name.split('.');
    if (this._name.length !== 3) {
      throw new Error('semantic-model scope must be <projectId>.<locationId>.<entryGroupId>');
    }
  }

  // The scope triple, which serves as the default deploy destination (overridable
  // by push-time flags). `entryGroupId` also names the local workspace directory
  // (catalog/<id>/).
  get projectId(): string {
    return this._name[0];
  }

  get locationId(): string {
    return this._name[1];
  }

  get entryGroupId(): string {
    return this._name[2];
  }

  async *entries(_ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown> {
    throw new Error('semantic-model scope does not support entry sync yet (KC push deferred)');
  }

  localName(_entry: gcp.Entry): string {
    throw new Error('semantic-model scope does not support entry sync yet (KC push deferred)');
  }

  serviceName(_localName: string): string {
    throw new Error('semantic-model scope does not support entry sync yet (KC push deferred)');
  }
}
