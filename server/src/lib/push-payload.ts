/**
 * Pure builders for Web Push payloads — no db, no I/O, so they unit-test
 * cleanly. Text stays short (lock-screen sized) and never carries emails.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Same-origin path the notification click opens. */
  url: string;
  /** Replaces an earlier notification with the same tag on the device. */
  tag: string;
}

export interface PayloadShare {
  userId: number;
  paidCents: number;
  owedCents: number;
}

const formatters = new Map<string, { exact: Intl.NumberFormat; whole: Intl.NumberFormat }>();

/** "₹450" / "₹450.50" / "$1,000"; "450.50 XXX" for unknown codes. */
export function formatAmount(cents: number, currency: string): string {
  let f = formatters.get(currency);
  if (f === undefined) {
    try {
      f = {
        exact: new Intl.NumberFormat('en', { style: 'currency', currency }),
        whole: new Intl.NumberFormat('en', {
          style: 'currency',
          currency,
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        }),
      };
    } catch {
      return `${(cents / 100).toFixed(2)} ${currency}`;
    }
    formatters.set(currency, f);
  }
  // Intl knows the currency's minor-unit digits; feed it major units.
  const digits = f.exact.resolvedOptions().maximumFractionDigits ?? 2;
  const major = cents / 10 ** digits;
  // Whole amounts read better without ".00" on a lock screen.
  return (Number.isInteger(major) ? f.whole : f.exact).format(major);
}

const MAX_TEXT = 60;

/** Trim user-entered text (descriptions, names) to a lock-screen length. */
export function clip(text: string, max = MAX_TEXT): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const quote = (description: string) => `“${clip(description, 40)}”`;

interface ExpenseContext {
  expenseId: number;
  groupId: number | null;
  /** Group name for group expenses; ignored otherwise. */
  groupName?: string | null;
  description: string;
  currency: string;
  isPayment: boolean;
  shares: PayloadShare[];
}

/** Where a click should land for this recipient. */
function expenseUrl(groupId: number | null, actorId: number): string {
  return groupId !== null ? `/groups/${groupId}` : `/friends/${actorId}`;
}

function titleFor(groupId: number | null, groupName: string | null | undefined): string {
  return groupId !== null && groupName ? clip(groupName, 40) : 'Splitup';
}

/** "you owe ₹450" / "you get back ₹450" / "you're settled on this" from paid − owed. */
export function positionText(share: PayloadShare | undefined, currency: string): string | null {
  if (!share) return null;
  const net = share.paidCents - share.owedCents;
  if (net < 0) return `you owe ${formatAmount(-net, currency)}`;
  if (net > 0) return `you get back ${formatAmount(net, currency)}`;
  return null;
}

/**
 * The payment line from the recipient's point of view. Payments have exactly
 * one payer and one recipient (validated); the actor may be either, or a third
 * group member who recorded it on their behalf.
 */
function paymentText(
  verb: 'recorded' | 'edited' | 'deleted',
  actor: { id: number; name: string },
  recipientId: number,
  shares: PayloadShare[],
  currency: string,
  names: Map<number, string>,
): string {
  const payer = shares.find((s) => s.paidCents > 0);
  const payee = shares.find((s) => s.owedCents > 0);
  const amount = formatAmount(payer?.paidCents ?? 0, currency);
  const name = (id: number | undefined) => clip(names.get(id ?? -1) ?? 'someone', 30);
  const what = verb === 'recorded' ? 'recorded a payment' : `${verb} a payment`;
  if (payer?.userId === actor.id && payee?.userId === recipientId) {
    return `${clip(actor.name, 30)} ${what} of ${amount} to you`;
  }
  if (payee?.userId === actor.id && payer?.userId === recipientId) {
    return `${clip(actor.name, 30)} ${what} of ${amount} from you`;
  }
  if (payee?.userId === recipientId) {
    return `${clip(actor.name, 30)} ${what} of ${amount} from ${name(payer?.userId)} to you`;
  }
  return `${clip(actor.name, 30)} ${what} of ${amount} from you to ${name(payee?.userId)}`;
}

/**
 * Payload for one recipient of an expense change. `before` (edits) lets a
 * person who was removed from the split learn about it.
 */
export function expensePayload(
  kind: 'created' | 'edited' | 'deleted',
  actor: { id: number; name: string },
  recipientId: number,
  expense: ExpenseContext,
  names: Map<number, string> = new Map(),
): PushPayload {
  const title = titleFor(expense.groupId, expense.groupName);
  const url = expenseUrl(expense.groupId, actor.id);
  const tag = `expense-${expense.expenseId}`;
  if (expense.isPayment) {
    const verb = kind === 'created' ? 'recorded' : kind;
    return {
      title,
      body: paymentText(verb, actor, recipientId, expense.shares, expense.currency, names),
      url,
      tag,
    };
  }
  const who = clip(actor.name, 30);
  const desc = quote(expense.description);
  const share = expense.shares.find((s) => s.userId === recipientId);
  let body: string;
  if (kind === 'created') {
    const pos = positionText(share, expense.currency);
    body = `${who} added ${desc}${pos ? ` — ${pos}` : ''}`;
  } else if (kind === 'edited') {
    const pos = share ? positionText(share, expense.currency) : null;
    body = share
      ? `${who} edited ${desc}${pos ? ` — ${pos}` : ''}`
      : `${who} edited ${desc} — you’re no longer in it`;
  } else {
    body = `${who} deleted ${desc}`;
  }
  return { title, body, url, tag };
}

/**
 * One notification for a whole settle-up batch, from the counterparty's side:
 * rows may run both ways (per-group apportionment), so report the net.
 */
export function settlementPayload(
  actor: { id: number; name: string },
  counterpartyId: number,
  rows: { payerId: number; recipientId: number; amountCents: number }[],
  currency: string,
): PushPayload {
  let toThem = 0;
  for (const r of rows) {
    if (r.payerId === actor.id && r.recipientId === counterpartyId) toThem += r.amountCents;
    else if (r.payerId === counterpartyId && r.recipientId === actor.id) toThem -= r.amountCents;
  }
  const who = clip(actor.name, 30);
  const body =
    toThem > 0
      ? `${who} recorded a payment of ${formatAmount(toThem, currency)} to you`
      : toThem < 0
        ? `${who} recorded a payment of ${formatAmount(-toThem, currency)} from you`
        : `${who} settled up with you`;
  return { title: 'Splitup', body, url: `/friends/${actor.id}`, tag: `settle-${actor.id}` };
}

/** A settle-up batch was undone: tell the other party which way the cash had gone. */
export function settlementUndonePayload(
  actor: { id: number; name: string },
  batch: { payerId: number; payeeId: number; amountCents: number; currency: string },
): PushPayload {
  const who = clip(actor.name, 30);
  const amount = formatAmount(batch.amountCents, batch.currency);
  const body =
    batch.payerId === actor.id
      ? `${who} undid a payment of ${amount} to you`
      : `${who} undid your payment of ${amount}`;
  return { title: 'Splitup', body, url: `/friends/${actor.id}`, tag: `settle-${actor.id}` };
}

export function friendRequestPayload(actor: { id: number; name: string }): PushPayload {
  return {
    title: 'Friend request',
    body: `${clip(actor.name, 30)} wants to add you as a friend`,
    url: '/friends',
    tag: `friend-request-${actor.id}`,
  };
}

export function friendAcceptedPayload(
  actor: { id: number; name: string },
  via: 'request' | 'invite',
): PushPayload {
  const who = clip(actor.name, 30);
  return {
    title: 'New friend',
    body:
      via === 'request'
        ? `${who} accepted your friend request`
        : `${who} accepted your invite — you’re now friends`,
    url: `/friends/${actor.id}`,
    tag: `friend-${actor.id}`,
  };
}

export function addedToGroupPayload(
  actor: { id: number; name: string },
  group: { id: number; name: string },
): PushPayload {
  return {
    title: clip(group.name, 40),
    body: `${clip(actor.name, 30)} added you to “${clip(group.name, 40)}”`,
    url: `/groups/${group.id}`,
    tag: `group-${group.id}`,
  };
}
