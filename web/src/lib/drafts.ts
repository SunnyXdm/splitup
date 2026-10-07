import {
  checkFormValues,
  firstFormError,
  participantIdsFor,
  referencedUserIds,
  revalidateFormValues,
  userById,
  type ExpenseFormValues,
} from './expense-form';
import { CATEGORIES } from './categories';
import type { ExpenseInput, SyncData } from './types';

/**
 * Offline drafts — pure model. A draft is an add-expense form the user saved
 * (typically offline) to submit later. It lives only on this device, per
 * signed-in user, and never touches the ['sync'] cache or balances until it is
 * submitted with its own idempotency key.
 *
 * Alongside the saved drafts, each scope keeps one AUTOSAVE: the in-progress
 * "Add expense" form, so closing the sheet or the app doesn't lose it.
 */

export const DRAFTS_SCHEMA_VERSION = 1;

/** IndexedDB key prefix; the full key is per user: `splitup-drafts:<userId>`. */
export const DRAFTS_KEY_PREFIX = 'splitup-drafts:';

export const draftsKey = (userId: number): string => `${DRAFTS_KEY_PREFIX}${userId}`;

export interface Draft {
  id: string;
  /** Idempotency key minted when the draft was created — every submit reuses it. */
  clientKey: string;
  createdAt: string;
  updatedAt: string;
  values: ExpenseFormValues;
  /** Names of the people involved, so notes stay readable if they vanish from sync. */
  names: Record<number, string>;
}

export interface AutosaveEntry {
  values: ExpenseFormValues;
  updatedAt: string;
}

export interface DraftsState {
  userId: number;
  drafts: Draft[];
  /** Keyed by autosaveScopeKey(). */
  autosaves: Record<string, AutosaveEntry>;
}

export interface SerializedDrafts extends DraftsState {
  v: typeof DRAFTS_SCHEMA_VERSION;
}

export const emptyDrafts = (userId: number): DraftsState => ({ userId, drafts: [], autosaves: {} });

/** Where an in-progress form autosaves: one slot per group / friend / generic 1:1. */
export function autosaveScopeKey(scope: {
  groupId: number | null;
  friendId?: number | null;
}): string {
  if (scope.groupId !== null) return `group:${scope.groupId}`;
  return scope.friendId != null ? `friend:${scope.friendId}` : 'direct';
}

export function serializeDrafts(state: DraftsState): SerializedDrafts {
  return { v: DRAFTS_SCHEMA_VERSION, ...state };
}

// --- Defensive parsing: anything malformed is dropped, never crashes the app.

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isIdOrNull = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) > 0);
const isIdArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => Number.isInteger(x));
const isRecordOf = (v: unknown, check: (x: unknown) => boolean) =>
  isObj(v) && Object.entries(v).every(([k, x]) => /^\d+$/.test(k) && check(x));

export function isFormValues(v: unknown): v is ExpenseFormValues {
  if (!isObj(v)) return false;
  const { payer, split } = v;
  return (
    isIdOrNull(v.groupId) &&
    isIdOrNull(v.friendId) &&
    isStr(v.description) &&
    isStr(v.amountRaw) &&
    isStr(v.currency) &&
    /^[A-Z]{3}$/.test(v.currency) &&
    isStr(v.date) &&
    (CATEGORIES as readonly unknown[]).includes(v.category) &&
    isStr(v.notes) &&
    typeof v.showNotes === 'boolean' &&
    isObj(payer) &&
    (payer.mode === 'single' || payer.mode === 'multiple') &&
    Number.isInteger(payer.payerId) &&
    isRecordOf(payer.multiRaw, isStr) &&
    isObj(split) &&
    ['equal', 'unequal', 'percent', 'shares'].includes(split.mode as string) &&
    isIdArray(split.equalChecked) &&
    isRecordOf(split.unequalRaw, isStr) &&
    isRecordOf(split.percentRaw, isStr) &&
    isRecordOf(split.shareCounts, (x) => Number.isInteger(x) && (x as number) >= 0)
  );
}

function parseDraft(v: unknown): Draft | null {
  if (!isObj(v)) return null;
  if (!isStr(v.id) || !isStr(v.clientKey) || !/^[A-Za-z0-9_-]{8,64}$/.test(v.clientKey))
    return null;
  if (!isStr(v.createdAt) || !isStr(v.updatedAt) || !isFormValues(v.values)) return null;
  return {
    id: v.id,
    clientKey: v.clientKey,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    values: v.values,
    names: isRecordOf(v.names, isStr) ? (v.names as Record<number, string>) : {},
  };
}

/**
 * Parse what was stored for `userId`. Unknown versions, another user's data
 * (never shown across accounts) and malformed entries all yield empty/partial
 * state rather than an error.
 */
export function deserializeDrafts(raw: unknown, userId: number): DraftsState {
  if (!isObj(raw) || raw.v !== DRAFTS_SCHEMA_VERSION || raw.userId !== userId) {
    return emptyDrafts(userId);
  }
  const drafts = Array.isArray(raw.drafts)
    ? raw.drafts.map(parseDraft).filter((d): d is Draft => d !== null)
    : [];
  const autosaves: Record<string, AutosaveEntry> = {};
  if (isObj(raw.autosaves)) {
    for (const [key, entry] of Object.entries(raw.autosaves)) {
      if (isObj(entry) && isStr(entry.updatedAt) && isFormValues(entry.values)) {
        autosaves[key] = { values: entry.values, updatedAt: entry.updatedAt };
      }
    }
  }
  return { userId, drafts, autosaves };
}

/** A new draft from the form, with its own id and idempotency key. */
export function createDraft(
  values: ExpenseFormValues,
  sync: SyncData,
  ids: { id: string; clientKey: string },
  now: string = new Date().toISOString(),
): Draft {
  return {
    ...ids,
    createdAt: now,
    updatedAt: now,
    values,
    names: namesFor(values, sync),
  };
}

/** Name snapshot of everyone the values involve (for later notes). */
export function namesFor(values: ExpenseFormValues, sync: SyncData): Record<number, string> {
  const ids = new Set(referencedUserIds(values));
  if (values.friendId !== null) ids.add(values.friendId);
  const names: Record<number, string> = {};
  for (const id of ids) {
    const u = sync.users.find((x) => x.id === id);
    if (u) names[id] = u.name;
  }
  return names;
}

export function withDraft(state: DraftsState, draft: Draft): DraftsState {
  const exists = state.drafts.some((d) => d.id === draft.id);
  return {
    ...state,
    drafts: exists
      ? state.drafts.map((d) => (d.id === draft.id ? draft : d))
      : [...state.drafts, draft],
  };
}

export function withoutDraft(state: DraftsState, id: string): DraftsState {
  return { ...state, drafts: state.drafts.filter((d) => d.id !== id) };
}

export function withAutosave(
  state: DraftsState,
  scopeKey: string,
  values: ExpenseFormValues | null,
  now: string = new Date().toISOString(),
): DraftsState {
  const autosaves = { ...state.autosaves };
  if (values) autosaves[scopeKey] = { values, updatedAt: now };
  else delete autosaves[scopeKey];
  return { ...state, autosaves };
}

export type DraftScope =
  { kind: 'all' } | { kind: 'group'; groupId: number } | { kind: 'friend'; friendId: number };

export function draftsInScope(drafts: Draft[], scope: DraftScope): Draft[] {
  switch (scope.kind) {
    case 'all':
      return drafts;
    case 'group':
      return drafts.filter((d) => d.values.groupId === scope.groupId);
    case 'friend':
      return drafts.filter(
        (d) => d.values.groupId === null && d.values.friendId === scope.friendId,
      );
  }
}

export interface DraftValidation {
  /** Ready to submit as-is: nothing drifted and every form rule passes. */
  ok: boolean;
  /** Human-readable problems (drift notes first, then form rules). */
  issues: string[];
  /** Values after revalidation (what the review form opens with). */
  values: ExpenseFormValues;
  /** Drift notes only (shown at the top of the review form). */
  notes: string[];
  /** Request body when ok. */
  input: ExpenseInput | null;
}

/**
 * Re-check a draft against the CURRENT dataset: membership, friendship,
 * currency and every form rule. A draft whose people changed is never "ok" —
 * it must be reviewed — even when the repaired values would be valid.
 */
export function validateDraft(draft: Draft, sync: SyncData): DraftValidation {
  const rv = revalidateFormValues(draft.values, sync, draft.names);
  if (rv.blocking) {
    return { ok: false, issues: [rv.blocking], values: rv.values, notes: [], input: null };
  }
  const participants = participantIdsFor(rv.values, sync).map((id) => userById(sync, id));
  const check = checkFormValues(rv.values, participants, sync.me.id);
  const formError = firstFormError(check);
  const issues = [...rv.notes, ...(formError ? [formError] : [])];
  return {
    ok: issues.length === 0 && check.input !== null,
    issues,
    values: rv.values,
    notes: rv.notes,
    input: issues.length === 0 ? check.input : null,
  };
}
