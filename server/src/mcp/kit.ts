import type {
  CallToolResult,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { SyncData } from '../../../shared/types';
import type { UserRow } from '../db';
import { runVia } from '../lib/via';
import type { TokenPrincipal } from '../oauth/tokens';
import { ApiCallError, callApi } from './api';
import { ToolError } from './support';

/** Everything a tool call runs with: the token owner and what the token allows. */
export interface ToolEnv {
  user: UserRow;
  principal: TokenPrincipal;
  canWrite: boolean;
  /** The app's own sync payload for this user (cached per MCP request). */
  sync(): Promise<SyncData>;
  /** Drop the cached payload after a write, so later reads see it. */
  invalidate(): void;
}

export function makeEnv(user: UserRow, principal: TokenPrincipal, canWrite: boolean): ToolEnv {
  let cached: Promise<SyncData> | null = null;
  return {
    user,
    principal,
    canWrite,
    sync: () => (cached ??= callApi<SyncData>(user, 'GET', '/api/sync')),
    invalidate: () => {
      cached = null;
    },
  };
}

/** The JSON answer of a tool, as text for the model and as structured content. */
export function ok(data: Record<string, unknown>, lead?: string): CallToolResult {
  const json = JSON.stringify(data);
  return {
    content: [{ type: 'text', text: lead ? `${lead}\n\n${json}` : json }],
    structuredContent: data,
  };
}

export function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

/** API answers the assistant can act on, in its terms rather than HTTP's. */
const API_HINTS: Record<string, string> = {
  conflict:
    'The expense changed since you read it (expected_updated_at no longer matches). Fetch it again with get_expense and retry.',
  stale:
    'Balances changed while the payment was being recorded. Call record_payment again to use the fresh balance.',
  'part of a settle-up': 'This row is part of a settle-up payment: use undo_payment instead.',
  'departed member':
    'That change would move the balance of someone who has left the group, which is not allowed.',
  'key reused':
    'This idempotency_key was already used for a different expense. Use a new key, or look at the existing expense.',
  'already saved and later removed':
    'An expense was already recorded with this idempotency_key and has since been deleted.',
  'not found': 'Not found — it does not exist, or it is not visible to you.',
};

export function toolError(err: unknown): CallToolResult {
  let message: string;
  if (err instanceof ToolError) {
    message = err.message;
  } else if (err instanceof ApiCallError) {
    const hint = API_HINTS[err.message];
    const id = typeof err.data.expenseId === 'number' ? ` (expense id ${err.data.expenseId})` : '';
    message = hint ? `${hint}${id}` : `Splitup rejected this: ${err.message}${id}`;
  } else if (err instanceof HTTPException) {
    message = err.message;
  } else {
    console.error('mcp tool failed', err);
    message = 'Internal error in Splitup. Nothing further was changed by this call.';
  }
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** A person (or group) by id, exact/partial name, or email. Advertised as a plain string. */
export const ref = (what: string) =>
  z
    .union([z.number().int().positive(), z.string().trim().min(1).max(200)])
    .describe(
      `${what}: numeric id like "12", name (partial ok), or email. "me" means the signed-in user.`,
    );

/** A row id. Advertised as an integer; a numeric string like "12" is accepted too. */
export const idInput = (what?: string) => {
  const schema = z.preprocess(
    (v) => (typeof v === 'string' && /^\s*\d{1,15}\s*$/.test(v) ? Number(v) : v),
    z.number().int().positive(),
  );
  return what ? schema.describe(what) : schema;
};

export const amountInput = (what: string) =>
  z
    .union([z.string().trim().min(1).max(40), z.number().positive()])
    .describe(`${what} as a decimal string in major units, e.g. "1250.50" (not minor units)`);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date; `note` (e.g. "default: today") is added to the description. */
export const isoDay = (note?: string) =>
  z
    .string()
    .regex(ISO_DAY, 'use YYYY-MM-DD')
    .describe(note ? `Calendar date, YYYY-MM-DD (${note})` : 'Calendar date, YYYY-MM-DD');

export const currencyCode = (note = 'e.g. INR') =>
  z
    .string()
    .regex(/^[A-Z]{3}$/)
    .describe(`ISO 4217 currency code, ${note}`);

export const confirmFlag = z
  .literal(true)
  .describe('Must be true. Only set it after the user explicitly confirmed this action.');

type JsonSchema = Record<string, unknown>;

/** Above this a numeric bound is a representation limit, not a rule worth telling the model. */
const MEANINGFUL_BOUND = 1e9;

const clause = (text: string) => text.trim().replace(/\.$/, '');

/**
 * Rewrites a JSON Schema into the subset every LLM provider accepts for tool
 * parameters (Gemini function declarations, OpenAI/Azure strict-ish validators,
 * OpenRouter backends): only type, description, properties, required, items
 * and string enums. Unions collapse to their most permissive simple type
 * (id|name → string, null branches dropped), and bounds, defaults and formats
 * move into the description. The zod schema still validates every call, so
 * nothing gets looser server-side — the advertised shape just gets plainer.
 */
function portable(node: JsonSchema): JsonSchema {
  const notes: string[] = [];
  let s = node;
  const alts = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (alts) {
    const { anyOf: _a, oneOf: _o, ...rest } = s;
    s = { ...collapse(alts.filter((a) => a.type !== 'null')), ...rest };
  }
  if (s.$ref !== undefined || s.allOf !== undefined) {
    throw new Error('portable(): $ref / allOf are not supported in tool schemas');
  }

  let type = s.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? 'string';
  let values = s.enum as unknown[] | undefined;
  if (s.const !== undefined) {
    if (typeof s.const === 'string') values = [s.const];
    else type = typeof s.const === 'boolean' ? 'boolean' : 'number';
    type ??= 'string';
  }
  if (values) {
    values = values.filter((v) => v !== null);
    if (values.every((v) => typeof v === 'string')) type = 'string';
    else {
      notes.push(`One of ${values.map((v) => JSON.stringify(v)).join(', ')}`);
      values = undefined;
    }
  }
  if (type === undefined) type = s.properties ? 'object' : 'string';

  const description = typeof s.description === 'string' ? s.description : '';
  if (type === 'integer' || type === 'number') {
    const kind = type === 'integer' ? 'Integer' : 'Number';
    const min = s.minimum as number | undefined;
    const max = s.maximum as number | undefined;
    const xmin = s.exclusiveMinimum as number | undefined;
    const xmax = s.exclusiveMaximum as number | undefined;
    const lo =
      min !== undefined
        ? `${min}`
        : xmin === undefined
          ? null
          : type === 'integer'
            ? `${xmin + 1}`
            : null;
    const hi = max !== undefined && Math.abs(max) < MEANINGFUL_BOUND ? `${max}` : null;
    if (lo !== null && hi !== null) notes.push(`${kind} ${lo}–${hi}`);
    else if (lo !== null && lo !== '1') notes.push(`${kind} ≥ ${lo}`);
    else if (lo === null && xmin !== undefined) notes.push(`Greater than ${xmin}`);
    else if (hi !== null) notes.push(`${kind} ≤ ${hi}`);
    if (xmax !== undefined && Math.abs(xmax) < MEANINGFUL_BOUND) notes.push(`Less than ${xmax}`);
  }
  if (type === 'string' && !description) {
    if (typeof s.format === 'string') notes.push(`Format: ${s.format}`);
    else if (typeof s.pattern === 'string') notes.push(`Must match ${s.pattern}`);
  }
  if (type === 'array' && typeof s.minItems === 'number' && s.minItems > 0) {
    notes.push(`At least ${s.minItems} item${s.minItems === 1 ? '' : 's'}`);
  }
  if (s.default !== undefined && !/default/i.test(description)) {
    notes.push(`Default: ${JSON.stringify(s.default)}`);
  }

  const out: JsonSchema = { type };
  const text = [description, ...notes].filter(Boolean).map(clause).join('. ');
  if (text) out.description = text;
  if (values) out.enum = values;
  if (type === 'array')
    out.items = portable((s.items as JsonSchema | undefined) ?? { type: 'string' });
  if (type === 'object') {
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    out.properties = Object.fromEntries(
      Object.entries(props).map(([key, value]) => [key, portable(value)]),
    );
    const required = ((s.required ?? []) as string[]).filter((key) => key in props);
    if (required.length > 0) out.required = required;
  }
  return out;
}

/** One simple schema standing in for a union: string wins, then number, then the first branch. */
function collapse(alts: JsonSchema[]): JsonSchema {
  if (alts.length === 1) return alts[0];
  const simple = alts.map(portable);
  if (simple.every((a) => Array.isArray(a.enum))) {
    return { type: 'string', enum: [...new Set(simple.flatMap((a) => a.enum as string[]))] };
  }
  const described = alts.find((a) => typeof a.description === 'string');
  const keep = described ? { description: described.description } : {};
  if (simple.some((a) => a.type === 'string')) return { type: 'string', ...keep };
  if (simple.every((a) => a.type === 'integer')) return { type: 'integer', ...keep };
  if (simple.every((a) => a.type === 'integer' || a.type === 'number')) {
    return { type: 'number', ...keep };
  }
  return alts[0];
}

/** The JSON Schema a tool advertises in tools/list (see {@link portable}). */
export const advertisedSchema = (schema: z.ZodType): JsonSchema =>
  portable(z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as JsonSchema);

/** A Standard Schema that validates with zod but advertises the portable JSON Schema. */
function portableInput<S extends z.ZodObject>(
  schema: S,
): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  let json: JsonSchema | undefined;
  const advertised = () => (json ??= advertisedSchema(schema));
  return {
    '~standard': {
      version: 1,
      vendor: 'splitup',
      validate: schema['~standard'].validate,
      jsonSchema: { input: advertised, output: advertised },
    },
  };
}

interface ToolSpec<S extends z.ZodObject> {
  title: string;
  description: string;
  input: S;
  /** Needs splitup.write; such tools aren't even listed for read-only tokens. */
  write?: boolean;
  annotations: Omit<ToolAnnotations, 'title'>;
}

/**
 * Registers one tool: scope gate, "(via <client>)" attribution for writes,
 * error mapping, and a log line with tool, user and duration only — never
 * amounts, names or other content.
 */
export function defineTool<S extends z.ZodObject>(
  server: McpServer,
  env: ToolEnv,
  name: string,
  spec: ToolSpec<S>,
  run: (args: z.infer<S>, ctx: ServerContext) => Promise<CallToolResult>,
): void {
  if (spec.write && !env.canWrite) return;
  const handler = async (args: z.infer<S>, ctx: ServerContext): Promise<CallToolResult> => {
    const started = performance.now();
    let outcome = 'ok';
    try {
      if (spec.write && !env.canWrite) throw new ToolError('this token is read-only');
      const result = spec.write
        ? await runVia(env.principal.clientName, () => run(args, ctx))
        : await run(args, ctx);
      if (spec.write) env.invalidate();
      if (result.isError) outcome = 'error';
      return result;
    } catch (err) {
      outcome = 'error';
      return toolError(err);
    } finally {
      console.log(
        JSON.stringify({
          mcp: 'tool',
          tool: name,
          user: env.user.id,
          via: env.principal.kind,
          ms: Math.round(performance.now() - started),
          outcome,
        }),
      );
    }
  };
  server.registerTool(
    name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: portableInput(spec.input),
      annotations: { title: spec.title, openWorldHint: false, ...spec.annotations },
    },
    handler as never,
  );
}
