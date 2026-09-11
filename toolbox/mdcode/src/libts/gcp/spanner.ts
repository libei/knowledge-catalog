// API client for Cloud Spanner.
//
// Two surfaces, on two hosts:
//
//   * Database Admin -- updateDatabaseDdl (which returns a long-running
//     operation) and getOperation (to poll it). This is what the semantic-model
//     push leg needs to create a property graph.
//   * Data (SpannerDataClient) -- sessions and read-write transactions, so a
//     caller can run DML and queries and decide whether to commit. This is what
//     the semantic runtime needs: it applies an action's writes, evaluates the
//     model's constraints against the UNCOMMITTED state in the same
//     transaction, and then commits or rolls back.
//

import * as api from './api';
import * as context from './context';


// A long-running operation, as returned by updateDatabaseDdl and fetched by
// getOperation. `done` flips to true at completion; `error` is set on failure
// (a google.rpc.Status).
export interface Operation {
  name?: string;
  done?: boolean;
  error?: {code?: number; message?: string; [key: string]: any};
  response?: {[key: string]: any};
  metadata?: {[key: string]: any};
  [key: string]: any;
}


export class SpannerClient extends api.ApiClient {
  constructor(ctx: context.ApiContext) {
    super('https://spanner.googleapis.com', 'v1', ctx);
  }

  // Applies DDL statements to a database. This is asynchronous: the response is
  // a long-running Operation whose `name` the caller polls with getOperation
  // until `done`. Statements are applied in order. The REST binding for
  // updateDatabaseDdl is PATCH on the `.../ddl` collection (a POST 404s --
  // verified live), so this uses PATCH, not the more common POST-to-create.
  async updateDatabaseDdl(
      project: string, instance: string, database: string,
      statements: string[]): Promise<api.ApiResult<Operation>> {
    const name =
        `projects/${project}/instances/${instance}/databases/${database}/ddl`;
    return await this._patch<Operation>(name, {statements});
  }

  // Creates a database. Like DDL, this is asynchronous: the response is a
  // long-running Operation to poll with getOperation. The database name goes
  // inside a CREATE DATABASE statement rather than in a field, which is the
  // REST surface's own shape; it is backticked because a database may be named
  // for a reserved word.
  async createDatabase(
      project: string, instance: string, database: string,
      extraStatements: string[] = []): Promise<api.ApiResult<Operation>> {
    const parent = `projects/${project}/instances/${instance}/databases`;
    return await this._post<Operation>(parent, {
      createStatement: `CREATE DATABASE \`${database}\``,
      extraStatements,
    });
  }

  // Fetches a database. A 404 means it does not exist, which is the only
  // reliable way to ask: listing and matching names has to guess at whether the
  // surface returns bare ids or full resource paths.
  async getDatabase(project: string, instance: string, database: string):
      Promise<api.ApiResult<{name?: string; state?: string}>> {
    return await this._get<{name?: string; state?: string}>(
        `projects/${project}/instances/${instance}/databases/${database}`);
  }

  // Drops a database and everything in it. Synchronous, and irreversible.
  async dropDatabase(project: string, instance: string, database: string):
      Promise<api.ApiResult<{}>> {
    return await this._delete<{}>(
        `projects/${project}/instances/${instance}/databases/${database}`);
  }

  // Fetches a long-running operation by its resource name (as returned in
  // Operation.name, e.g.
  // `projects/.../instances/.../databases/.../operations/...`).
  async getOperation(operationName: string): Promise<api.ApiResult<Operation>> {
    return await this._get<Operation>(operationName);
  }
}


// A Spanner session, the handle every data-API call is scoped to. Sessions are
// server resources with a finite lifetime, so a caller creates one, uses it,
// and deletes it (see SpannerDataClient.withSession).
export interface Session {
  name?: string;
  [key: string]: any;
}


// A transaction handle returned by beginTransaction. `id` is the opaque token
// that subsequent executeSql / commit / rollback calls quote.
export interface Transaction {
  id?: string;
  [key: string]: any;
}


// One row of a query result. The Spanner REST surface returns values
// positionally in `rows` with the column layout in `metadata.rowType.fields`,
// and encodes every scalar as a STRING (an INT64 comes back as "42"), so a
// caller converts as needed.
export interface ResultSet {
  metadata?: {rowType?: {fields?: Array<{name?: string; type?: any}>}};
  rows?: string[][];
  stats?: {rowCountExact?: string; [key: string]: any};
  [key: string]: any;
}


// The parameter types accompanying a parameterized statement. Spanner infers
// most types from the JSON value, but cannot infer one for a NULL or for an
// empty array, so those must be declared. Codes are Spanner TypeCode names
// (e.g. 'INT64', 'STRING', 'FLOAT64', 'TIMESTAMP').
export type ParamTypes = Record<string, {code: string; arrayElementType?: {code: string}}>;


// A statement to run inside a transaction: SQL plus its named parameters
// (referenced as @name in the SQL).
export interface Statement {
  sql: string;
  params?: Record<string, any>;
  paramTypes?: ParamTypes;
}


// The Spanner DATA surface (spanner.googleapis.com/v1), a separate client from
// the Database Admin one above because the two share a host but nothing else:
// this one is scoped to a single database and speaks sessions, not operations.
//
// Read-write transactions here are explicit rather than a callback wrapper, so
// the caller keeps the decision to commit -- which is the whole point for the
// semantic runtime, whose gate runs between the write and the commit.
export class SpannerDataClient extends api.ApiClient {
  private readonly _database: string;
  // Per-transaction statement counter. Spanner REQUIRES a monotonically
  // increasing `seqno` on every DML statement in a read-write transaction --
  // it is how the server recognizes a retry of a statement it has already
  // applied, so that a retried DML is not applied twice. Sending the same seqno
  // with a DIFFERENT statement fails with "Previously received a different
  // request with this seqno", which is what makes a hand-rolled client fail on
  // its second statement. Tracking it here means a caller running several
  // statements in one transaction does not have to know about it at all.
  private readonly _seqno = new Map<string, number>();

  constructor(
      ctx: context.ApiContext, project: string, instance: string,
      database: string) {
    super('https://spanner.googleapis.com', 'v1', ctx);
    this._database =
        `projects/${project}/instances/${instance}/databases/${database}`;
  }

  get database(): string {
    return this._database;
  }

  async createSession(): Promise<api.ApiResult<Session>> {
    return await this._post<Session>(`${this._database}/sessions`, {});
  }

  async deleteSession(sessionName: string): Promise<api.ApiResult<{}>> {
    return await this._delete<{}>(sessionName);
  }

  // Starts a read-write transaction. Spanner also allows a single-use
  // transaction inlined on executeSql, but the runtime needs a durable id it
  // can hold across the write, the constraint probes, and the commit.
  async beginReadWrite(sessionName: string): Promise<api.ApiResult<Transaction>> {
    return await this._post<Transaction>(
        `${sessionName}:beginTransaction`, {options: {readWrite: {}}});
  }

  // Runs one statement inside `transactionId`. Used for both the action's DML
  // and the constraint probes, so the probes observe the transaction's own
  // uncommitted writes (read-your-writes) -- the property that makes the gate
  // meaningful.
  async executeSql(
      sessionName: string, transactionId: string,
      stmt: Statement): Promise<api.ApiResult<ResultSet>> {
    const seqno = (this._seqno.get(transactionId) ?? 0) + 1;
    this._seqno.set(transactionId, seqno);
    return await this._post<ResultSet>(`${sessionName}:executeSql`, {
      transaction: {id: transactionId},
      sql: stmt.sql,
      params: stmt.params,
      paramTypes: stmt.paramTypes,
      // Ignored for queries, required for DML; sent unconditionally so the
      // counter stays in step with the statements actually issued.
      seqno: `${seqno}`,
    });
  }

  // Runs one statement outside any read-write transaction, as a single-use
  // strong read. For a plain read -- showing state, resolving a display name --
  // there is nothing to commit, and holding a transaction open for it would add
  // a round trip and a rollback that say nothing.
  async executeQuery(sessionName: string, stmt: Statement):
      Promise<api.ApiResult<ResultSet>> {
    return await this._post<ResultSet>(`${sessionName}:executeSql`, {
      transaction: {singleUse: {readOnly: {strong: true}}},
      sql: stmt.sql,
      params: stmt.params,
      paramTypes: stmt.paramTypes,
    });
  }

  async commit(sessionName: string, transactionId: string):
      Promise<api.ApiResult<{commitTimestamp?: string}>> {
    this._seqno.delete(transactionId);
    return await this._post<{commitTimestamp?: string}>(
        `${sessionName}:commit`, {transactionId});
  }

  async rollback(sessionName: string, transactionId: string):
      Promise<api.ApiResult<{}>> {
    this._seqno.delete(transactionId);
    return await this._post<{}>(`${sessionName}:rollback`, {transactionId});
  }

  // Runs `fn` with a fresh session and deletes it afterwards, including when
  // `fn` throws -- a leaked session holds server resources until it ages out.
  async withSession<T>(fn: (sessionName: string) => Promise<T>): Promise<T> {
    const created = await this.createSession();
    const sessionName = created.result?.name;
    if (!sessionName) {
      throw new Error(
          `Spanner: could not create a session on ${this._database} (${
              created.status}${created.message ? `: ${created.message}` : ''})`);
    }
    try {
      return await fn(sessionName);
    } finally {
      await this.deleteSession(sessionName);
    }
  }
}
