import { describe, expect, it } from 'vitest';
import {
  DRAFTS_SCHEMA_VERSION,
  autosaveScopeKey,
  createDraft,
  deserializeDrafts,
  draftsInScope,
  draftsKey,
  emptyDrafts,
  serializeDrafts,
  validateDraft,
  withAutosave,
  withDraft,
  withoutDraft,
  type Draft,
} from './drafts';
import { emptyFormValues, type ExpenseFormValues } from './expense-form';
import { ashaLeft, makeSync } from './test-fixtures';

const KEY = 'abcdef1234567890';

function groupValues(over: Partial<ExpenseFormValues> = {}): ExpenseFormValues {
  return {
    ...emptyFormValues(makeSync(), { groupId: 10 }, '2026-10-01'),
    description: 'Taxi',
    amountRaw: '30',
    ...over,
  };
}

const draftOf = (values: ExpenseFormValues, id = 'd1'): Draft =>
  createDraft(values, makeSync(), { id, clientKey: KEY }, '2026-10-01T10:00:00Z');

describe('draft storage schema', () => {
  it('is keyed per user', () => {
    expect(draftsKey(7)).toBe('splitup-drafts:7');
  });

  it('round-trips through JSON', () => {
    const state = withAutosave(
      withDraft(emptyDrafts(1), draftOf(groupValues())),
      'group:10',
      groupValues({ description: 'half typed' }),
      '2026-10-01T10:00:00Z',
    );
    const raw = JSON.parse(JSON.stringify(serializeDrafts(state)));
    expect(raw.v).toBe(DRAFTS_SCHEMA_VERSION);
    expect(deserializeDrafts(raw, 1)).toEqual(state);
  });

  it('never returns another user’s drafts', () => {
    const raw = serializeDrafts(withDraft(emptyDrafts(1), draftOf(groupValues())));
    expect(deserializeDrafts(raw, 2)).toEqual(emptyDrafts(2));
  });

  it('ignores unknown versions and garbage', () => {
    const raw = { ...serializeDrafts(withDraft(emptyDrafts(1), draftOf(groupValues()))), v: 99 };
    expect(deserializeDrafts(raw, 1)).toEqual(emptyDrafts(1));
    expect(deserializeDrafts(undefined, 1)).toEqual(emptyDrafts(1));
    expect(deserializeDrafts('nope', 1)).toEqual(emptyDrafts(1));
  });

  it('drops malformed drafts but keeps the good ones', () => {
    const good = draftOf(groupValues());
    const raw = {
      v: DRAFTS_SCHEMA_VERSION,
      userId: 1,
      drafts: [good, { ...good, id: 'bad', clientKey: 'x' }, { ...good, id: 'bad2', values: {} }],
      autosaves: { 'group:10': { updatedAt: 'x', values: { nope: true } } },
    };
    const parsed = deserializeDrafts(JSON.parse(JSON.stringify(raw)), 1);
    expect(parsed.drafts.map((d) => d.id)).toEqual(['d1']);
    expect(parsed.autosaves).toEqual({});
  });

  it('upserts, removes and clears autosave slots', () => {
    let s = withDraft(emptyDrafts(1), draftOf(groupValues()));
    s = withDraft(s, { ...draftOf(groupValues({ description: 'Bus' })), id: 'd1' });
    expect(s.drafts).toHaveLength(1);
    expect(s.drafts[0].values.description).toBe('Bus');
    expect(withoutDraft(s, 'd1').drafts).toEqual([]);
    const a = withAutosave(s, 'direct', groupValues());
    expect(Object.keys(a.autosaves)).toEqual(['direct']);
    expect(withAutosave(a, 'direct', null).autosaves).toEqual({});
  });

  it('keeps the idempotency key minted at creation', () => {
    expect(draftOf(groupValues()).clientKey).toBe(KEY);
  });

  it('snapshots the names of everyone involved', () => {
    expect(draftOf(groupValues()).names).toEqual({ 1: 'Me', 2: 'Ben', 4: 'Asha' });
  });
});

describe('scopes', () => {
  it('derives autosave slots', () => {
    expect(autosaveScopeKey({ groupId: 10 })).toBe('group:10');
    expect(autosaveScopeKey({ groupId: null, friendId: 3 })).toBe('friend:3');
    expect(autosaveScopeKey({ groupId: null })).toBe('direct');
  });

  it('filters drafts for a group / friend screen', () => {
    const g = draftOf(groupValues(), 'g');
    const f = draftOf({ ...emptyFormValues(makeSync(), { groupId: null, friendId: 3 }) }, 'f');
    expect(draftsInScope([g, f], { kind: 'all' })).toHaveLength(2);
    expect(draftsInScope([g, f], { kind: 'group', groupId: 10 }).map((d) => d.id)).toEqual(['g']);
    expect(draftsInScope([g, f], { kind: 'friend', friendId: 3 }).map((d) => d.id)).toEqual(['f']);
    expect(draftsInScope([g, f], { kind: 'friend', friendId: 2 })).toEqual([]);
  });
});

describe('validateDraft', () => {
  it('is ready when nothing drifted', () => {
    const res = validateDraft(draftOf(groupValues()), makeSync());
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.input).toMatchObject({ groupId: 10, amountCents: 3000, currency: 'EUR' });
    expect(res.input?.shares).toEqual([
      { userId: 1, paidCents: 3000, owedCents: 1000 },
      { userId: 2, paidCents: 0, owedCents: 1000 },
      { userId: 4, paidCents: 0, owedCents: 1000 },
    ]);
  });

  it('needs review when a member left, even though the repair is valid', () => {
    const res = validateDraft(draftOf(groupValues()), ashaLeft());
    expect(res.ok).toBe(false);
    expect(res.input).toBeNull();
    expect(res.issues[0]).toBe('Removed Asha — no longer in this group');
    expect(res.values.split.equalChecked).toEqual([1, 2]);
  });

  it('uses the name snapshot when the person is gone from the dataset', () => {
    const sync = ashaLeft();
    const gone = { ...sync, users: sync.users.filter((u) => u.id !== 4) };
    expect(validateDraft(draftOf(groupValues()), gone).issues[0]).toBe(
      'Removed Asha — no longer in this group',
    );
  });

  it('flags an ex-friend', () => {
    const values = {
      ...emptyFormValues(makeSync(), { groupId: null, friendId: 3 }),
      description: 'x',
      amountRaw: '5',
    };
    const res = validateDraft(draftOf(values), { ...makeSync(), friendIds: [2] });
    expect(res.ok).toBe(false);
    expect(res.issues[0]).toBe('Removed Cara — no longer your friend');
  });

  it('flags a group currency change', () => {
    const sync = makeSync();
    const changed = { ...sync, groups: sync.groups.map((g) => ({ ...g, currency: 'GBP' })) };
    const res = validateDraft(draftOf(groupValues()), changed);
    expect(res.ok).toBe(false);
    expect(res.issues[0]).toMatch(/GBP/);
    expect(res.values.currency).toBe('GBP');
  });

  it('blocks a draft for a group you left', () => {
    const res = validateDraft(draftOf(groupValues()), { ...makeSync(), groups: [] });
    expect(res.ok).toBe(false);
    expect(res.issues).toEqual(['You’re no longer in this group.']);
  });

  it('reports form rule failures', () => {
    const res = validateDraft(draftOf(groupValues({ amountRaw: '' })), makeSync());
    expect(res.ok).toBe(false);
    expect(res.issues).toEqual(['Enter a valid amount.']);
  });
});
