// API client for BigQuery
//

import * as api from './api';
import * as context from './context';


export interface Dataset {
  id: string;
  datasetReference: {
    projectId: string;
    datasetId: string;
  };
  location: string;
  [key: string]: any;
}

export interface Table {
  id: string;
  tableReference: {
    projectId: string;
    datasetId: string;
    tableId: string;
  };
  [key: string]: any;
}

interface TableList {
  tables: Table[];
  nextPageToken?: string;
}

export interface QueryError {
  reason?: string;
  location?: string;
  message?: string;
}

export interface QueryResponse {
  jobComplete?: boolean;
  // jobs.query returns query-level errors here (often with HTTP 200), so callers
  // must check this in addition to the HTTP status.
  errors?: QueryError[];
  [key: string]: any;
}


export class BigQueryClient extends api.ApiClient {

  constructor(ctx: context.ApiContext) {
    super('https://bigquery.googleapis.com', 'bigquery/v2', ctx);
  }

  async getDataset(project: string, dataset: string): Promise<api.ApiResult<Dataset>> {
    const name = `projects/${project}/datasets/${dataset}`;
    const params: Record<string, any> = { datasetView: 'METADATA' };

    return await this._get(name, params);
  }

  async *listTables(project: string, dataset: string): AsyncGenerator<Table> {
    const name = `projects/${project}/datasets/${dataset}/tables`;

    let pageToken: string | undefined = undefined;
    do {
      const params: Record<string, any> = { maxResults: 500 };
      if (pageToken) {
        params.pageToken = pageToken;
      }

      const res = await this._get<TableList>(name, params);
      if (res.status !== 200) {
        throw new Error(`Failed to list tables: ${res.message || res.status}`);
      }

      const tables = res.result?.tables || [];
      for (const table of tables) {
        yield table;
      }

      pageToken = res.result?.nextPageToken;
    } while (pageToken);
  }

  // Runs a SQL statement (including DDL, e.g. CREATE OR REPLACE PROPERTY GRAPH)
  // synchronously via jobs.query, billed to `project`. Query-level failures may
  // be reported either by a non-200 status or by a populated `errors` array on a
  // 200 response, so callers should inspect both.
  async query(project: string, sql: string): Promise<api.ApiResult<QueryResponse>> {
    const name = `projects/${project}/queries`;
    const body = { query: sql, useLegacySql: false };
    return await this._post<QueryResponse>(name, body);
  }
}
