// API client for Knowledge Catalog (Dataplex)
//

import * as api from './api';
import * as context from './context';
import * as crm from './crm';


export interface EntryGroup {
  name: string;
  [key: string]: any;
}

export interface EntryType {
  name: string;
  requiredAspects: { type: string; }[];
  [key: string]: any;
}

export interface AspectType {
  name: string;
  [key: string]: any;
}

export interface Aspect {
  aspectType?: string;
  data?: Record<string, any>;
}

export interface Entry {
  name: string;
  entryType: string;
  parentEntry?: string;
  createTime?: string;
  updateTime?: string;
  entrySource?: {
    resource?: string;
    ancestors?: {
      name: string;
      type: string;
    }[];
    displayName?: string;
    description?: string;
    labels?: Record<string, string>;
    location?: string;
    createTime?: string;
    updateTime?: string; 
  };
  aspects?: Record<string, Aspect>;
}

interface EntryList {
  entries: Entry[];
  nextPageToken?: string;
}

// A Dataplex long-running operation. aspectTypes/entryTypes/entryGroups creates
// return one (they complete in seconds); entries/entryLinks creates are
// synchronous and return the resource directly.
export interface Operation {
  name: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: any;
  metadata?: any;
}


export class CatalogClient extends api.ApiClient {

  constructor(ctx: context.ApiContext) {
    super('https://dataplex.googleapis.com', 'v1', ctx);
  }

  async getEntryGroup(project: string, location: string,
                      entryGroup: string): Promise<api.ApiResult<EntryGroup>> {
    const name = catalogContainer(project, location, entryGroup);
    return await this._get(name);
  }

  async getEntryType(project: string, location: string,
                     type: string): Promise<api.ApiResult<EntryType>> {
    const name = `${catalogContainer(project, location)}/entryTypes/${type}`;
    return await this._get(name);
  }

  async getAspectType(project: string, location: string,
                      type: string): Promise<api.ApiResult<AspectType>> {
    const name = `${catalogContainer(project, location)}/aspectTypes/${type}`;
    return await this._get(name);
  }

  async getEntry(project: string, location: string, entryGroup: string, entry: string,
                 aspects?: string[]): Promise<api.ApiResult<Entry>> {
    const name = `${catalogContainer(project, location, entryGroup)}/entries/${entry}`;
    const params: Record<string, any> = { view: 'BASIC' };
    if (aspects && aspects.length) {
      params.view = 'CUSTOM';
      params.aspectTypes = aspects;
    }

    const res = await this._get<Entry>(name, params);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async lookupEntry(project: string, location: string, name: string,
                    aspects?: string[]): Promise<api.ApiResult<Entry>> {
    const container = `${catalogContainer(project, location)}:lookupEntry`;
    const params: Record<string, any> = { entry: name, view: 'BASIC' };
    if (aspects && aspects.length) {
      params.view = 'CUSTOM';
      params.aspectTypes = aspects;
    }

    const res = await this._get<Entry>(container, params);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async modifyEntry(project: string, location: string, entry: Entry,
                    updateMask?: string[],
                    aspectKeys?: string[]): Promise<api.ApiResult<Entry>> {
    const container = `${catalogContainer(project, location)}:modifyEntry`;
    const body: Record<string, any> = {
      entry: entry,
      updateMask: updateMask ? updateMask.join(',') : undefined,
      aspectKeys: aspectKeys ?? undefined
    };

    const res = await this._post<Entry>(container, body);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async updateEntry(entry: Entry,
                    updateMask?: string[],
                    aspectKeys?: string[]): Promise<api.ApiResult<Entry>> {
    const params: Record<string, any> = {};
    if (updateMask && updateMask.length) {
      params.updateMask = updateMask.join(',');
    }
    if (aspectKeys && aspectKeys.length) {
      params.aspectKeys = aspectKeys;
    }

    const res = await this._patch<Entry>(entry.name, entry, params);
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async *listEntries(project: string, location: string,
                     entryGroup: string): AsyncGenerator<Entry, void, unknown> {
    const parent = catalogContainer(project, location, entryGroup);
    const resourceName = `${parent}/entries`;

    let pageToken: string | undefined = undefined;
    do {
      const params: Record<string, string | number> = { pageSize: 1000 };
      if (pageToken) {
        params.pageToken = pageToken;
      }

      const res = await this._get<EntryList>(resourceName, params);
      if (res.status !== 200) {
        throw new Error(`Failed to list entries: ${res.message || res.status}`);
      }

      const entries = res.result?.entries || [];
      for (const entry of entries) {
        await _fixEntry(entry, this.context);
        yield entry;
      }

      pageToken = res.result?.nextPageToken;
    } while (pageToken);
  }

  async createEntry(project: string, location: string, entryGroup: string, 
                    entryId: string, entry?: Entry): Promise<api.ApiResult<Entry>> {
    const parent = catalogContainer(project, location, entryGroup);
    const resourceName = `${parent}/entries`;

    const params: Record<string, any> = { entryId };

    const res = await this._post<Entry>(resourceName, entry, params);
    
    if (res.status == 200 && res.result) {
      await _fixEntry(res.result, this.context);
    }

    return res;
  }

  async createEntryGroup(project: string, location: string,
                         entryGroupId: string, entryGroup?: EntryGroup): Promise<api.ApiResult<EntryGroup>> {
    const parent = catalogContainer(project, location);
    const resourceName = `${parent}/entryGroups`;

    const params: Record<string, any> = { entryGroupId };

    const res = await this._post<Operation>(resourceName, entryGroup ?? {}, params);
    return this._awaitCreate<EntryGroup>(res);
  }

  // Creates a custom aspect type. The metadataTemplate defines the CLOSED schema
  // that aspect data of this type is validated against, so it must match the
  // shape of the aspects written for it (see semantic/catalog.ts). This is an LRO.
  async createAspectType(project: string, location: string, aspectTypeId: string,
                         aspectType: Partial<AspectType>): Promise<api.ApiResult<AspectType>> {
    const parent = catalogContainer(project, location);
    const resourceName = `${parent}/aspectTypes`;

    const res = await this._post<Operation>(resourceName, aspectType, { aspectTypeId });
    return this._awaitCreate<AspectType>(res);
  }

  // Creates a custom entry type. This is an LRO. A freshly created entry type can
  // lag a few seconds before entries.create sees it (callers should retry the
  // "may not exist" propagation window).
  async createEntryType(project: string, location: string, entryTypeId: string,
                        entryType: Partial<EntryType> = {}): Promise<api.ApiResult<EntryType>> {
    const parent = catalogContainer(project, location);
    const resourceName = `${parent}/entryTypes`;

    const res = await this._post<Operation>(resourceName, entryType, { entryTypeId });
    return this._awaitCreate<EntryType>(res);
  }

  // Creates an entry link between two entries in an entry group. Synchronous
  // (no LRO), like createEntry.
  async createEntryLink(project: string, location: string, entryGroup: string,
                        entryLinkId: string, entryLink: Record<string, any>): Promise<api.ApiResult<any>> {
    const parent = catalogContainer(project, location, entryGroup);
    const resourceName = `${parent}/entryLinks`;

    return this._post<any>(resourceName, entryLink, { entryLinkId });
  }

  // Polls a long-running operation until it completes, then returns an ApiResult
  // shaped like the synchronous creates: the created resource on success, or the
  // operation's error mapped to a status/message. A response that is not an
  // operation (e.g. a resource returned directly) is passed through unchanged.
  async awaitOperation<T>(op: Operation | undefined,
                          { tries = 40, delayMs = 1500 } = {}): Promise<api.ApiResult<T>> {
    if (!op?.name || !op.name.includes('/operations/')) {
      return { status: 200, result: op as unknown as T };
    }
    // A transient poll error (5xx/429) must not fail an in-progress operation:
    // remember it and keep polling, surfacing it only if the tries run out.
    let lastErr: api.ApiResult<T> = { status: 504, message: `operation timed out: ${op.name}` };
    for (let i = 0; i < tries; i++) {
      const res = await this._get<Operation>(op.name);
      if (res.status === 200) {
        const done = res.result;
        if (done?.done) {
          if (done.error) {
            return { status: done.error.code ?? 500, message: done.error.message ?? 'operation failed' };
          }
          return { status: 200, result: (done.response ?? done) as T };
        }
      }
      else if (res.status >= 500 || res.status === 429) {
        lastErr = { status: res.status, message: res.message };
      }
      else {
        return { status: res.status, message: res.message };
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    return lastErr;
  }

  // Bridges an LRO-create POST to the resource result: if the POST itself failed
  // (e.g. 409 ALREADY_EXISTS), return it verbatim; otherwise await the operation.
  private async _awaitCreate<T>(res: api.ApiResult<Operation>): Promise<api.ApiResult<T>> {
    if (res.status !== 200) return { status: res.status, message: res.message };
    return this.awaitOperation<T>(res.result);
  }

}


// Fix all entries and aspects to consistently use project id. Its currently a mess with an
// inconsistent mix of project ids and unusable project numbers.
async function _fixEntry(entry: Entry, ctx: context.ApiContext): Promise<void> {
  entry.name = await crm.fixProject(entry.name, ctx);
  entry.entryType = await crm.fixProject(entry.entryType, ctx);
  if (entry.entrySource?.resource) {
    entry.entrySource.resource = await crm.fixProject(entry.entrySource.resource, ctx);
  }

  if (entry.aspects) {
    const fixedAspects: Record<string, Aspect> = {};
    for (const [aspectKey, aspectValue] of Object.entries(entry.aspects)) {
      let aspectType = '';
      if (!aspectValue || Object.keys(aspectValue).length) {
        aspectType = _typeRefToName(aspectKey, 'aspect');
      }
      else {
        aspectType = aspectValue['aspectType'] as string;
      }
      aspectType = await crm.fixProject(aspectType, ctx);

      fixedAspects[_nameToTypeRef(aspectType)] = {
        aspectType: aspectType,
        data: aspectValue['data'] ?? {}
      };
    }
    entry.aspects = fixedAspects;
  }
}

// Constructs canonical names for catalog container resources, identified by project, location and
// optionally, depending on use-case, the entry group.
export function catalogContainer(project: string, location: string, entryGroup: string=''): string {
  let container = `projects/${project}/locations/${location}`;
  if (entryGroup) {
    container += `/entryGroups/${entryGroup}`;
  }

  return container;
}

// Converts project.location.type to projects/${project}/locations/${location}/typeTypes/${type}
export function _typeRefToName(ref: string, type: string): string {
  const refParts = ref.split('.');
  if (refParts.length !== 3) {
    throw new Error(`Invalid type reference: ${ref}`);
  }
  return `projects/${refParts[0]}/locations/${refParts[1]}/${type}Types/${refParts[2]}`;
}

// Converts projects/${project}/locations/${location}/typeTypes/${type} -> project.location.type
export function _nameToTypeRef(name: string): string {
  const nameParts = name.split('/');
  if (nameParts.length < 6) {
    throw new Error(`Invalid type name: ${name}`);
  }
  return `${nameParts[1]}.${nameParts[3]}.${nameParts[5]}`;
}
