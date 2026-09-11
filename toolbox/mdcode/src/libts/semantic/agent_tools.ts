/**
 * Turning a model into agent tools.
 *
 * An agent needs two things from a model: a way to look at what is there, and
 * a way to change it. Both are already declared.
 *
 * An action declares everything a write tool needs: a name, a description of
 * what it does, its typed parameters, the guidance an AI caller should follow
 * (`ai_context.instructions`), and the rules that gate it. An entity plus its
 * binding profile declares everything a read tool needs: the fields, and the
 * table and columns they resolve to. This module reads both out and hands back
 * plain descriptions of the tools, each with a function that runs it.
 *
 * The description is framework-neutral on purpose. Nothing here imports an
 * agent framework, so binding these to Google ADK, to LangChain, or to an MCP
 * server is a short adapter the caller writes, and adding a second framework
 * costs nothing in this file. See demo/credit/agent.ts for the ADK adapter,
 * which is eight lines.
 *
 * What this module does NOT do is decide anything. A tool built here is a way
 * to ask; every rule is still checked by runAction inside the Spanner
 * transaction, against the uncommitted rows. An agent that calls a tool with a
 * bad amount gets an outcome it has to report, and it has no way to overrule
 * one -- `approvals` is not reachable from here, by construction, because the
 * caller that needs approving is not the party that grants it.
 */

import * as spanner from '../gcp/spanner';

import {Action, Entity, SemanticModel} from './ir';
import {ActionOutcome, runAction} from './runtime';
import {spannerTable} from './spanner';
import {quoteIfReserved} from './sql_identifiers';


/** The JSON types a tool parameter can take. */
export type ToolParameterType = 'string'|'number'|'integer'|'boolean';


/** One argument a tool accepts, derived from an action parameter. */
export interface ToolParameter {
  name: string;
  type: ToolParameterType;
  /** What to pass, in the words the model's own types justify. */
  description: string;
  /** Action parameters are all required; entity filters are all optional. */
  required: boolean;
}


/** One tool, derived from one action. */
export interface ActionTool {
  /** The action name in snake_case, which is what tool APIs expect. */
  name: string;
  /** The action this tool calls, by its authored name. */
  actionName: string;
  /**
   * What the tool does and how to call it: the action's description, its
   * `ai_context.instructions`, and a line naming the rules that gate it so a
   * caller learns the shape of a refusal before it hits one.
   */
  description: string;
  parameters: ToolParameter[];
  /** Runs the action and reports the outcome in terms an agent can act on. */
  invoke(args: Record<string, unknown>): Promise<ToolResult>;
}


/**
 * What a caller is told after invoking a tool.
 *
 * A refusal and a held write read differently on purpose. One is something to
 * fix and retry, the other is something to report and stop. Neither leaves the
 * caller an approval to grant.
 */
export interface ToolResult {
  applied: boolean;
  /** Present when the write committed. */
  committedAt?: string;
  /** The rules that were checked, so a caller can show its work. */
  rulesChecked?: string[];
  /** Why the write did not happen, in the violated rules' own words. */
  reason?: string;
  /** The rules a refusal broke. */
  rulesBroken?: string[];
  /** The rules a human must sign off before this write can proceed. */
  needsApprovalFor?: string[];
  /** What the caller should do next, when the outcome permits only one thing. */
  whatToDo?: string;
}


export interface ActionToolOptions {
  model: SemanticModel;
  client: spanner.SpannerDataClient;
  /** Cap on the violating rows a probe reports; passed through to runAction. */
  violationLimit?: number;
}


/**
 * One tool per action the model declares, in declaration order.
 *
 * A model with no actions yields no tools, which is the honest answer: an
 * agent over a read-only model has nothing to call.
 */
export function actionTools(opts: ActionToolOptions): ActionTool[] {
  return (opts.model.actions ?? []).map(action => toolFor(action, opts));
}


function toolFor(action: Action, opts: ActionToolOptions): ActionTool {
  return {
    name: snakeCase(action.name),
    actionName: action.name,
    description: toolDescription(action, opts.model),
    parameters: action.parameters.map(p => toolParameter(p, opts.model)),
    async invoke(args: Record<string, unknown>): Promise<ToolResult> {
      const outcome = await runAction({
        model: opts.model,
        actionName: action.name,
        args,
        client: opts.client,
        violationLimit: opts.violationLimit,
      });
      return describeOutcome(outcome);
    },
  };
}


// The three sources of description, in the order a caller needs them: what the
// action does, how to call it, and what a refusal will look like. A model that
// supplies none of them still yields a usable tool, because the parameter
// descriptions carry their own types.
function toolDescription(action: Action, model: SemanticModel): string {
  const parts: string[] = [];
  if (action.description) parts.push(action.description.trim());
  const instructions = action.aiContext?.instructions?.trim();
  if (instructions) parts.push(instructions);

  const gates = gatingRules(action, model);
  if (gates.length) {
    parts.push(
        `This call is checked against ${joinNames(gates)}. A check that ` +
        `fails comes back as a refusal or as a request for a human ` +
        `decision, and the reason is text you should report as given.`);
  }
  return parts.join('\n\n');
}


// Which rules a caller will meet. `guards` names the ones checked before the
// write; a constraint over stored state is checked after it and is not named
// here, because a caller cannot do anything differently about one.
function gatingRules(action: Action, model: SemanticModel): string[] {
  const declared = new Set((model.constraints ?? []).map(c => c.name));
  return (action.guards ?? []).filter(name => declared.has(name));
}


// An entity-typed parameter takes a reference the runtime resolves, so the
// description says so rather than demanding a key the caller may not have. A
// scalar parameter takes its own type.
function toolParameter(
    param: {name: string; type: string; isEntityRef?: boolean},
    model: SemanticModel): ToolParameter {
  if (param.isEntityRef) {
    return {
      name: param.name,
      type: 'string',
      description: `Which ${param.type} this applies to. Give its key, or ` +
          `text that identifies exactly one; the call fails when nothing ` +
          `matches or more than one does.`,
      required: true,
    };
  }
  return {
    name: param.name,
    type: jsonType(param.type),
    description: `The ${param.name}, as ${article(param.type)}.`,
    required: true,
  };
}


// The model's scalar types over the four JSON types a tool schema can express.
// Anything temporal or opaque travels as a string, because that is what the
// model's own text form uses and what the store parses back.
function jsonType(dataType: string): ToolParameterType {
  switch (dataType) {
    case 'Integer':
      return 'integer';
    case 'Decimal':
    case 'Float':
      return 'number';
    case 'Boolean':
      return 'boolean';
    default:
      return 'string';
  }
}


function article(dataType: string): string {
  switch (dataType) {
    case 'Integer':
      return 'a whole number';
    case 'Decimal':
      return 'a decimal number';
    case 'Float':
      return 'a number';
    case 'Boolean':
      return 'true or false';
    case 'Date':
      return 'a date, YYYY-MM-DD';
    case 'Time':
      return 'a time, HH:MM:SS';
    case 'DateTime':
    case 'DateTimeTz':
      return 'a timestamp in RFC 3339 form';
    default:
      return 'text';
  }
}


/**
 * An outcome in the terms a caller can act on.
 *
 * Exported because an adapter for a framework with its own result shape needs
 * this mapping without needing the rest of the tool.
 */
export function describeOutcome(outcome: ActionOutcome): ToolResult {
  switch (outcome.status) {
    case 'committed': {
      const result: ToolResult = {
        applied: true,
        committedAt: outcome.commitTimestamp,
        rulesChecked: outcome.checked,
      };
      if (outcome.warnings.length) {
        result.reason = outcome.warnings.map(w => w.message).join(' ');
      }
      return result;
    }
    case 'escalated':
      return {
        applied: false,
        reason: outcome.message,
        needsApprovalFor: outcome.approvalRequired,
        whatToDo: 'Report this and stop. You cannot approve it yourself, ' +
            'and retrying the same call changes nothing.',
      };
    case 'rejected':
      return {
        applied: false,
        reason: outcome.message,
        rulesBroken: outcome.violations.map(v => v.constraint),
        whatToDo: 'Correct the problem the reason describes, or report it. ' +
            'Nobody can approve this one.',
      };
    case 'error':
      return {applied: false, reason: outcome.message};
  }
}


// `IssueCredit` -> `issue_credit`, `HTTPRetry` -> `http_retry`. Tool names are
// snake_case across every framework this targets, and an action name is
// PascalCase by the model's own convention.
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_')
      .toLowerCase();
}


function joinNames(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}


// ---------------------------------------------------------------------------
// The read side: one lookup tool per entity.
// ---------------------------------------------------------------------------

/**
 * Rows a lookup tool returned, with the field names they line up with.
 *
 * Values are strings because that is what the store returns over REST, and
 * because a tool result is read by a language model rather than by arithmetic.
 */
export interface EntityRows {
  entity: string;
  fields: string[];
  rows: string[][];
  /** True when the row cap cut the answer short, so a caller can narrow it. */
  truncated: boolean;
  /** Set instead of rows when the entity cannot be read, saying why. */
  problem?: string;
}


/** One lookup tool, derived from one entity and its binding. */
export interface EntityTool {
  name: string;
  entityName: string;
  description: string;
  /** One optional exact-match filter per bound field. */
  parameters: ToolParameter[];
  invoke(args: Record<string, unknown>): Promise<EntityRows>;
}


export interface EntityToolOptions {
  model: SemanticModel;
  client: spanner.SpannerDataClient;
  /** Most rows one call returns. Defaults to 50. */
  rowLimit?: number;
}


const DEFAULT_ROW_LIMIT = 50;


/**
 * One lookup tool per entity the model declares, in declaration order.
 *
 * What these tools can express is deliberately narrow: exact match on any
 * bound field, combined with AND, capped at `rowLimit` rows. No joins, no
 * ranges, no aggregation and no ordering. That is enough for an agent to find
 * the object an action needs, which is the job here, and it keeps the derived
 * SQL something a reader can check by eye. A model that needs richer questions
 * answered wants a metric or a query surface declared in the model, rather
 * than a more clever generator over this one.
 *
 * Table and column names come from the model's binding, never from an
 * argument; filter values are bound parameters. So no caller-supplied text
 * reaches the SQL text.
 */
export function entityTools(opts: EntityToolOptions): EntityTool[] {
  return (opts.model.entities ?? []).map(entity => lookupFor(entity, opts));
}


function lookupFor(entity: Entity, opts: EntityToolOptions): EntityTool {
  const bound = boundFields(entity);
  return {
    name: `find_${snakeCase(entity.name)}`,
    entityName: entity.name,
    description: lookupDescription(entity, bound),
    parameters: bound.map(f => ({
                            name: f.name,
                            type: jsonType(f.type),
                            description: `Match ${entity.name}.${
                                f.name} exactly. Omit to leave it unfiltered.`,
                            required: false,
                          })),
    async invoke(args: Record<string, unknown>): Promise<EntityRows> {
      return await runLookup(entity, bound, args, opts);
    },
  };
}


// A field is readable when the profile bound it to a plain column. One bound
// to an expression is skipped rather than guessed at, and an entity with no
// plain-column fields yields a tool that reports the problem when called.
interface BoundField {
  name: string;
  type: string;
  column: string;
}


function boundFields(entity: Entity): BoundField[] {
  const bound: BoundField[] = [];
  for (const field of entity.fields) {
    const expr = (field.expression ?? '').trim();
    if (!expr || !/^[A-Za-z_]\w*$/.test(expr)) continue;
    // A field with no declared type travels as text, which is the carrier
    // every scalar has a faithful string form in.
    bound.push({name: field.name, type: field.type ?? 'String', column: expr});
  }
  return bound;
}


function lookupDescription(entity: Entity, bound: BoundField[]): string {
  const parts: string[] = [];
  parts.push(
      entity.description?.trim() ||
      `Look up ${entity.name} records.`);
  if (bound.length) {
    parts.push(
        `Returns ${bound.map(f => f.name).join(', ')}. Every argument is an ` +
        `exact match and every one is optional; giving none returns the ` +
        `first rows. This tool cannot join, compare ranges, or total ` +
        `anything.`);
  }
  const instructions = entity.aiContext?.instructions?.trim();
  if (instructions) parts.push(instructions);
  return parts.join('\n\n');
}


async function runLookup(
    entity: Entity, bound: BoundField[], args: Record<string, unknown>,
    opts: EntityToolOptions): Promise<EntityRows> {
  const empty = {entity: entity.name, fields: [], rows: [], truncated: false};
  if (!bound.length) {
    return {
      ...empty,
      problem: `No field of ${entity.name} is bound to a plain column, so ` +
          `there is nothing to read. Push the model with a binding profile.`,
    };
  }

  const warnings: string[] = [];
  const table =
      spannerTable(entity.dataSource, warnings, `entity '${entity.name}'`);
  if (warnings.length) {
    return {...empty, problem: warnings.join('; ')};
  }

  // Only field names the model declares reach the SQL, and every value is
  // bound. An argument naming an unknown field is a caller error worth
  // reporting rather than ignoring.
  const predicates: string[] = [];
  const params: Record<string, string> = {};
  const paramTypes: Record<string, {code: string}> = {};
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    const field = bound.find(f => f.name === name);
    if (!field) {
      return {
        ...empty,
        problem: `${entity.name} has no readable field '${name}'. It has ${
            bound.map(f => f.name).join(', ')}.`,
      };
    }
    const bind = `f_${predicates.length}`;
    predicates.push(
        `CAST(${quoteIfReserved(field.column)} AS STRING) = @${bind}`);
    params[bind] = `${value}`;
    paramTypes[bind] = {code: 'STRING'};
  }

  const limit = opts.rowLimit ?? DEFAULT_ROW_LIMIT;
  const columns =
      bound.map(f => `CAST(${quoteIfReserved(f.column)} AS STRING)`).join(', ');
  const where = predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '';
  // One row over the cap, so "there are more" can be told from "that is all".
  const sql = `SELECT ${columns} FROM ${table}${where} LIMIT ${limit + 1}`;

  const rows = await opts.client.withSession(async sessionName => {
    const res = await opts.client.executeQuery(
        sessionName, {sql, params, paramTypes});
    if (res.status < 200 || res.status >= 300) {
      throw new Error(res.message ?? `${res.status}`);
    }
    return res.result?.rows ?? [];
  });

  return {
    entity: entity.name,
    fields: bound.map(f => f.name),
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}
