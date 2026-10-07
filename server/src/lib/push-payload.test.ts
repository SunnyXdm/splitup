import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addedToGroupPayload,
  clip,
  expensePayload,
  formatAmount,
  friendAcceptedPayload,
  friendRequestPayload,
  recurringDuePayload,
  settlementPayload,
} from './push-payload';
import { pushSubscriptionBody, pushUnsubscribeBody } from '../validate';

const asha = { id: 1, name: 'Asha' };
const dinner = {
  expenseId: 42,
  groupId: 7,
  groupName: 'Goa trip',
  description: 'Dinner',
  currency: 'INR',
  isPayment: false,
  shares: [
    { userId: 1, paidCents: 135000, owedCents: 45000 },
    { userId: 2, paidCents: 0, owedCents: 45000 },
    { userId: 3, paidCents: 0, owedCents: 45000 },
  ],
};

describe('formatAmount', () => {
  it('drops .00 for whole amounts and keeps cents otherwise', () => {
    assert.equal(formatAmount(45000, 'INR'), '₹450');
    assert.equal(formatAmount(45050, 'INR'), '₹450.50');
    assert.equal(formatAmount(100000000, 'USD'), '$1,000,000');
  });
  it('respects zero-decimal currencies', () => {
    assert.equal(formatAmount(500, 'JPY'), '¥500');
  });
});

describe('expensePayload', () => {
  it('tells a debtor what they owe, deep-linking the group', () => {
    const p = expensePayload('created', asha, 2, dinner);
    assert.deepEqual(p, {
      title: 'Goa trip',
      body: 'Asha added “Dinner” — you owe ₹450',
      url: '/groups/7',
      tag: 'expense-42',
    });
  });

  it('tells a payer what they get back', () => {
    const p = expensePayload('created', { id: 2, name: 'Ben' }, 1, dinner);
    assert.equal(p.body, 'Ben added “Dinner” — you get back ₹900');
  });

  it('omits the position when the recipient nets to zero', () => {
    const even = { ...dinner, shares: [{ userId: 2, paidCents: 100, owedCents: 100 }] };
    assert.equal(expensePayload('created', asha, 2, even).body, 'Asha added “Dinner”');
  });

  it('links a direct expense to the actor’s friend page', () => {
    const direct = { ...dinner, groupId: null, groupName: null };
    const p = expensePayload('created', asha, 2, direct);
    assert.equal(p.title, 'Splitup');
    assert.equal(p.url, '/friends/1');
  });

  it('words edits and deletes', () => {
    assert.equal(expensePayload('edited', asha, 2, dinner).body, 'Asha edited “Dinner” — you owe ₹450');
    assert.equal(
      expensePayload('edited', asha, 9, dinner).body,
      'Asha edited “Dinner” — you’re no longer in it',
    );
    assert.equal(expensePayload('deleted', asha, 2, dinner).body, 'Asha deleted “Dinner”');
  });

  it('words restores', () => {
    assert.equal(
      expensePayload('restored', asha, 2, dinner).body,
      'Asha restored “Dinner” — you owe ₹450',
    );
    assert.equal(
      expensePayload('restored', asha, 9, dinner).body,
      'Asha restored “Dinner” — you’re no longer in it',
    );
  });

  it('clips long descriptions', () => {
    const long = { ...dinner, description: 'x'.repeat(100) };
    const body = expensePayload('deleted', asha, 2, long).body;
    assert.ok(body.length < 60, body);
    assert.ok(body.includes('…'));
  });

  it('words payments from the recipient’s side', () => {
    const payment = {
      ...dinner,
      isPayment: true,
      description: 'Payment',
      shares: [
        { userId: 1, paidCents: 50000, owedCents: 0 },
        { userId: 2, paidCents: 0, owedCents: 50000 },
      ],
    };
    assert.equal(
      expensePayload('created', asha, 2, payment).body,
      'Asha recorded a payment of ₹500 to you',
    );
    assert.equal(
      expensePayload('created', { id: 2, name: 'Ben' }, 1, payment).body,
      'Ben recorded a payment of ₹500 from you',
    );
    const names = new Map([
      [1, 'Asha'],
      [2, 'Ben'],
    ]);
    assert.equal(
      expensePayload('created', { id: 3, name: 'Chen' }, 2, payment, names).body,
      'Chen recorded a payment of ₹500 from Asha to you',
    );
    assert.equal(
      expensePayload('deleted', { id: 3, name: 'Chen' }, 1, payment, names).body,
      'Chen deleted a payment of ₹500 from you to Ben',
    );
  });
});

describe('settlementPayload', () => {
  it('reports the net of a two-way batch', () => {
    const rows = [
      { payerId: 1, recipientId: 2, amountCents: 80000 },
      { payerId: 2, recipientId: 1, amountCents: 30000 },
    ];
    assert.deepEqual(settlementPayload(asha, 2, rows, 'INR'), {
      title: 'Splitup',
      body: 'Asha recorded a payment of ₹500 to you',
      url: '/friends/1',
      tag: 'settle-1',
    });
    assert.equal(
      settlementPayload(asha, 2, [{ payerId: 2, recipientId: 1, amountCents: 50000 }], 'INR').body,
      'Asha recorded a payment of ₹500 from you',
    );
  });
});

describe('friend and group payloads', () => {
  it('builds short, email-free messages', () => {
    assert.equal(friendRequestPayload(asha).body, 'Asha wants to add you as a friend');
    assert.equal(friendRequestPayload(asha).url, '/friends');
    assert.equal(friendAcceptedPayload(asha, 'request').url, '/friends/1');
    assert.equal(addedToGroupPayload(asha, { id: 7, name: 'Goa trip' }).body, 'Asha added you to “Goa trip”');
  });
  it('clip collapses whitespace', () => {
    assert.equal(clip('  a \n b  '), 'a b');
  });
});

describe('recurringDuePayload', () => {
  it('names one bill, two bills, or the first and a count', () => {
    assert.equal(recurringDuePayload(['Rent']).body, '“Rent” is due to add');
    assert.equal(recurringDuePayload(['Rent', 'Rent']).body, '“Rent” is due to add');
    assert.equal(recurringDuePayload(['Rent', 'Wifi']).body, '“Rent” and “Wifi” are due to add');
    assert.equal(
      recurringDuePayload(['Rent', 'Wifi', 'Gym']).body,
      '“Rent” and 2 other bills are due to add',
    );
    assert.equal(recurringDuePayload(['Rent']).url, '/');
  });
});

describe('push subscription validation', () => {
  const keys = { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) };
  const ok = (endpoint: string) => pushSubscriptionBody.safeParse({ endpoint, keys }).success;

  it('accepts real push service endpoints and toJSON() shape', () => {
    assert.ok(ok('https://fcm.googleapis.com/fcm/send/abc:def'));
    assert.ok(ok('https://web.push.apple.com/QH4x'));
    assert.ok(
      pushSubscriptionBody.safeParse({
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x',
        expirationTime: null,
        keys,
      }).success,
    );
  });

  it('rejects non-https, internal hosts and oversized endpoints', () => {
    assert.ok(!ok('http://fcm.googleapis.com/x'));
    assert.ok(!ok('https://localhost/x'));
    assert.ok(!ok('https://127.0.0.1/x'));
    assert.ok(!ok('https://[::1]/x'));
    assert.ok(!ok('https://intranet/x'));
    assert.ok(!ok('https://db.internal/x'));
    assert.ok(!ok('https://user:pw@fcm.googleapis.com/x'));
    assert.ok(!ok(`https://fcm.googleapis.com/${'a'.repeat(1000)}`));
    assert.ok(!ok('not a url'));
  });

  it('requires base64url keys and no extra fields', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/x';
    assert.ok(!pushSubscriptionBody.safeParse({ endpoint, keys: { ...keys, auth: 'short' } }).success);
    assert.ok(!pushSubscriptionBody.safeParse({ endpoint, keys: { ...keys, p256dh: 'a b'.repeat(10) } }).success);
    assert.ok(!pushSubscriptionBody.safeParse({ endpoint, keys, extra: 1 }).success);
    assert.ok(pushUnsubscribeBody.safeParse({ endpoint }).success);
    assert.ok(!pushUnsubscribeBody.safeParse({}).success);
  });
});
