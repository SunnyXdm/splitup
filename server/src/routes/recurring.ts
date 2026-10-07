import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuth, type AppEnv } from '../auth';
import {
  db,
  nowIso,
  type RecurringOccurrenceRow,
  type RecurringRuleRow,
  type UserRow,
} from '../db';
import {
  expenseCreateBody,
  idParam,
  occurrenceAddBody,
  recurringCreateBody,
  recurringPatchBody,
  type RecurringTemplate,
} from '../validate';
import { createExpense, expenseByClientKey } from '../lib/create-expense';
import { areFriends, checkExpenseInput, expenseWire, memberGroupOr404 } from '../lib/expense';
import { firstOnOrAfter, intentUserIds, occurrenceDate, type Schedule } from '../lib/recurrence';
import {
  assertParticipantsCurrent,
  generateForRule,
  occurrenceClientKey,
  ownRuleOr404,
  ruleById,
  templateExpenseBody,
  templateOf,
  todayFromQuery,
  toRecurringRule,
  visibleRuleOr404,
  visibleRules,
} from '../lib/recurring';
import { readJson } from '../lib/wire';

const app = new Hono<AppEnv>();
app.use(requireAuth);

/**
 * A template is valid when the expense it describes would be accepted right
 * now by POST /api/expenses — same zod rules, same membership/friend checks.
 */
function checkTemplate(
  me: UserRow,
  scope: { groupId: number | null; friendId: number | null },
  template: RecurringTemplate,
  date: string,
): void {
  if (scope.groupId !== null) {
    const group = memberGroupOr404(scope.groupId, me.id);
    if (template.currency !== group.currency) {
      throw new HTTPException(400, { message: 'group expenses must use the group currency' });
    }
  } else if (scope.friendId === null || !areFriends(me.id, scope.friendId)) {
    throw new HTTPException(400, { message: 'you can only split with a friend' });
  }
  const values = template.split.values ?? [];
  const valueSum = values.reduce((s, v) => s + v.value, 0);
  if (template.split.mode === 'exact' && valueSum !== template.amountCents) {
    throw new HTTPException(400, { message: 'shares must sum to the amount' });
  }
  const paidSum = template.split.payers.reduce((s, p) => s + p.cents, 0);
  if (paidSum !== template.amountCents) {
    throw new HTTPException(400, { message: 'shares must sum to the amount' });
  }
  const body = expenseCreateBody.parse(
    templateExpenseBody(
      { id: 0, created_by: me.id, group_id: scope.groupId, friend_id: scope.friendId },
      template,
      { date },
    ),
  );
  checkExpenseInput(me, body);
}

app.get('/', (c) => {
  const me = c.get('user');
  return c.json({ rules: visibleRules(me.id).map(toRecurringRule) });
});

app.post('/', async (c) => {
  const me = c.get('user');
  const body = recurringCreateBody.parse(await readJson(c));
  const today = todayFromQuery(c.req.query('today'));
  if (body.clientKey !== undefined) {
    const prior = db
      .prepare<[number, string], RecurringRuleRow>(
        'SELECT * FROM recurring_rules WHERE created_by = ? AND client_key = ?',
      )
      .get(me.id, body.clientKey);
    if (prior) {
      const first = expenseByClientKey(me.id, occurrenceClientKey(prior.id, prior.anchor_date));
      return c.json({ rule: toRecurringRule(prior), expense: first });
    }
  }
  checkTemplate(me, body, body.template, body.anchorDate);
  const schedule: Schedule = {
    cadence: body.cadence,
    interval: body.interval,
    anchorDate: body.anchorDate,
  };
  const now = nowIso();
  const { rule, expense } = db.transaction(() => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO recurring_rules (created_by, group_id, friend_id, template, cadence, interval,
             anchor_date, next_due, paused, client_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          me.id,
          body.groupId,
          body.friendId,
          JSON.stringify(body.template),
          body.cadence,
          body.interval,
          body.anchorDate,
          body.addFirst ? occurrenceDate(schedule, 1) : body.anchorDate,
          body.clientKey ?? null,
          now,
          now,
        ).lastInsertRowid,
    );
    let first = null;
    if (body.addFirst) {
      const created = ruleById(id);
      first = createExpense(
        me,
        templateExpenseBody(created, body.template, {
          date: body.anchorDate,
          clientKey: occurrenceClientKey(id, body.anchorDate),
        }),
        (expense) => {
          db.prepare(
            `INSERT INTO recurring_occurrences (rule_id, due_date, status, expense_id, created_at)
             VALUES (?, ?, 'added', ?, ?)`,
          ).run(id, body.anchorDate, expense.id, now);
        },
      );
    }
    return { rule: ruleById(id), expense: first };
  })();
  generateForRule(rule, today);
  return c.json({ rule: toRecurringRule(ruleById(rule.id)), expense });
});

app.patch('/:id', async (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const body = recurringPatchBody.parse(await readJson(c));
  const today = todayFromQuery(c.req.query('today'));
  const rule = ownRuleOr404(me.id, id);
  const template = body.template ?? templateOf(rule);
  if (body.template !== undefined) {
    // The bill's scope is fixed: it can't move between groups or friends.
    checkTemplate(me, { groupId: rule.group_id, friendId: rule.friend_id }, template, today);
  }
  const schedule: Schedule = {
    cadence: body.cadence ?? (rule.cadence as Schedule['cadence']),
    interval: body.interval ?? rule.interval,
    anchorDate: body.anchorDate ?? rule.anchor_date,
  };
  const scheduleChanged =
    schedule.cadence !== rule.cadence ||
    schedule.interval !== rule.interval ||
    schedule.anchorDate !== rule.anchor_date;
  const paused = body.paused ?? rule.paused === 1;
  let nextDue = rule.next_due;
  // A new schedule starts fresh from today (no backfill of the old one); a
  // resume skips what fell due while paused.
  if (scheduleChanged) nextDue = firstOnOrAfter(schedule, today);
  else if (rule.paused === 1 && !paused) {
    const resumeFrom = firstOnOrAfter(schedule, today);
    if (resumeFrom > nextDue) nextDue = resumeFrom;
  }
  db.prepare(
    `UPDATE recurring_rules SET template = ?, cadence = ?, interval = ?, anchor_date = ?,
       next_due = ?, paused = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(
    JSON.stringify(template),
    schedule.cadence,
    schedule.interval,
    schedule.anchorDate,
    nextDue,
    paused ? 1 : 0,
    nowIso(),
    id,
  );
  generateForRule(ruleById(id), today);
  return c.json(toRecurringRule(ruleById(id)));
});

app.delete('/:id', (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  ownRuleOr404(me.id, id);
  const now = nowIso();
  db.prepare(
    'UPDATE recurring_rules SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
  ).run(now, now, id);
  return c.body(null, 204);
});

/** An occurrence of one of MY live rules (only the creator gets inbox items); 404 otherwise. */
function myOccurrenceOr404(
  meId: number,
  id: number,
): { occurrence: RecurringOccurrenceRow; rule: RecurringRuleRow } {
  const occurrence = db
    .prepare<[number], RecurringOccurrenceRow>('SELECT * FROM recurring_occurrences WHERE id = ?')
    .get(id);
  if (!occurrence) throw new HTTPException(404, { message: 'not found' });
  const rule = visibleRuleOr404(meId, occurrence.rule_id);
  if (rule.created_by !== meId) throw new HTTPException(404, { message: 'not found' });
  return { occurrence, rule };
}

const markAdded = (occurrenceId: number, expenseId: number) =>
  db
    .prepare(
      `UPDATE recurring_occurrences SET status = 'added', expense_id = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(expenseId, occurrenceId);

app.post('/occurrences/:id/add', async (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const body = occurrenceAddBody.parse(await readJson(c));
  const { occurrence, rule } = myOccurrenceOr404(me.id, id);
  const clientKey = occurrenceClientKey(rule.id, occurrence.due_date);
  // Idempotent: a repeated add (double tap, retried request) returns the
  // expense the first one recorded.
  const prior =
    occurrence.expense_id !== null
      ? expenseWire(occurrence.expense_id)
      : expenseByClientKey(me.id, clientKey);
  if (prior) {
    markAdded(occurrence.id, prior.id);
    return c.json({ expense: prior, occurrenceId: occurrence.id });
  }
  if (occurrence.status === 'skipped') {
    throw new HTTPException(409, { message: 'This bill was skipped.' });
  }
  let expenseBody;
  if (body.expense) {
    // The user reviewed (and maybe edited) the expense: it must stay where
    // the bill lives — same group, or the same two people.
    const e = body.expense;
    const sameScope =
      rule.group_id !== null
        ? e.groupId === rule.group_id
        : e.groupId === null &&
          e.shares.length === 2 &&
          e.shares.every((s) => s.userId === me.id || s.userId === rule.friend_id);
    if (!sameScope) {
      throw new HTTPException(400, { message: 'the expense must stay in this bill’s group' });
    }
    expenseBody = expenseCreateBody.parse({ ...e, isPayment: false, clientKey });
  } else {
    expenseBody = expenseCreateBody.parse(
      templateExpenseBody(rule, templateOf(rule), {
        date: body.date ?? occurrence.due_date,
        amountCents: body.amountCents,
        clientKey,
      }),
    );
  }
  const involved = body.expense
    ? expenseBody.shares.map((s) => s.userId)
    : intentUserIds(templateOf(rule).split);
  assertParticipantsCurrent(me, rule, involved);
  const expense = createExpense(me, expenseBody, (created) => {
    if (markAdded(occurrence.id, created.id).changes === 0) {
      // Skipped (or added) concurrently: roll the expense back.
      throw new HTTPException(409, { message: 'This bill was already handled.' });
    }
  });
  return c.json({ expense, occurrenceId: occurrence.id });
});

app.post('/occurrences/:id/skip', (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const { occurrence } = myOccurrenceOr404(me.id, id);
  if (occurrence.status === 'added') {
    throw new HTTPException(409, { message: 'This bill was already added.' });
  }
  db.prepare(
    "UPDATE recurring_occurrences SET status = 'skipped' WHERE id = ? AND status = 'pending'",
  ).run(id);
  return c.body(null, 204);
});

export default app;
