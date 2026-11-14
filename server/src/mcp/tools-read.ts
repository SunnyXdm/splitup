import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  friendBalance,
  groupBalances,
  groupSettlements,
  myGrossBalances,
  myPersonBalances,
  myTotalBalance,
  orderByCurrency,
} from '../../../shared/balances';
import type { DayRange } from '../../../shared/day-range';
import { explainDirect, explainFriend, explainGroup } from '../../../shared/explain';
import { formatMoney } from '../../../shared/money';
import { pairConstituents } from '../../../shared/settle';
import { groupSummary, personalSummary, type CurrencySummary } from '../../../shared/summary';
import type { Expense, SyncData } from '../../../shared/types';
import { localToday } from '../lib/recurring';
import { CATEGORIES } from '../validate';
import { callApi } from './api';
import { defineTool, idInput, isoDay, ok, ref, text, type ToolEnv } from './kit';
import {
  ToolError,
  addDays,
  balanceSentence,
  expenseOut,
  groupOut,
  isIsoDay,
  money,
  monthBounds,
  nameOf,
  normalize,
  personOut,
  resolveGroup,
  resolvePerson,
  userById,
} from './support';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

/** My own net in a group, per currency (nonzero only). */
function myGroupNet(sync: SyncData, groupId: number) {
  return groupBalances(sync, groupId)
    .filter((b) => b.userId === sync.me.id && b.netCents !== 0)
    .map((b) => money(b.netCents, b.currency));
}

export function groupDetail(sync: SyncData, groupId: number, expenseLimit = 10) {
  const g = resolveGroup(sync, groupId);
  const roster = new Set(g.memberIds);
  const balances = groupBalances(sync, g.id);
  const byUser = new Map<number, { currency: string; net: ReturnType<typeof money> }[]>();
  for (const b of balances) {
    const list = byUser.get(b.userId) ?? [];
    list.push({ currency: b.currency, net: money(b.netCents, b.currency) });
    byUser.set(b.userId, list);
  }
  const memberIds = [...new Set([...g.memberIds, ...byUser.keys()])];
  const expenses = sync.expenses.filter((e) => e.groupId === g.id);
  return {
    id: g.id,
    name: g.name,
    emoji: g.emoji,
    currency: g.currency,
    archived: Boolean(g.archivedAt),
    members: memberIds.map((id) => ({
      ...personOut(sync, id),
      ...(roster.has(id) ? {} : { formerMember: true }),
      /** + = the group owes them; − = they owe the group. */
      balances: byUser.get(id) ?? [],
    })),
    suggestedSettlements: groupSettlements(sync, g.id).map((t) => ({
      from: personOut(sync, t.fromUserId),
      to: personOut(sync, t.toUserId),
      amount: money(t.cents, t.currency),
    })),
    yourBalance: myGroupNet(sync, g.id),
    expenseCount: expenses.length,
    recentExpenses: expenses.slice(0, expenseLimit).map((e) => expenseOut(sync, e)),
  };
}

export function groupList(sync: SyncData, includeArchived = true) {
  return sync.groups
    .filter((g) => includeArchived || !g.archivedAt)
    .map((g) => ({
      id: g.id,
      name: g.name,
      emoji: g.emoji,
      currency: g.currency,
      memberCount: g.memberIds.length,
      archived: Boolean(g.archivedAt),
      yourBalance: myGroupNet(sync, g.id),
    }));
}

function summaryOut(sync: SyncData, list: CurrencySummary[]) {
  return list.map((s) => ({
    currency: s.currency,
    totalSpent: money(s.totalCents, s.currency),
    expenseCount: s.expenseCount,
    yourShare: money(s.myShareCents, s.currency),
    youPaid: money(s.myPaidCents, s.currency),
    paymentsSent: money(s.paymentsSentCents, s.currency),
    paymentsReceived: money(s.paymentsReceivedCents, s.currency),
    byCategory: s.categories.map((c) => ({
      category: c.category,
      yourShare: money(c.cents, s.currency),
    })),
    biggestExpenses: s.top.map((e) => expenseOut(sync, e)),
  }));
}

/** Named period → inclusive day range, relative to the server's local today. */
export function periodRange(
  period: string | undefined,
  from: string | undefined,
  to: string | undefined,
): DayRange & { label: string } {
  if (from !== undefined || to !== undefined) {
    for (const d of [from, to]) {
      if (d !== undefined && !isIsoDay(d)) throw new ToolError(`invalid date ${d}`);
    }
    return { from: from ?? null, to: to ?? null, label: `${from ?? '…'} to ${to ?? '…'}` };
  }
  const today = localToday();
  switch (period ?? 'this-month') {
    case 'this-month':
      return { ...monthBounds(today), label: 'this month' };
    case 'last-month':
      return { ...monthBounds(today, -1), label: 'last month' };
    case 'last-30-days':
      return { from: addDays(today, -29), to: today, label: 'the last 30 days' };
    case 'this-year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today, label: 'this year' };
    case 'all':
      return { from: null, to: null, label: 'all time' };
    default: {
      if (/^\d{4}-\d{2}$/.test(period!)) {
        return { ...monthBounds(`${period}-01`), label: period! };
      }
      throw new ToolError(`unknown period ${period}`);
    }
  }
}

const describeSplit = (sync: SyncData, e: Expense) => {
  const s = e.split;
  if (!s) return null;
  const values = s.values ?? {};
  return {
    method: s.mode === 'unequal' ? 'exact' : s.mode,
    among: s.participants.map((id) => {
      const v = values[String(id)];
      const value =
        v === undefined
          ? undefined
          : s.mode === 'unequal'
            ? money(v, e.currency).amount
            : s.mode === 'percent'
              ? `${(v / 100).toFixed(2)}%`
              : String(v);
      return { ...personOut(sync, id), ...(value === undefined ? {} : { value }) };
    }),
  };
};

interface RevisionWire {
  revision: number;
  action: string;
  actorId: number;
  createdAt: string;
  snapshot: {
    description: string;
    amountCents: number;
    currency: string;
    date: string;
    groupId: number | null;
    isPayment: boolean;
    shares: { userId: number; paidCents: number; owedCents: number }[];
  };
}
interface RevisionsWire {
  revisions: RevisionWire[];
  users: { id: number; name: string }[];
}

export function registerReadTools(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    'whoami',
    {
      title: 'Who am I',
      description:
        'The signed-in Splitup user this connection acts for: name, email, default currency, ' +
        'and what this token may do. Call first if unsure whose data you are seeing.',
      input: z.object({}),
      annotations: READ,
    },
    async () => {
      const sync = await env.sync();
      return ok({
        user: { id: sync.me.id, name: sync.me.name, email: sync.me.email },
        defaultCurrency: sync.me.defaultCurrency,
        connectedVia: env.principal.clientName,
        canWrite: env.canWrite,
        groups: sync.groups.length,
        friends: sync.friendIds.length,
        today: localToday(),
      });
    },
  );

  defineTool(
    server,
    env,
    'list_groups',
    {
      title: 'List groups',
      description:
        'Groups the user belongs to, with currency, member count, archived flag and the ' +
        "user's own balance in each (+ = the group owes them, − = they owe).",
      input: z.object({
        include_archived: z.boolean().default(true).describe('Include groups archived on Home'),
      }),
      annotations: READ,
    },
    async ({ include_archived }) => {
      const sync = await env.sync();
      return ok({ groups: groupList(sync, include_archived) });
    },
  );

  defineTool(
    server,
    env,
    'get_group',
    {
      title: 'Get group',
      description:
        'One group: members (with guests and former members that still have a balance), each ' +
        "member's net balance, the app's suggested settlements (who pays whom), the user's own " +
        'balance, and recent expenses.',
      input: z.object({
        group: ref('Group'),
        expense_limit: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(10)
          .describe('How many recent expenses to include'),
      }),
      annotations: READ,
    },
    async ({ group, expense_limit }) => {
      const sync = await env.sync();
      return ok(groupDetail(sync, resolveGroup(sync, group).id, expense_limit));
    },
  );

  defineTool(
    server,
    env,
    'list_friends',
    {
      title: 'List friends',
      description:
        'Friends with the balance per currency (+ = they owe the user, − = the user owes them), ' +
        'across all shared groups and direct expenses — the same numbers as the Friends tab. ' +
        'Also lists other people (e.g. group guests) the user has an open balance with.',
      input: z.object({}),
      annotations: READ,
    },
    async () => {
      const sync = await env.sync();
      const friends = sync.friendIds.map((id) => {
        const u = userById(sync, id);
        return {
          ...personOut(sync, id),
          email: u?.email ?? null,
          balances: orderByCurrency(friendBalance(sync, id), sync.me.defaultCurrency).map((b) => ({
            net: money(b.netCents, b.currency),
            summary: balanceSentence(sync, id, b.netCents, b.currency),
          })),
        };
      });
      const friendSet = new Set(sync.friendIds);
      const others = myPersonBalances(sync)
        .filter((p) => !friendSet.has(p.userId))
        .map((p) => ({
          ...personOut(sync, p.userId),
          net: money(p.netCents, p.currency),
          summary: balanceSentence(sync, p.userId, p.netCents, p.currency),
        }));
      return ok({
        friends,
        othersWithBalances: others,
        pendingFriendRequests: {
          incoming: sync.friendRequests?.incoming.length ?? 0,
          outgoing: sync.friendRequests?.outgoing.length ?? 0,
        },
      });
    },
  );

  defineTool(
    server,
    env,
    'get_balance',
    {
      title: 'Get balance',
      description:
        'Balances, per currency (currencies are never added together). With no arguments: the ' +
        "user's overall position (net, total owed to them, total they owe), per person and per " +
        'group. With `friend`: the balance with that person and how it splits across groups and ' +
        "direct expenses. With `group`: the user's net in that group and their suggested " +
        'payments. Sign convention: + = owed to the user.',
      input: z.object({
        friend: ref('Person').optional(),
        group: ref('Group').optional(),
      }),
      annotations: READ,
    },
    async ({ friend, group }) => {
      const sync = await env.sync();
      const me = sync.me.id;
      if (friend !== undefined && group !== undefined) {
        throw new ToolError('pass either friend or group, not both');
      }
      if (friend !== undefined) {
        const id = resolvePerson(sync, friend);
        return ok({
          person: personOut(sync, id),
          balances: friendBalance(sync, id).map((b) => ({
            net: money(b.netCents, b.currency),
            summary: balanceSentence(sync, id, b.netCents, b.currency),
            byScope: pairConstituents(sync, id, b.currency).map((c) => ({
              scope: c.scope === null ? 'direct' : groupOut(sync, c.scope),
              net: money(c.cents, b.currency),
            })),
          })),
        });
      }
      if (group !== undefined) {
        const g = resolveGroup(sync, group);
        return ok({
          group: { id: g.id, name: g.name },
          yourNet: myGroupNet(sync, g.id),
          yourSuggestedTransfers: groupSettlements(sync, g.id)
            .filter((t) => t.fromUserId === me || t.toUserId === me)
            .map((t) => ({
              from: personOut(sync, t.fromUserId),
              to: personOut(sync, t.toUserId),
              amount: money(t.cents, t.currency),
            })),
        });
      }
      const primary = sync.me.defaultCurrency;
      return ok({
        net: orderByCurrency(myTotalBalance(sync), primary).map((b) =>
          money(b.netCents, b.currency),
        ),
        gross: orderByCurrency(myGrossBalances(sync), primary).map((b) => ({
          currency: b.currency,
          owedToYou: money(b.owedCents, b.currency),
          youOwe: money(b.owingCents, b.currency),
        })),
        perPerson: myPersonBalances(sync).map((p) => ({
          ...personOut(sync, p.userId),
          net: money(p.netCents, p.currency),
          summary: balanceSentence(sync, p.userId, p.netCents, p.currency),
        })),
        perGroup: sync.groups
          .map((g) => ({ group: { id: g.id, name: g.name }, net: myGroupNet(sync, g.id) }))
          .filter((g) => g.net.length > 0),
      });
    },
  );

  defineTool(
    server,
    env,
    'explain_balance',
    {
      title: 'Explain balance',
      description:
        "Plain-text trace of WHY a balance is what it is, built from the same code the app's " +
        '"Why?" sheet uses. With `friend`: each group\'s routed slice plus the direct expenses. ' +
        "With `group` (optionally `person`): every member's paid/share/payments, the " +
        "settlement sweep, and the ledger lines that moved the user's balance.",
      input: z.object({
        friend: ref('Person').optional(),
        group: ref('Group').optional(),
        person: ref('In group mode, the other member to explain the pair balance with').optional(),
        ledger_limit: z
          .number()
          .int()
          .min(0)
          .max(200)
          .default(30)
          .describe('How many ledger lines to include'),
      }),
      annotations: READ,
    },
    async ({ friend, group, person, ledger_limit }) => {
      const sync = await env.sync();
      const me = sync.me.id;
      const f = (cents: number, cur: string) => formatMoney(cents, cur);
      const lines: string[] = [];
      if (group !== undefined) {
        const g = resolveGroup(sync, group);
        const other = person === undefined ? null : resolvePerson(sync, person);
        const currencies = [...new Set(groupBalances(sync, g.id).map((b) => b.currency))];
        for (const cur of currencies) {
          const x = explainGroup(sync, g.id, cur, me, other);
          lines.push(`## ${g.name} — ${cur}`);
          lines.push('Members (paid for expenses / their share / payments sent / received → net):');
          for (const m of x.members) {
            lines.push(
              `- ${nameOf(sync, m.userId)}${m.current ? '' : ' (left the group)'}: paid ${f(
                m.paidCents,
                cur,
              )}, share ${f(m.shareCents, cur)}, sent ${f(m.sentCents, cur)}, received ${f(
                m.receivedCents,
                cur,
              )} → net ${f(m.netCents, cur)}`,
            );
          }
          lines.push(
            `Debts are simplified: creditors and debtors are lined up by id and matched in order (total routed ${f(
              x.totalCents,
              cur,
            )}):`,
          );
          for (const s of x.steps) {
            lines.push(
              `${s.highlighted ? '* ' : '- '}${nameOf(sync, s.fromUserId)} pays ${nameOf(
                sync,
                s.toUserId,
              )} ${f(s.cents, cur)}`,
            );
          }
          lines.push(
            other === null
              ? `Your net here: ${f(x.pairCents, cur)} (+ = you are owed).`
              : `Between you and ${nameOf(sync, other)}: ${
                  x.pairCents === 0
                    ? 'nothing to settle'
                    : x.pairCents > 0
                      ? `${nameOf(sync, other)} pays you ${f(x.pairCents, cur)}`
                      : `you pay ${nameOf(sync, other)} ${f(-x.pairCents, cur)}`
                }.`,
          );
          const ledger = x.ledger.filter(
            (l) => l.focus.netCents !== 0 || (l.other?.netCents ?? 0) !== 0,
          );
          if (ledger.length > 0) {
            lines.push(
              `Ledger lines that moved your net (newest first, ${Math.min(ledger.length, ledger_limit)} of ${ledger.length}):`,
            );
            for (const l of ledger.slice(0, ledger_limit)) {
              lines.push(
                `- ${l.expense.date} ${l.expense.isPayment ? 'Payment' : `"${l.expense.description}"`} ${f(
                  l.expense.amountCents,
                  cur,
                )} (#${l.expense.id}): you paid ${f(l.focus.paidCents, cur)}, your share ${f(
                  l.focus.owedCents,
                  cur,
                )} → ${f(l.focus.netCents, cur)}`,
              );
            }
          }
          lines.push('');
        }
        return text(lines.join('\n').trim() || `No balances in ${g.name}.`);
      }
      if (friend === undefined) throw new ToolError('pass friend, or group (with optional person)');
      const id = resolvePerson(sync, friend);
      const explanations = explainFriend(sync, id);
      if (explanations.length === 0) return text(`You and ${nameOf(sync, id)} are all settled.`);
      for (const x of explanations) {
        lines.push(`## ${balanceSentence(sync, id, x.totalCents, x.currency)} (${x.currency})`);
        lines.push('It is the sum of these slices (+ = they owe you):');
        for (const s of x.slices) {
          if (s.scope === null) {
            lines.push(`- Direct (outside groups): ${f(s.cents, x.currency)}`);
            const d = explainDirect(sync, id, x.currency);
            for (const item of d.items.slice(0, ledger_limit)) {
              lines.push(
                item.kind === 'group'
                  ? `  - legacy balance from ${groupOut(sync, item.groupId)?.name}: ${f(item.cents, x.currency)}`
                  : `  - ${item.expense.date} ${item.expense.isPayment ? 'Payment' : `"${item.expense.description}"`} (#${item.expense.id}): ${f(item.cents, x.currency)}`,
              );
            }
          } else {
            lines.push(
              `- In ${groupOut(sync, s.scope)?.name}: ${f(s.cents, x.currency)} — the group's simplified debts route this between you (see explain_balance with group).`,
            );
          }
        }
        lines.push('');
      }
      return text(lines.join('\n').trim());
    },
  );

  defineTool(
    server,
    env,
    'search_expenses',
    {
      title: 'Search expenses',
      description:
        'Find expenses and payments (newest first). All filters are optional and combine: text ' +
        '(description, notes, group, people), date range, person involved, group (or "direct" ' +
        'for non-group), category, type. Returns ids for get_expense / edit_expense.',
      input: z.object({
        text: z.string().max(200).optional(),
        from: isoDay().optional(),
        to: isoDay().optional(),
        person: ref('Someone who holds a share').optional(),
        group: z
          .union([
            z.literal('direct'),
            z.number().int().positive(),
            z.string().trim().min(1).max(200),
          ])
          .optional()
          .describe('Group id/name, or "direct" for expenses outside groups'),
        category: z.enum(CATEGORIES).optional(),
        type: z.enum(['all', 'expenses', 'payments']).default('all'),
        limit: z.number().int().min(1).max(100).default(20).describe('How many to return'),
      }),
      annotations: READ,
    },
    async (args) => {
      const sync = await env.sync();
      const personId = args.person === undefined ? null : resolvePerson(sync, args.person);
      const groupId =
        args.group === undefined
          ? undefined
          : args.group === 'direct'
            ? null
            : resolveGroup(sync, args.group).id;
      const words = normalize(args.text ?? '')
        .split(' ')
        .filter(Boolean);
      const hay = (e: Expense) =>
        normalize(
          [
            e.description,
            e.notes ?? '',
            e.category,
            groupOut(sync, e.groupId)?.name ?? 'direct',
            ...e.shares.map((s) => userById(sync, s.userId)?.name ?? ''),
            String(e.amountCents / 100),
          ].join(' '),
        );
      const matches = sync.expenses.filter(
        (e) =>
          (args.from === undefined || e.date >= args.from) &&
          (args.to === undefined || e.date <= args.to) &&
          (personId === null || e.shares.some((s) => s.userId === personId)) &&
          (groupId === undefined || e.groupId === groupId) &&
          (args.category === undefined || (!e.isPayment && e.category === args.category)) &&
          (args.type === 'all' || (args.type === 'payments') === e.isPayment) &&
          (words.length === 0 || words.every((w) => hay(e).includes(w))),
      );
      matches.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
      return ok({
        total: matches.length,
        expenses: matches.slice(0, args.limit).map((e) => expenseOut(sync, e)),
      });
    },
  );

  defineTool(
    server,
    env,
    'get_expense',
    {
      title: 'Get expense',
      description:
        'One expense or payment by id, including deleted ones you could see: every share ' +
        '(paid/owed per person), how it was split, its settle-up batch, and its full change ' +
        'history (revision numbers usable with restore_expense).',
      input: z.object({ expense_id: idInput() }),
      annotations: READ,
    },
    async ({ expense_id }) => {
      const sync = await env.sync();
      const history = await callApi<RevisionsWire>(
        env.user,
        'GET',
        `/api/expenses/${expense_id}/revisions`,
      );
      const names = new Map(history.users.map((u) => [u.id, u.name]));
      const live = sync.expenses.find((e) => e.id === expense_id);
      const latest = history.revisions[0];
      const base =
        live ??
        (latest && {
          id: expense_id,
          groupId: latest.snapshot.groupId,
          description: latest.snapshot.description,
          amountCents: latest.snapshot.amountCents,
          currency: latest.snapshot.currency,
          date: latest.snapshot.date,
          category: 'general' as const,
          notes: null,
          isPayment: latest.snapshot.isPayment,
          shares: latest.snapshot.shares,
          createdBy: 0,
          createdAt: '',
          updatedAt: '',
        });
      if (!base) throw new ToolError('not found');
      const batch =
        base.settlementBatchId != null
          ? sync.settlementBatches?.find((b) => b.id === base.settlementBatchId)
          : undefined;
      return ok({
        ...expenseOut(sync, base),
        deleted: live === undefined,
        createdBy: live ? personOut(sync, live.createdBy) : undefined,
        createdAt: live?.createdAt,
        shares: base.shares.map((s) => ({
          person: userById(sync, s.userId)
            ? personOut(sync, s.userId)
            : { id: s.userId, name: names.get(s.userId) ?? `user #${s.userId}` },
          paid: money(s.paidCents, base.currency),
          owes: money(s.owedCents, base.currency),
        })),
        split: live ? describeSplit(sync, live) : null,
        settlement: batch
          ? {
              batchId: batch.id,
              payer: personOut(sync, batch.payerId),
              payee: personOut(sync, batch.payeeId),
              cash: money(batch.amountCents, batch.currency),
              method: batch.method,
              reference: batch.reference,
              note: batch.note,
              rows: batch.rows,
            }
          : null,
        history: history.revisions.map((r) => ({
          revision: r.revision,
          action: r.action,
          by: names.get(r.actorId) ?? `user #${r.actorId}`,
          at: r.createdAt,
          description: r.snapshot.description,
          amount: money(r.snapshot.amountCents, r.snapshot.currency),
          date: r.snapshot.date,
        })),
      });
    },
  );

  defineTool(
    server,
    env,
    'spending_summary',
    {
      title: 'Spending summary',
      description:
        "What things cost the user over a period: total spent, the user's share (consumption, " +
        'not balance), what they paid, settle-up payments sent/received, share by category and ' +
        'the biggest expenses — per currency. Optionally for one group (then totals are the ' +
        "whole group's spending).",
      input: z.object({
        period: z
          .string()
          .regex(/^(this-month|last-month|last-30-days|this-year|all|\d{4}-\d{2})$/)
          .optional()
          .describe('this-month (default), last-month, last-30-days, this-year, all, or YYYY-MM'),
        from: isoDay().optional(),
        to: isoDay().optional(),
        group: ref('Group').optional(),
      }),
      annotations: READ,
    },
    async ({ period, from, to, group }) => {
      const sync = await env.sync();
      const range = periodRange(period, from, to);
      const g = group === undefined ? null : resolveGroup(sync, group);
      const list = g ? groupSummary(sync, g.id, range) : personalSummary(sync, range);
      return ok({
        period: { label: range.label, from: range.from, to: range.to },
        group: g ? { id: g.id, name: g.name } : null,
        currencies: summaryOut(sync, list),
      });
    },
  );

  defineTool(
    server,
    env,
    'list_recurring',
    {
      title: 'List recurring bills',
      description:
        'Recurring bills (rent, subscriptions…) the user can see, and the bills that are due ' +
        'to add now ("due" — only the bill\'s creator gets these). Use add_due_bill / ' +
        'skip_due_bill with an occurrence id.',
      input: z.object({}),
      annotations: READ,
    },
    async () => {
      const sync = await env.sync();
      const rec = sync.recurring ?? { rules: [], pending: [] };
      const scope = (groupId: number | null, friendId: number | null) =>
        groupId !== null
          ? { group: groupOut(sync, groupId) }
          : { friend: friendId === null ? null : personOut(sync, friendId) };
      return ok({
        due: rec.pending.map((p) => ({
          occurrenceId: p.id,
          ruleId: p.ruleId,
          dueDate: p.dueDate,
          description: p.description,
          amount: money(p.amountCents, p.currency),
          ...scope(p.groupId, p.friendId),
        })),
        rules: rec.rules.map((r) => ({
          id: r.id,
          description: r.template.description,
          amount: money(r.template.amountCents, r.template.currency),
          category: r.template.category,
          cadence: r.cadence,
          every: r.interval,
          nextDue: r.nextDue,
          paused: r.paused,
          yours: r.createdBy === sync.me.id,
          ...scope(r.groupId, r.friendId),
        })),
      });
    },
  );

  defineTool(
    server,
    env,
    'list_activity',
    {
      title: 'List activity',
      description:
        'Recent activity feed (newest first): expenses added/edited/deleted, payments, group ' +
        'changes — including changes made by other people and by connected assistants.',
      input: z.object({
        limit: z.number().int().min(1).max(200).default(20).describe('How many to return'),
        group: ref('Only this group').optional(),
      }),
      annotations: READ,
    },
    async ({ limit, group }) => {
      const sync = await env.sync();
      const gid = group === undefined ? null : resolveGroup(sync, group).id;
      return ok({
        activity: sync.activity
          .filter((a) => gid === null || a.groupId === gid)
          .slice(0, limit)
          .map((a) => ({
            id: a.id,
            at: a.createdAt,
            type: a.type,
            summary: a.summary,
            by: personOut(sync, a.actorId),
            group: groupOut(sync, a.groupId),
            expenseId: a.expenseId,
          })),
      });
    },
  );
}
