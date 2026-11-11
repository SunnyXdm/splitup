import type {
  CallToolResult,
  McpServer,
  ServerContext,
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

/** A person (or group) by id, exact/partial name, or email. */
export const ref = (what: string) =>
  z
    .union([z.number().int().positive(), z.string().trim().min(1).max(200)])
    .describe(`${what}: numeric id, name (partial ok), or email. "me" means the signed-in user.`);

export const amountInput = (what: string) =>
  z
    .union([z.string().trim().min(1).max(40), z.number().positive()])
    .describe(`${what} as a decimal string in major units, e.g. "1250.50" (not minor units)`);

export const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
  .describe('Calendar date, YYYY-MM-DD');

export const confirmFlag = z
  .literal(true)
  .describe('Must be true. Only set it after the user explicitly confirmed this action.');

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
      inputSchema: spec.input,
      annotations: { title: spec.title, openWorldHint: false, ...spec.annotations },
    },
    handler as never,
  );
}
