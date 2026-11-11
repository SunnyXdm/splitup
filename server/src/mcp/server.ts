import { McpServer, ResourceTemplate, type AuthInfo } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { db, type UserRow } from '../db';
import { SCOPE_WRITE } from '../oauth/config';
import { principalOf } from '../oauth/tokens';
import { makeEnv, type ToolEnv } from './kit';
import { groupDetail, groupList, registerReadTools } from './tools-read';
import { registerWriteTools } from './tools-write';

export const INSTRUCTIONS = [
  'Splitup is a shared-expenses app (like Splitwise). These tools act as the signed-in user.',
  'Money: every amount is returned as { currency, minor, amount, formatted } — "minor" is ' +
    'integer minor units (cents/paise; 0 decimals for JPY, 3 for BHD), "amount" a plain ' +
    'decimal string, "formatted" for display. When you pass amounts, use decimal strings in ' +
    'major units ("1250.50"), never minor units. Currencies are ISO 4217 codes and are never ' +
    'added together: balances are per currency. A group has one currency and all its expenses ' +
    "use it; 1:1 expenses default to the user's default currency.",
  'Signs: a balance of +X means the OTHER side owes the user X; −X means the user owes X.',
  'Scopes: an expense lives either in a GROUP (split among its members, including guests ' +
    'without an account) or DIRECT between the user and one friend. Balances with a friend ' +
    'combine every shared group and direct expenses; inside a group the app simplifies debts ' +
    '(who pays whom), so group balances may route through people. Use get_balance / ' +
    'explain_balance rather than adding things up yourself.',
  'People and groups can be referred to by id, (partial) name or email; "me" is the user. ' +
    'If a name is ambiguous the tool lists the candidates — ask the user which one.',
  "Writes (needs the splitup.write scope) go through the app's own code paths: same " +
    'validation, the same edit history and undo (restore_expense, undo_payment), the activity ' +
    'feed (marked "via <this app>") and push notifications to the people involved. Always ' +
    'confirm the details with the user before adding, editing or paying, and get explicit ' +
    'confirmation before delete_expense, undo_payment or skip_due_bill (they require confirm: ' +
    'true). Pass an idempotency_key on add_expense / record_payment if you may retry.',
  'scan_receipt only reads a photo and returns a draft; nothing is saved until you call ' +
    'add_expense.',
].join('\n\n');

function userRow(id: number): UserRow {
  const user = db.prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('token owner vanished');
  return user;
}

function registerResources(server: McpServer, env: ToolEnv): void {
  const json = (uri: URL, data: unknown) => ({
    contents: [
      { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) },
    ],
  });
  server.registerResource(
    'groups',
    'splitup://groups',
    {
      title: 'Your groups',
      description: "The user's groups with their own balance in each",
      mimeType: 'application/json',
    },
    async (uri) => json(uri, { groups: groupList(await env.sync()) }),
  );
  server.registerResource(
    'group',
    new ResourceTemplate('splitup://groups/{id}', {
      list: async () => ({
        resources: (await env.sync()).groups.map((g) => ({
          uri: `splitup://groups/${g.id}`,
          name: g.name,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Group',
      description: 'Members, balances, suggested settlements and recent expenses of one group',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = Number(variables.id);
      return json(uri, groupDetail(await env.sync(), id, 20));
    },
  );
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'settle-up-summary',
    {
      title: 'Settle-up summary',
      description: 'Who owes whom right now, and the simplest way to settle up',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Using Splitup, summarize where I stand: call get_balance (no arguments) and ' +
              'list_friends, then tell me per currency who owes me and whom I owe, largest ' +
              'first. For each open balance suggest the payment that settles it (use ' +
              'explain_balance if a number looks surprising). Do not record anything — ask ' +
              'me which payments to record.',
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'monthly-recap',
    {
      title: 'Monthly recap',
      description: 'What I spent in a month, by category and group, plus notable activity',
      argsSchema: z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional()
          .describe('YYYY-MM (default: last month)'),
      }),
    },
    ({ month }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Give me a recap of my Splitup spending for ${month ?? 'last month'}: call ` +
              `spending_summary with period "${month ?? 'last-month'}", then summarize my ` +
              'share by category and the biggest expenses, compare groups where useful (call ' +
              'spending_summary per group), mention settle-up payments, and end with my ' +
              'current open balances from get_balance. Keep currencies separate.',
          },
        },
      ],
    }),
  );
}

/** One MCP server instance per request, bound to the verified token's owner. */
export function createSplitupServer(auth: AuthInfo): McpServer {
  const principal = principalOf(auth);
  const env = makeEnv(userRow(principal.userId), principal, auth.scopes.includes(SCOPE_WRITE));
  const server = new McpServer(
    { name: 'splitup', title: 'Splitup', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );
  registerReadTools(server, env);
  registerWriteTools(server, env);
  registerResources(server, env);
  registerPrompts(server);
  return server;
}
