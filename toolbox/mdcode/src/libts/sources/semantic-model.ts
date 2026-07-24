// Semantic model as Metadata Source
//
// A `semantic-model` scope targets an existing Dataplex EntryGroup
// (<project>.<location>.<entryGroup>), the same shape as an entryGroup scope. The
// entry group is validated on init/load and otherwise reserved for the (deferred)
// Knowledge Catalog push path. The current BigQuery push path compiles the local
// model YAML directly and never enumerates service entries, so the entry-sync
// members below are intentionally unsupported.

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import { Layouts } from '../layout';
import { CatalogSource } from '../source';


export class SemanticModelSource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries = false;
  readonly layout = Layouts.SEMANTIC_MODEL;

  private readonly _name: string[];

  // `_entryGroup` is accepted (and validated by the caller via getEntryGroup) to
  // confirm the target exists, but the BigQuery push path does not read it; the
  // deferred KC push will.
  constructor(type: string, name: string, _entryGroup: dataplex.EntryGroup) {
    this.type = type;
    this.name = name;

    this._name = name.split('.');
    if (this._name.length !== 3) {
      throw new Error('semantic-model scope must be <projectId>.<locationId>.<entryGroupId>');
    }
  }

  // The entry group id, used as the local workspace directory name (catalog/<id>/).
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
