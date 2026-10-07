import { CATEGORY_META } from './categories';
import { currencyDigits } from './money';
import type { SyncData, User } from './types';

/**
 * Spreadsheet formula-injection guard: a text cell starting with = + - @ tab
 * or CR is executed as a formula by Excel/Sheets (an expense described as
 * "=HYPERLINK(...)" would run on open). Prefix it with ' so it stays text.
 * Plain numbers ("-12.50" nets) are left alone so they still sum.
 */
export function neutralizeFormula(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvField(raw: string): string {
  const value = neutralizeFormula(raw);
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Splitwise-compatible CSV for one group: Date, Description, Category, Cost,
 * Currency, then one column per person holding their net effect on that row
 * (paid − owed; payers positive, owers negative).
 */
export function buildGroupCsv(sync: SyncData, groupId: number): string {
  const group = sync.groups.find((g) => g.id === groupId);
  if (!group) return '';
  const expenses = sync.expenses
    .filter((e) => e.groupId === groupId)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  const userOf = (id: number): User =>
    sync.users.find((u) => u.id === id) ?? { id, name: `User ${id}`, email: null, picture: null };
  // Roster plus anyone appearing in shares (e.g. members who later left).
  const columnIds = [...group.memberIds];
  for (const e of expenses) {
    for (const s of e.shares) if (!columnIds.includes(s.userId)) columnIds.push(s.userId);
  }
  const columns = columnIds.map(userOf);

  const rows: string[][] = [
    ['Date', 'Description', 'Category', 'Cost', 'Currency', ...columns.map((u) => u.name)],
  ];
  for (const e of expenses) {
    const digits = currencyDigits(e.currency);
    const major = (cents: number) => (cents / 10 ** digits).toFixed(digits);
    const nets = new Map(e.shares.map((s) => [s.userId, s.paidCents - s.owedCents]));
    rows.push([
      e.date,
      e.description,
      e.isPayment ? 'Payment' : (CATEGORY_META[e.category]?.label ?? e.category),
      major(e.amountCents),
      e.currency,
      ...columns.map((u) => major(nets.get(u.id) ?? 0)),
    ]);
  }
  return rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // iOS Safari reads the blob asynchronously after click(); revoking at once
  // can yield an empty or failed download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
