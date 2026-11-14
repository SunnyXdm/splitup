import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  apportionSettle,
  currentSuggestion,
  pairConstituents,
  settlePrefillFor,
  settlementWatermark,
  type SettleDirection,
} from '../../../shared/settle';
import { parseDecimalToMinor } from '../../../shared/money';
import type { Expense, SettlementBatch, SyncData } from '../../../shared/types';
import { localToday } from '../lib/recurring';
import { owedFromSplitMeta, type SplitMeta } from '../lib/split-meta';
import { CATEGORIES, SETTLEMENT_METHODS } from '../validate';
import { callApi } from './api';
import {
  amountInput,
  confirmFlag,
  currencyCode,
  defineTool,
  idInput,
  isoDay,
  ok,
  ref,
  type ToolEnv,
} from './kit';
import { scanReceipt } from './receipt';
import { groupDetail } from './tools-read';
import {
  ToolError,
  balanceSentence,
  expenseOut,
  isIsoDay,
  money,
  nameOf,
  parseAmount,
  personOut,
  resolveFriend,
  resolveGroup,
  resolvePerson,
  type Ref,
} from './support';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;

const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .describe(
    'Optional idempotency key (8–64 of A-Z a-z 0-9 _ -). Retrying with the same key never ' +
      'records twice; reuse it only for a retry of the exact same request.',
  );

const splitInput = z
  .object({
    method: z
      .enum(['equal', 'exact', 'percent', 'shares'])
      .describe(
        'equal: same share each · exact: amounts · percent: must total 100 · shares: weights',
      ),
    among: z
      .array(ref('Person'))
      .max(50)
      .optional()
      .describe('equal only: who shares the cost (default: everyone in the group / both of you)'),
    values: z
      .array(
        z.object({
          person: ref('Person'),
          value: z
            .union([z.string().trim().min(1).max(40), z.number().nonnegative()])
            .describe('exact: amount like "12.50" · percent: like "33.33" · shares: integer'),
        }),
      )
      .max(50)
      .optional()
      .describe('exact / percent / shares: one entry per person who owes something'),
  })
  .describe('How the cost is shared. Default: equally among everyone in scope.');

type SplitInput = z.infer<typeof splitInput>;

const payersInput = z
  .array(z.object({ person: ref('Payer'), amount: amountInput('What this person paid') }))
  .min(1)
  .max(50)
  .describe('Several payers (amounts must add up to the total). Use instead of paid_by.');

type Share = { userId: number; paidCents: number; owedCents: number };

/** Split input → the app's SplitMeta (validated by the server against the shares). */
function buildSplit(
  sync: SyncData,
  split: SplitInput | undefined,
  pool: number[],
  poolLabel: string,
  amountCents: number,
  currency: string,
): SplitMeta {
  const person = (r: Ref) => resolvePerson(sync, r, pool, poolLabel);
  if (!split || split.method === 'equal') {
    if (split?.values?.length) throw new ToolError('an equal split takes `among`, not `values`');
    const among = split?.among?.length ? split.among.map(person) : pool;
    if (new Set(among).size !== among.length) throw new ToolError('someone is listed twice');
    return { mode: 'equal', participants: among };
  }
  if (split.among?.length)
    throw new ToolError(`a ${split.method} split takes \`values\`, not \`among\``);
  if (!split.values?.length) throw new ToolError(`a ${split.method} split needs \`values\``);
  const values: Record<string, number> = {};
  const participants: number[] = [];
  for (const v of split.values) {
    const id = person(v.person);
    if (values[String(id)] !== undefined)
      throw new ToolError(`${nameOf(sync, id)} is listed twice`);
    const raw = String(v.value).trim().replace(/%$/, '');
    let n: number | null;
    if (split.method === 'exact') {
      n = Number(raw) === 0 ? 0 : parseAmount(raw, currency, `amount for ${nameOf(sync, id)}`);
    } else if (split.method === 'percent') {
      n = parseDecimalToMinor(raw, 2); // basis points
      if (n === null || n > 10_000) throw new ToolError(`invalid percentage "${v.value}"`);
    } else {
      n = /^\d{1,6}$/.test(raw) ? Number(raw) : null;
      if (n === null) throw new ToolError(`shares must be whole numbers, got "${v.value}"`);
    }
    if (n === 0) continue;
    values[String(id)] = n;
    participants.push(id);
  }
  if (participants.length === 0) throw new ToolError('nobody owes anything in that split');
  const total = participants.reduce((sum, id) => sum + values[String(id)], 0);
  if (split.method === 'exact' && total !== amountCents) {
    throw new ToolError(
      `exact amounts add up to ${money(total, currency).formatted}, not ${money(amountCents, currency).formatted}`,
    );
  }
  if (split.method === 'percent' && total !== 10_000) {
    throw new ToolError(`percentages add up to ${(total / 100).toFixed(2)}%, not 100%`);
  }
  return { mode: split.method === 'exact' ? 'unequal' : split.method, participants, values };
}

function buildPayers(
  sync: SyncData,
  args: { paid_by?: Ref; payers?: { person: Ref; amount: string | number }[] },
  pool: number[],
  poolLabel: string,
  amountCents: number,
  currency: string,
): Map<number, number> {
  if (args.paid_by !== undefined && args.payers !== undefined) {
    throw new ToolError('pass paid_by or payers, not both');
  }
  const paid = new Map<number, number>();
  if (args.payers) {
    for (const p of args.payers) {
      const id = resolvePerson(sync, p.person, pool, poolLabel);
      if (paid.has(id)) throw new ToolError(`${nameOf(sync, id)} is listed twice`);
      paid.set(id, parseAmount(p.amount, currency, `amount paid by ${nameOf(sync, id)}`));
    }
    const total = [...paid.values()].reduce((a, b) => a + b, 0);
    if (total !== amountCents) {
      throw new ToolError(
        `payers add up to ${money(total, currency).formatted}, not ${money(amountCents, currency).formatted}`,
      );
    }
    return paid;
  }
  paid.set(resolvePerson(sync, args.paid_by ?? 'me', pool, poolLabel), amountCents);
  return paid;
}

function mergeShares(
  owed: Map<number, number>,
  paid: Map<number, number>,
  keep: number[] = [],
): Share[] {
  const ids = new Set([...owed.keys(), ...paid.keys(), ...keep]);
  return [...ids]
    .sort((a, b) => a - b)
    .map((userId) => ({
      userId,
      paidCents: paid.get(userId) ?? 0,
      owedCents: owed.get(userId) ?? 0,
    }))
    .filter((s) => s.paidCents > 0 || s.owedCents > 0 || keep.includes(s.userId));
}

function checkDate(date: string | undefined): string {
  const d = date ?? localToday();
  if (!isIsoDay(d)) throw new ToolError(`invalid date ${d}`);
  return d;
}

function liveExpense(sync: SyncData, id: number): Expense {
  const e = sync.expenses.find((x) => x.id === id);
  if (!e) throw new ToolError(`no live expense with id ${id} (deleted, or not visible to you)`);
  return e;
}

function batchOut(sync: SyncData, b: SettlementBatch) {
  return {
    batchId: b.id,
    payer: personOut(sync, b.payerId),
    payee: personOut(sync, b.payeeId),
    cash: money(b.amountCents, b.currency),
    date: b.date,
    method: b.method,
    reference: b.reference,
    note: b.note,
    paymentRows: b.rows,
  };
}

export function registerWriteTools(server: McpServer, env: ToolEnv): void {
  defineTool(
    server,
    env,
    'add_expense',
    {
      title: 'Add expense',
      description:
        'Record a shared expense in a group or with one friend, exactly like the app does ' +
        '(validation, history, activity, notifications). Amount in major units ("1250.50"). ' +
        "Currency defaults to the group's (group expenses must use it) or the user's default. " +
        'Payer defaults to the user; split defaults to equal among everyone in scope. Confirm ' +
        'the details with the user before calling.',
      write: true,
      input: z.object({
        group: ref('Group to add it to').optional(),
        friend: ref('Friend, for a 1:1 expense outside groups').optional(),
        description: z.string().trim().min(1).max(200),
        amount: amountInput('Total amount'),
        currency: currencyCode().optional(),
        date: isoDay('default: today').optional(),
        paid_by: ref('Who paid (default: me)').optional(),
        payers: payersInput.optional(),
        split: splitInput.optional(),
        category: z.enum(CATEGORIES).optional(),
        notes: z.string().trim().max(1000).optional(),
        idempotency_key: idempotencyKey.optional(),
      }),
      annotations: WRITE,
    },
    async (args) => {
      const sync = await env.sync();
      if ((args.group === undefined) === (args.friend === undefined)) {
        throw new ToolError('pass exactly one of group or friend');
      }
      let groupId: number | null = null;
      let pool: number[];
      let poolLabel: string;
      let currency: string;
      if (args.group !== undefined) {
        const g = resolveGroup(sync, args.group);
        groupId = g.id;
        pool = g.memberIds;
        poolLabel = `the members of ${g.name}`;
        if (args.currency && args.currency !== g.currency) {
          throw new ToolError(`${g.name} uses ${g.currency}; group expenses must be in it`);
        }
        currency = g.currency;
      } else {
        const friendId = resolveFriend(sync, args.friend!);
        pool = [sync.me.id, friendId];
        poolLabel = `you and ${nameOf(sync, friendId)}`;
        currency = args.currency ?? sync.me.defaultCurrency;
      }
      const amountCents = parseAmount(args.amount, currency);
      const meta = buildSplit(sync, args.split, pool, poolLabel, amountCents, currency);
      const owed = owedFromSplitMeta(meta, amountCents);
      const paid = buildPayers(sync, args, pool, poolLabel, amountCents, currency);
      const shares = mergeShares(owed, paid, groupId === null ? pool : []);
      const expense = await callApi<Expense>(env.user, 'POST', '/api/expenses', {
        groupId,
        description: args.description,
        amountCents,
        currency,
        date: checkDate(args.date),
        category: args.category ?? 'general',
        notes: args.notes || null,
        isPayment: false,
        shares,
        split: meta,
        ...(args.idempotency_key ? { clientKey: args.idempotency_key } : {}),
      });
      env.invalidate();
      const fresh = await env.sync();
      return ok({ expense: expenseOut(fresh, expense) }, `Recorded expense #${expense.id}.`);
    },
  );

  defineTool(
    server,
    env,
    'edit_expense',
    {
      title: 'Edit expense',
      description:
        'Change an expense (not a payment). Only pass what changes. Changing the amount keeps ' +
        'an equal/percent/shares split and a single payer; an exact split or several payers ' +
        'need new values. Pass expected_updated_at (from get_expense) to refuse the edit if ' +
        'someone changed it meanwhile. Recorded in the expense history; undo with restore_expense.',
      write: true,
      input: z.object({
        expense_id: idInput(),
        expected_updated_at: z.string().max(40).optional(),
        description: z.string().trim().min(1).max(200).optional(),
        amount: amountInput('New total').optional(),
        date: isoDay().optional(),
        category: z.enum(CATEGORIES).optional(),
        notes: z
          .string()
          .trim()
          .max(1000)
          .nullable()
          .optional()
          .describe('New notes; an empty string "" clears them'),
        paid_by: ref('Who paid').optional(),
        payers: payersInput.optional(),
        split: splitInput.optional(),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async (args) => {
      const sync = await env.sync();
      const e = liveExpense(sync, args.expense_id);
      if (e.isPayment) {
        throw new ToolError('payments cannot be edited; use undo_payment and record_payment');
      }
      const currency = e.currency;
      const current = e.shares.map((s) => s.userId);
      const g = e.groupId === null ? null : sync.groups.find((x) => x.id === e.groupId);
      // Group: current members, plus anyone already on the expense (grandfathered).
      const pool = g ? [...new Set([...g.memberIds, ...current])] : current;
      const poolLabel = g ? `the members of ${g.name}` : 'the two people on this expense';
      const amountCents =
        args.amount === undefined ? e.amountCents : parseAmount(args.amount, currency);
      const amountChanged = amountCents !== e.amountCents;

      let paid: Map<number, number>;
      if (args.paid_by !== undefined || args.payers !== undefined) {
        paid = buildPayers(sync, args, pool, poolLabel, amountCents, currency);
      } else {
        const payers = e.shares.filter((s) => s.paidCents > 0);
        if (amountChanged && payers.length !== 1) {
          throw new ToolError(
            'this expense has several payers: pass `payers` with the new amounts',
          );
        }
        paid = new Map(payers.map((s) => [s.userId, amountChanged ? amountCents : s.paidCents]));
      }

      let owed: Map<number, number>;
      let meta: SplitMeta | undefined;
      if (args.split !== undefined) {
        meta = buildSplit(sync, args.split, pool, poolLabel, amountCents, currency);
        owed = owedFromSplitMeta(meta, amountCents);
      } else if (!amountChanged) {
        owed = new Map(e.shares.map((s) => [s.userId, s.owedCents]));
        meta = e.split;
      } else if (e.split && e.split.mode !== 'unequal') {
        meta = e.split;
        owed = owedFromSplitMeta(meta, amountCents);
      } else {
        throw new ToolError('the split is in exact amounts: pass `split` for the new amount');
      }
      const shares = mergeShares(owed, paid, e.groupId === null ? current : []);
      const updated = await callApi<Expense>(env.user, 'PATCH', `/api/expenses/${e.id}`, {
        groupId: e.groupId,
        description: args.description ?? e.description,
        amountCents,
        currency,
        date: args.date ?? e.date,
        category: args.category ?? e.category,
        notes: args.notes === undefined ? e.notes : args.notes || null,
        isPayment: false,
        shares,
        ...(meta ? { split: meta } : {}),
        ...(args.expected_updated_at ? { expectedUpdatedAt: args.expected_updated_at } : {}),
      });
      env.invalidate();
      const fresh = await env.sync();
      return ok({ expense: expenseOut(fresh, updated) }, `Updated expense #${updated.id}.`);
    },
  );

  defineTool(
    server,
    env,
    'delete_expense',
    {
      title: 'Delete expense',
      description:
        'Delete an expense (soft delete: it moves to Recently deleted and can be brought back ' +
        'with restore_expense). Settle-up payments are removed with undo_payment instead. Ask ' +
        'the user to confirm first, then pass confirm: true.',
      write: true,
      input: z.object({ expense_id: idInput(), confirm: confirmFlag }),
      annotations: DESTRUCTIVE,
    },
    async ({ expense_id }) => {
      const sync = await env.sync();
      const e = liveExpense(sync, expense_id);
      if (e.settlementBatchId != null) {
        throw new ToolError(
          `#${e.id} is part of settle-up batch ${e.settlementBatchId}: use undo_payment with that batch_id`,
        );
      }
      await callApi(env.user, 'DELETE', `/api/expenses/${e.id}`);
      return ok(
        { deleted: expenseOut(sync, e) },
        `Deleted expense #${e.id}. It can be restored with restore_expense.`,
      );
    },
  );

  defineTool(
    server,
    env,
    'restore_expense',
    {
      title: 'Restore expense',
      description:
        'Undo a deletion or an edit: brings an expense back to one of its history revisions ' +
        '(see get_expense). For a deleted expense, revision defaults to the version it was ' +
        'deleted at; for a live one, pass the revision to revert to.',
      write: true,
      input: z.object({
        expense_id: idInput(),
        revision: idInput().optional(),
      }),
      annotations: WRITE,
    },
    async ({ expense_id, revision }) => {
      const sync = await env.sync();
      const live = sync.expenses.find((x) => x.id === expense_id);
      let target = revision;
      if (target === undefined) {
        if (live)
          throw new ToolError('this expense is not deleted: pass the revision to revert to');
        const history = await callApi<{ revisions: { revision: number }[] }>(
          env.user,
          'GET',
          `/api/expenses/${expense_id}/revisions`,
        );
        target = history.revisions[0]?.revision;
        if (target === undefined) throw new ToolError('no history for this expense');
      }
      const restored = await callApi<Expense>(
        env.user,
        'POST',
        `/api/expenses/${expense_id}/restore`,
        { revision: target, ...(live ? { expectedUpdatedAt: live.updatedAt } : {}) },
      );
      env.invalidate();
      const fresh = await env.sync();
      return ok(
        { expense: expenseOut(fresh, restored), restoredRevision: target },
        `Restored expense #${expense_id} to revision ${target}.`,
      );
    },
  );

  defineTool(
    server,
    env,
    'record_payment',
    {
      title: 'Record payment',
      description:
        'Record a settle-up payment with a person, through the same settle-up flow as the app. ' +
        'Without `group`: settles the overall balance with a friend, split across shared groups ' +
        'and direct expenses the way the app does. With `group`: settles only inside that group. ' +
        'direction: i_paid (the user paid them) or they_paid. Amount and direction default to ' +
        'settling the current balance in full. Confirm with the user before calling.',
      write: true,
      input: z.object({
        person: ref('Who the money moved to/from'),
        group: ref('Settle only inside this group').optional(),
        direction: z.enum(['i_paid', 'they_paid']).optional(),
        amount: amountInput('Cash amount (default: the full balance)').optional(),
        currency: currencyCode(
          'e.g. INR (default: the currency you owe or are owed in)',
        ).optional(),
        date: isoDay('default: today').optional(),
        method: z.enum(SETTLEMENT_METHODS).optional(),
        reference: z.string().trim().max(100).optional().describe('e.g. a UPI reference'),
        note: z.string().trim().max(500).optional(),
        idempotency_key: idempotencyKey.optional(),
      }),
      annotations: WRITE,
    },
    async (args) => {
      const sync = await env.sync();
      const me = sync.me.id;
      const g = args.group === undefined ? null : resolveGroup(sync, args.group);
      const cp = g
        ? resolvePerson(sync, args.person, g.memberIds, `the members of ${g.name}`)
        : resolveFriend(sync, args.person);
      if (cp === me) throw new ToolError('you cannot settle with yourself');
      let currency: string;
      if (g) {
        if (args.currency && args.currency !== g.currency) {
          throw new ToolError(`${g.name} settles in ${g.currency}`);
        }
        currency = g.currency;
      } else {
        currency =
          args.currency ?? settlePrefillFor(sync, null, cp, sync.me.defaultCurrency).currency;
      }
      const suggestion = currentSuggestion(sync, g?.id ?? null, cp, currency);
      const direction: SettleDirection | undefined = args.direction ?? suggestion?.direction;
      if (!direction) {
        throw new ToolError(
          `nothing to settle with ${nameOf(sync, cp)} in ${currency}: pass direction and amount to record a payment anyway`,
        );
      }
      let amountCents: number;
      if (args.amount !== undefined) amountCents = parseAmount(args.amount, currency);
      else if (suggestion && suggestion.direction === direction) amountCents = suggestion.cents;
      else throw new ToolError('pass the amount (there is no balance to settle in that direction)');

      const rows = g
        ? [
            {
              groupId: g.id,
              payerId: direction === 'i_paid' ? me : cp,
              recipientId: direction === 'i_paid' ? cp : me,
              amountCents,
            },
          ]
        : apportionSettle(pairConstituents(sync, cp, currency), amountCents, direction, me, cp).map(
            ({ groupId, payerId, recipientId, amountCents: cents }) => ({
              groupId,
              payerId,
              recipientId,
              amountCents: cents,
            }),
          );
      // The freshness fingerprint the server re-computes: if anything this
      // settle depends on changed since our snapshot, it answers 409 stale.
      const result = await callApi<{ batch: SettlementBatch | null }>(
        env.user,
        'POST',
        '/api/settlements',
        {
          counterpartyId: cp,
          currency,
          date: checkDate(args.date),
          ...settlementWatermark(sync, cp),
          rows,
          ...(args.method ? { method: args.method } : {}),
          ...(args.reference ? { reference: args.reference } : {}),
          ...(args.note ? { note: args.note } : {}),
          ...(args.idempotency_key ? { clientKey: args.idempotency_key } : {}),
        },
      );
      env.invalidate();
      const fresh = await env.sync();
      const after = currentSuggestion(fresh, g?.id ?? null, cp, currency);
      const afterCents = after ? (after.direction === 'they_paid' ? after.cents : -after.cents) : 0;
      return ok(
        {
          payment: result.batch ? batchOut(fresh, result.batch) : null,
          balanceAfter: {
            net: money(afterCents, currency),
            summary: balanceSentence(fresh, cp, afterCents, currency),
          },
        },
        `Recorded the payment${result.batch ? ` (batch ${result.batch.id})` : ''}.`,
      );
    },
  );

  defineTool(
    server,
    env,
    'undo_payment',
    {
      title: 'Undo payment',
      description:
        'Undo a whole settle-up payment (all its rows, atomically) — by batch_id, or by the id ' +
        'of one of its payment rows. Only the payer, payee or whoever recorded it may undo. ' +
        'Ask the user to confirm first, then pass confirm: true.',
      write: true,
      input: z.object({
        batch_id: idInput().optional(),
        expense_id: idInput('A payment row of the batch').optional(),
        confirm: confirmFlag,
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ batch_id, expense_id }) => {
      const sync = await env.sync();
      let batchId = batch_id;
      if (batchId === undefined) {
        if (expense_id === undefined) throw new ToolError('pass batch_id or expense_id');
        const e = liveExpense(sync, expense_id);
        if (!e.isPayment || e.settlementBatchId == null) {
          throw new ToolError(`#${e.id} is not part of a settle-up; use delete_expense`);
        }
        batchId = e.settlementBatchId;
      }
      const batch = sync.settlementBatches?.find((b) => b.id === batchId);
      await callApi(env.user, 'DELETE', `/api/settlements/${batchId}`);
      return ok(
        { undone: batch ? batchOut(sync, batch) : { batchId } },
        `Undid settle-up batch ${batchId}.`,
      );
    },
  );

  defineTool(
    server,
    env,
    'add_due_bill',
    {
      title: 'Add due recurring bill',
      description:
        'Add a due recurring-bill occurrence (from list_recurring → due) as an expense, as its ' +
        'template says — optionally with a different amount or date (the split re-applies).',
      write: true,
      input: z.object({
        occurrence_id: idInput(),
        amount: amountInput("This time's amount").optional(),
        date: isoDay().optional(),
      }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ occurrence_id, amount, date }) => {
      const sync = await env.sync();
      const due = sync.recurring?.pending.find((p) => p.id === occurrence_id);
      if (!due) throw new ToolError(`no due bill with occurrence id ${occurrence_id}`);
      if (date !== undefined) checkDate(date);
      const res = await callApi<{ expense: Expense }>(
        env.user,
        'POST',
        `/api/recurring/occurrences/${occurrence_id}/add`,
        {
          ...(amount === undefined ? {} : { amountCents: parseAmount(amount, due.currency) }),
          ...(date === undefined ? {} : { date }),
        },
      );
      env.invalidate();
      const fresh = await env.sync();
      return ok({ expense: expenseOut(fresh, res.expense) }, `Added "${due.description}".`);
    },
  );

  defineTool(
    server,
    env,
    'skip_due_bill',
    {
      title: 'Skip due recurring bill',
      description:
        'Skip one due occurrence of a recurring bill (it will not be added; the bill keeps ' +
        'recurring). Ask the user first, then pass confirm: true.',
      write: true,
      input: z.object({ occurrence_id: idInput(), confirm: confirmFlag }),
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    async ({ occurrence_id }) => {
      const sync = await env.sync();
      const due = sync.recurring?.pending.find((p) => p.id === occurrence_id);
      if (!due) throw new ToolError(`no due bill with occurrence id ${occurrence_id}`);
      await callApi(env.user, 'POST', `/api/recurring/occurrences/${occurrence_id}/skip`);
      return ok({
        skipped: { occurrenceId: due.id, description: due.description, dueDate: due.dueDate },
      });
    },
  );

  defineTool(
    server,
    env,
    'create_group',
    {
      title: 'Create group',
      description:
        'Create a group (the user is its first member) and optionally add friends to it. ' +
        "Currency defaults to the user's default.",
      write: true,
      input: z.object({
        name: z.string().trim().min(1).max(80),
        emoji: z.string().min(1).max(8).optional(),
        currency: currencyCode("e.g. INR (default: the user's default currency)").optional(),
        members: z.array(ref('Friend to add')).max(30).optional(),
      }),
      annotations: WRITE,
    },
    async ({ name, emoji, currency, members }) => {
      const sync = await env.sync();
      const memberIds = [...new Set((members ?? []).map((m) => resolveFriend(sync, m)))].filter(
        (id) => id !== sync.me.id,
      );
      const group = await callApi<{ id: number }>(env.user, 'POST', '/api/groups', {
        name,
        ...(emoji ? { emoji } : {}),
        ...(currency ? { currency } : {}),
      });
      for (const userId of memberIds) {
        await callApi(env.user, 'POST', `/api/groups/${group.id}/members`, { userId });
      }
      env.invalidate();
      const fresh = await env.sync();
      return ok(groupDetail(fresh, group.id, 0), `Created group #${group.id}.`);
    },
  );

  defineTool(
    server,
    env,
    'scan_receipt',
    {
      title: 'Scan receipt',
      description:
        'Read a receipt photo (JPEG, PNG or WebP, at most 3 MB) and return the extracted draft — ' +
        'merchant, date, total, line items, taxes, suggested category. Nothing is saved: show ' +
        'the draft to the user, then call add_expense with what they confirm. Pass the image ' +
        'as base64 (image_base64 + mime_type, or a data: URL) or as a public https image_url.',
      input: z.object({
        image_base64: z.string().max(5_000_000).optional(),
        mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
        image_url: z.string().url().max(2000).optional().describe('Public https URL of the image'),
        currency: currencyCode('the expected one, if known').optional(),
      }),
      // Part of adding an expense (and it spends the user's scan quota).
      write: true,
      // Calls an external model, but changes nothing in Splitup.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      const result = await scanReceipt(env.user, args, ctx.mcpReq.signal);
      return ok(result, 'Receipt read — NOT saved. Confirm with the user, then call add_expense.');
    },
  );
}
